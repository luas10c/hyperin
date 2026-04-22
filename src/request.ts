import { IncomingMessage } from 'node:http'
import type { Socket } from 'node:net'
import type { ParsedUrlQuery } from 'node:querystring'

export type RequestParams = Record<string, unknown>
export type RequestQuery = ParsedUrlQuery | Record<string, unknown>
export type RequestBody =
  | Record<string, string>
  | Record<string, unknown>
  | Record<string, string | string[]>
  | string
  | undefined

export type AnyRequest = Request<RequestBody, RequestParams, RequestQuery>

function isUnsafePropertyKey(key: string): boolean {
  return key === '__proto__' || key === 'constructor' || key === 'prototype'
}

// ─────────────────────────────────────────────────────────────
// Request
// ─────────────────────────────────────────────────────────────

export class Request<
  TBody = RequestBody,
  TParams extends RequestParams = RequestParams,
  TQuery extends RequestQuery = RequestQuery
> extends IncomingMessage {
  /** Parsed route params e.g. /users/:id → req.params.id */
  params = {} as TParams
  /** Parsed body (requires json middleware) */
  body = undefined as TBody
  /** Uploaded files (requires multipart middleware) */
  files: Record<string, unknown> = {}
  /** Parsed cookies (requires cookies middleware) */
  cookies: Record<string, string> = {}
  /** Parsed and verified signed cookies (requires cookies middleware) */
  signedCookies: Record<string, string> = {}
  /** Custom state bag for middleware communication */
  locals: Record<string, unknown> = {}

  #parsedUrl: URL | null = null
  #path: string | null = null
  #query: TQuery | null = null
  #rawQuery: string | null = null
  #abortController = new AbortController()

  static #extractPathname(rawUrl: string): string {
    if (!rawUrl) return '/'

    let pathStart = 0

    if (rawUrl.startsWith('http://') || rawUrl.startsWith('https://')) {
      const authorityStart = rawUrl.indexOf('//')
      const firstSlash = rawUrl.indexOf('/', authorityStart + 2)

      if (firstSlash === -1) return '/'
      pathStart = firstSlash
    }

    let pathEnd = rawUrl.length
    const queryStart = rawUrl.indexOf('?', pathStart)
    if (queryStart !== -1 && queryStart < pathEnd) pathEnd = queryStart

    const hashStart = rawUrl.indexOf('#', pathStart)
    if (hashStart !== -1 && hashStart < pathEnd) pathEnd = hashStart

    const pathname = rawUrl.slice(pathStart, pathEnd)
    if (!pathname) return '/'
    return pathname.charCodeAt(0) === 47 ? pathname : `/${pathname}`
  }

  static #decodeQueryComponent(value: string): string {
    const normalized = value.includes('+') ? value.replace(/\+/g, ' ') : value

    try {
      return decodeURIComponent(normalized)
    } catch {
      return normalized
    }
  }

  static #parseQueryString(query: string): ParsedUrlQuery {
    const parsed: ParsedUrlQuery = {}
    let index = 0

    while (index < query.length) {
      let separator = query.indexOf('&', index)
      if (separator === -1) separator = query.length

      if (separator > index) {
        const entry = query.slice(index, separator)
        const equals = entry.indexOf('=')
        const rawKey = equals === -1 ? entry : entry.slice(0, equals)

        if (rawKey) {
          const key = Request.#decodeQueryComponent(rawKey)
          if (isUnsafePropertyKey(key)) {
            index = separator + 1
            continue
          }
          const value =
            equals === -1
              ? ''
              : Request.#decodeQueryComponent(entry.slice(equals + 1))
          parsed[key] = value
        }
      }

      index = separator + 1
    }

    return parsed
  }

  constructor(socket: Socket) {
    super(socket)
  }

  get parsedUrl(): URL {
    if (!this.#parsedUrl) {
      this.#parsedUrl = new URL(
        this.url || '/',
        `http://${this.headers.host || 'localhost'}`
      )
    }
    return this.#parsedUrl
  }

  get signal(): AbortSignal {
    return this.#abortController.signal
  }

  abort(reason?: unknown): void {
    if (!this.#abortController.signal.aborted) {
      this.#abortController.abort(reason)
    }
  }

  get query(): TQuery {
    if (this.#query === null) {
      this.#query = (
        this.#rawQuery ? Request.#parseQueryString(this.#rawQuery) : {}
      ) as TQuery
    }

    return this.#query
  }

  set query(value: TQuery) {
    this.#query = value
    this.#rawQuery = null
  }

  setParsedTarget(path: string | null, rawQuery: string | null): void {
    this.#path = path
    this.#query = null
    this.#rawQuery = rawQuery
  }

  resetParsedUrl(): void {
    this.#parsedUrl = null
    this.#path = null
    this.#query = null
    this.#rawQuery = null
  }

  get path(): string {
    if (this.#path === null) {
      this.#path = Request.#extractPathname(this.url || '/')
    }

    return this.#path
  }

  get ipAddress(): string {
    const locals = this.locals as unknown as { trustProxyEnabled?: boolean }
    const trustProxyEnabled = locals?.trustProxyEnabled ?? false
    if (trustProxyEnabled) {
      const forwarded = this.headers['x-forwarded-for']
      if (forwarded) {
        // Take the rightmost IP — it is appended by the trusted proxy and
        // cannot be forged by the client (who only controls leftmost values).
        return (Array.isArray(forwarded) ? forwarded[0] : forwarded)
          .split(',')
          .at(-1)!
          .trim()
      }
    }
    return this.socket?.remoteAddress || ''
  }

  get(header: string): string | string[] | undefined {
    return this.headers[header.toLowerCase()]
  }

  is(type: string): boolean {
    const contentType = this.headers['content-type'] || ''
    return contentType.includes(type)
  }
}
