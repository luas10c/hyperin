import type { Request } from '../request'
import type { Response } from '../response'
import type { Middleware } from '#/types'

export type RateLimitAlgorithm = 'fixed-window' | 'token-bucket'
type MaybePromise<T> = T | Promise<T>

export interface RateLimitResult {
  allowed: boolean
  limit: number
  remaining: number
  resetTime: number
  retryAfter?: number
}

export interface RateLimitStoreOptions {
  /**
   * Selected rate limit algorithm for the current request.
   */
  algorithm: RateLimitAlgorithm

  /**
   * Maximum number of requests allowed in the current window or bucket.
   */
  limit: number

  /**
   * Time window, in milliseconds, used by the store.
   */
  windowMs: number
}

export interface RateLimitStore {
  consume(
    key: string,
    options: RateLimitStoreOptions
  ): RateLimitResult | Promise<RateLimitResult>
  decrement?(key: string, options: RateLimitStoreOptions): void | Promise<void>
}

export interface RateLimitOptions {
  /**
   * Rate limiting strategy used by the middleware.
   * @default 'fixed-window'
   */
  algorithm?: RateLimitAlgorithm

  /**
   * Maximum number of requests allowed per key within the window.
   * Can be computed dynamically per request.
   * @default 100
   */
  limit?:
    | number
    | ((request: Request, response: Response) => MaybePromise<number>)

  /**
   * Window size in milliseconds.
   * @default 60000
   */
  windowMs?: number

  /**
   * Builds the identifier used to track each client.
   * Defaults to the request IP address.
   */
  keyGenerator?: (request: Request, response: Response) => MaybePromise<string>

  /**
   * Request header used as the client key when `keyGenerator` is not provided.
   */
  keyHeader?: string

  /**
   * Custom persistence layer for counters and token buckets.
   * Defaults to the in-memory store.
   */
  store?: RateLimitStore

  /**
   * Status code sent when the limit is exceeded.
   * Can be computed dynamically per request.
   * @default 429
   */
  statusCode?:
    | number
    | ((request: Request, response: Response) => MaybePromise<number>)

  /**
   * Enables `RateLimit-*` response headers.
   * Both `true` and `'draft-6'` enable the current standard header set.
   * @default true
   */
  standardHeaders?: boolean | 'draft-6'

  /**
   * Enables legacy `X-RateLimit-*` response headers.
   * @default false
   */
  legacyHeaders?: boolean

  /**
   * Response body sent when the limit is exceeded.
   * Can be static or computed per request.
   */
  message?:
    | string
    | Record<string, unknown>
    | ((
        request: Request,
        response: Response
      ) => MaybePromise<string | Record<string, unknown>>)

  /**
   * Skip rate limiting for requests that match this predicate.
   */
  skip?: (request: Request, response: Response) => boolean

  /**
   * Custom handler executed when a request is blocked.
   * Receives the resolved status code, message and store result.
   */
  handler?: (
    request: Request,
    response: Response,
    next: () => void | Promise<void>,
    options: {
      statusCode: number
      message: string | Record<string, unknown>
      limit: number
      result: RateLimitResult
    }
  ) => void | Promise<void>

  /**
   * Name of the request property used to expose the rate limit result.
   * @default 'rateLimit'
   */
  requestPropertyName?: string

  /**
   * Decrement the consumed hit when the response finishes with a status code below 400.
   */
  skipSuccessfulRequests?: boolean

  /**
   * Decrement the consumed hit when the response finishes with a status code of 400 or above.
   */
  skipFailedRequests?: boolean
}

export interface MemoryRateLimitStoreOptions {
  /**
   * Maximum number of keys retained by the in-memory store.
   * @default 10000
   */
  maxKeys?: number
}

type FixedWindowEntry = {
  count: number
  resetAt: number
}

type TokenBucketEntry = {
  tokens: number
  lastRefillAt: number
}

function secondsFromMs(ms: number): number {
  return Math.max(0, Math.ceil(ms / 1000))
}

function getHeaderValue(
  value: string | string[] | undefined
): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

function formatRateLimitPolicy(options: RateLimitStoreOptions): string {
  const windowSeconds = secondsFromMs(options.windowMs)
  return options.algorithm === 'token-bucket'
    ? `${options.limit};w=${windowSeconds};policy=token-bucket`
    : `${options.limit};w=${windowSeconds}`
}

export class MemoryRateLimitStore implements RateLimitStore {
  #fixedWindowEntries = new Map<string, FixedWindowEntry>()
  #tokenBucketEntries = new Map<string, TokenBucketEntry>()
  #sweepCountdown = 0
  readonly #maxKeys: number

  constructor(options: MemoryRateLimitStoreOptions = {}) {
    this.#maxKeys = Math.max(1, Math.floor(options.maxKeys ?? 10_000))
  }

