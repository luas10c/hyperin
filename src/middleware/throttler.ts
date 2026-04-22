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
  algorithm: RateLimitAlgorithm
  limit: number
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
  algorithm?: RateLimitAlgorithm
  limit?:
    | number
    | ((request: Request, response: Response) => MaybePromise<number>)
  windowMs?: number
  keyGenerator?: (request: Request, response: Response) => MaybePromise<string>
  keyHeader?: string
  store?: RateLimitStore
  statusCode?:
    | number
    | ((request: Request, response: Response) => MaybePromise<number>)
  standardHeaders?: boolean | 'draft-6'
  legacyHeaders?: boolean
  message?:
    | string
    | Record<string, unknown>
    | ((
        request: Request,
        response: Response
      ) => MaybePromise<string | Record<string, unknown>>)
  skip?: (request: Request, response: Response) => boolean
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
  requestPropertyName?: string
  skipSuccessfulRequests?: boolean
  skipFailedRequests?: boolean
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

    for (const [key, entry] of this.#fixedWindowEntries) {
      if (entry.resetAt <= now) {
        this.#fixedWindowEntries.delete(key)
      }
    }

    if (options.algorithm !== 'token-bucket') return

    for (const [key, entry] of this.#tokenBucketEntries) {
      const elapsed = now - entry.lastRefillAt
      const refillPerMs = options.limit / options.windowMs
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
