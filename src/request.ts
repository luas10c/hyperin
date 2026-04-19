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
  /** Parsed query string */
  query = {} as TQuery
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

  resetParsedUrl(): void {
    this.#parsedUrl = null
    this.#path = null
  }

  get path(): string {
    if (this.#path === null) {
      this.#path = Request.#extractPathname(this.url || '/')
    }

    return this.#path
  }

  get ipAddress(): string {
    const forwarded = this.headers['x-forwarded-for']
    if (forwarded) {
      return (Array.isArray(forwarded) ? forwarded[0] : forwarded)
        .split(',')[0]
        .trim()
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