  consume(key: string, options: RateLimitStoreOptions): RateLimitResult {
    const now = Date.now()
    this.#scheduleSweep(now, options)

    if (options.limit <= 0) {
      const resetTime = secondsFromMs(options.windowMs)
      return {
        allowed: false,
        limit: options.limit,
        remaining: 0,
        resetTime,
        retryAfter: resetTime
      }
    }

    if (options.algorithm === 'token-bucket') {
      return this.#consumeTokenBucket(key, options, now)
    }

    return this.#consumeFixedWindow(key, options, now)
  }

  decrement(key: string, options: RateLimitStoreOptions): void {
    if (options.algorithm === 'token-bucket') {
      const entry = this.#tokenBucketEntries.get(key)
      if (!entry) return

      entry.tokens = Math.min(options.limit, entry.tokens + 1)
      entry.lastRefillAt = Date.now()
      if (entry.tokens >= options.limit) {
        this.#tokenBucketEntries.delete(key)
      }
      return
    }

    const entry = this.#fixedWindowEntries.get(key)
    if (!entry) return

    entry.count = Math.max(0, entry.count - 1)
    if (entry.count === 0) {
      this.#fixedWindowEntries.delete(key)
    }
  }

  #scheduleSweep(now: number, options: RateLimitStoreOptions): void {
    this.#sweepCountdown++
    if (this.#sweepCountdown < 1024) return

    this.#sweepCountdown = 0
    this.#sweepExpired(now, options)
  }

  #sweepExpired(now: number, options: RateLimitStoreOptions): void {
    for (const [key, entry] of this.#fixedWindowEntries) {
      if (entry.resetAt <= now) {
        this.#fixedWindowEntries.delete(key)
      }
    }

    if (options.algorithm !== 'token-bucket') return

    // Evict idle token buckets and also remove old entries to prevent unbounded memory growth
    // Heuristic: consider an entry idle if it hasn't seen a refill in more than 2 * windowMs
    const idleThreshold = (options.windowMs ?? 60000) * 2
    for (const [key, entry] of this.#tokenBucketEntries) {
      const elapsed = now - entry.lastRefillAt
      // Regular cleanup: purge if idle for a long time
      if (elapsed > idleThreshold) {
        this.#tokenBucketEntries.delete(key)
        continue
      }

      // Maintain normal behavior: refill-like calculation to see if the bucket can be kept
      const refillPerMs = (options.limit ?? 0) / (options.windowMs ?? 1)
      const tokens = Math.min(
        options.limit,
        entry.tokens + elapsed * refillPerMs
      )
      if (tokens >= options.limit) {
        this.#tokenBucketEntries.delete(key)
      }
    }
  }

  #consumeFixedWindow(
    key: string,
    options: RateLimitStoreOptions,
    now: number
  ): RateLimitResult {
    const existing = this.#fixedWindowEntries.get(key)

    if (!existing || existing.resetAt <= now) {
      const resetAt = now + options.windowMs
      const entry: FixedWindowEntry = { count: 1, resetAt }
      this.#evictIfNeeded(now, options)
      this.#fixedWindowEntries.set(key, entry)

      return {
        allowed: true,
        limit: options.limit,
        remaining: Math.max(0, options.limit - 1),
        resetTime: secondsFromMs(resetAt - now)
      }
    }

    existing.count++

    const allowed = existing.count <= options.limit
    const resetTime = secondsFromMs(existing.resetAt - now)

    return {
      allowed,
      limit: options.limit,
      remaining: Math.max(0, options.limit - existing.count),
      resetTime,
      retryAfter: allowed ? undefined : resetTime
    }
  }

  #consumeTokenBucket(
    key: string,
    options: RateLimitStoreOptions,
    now: number
  ): RateLimitResult {
    const refillPerMs = options.limit / options.windowMs
    const existing = this.#tokenBucketEntries.get(key)

    if (!existing) {
      const entry: TokenBucketEntry = {
        tokens: Math.max(0, options.limit - 1),
        lastRefillAt: now
      }
      this.#evictIfNeeded(now, options)
      this.#tokenBucketEntries.set(key, entry)

      return {
        allowed: true,
        limit: options.limit,
        remaining: Math.floor(entry.tokens),
        resetTime: secondsFromMs(options.windowMs)
      }
    }

    const elapsed = now - existing.lastRefillAt
    if (elapsed > 0) {
      existing.tokens = Math.min(
        options.limit,
        existing.tokens + elapsed * refillPerMs
      )
      existing.lastRefillAt = now
    }

    if (existing.tokens >= 1) {
      existing.tokens -= 1

      return {
        allowed: true,
        limit: options.limit,
        remaining: Math.floor(existing.tokens),
        resetTime: secondsFromMs(
          (options.limit - existing.tokens) / refillPerMs || 0
        )
      }
    }

    const retryAfter = secondsFromMs((1 - existing.tokens) / refillPerMs)

    return {
      allowed: false,
      limit: options.limit,
      remaining: 0,
      resetTime: retryAfter,
      retryAfter
    }
  }

  #evictIfNeeded(now: number, options: RateLimitStoreOptions): void {
    if (this.#size < this.#maxKeys) return

    this.#sweepExpired(now, options)

    while (this.#size >= this.#maxKeys) {
      const fixedWindowKey = this.#fixedWindowEntries.keys().next().value as
        | string
        | undefined
      if (fixedWindowKey !== undefined) {
        this.#fixedWindowEntries.delete(fixedWindowKey)
        continue
      }

      const tokenBucketKey = this.#tokenBucketEntries.keys().next().value as
        | string
        | undefined
      if (tokenBucketKey === undefined) return
      this.#tokenBucketEntries.delete(tokenBucketKey)
    }
  }

  get #size(): number {
    return this.#fixedWindowEntries.size + this.#tokenBucketEntries.size
  }
}

