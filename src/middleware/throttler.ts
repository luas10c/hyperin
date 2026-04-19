import type { Request } from '../request'
import type { Response } from '../response'

type NextFunction = () => void | Promise<void>

type MiddlewareContext = {
  request: Request
  response: Response
  next: NextFunction
}

type Middleware = (ctx: MiddlewareContext) => void | Promise<void>

export type RateLimitAlgorithm = 'fixed-window' | 'token-bucket'

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
}

export interface RateLimitOptions {
  algorithm?: RateLimitAlgorithm
  limit?: number
  windowMs?: number
  keyGenerator?: (request: Request) => string
  keyHeader?: string
  store?: RateLimitStore
  statusCode?: number
  standardHeaders?: boolean
  legacyHeaders?: boolean
  message?: string | Record<string, unknown>
  skip?: (request: Request, response: Response) => boolean
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

  consume(key: string, options: RateLimitStoreOptions): RateLimitResult {
    const now = Date.now()

    if (options.algorithm === 'token-bucket') {
      return this.#consumeTokenBucket(key, options, now)
    }

    return this.#consumeFixedWindow(key, options, now)
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

function resolveKey(request: Request, options: RateLimitOptions): string {
  if (options.keyGenerator) return options.keyGenerator(request)

  if (options.keyHeader) {
    const header = getHeaderValue(request.get(options.keyHeader))
    if (header) return header
  }

  return request.ipAddress || 'unknown'
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
  const resolvedOptions: RateLimitStoreOptions = {
    algorithm: options.algorithm ?? 'fixed-window',
    limit: options.limit ?? 100,
    windowMs: options.windowMs ?? 60_000
  }
  const store = options.store ?? new MemoryRateLimitStore()
  const standardHeaders = options.standardHeaders ?? true
  const legacyHeaders = options.legacyHeaders ?? false
  const statusCode = options.statusCode ?? 429
  const message = options.message ?? { error: 'Too Many Requests' }

  return async ({ request, response, next }) => {
    if (options.skip?.(request, response)) {
      return void (await next())
    }

    const key = resolveKey(request, options)
    const result = await store.consume(key, resolvedOptions)

    sendRateLimitHeaders(
      response,
      resolvedOptions,
      result,
      standardHeaders,
      legacyHeaders
    )

    if (!result.allowed) {
      response.status(statusCode)

      if (typeof message === 'string') {
        response.text(message)
      } else {
        response.json(message)
      }

      return
    }

    await next()
  }
}
