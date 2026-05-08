import { IncomingMessage } from 'node:http'
import type { Socket } from 'node:net'
import type { ParsedUrlQuery } from 'node:querystring'

import { normalizeIp } from '#/utils/trust-proxy'

export type RequestParams = Record<string, unknown>
export type RequestQuery = ParsedUrlQuery | Record<string, unknown>
export type RequestFiles = Record<string, unknown>
export type RequestBody =
  | Record<string, string>
  | Record<string, unknown>
  | Record<string, string | string[]>
  | string
  | undefined

export interface RequestQueryLimits {
  maxLength?: number
  maxParameters?: number
}

type RequestState = {
  parsedUrl: URL | null
  path: string | null
  query: RequestQuery | null
  rawQuery: string | null
  targetOverridden: boolean
  abortController: AbortController
}

const REQUEST_STATE = Symbol('hyperin.request.state')

type RequestInternals = IncomingMessage & {
  [REQUEST_STATE]?: RequestState
}

const MAX_QUERY_LENGTH = 8 * 1024
const MAX_QUERY_PARAMETERS = 1000

function isUnsafePropertyKey(key: string): boolean {
  return key === '__proto__' || key === 'constructor' || key === 'prototype'
}

// ─────────────────────────────────────────────────────────────
// Request
// ─────────────────────────────────────────────────────────────

export class Request<
  TBody = RequestBody,
  TParams extends RequestParams = RequestParams,
  TQuery extends RequestQuery = RequestQuery,
  TFiles extends RequestFiles = RequestFiles
> extends IncomingMessage {
  /** Parsed route params e.g. /users/:id → req.params.id */
  declare params: TParams
  /** Parsed body (requires json middleware) */
  declare body: TBody
  /** Uploaded files (requires multipart middleware) */
  declare files: TFiles
  /** Parsed cookies (requires cookies middleware) */
  declare cookies: Record<string, string>
  /** Parsed and verified signed cookies (requires cookies middleware) */
  declare signedCookies: Record<string, string>
  /** Custom state bag for middleware communication */
  declare locals: Record<string, unknown>

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

  static #parseQueryString(
    query: string,
    limits: RequestQueryLimits = {}
  ): ParsedUrlQuery {
    const maxLength = limits.maxLength ?? MAX_QUERY_LENGTH
    const maxParameters = limits.maxParameters ?? MAX_QUERY_PARAMETERS

    if (query.length > maxLength) {
      throw Object.assign(new Error('Query string too large'), {
        statusCode: 414
      })
    }

    const parsed: ParsedUrlQuery = {}
    let index = 0
    let pairs = 0

    while (index < query.length) {
      let separator = query.indexOf('&', index)
      if (separator === -1) separator = query.length

      if (separator > index) {
        pairs++
        if (pairs > maxParameters) {
          throw Object.assign(new Error('Too many query parameters'), {
            statusCode: 400
          })
        }

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
          const current = parsed[key]

          if (current === undefined) {
            parsed[key] = value
          } else if (Array.isArray(current)) {
            current.push(value)
          } else {
            parsed[key] = [current, value]
          }
        }
      }

      index = separator + 1
    }

    return parsed
  }

  constructor(socket: Socket) {
    super(socket)
    initializeRequest(this)
  }

  get parsedUrl(): URL {
    const state = getRequestState(this)
    if (!state.parsedUrl) {
      state.parsedUrl = new URL(
        this.url || '/',
        `http://${this.headers.host || 'localhost'}`
      )
    }
    return state.parsedUrl
  }

  get signal(): AbortSignal {
    return getRequestState(this).abortController.signal
  }

  abort(reason?: unknown): void {
    const state = getRequestState(this)
    if (!state.abortController.signal.aborted) {
      state.abortController.abort(reason)
    }
  }

  get query(): TQuery {
    const state = getRequestState(this)
    if (state.query === null) {
      if (state.rawQuery === null && !state.targetOverridden) {
        const queryStart = (this.url || '/').indexOf('?')
        state.rawQuery =
          queryStart === -1 ? null : (this.url || '/').slice(queryStart + 1)
      }

      state.query = (
        state.rawQuery
          ? Request.#parseQueryString(state.rawQuery, {
              maxLength: (this.locals as { maxQueryLength?: number })
                .maxQueryLength,
              maxParameters: (this.locals as { maxQueryParameters?: number })
                .maxQueryParameters
            })
          : {}
      ) as TQuery
    }

    return state.query as TQuery
  }

  set query(value: TQuery) {
    const state = getRequestState(this)
    state.query = value
    state.rawQuery = null
    state.targetOverridden = true
  }

  setParsedTarget(path: string | null, rawQuery: string | null): void {
    const state = getRequestState(this)
    state.path = path
    state.query = null
    state.rawQuery = rawQuery
    state.targetOverridden = true
  }

  resetParsedUrl(): void {
    const state = getRequestState(this)
    state.parsedUrl = null
    state.path = null
    state.query = null
    state.rawQuery = null
    state.targetOverridden = false
  }

  get path(): string {
    const state = getRequestState(this)
    if (state.path === null) {
      state.path = Request.#extractPathname(this.url || '/')
    }

    return state.path
  }

  get ipAddress(): string {
    const locals = this.locals as {
      trustedClientIp?: string
    }

    return (
      locals.trustedClientIp ?? normalizeIp(this.socket?.remoteAddress) ?? ''
    )
  }

  get(header: string): string | string[] | undefined {
    return this.headers[header.toLowerCase()]
  }

  is(type: string): boolean {
    const contentType = this.headers['content-type'] || ''
    return contentType.includes(type)
  }
}

function ensureRequestState(request: RequestInternals): RequestState {
  if (request[REQUEST_STATE]) return request[REQUEST_STATE]

  const state: RequestState = {
    parsedUrl: null,
    path: null,
    query: null,
    rawQuery: null,
    targetOverridden: false,
    abortController: new AbortController()
  }

  Object.defineProperty(request, REQUEST_STATE, {
    value: state,
    configurable: false,
    enumerable: false,
    writable: false
  })

  return state
}

function initializeRequest(request: IncomingMessage): void {
  const enhancedRequest = request as Request
  ensureRequestState(request as RequestInternals)
  enhancedRequest.params ??= {} as Request['params']
  enhancedRequest.body ??= undefined as Request['body']
  enhancedRequest.files ??= {} as Request['files']
  enhancedRequest.cookies ??= {}
  enhancedRequest.signedCookies ??= {}
  enhancedRequest.locals ??= {}
}

function getRequestState(request: IncomingMessage): RequestState {
  return ensureRequestState(request as RequestInternals)
}

export function enhanceRequest(rawRequest: IncomingMessage): Request {
  if (Object.getPrototypeOf(rawRequest) !== Request.prototype) {
    Object.setPrototypeOf(rawRequest, Request.prototype)
  }

  initializeRequest(rawRequest)
  return rawRequest as Request
}