async function resolveKey(
  request: Request,
  response: Response,
  options: RateLimitOptions
): Promise<string> {
  if (options.keyGenerator) return await options.keyGenerator(request, response)

  if (options.keyHeader) {
    const header = getHeaderValue(request.get(options.keyHeader))
    if (header) return header
  }

  return request.ipAddress || 'unknown'
}

async function resolveLimit(
  request: Request,
  response: Response,
  limit: RateLimitOptions['limit']
): Promise<number> {
  if (typeof limit === 'function') return await limit(request, response)
  return limit ?? 100
}

async function resolveStatusCode(
  request: Request,
  response: Response,
  statusCode: RateLimitOptions['statusCode']
): Promise<number> {
  if (typeof statusCode === 'function')
    return await statusCode(request, response)
  return statusCode ?? 429
}

async function resolveMessage(
  request: Request,
  response: Response,
  message: RateLimitOptions['message']
): Promise<string | Record<string, unknown>> {
  if (typeof message === 'function') return await message(request, response)
  return message ?? 'Too Many Requests'
}

function sendRateLimitHeaders(
  response: Response,
  options: RateLimitStoreOptions,
  result: RateLimitResult,
  standardHeaders: boolean,
  legacyHeaders: boolean
): void {
  if (standardHeaders) {
    response.setHeader('RateLimit-Limit', String(result.limit))
    response.setHeader('RateLimit-Remaining', String(result.remaining))
    response.setHeader('RateLimit-Reset', String(result.resetTime))
    response.setHeader('RateLimit-Policy', formatRateLimitPolicy(options))
  }

  if (legacyHeaders) {
    response.setHeader('X-RateLimit-Limit', String(result.limit))
    response.setHeader('X-RateLimit-Remaining', String(result.remaining))
    response.setHeader('X-RateLimit-Reset', String(result.resetTime))
  }

  if (!result.allowed && result.retryAfter !== undefined) {
    response.setHeader('Retry-After', String(result.retryAfter))
  }
}

export function throttler(options: RateLimitOptions = {}): Middleware {
  const store = options.store ?? new MemoryRateLimitStore()
  const standardHeaders = options.standardHeaders ?? true
  const legacyHeaders = options.legacyHeaders ?? false
  const requestPropertyName = options.requestPropertyName ?? 'rateLimit'
  const algorithm = options.algorithm ?? 'fixed-window'
  const windowMs = options.windowMs ?? 60_000

  return async ({ request, response, next }) => {
    if (options.skip?.(request, response)) {
      return void (await next())
    }

    const resolvedOptions: RateLimitStoreOptions = {
      algorithm,
      limit: await resolveLimit(request, response, options.limit),
      windowMs
    }
    const key = await resolveKey(request, response, options)
    const result = await store.consume(key, resolvedOptions)

    ;(request as unknown as Record<string, unknown>)[requestPropertyName] =
      result

    sendRateLimitHeaders(
      response,
      resolvedOptions,
      result,
      standardHeaders !== false,
      legacyHeaders
    )

    if (!result.allowed) {
      const statusCode = await resolveStatusCode(
        request,
        response,
        options.statusCode
      )
      const message = await resolveMessage(request, response, options.message)

      if (options.handler) {
        await options.handler(request, response, next, {
          statusCode,
          message,
          limit: resolvedOptions.limit,
          result
        })
        return
      }

      const body =
        typeof message === 'string'
          ? {
              statusCode,
              path: request.url,
              message
            }
          : message

      response.status(statusCode).json(body)

      return
    }

    await next()

    if (
      (options.skipSuccessfulRequests && response.statusCode < 400) ||
      (options.skipFailedRequests && response.statusCode >= 400)
    ) {
      await store.decrement?.(key, resolvedOptions)
    }
  }
}
