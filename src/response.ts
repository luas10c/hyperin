import { ServerResponse } from 'node:http'

import type { Request } from './request'

// ─────────────────────────────────────────────────────────────
// Response
// ─────────────────────────────────────────────────────────────

export interface CookieOptions {
  /**
   * Cookie lifetime in seconds.
   */
  maxAge?: number

  /**
   * Absolute expiration date for the cookie.
   */
  expires?: Date

  /**
   * Domain attribute for the cookie.
   * Must be a valid hostname-like value without control characters.
   */
  domain?: string

  /**
   * Cookie path scope.
   * @default '/'
   * Must start with '/'.
   */
  path?: string

  /**
   * Sends the cookie only over HTTPS.
   */
  secure?: boolean

  /**
   * Prevents client-side JavaScript from reading the cookie.
   */
  httpOnly?: boolean

  /**
   * Controls whether the cookie is sent on cross-site requests.
   * `SameSite=None` requires `secure: true`.
   */
  sameSite?: 'Strict' | 'Lax' | 'None' | 'strict' | 'lax' | 'none'
}

type CookieTuple = [name: string, value: string, options?: CookieOptions]

type ResponseState = {
  sent: boolean
}

const RESPONSE_STATE = Symbol('hyperin.response.state')

type ResponseInternals = ServerResponse & {
  [RESPONSE_STATE]?: ResponseState
}

function appendHeaderValue(
  current: number | string | string[] | readonly string[] | undefined,
  value: string
): string | readonly string[] {
  if (current === undefined) return value
  if (Array.isArray(current)) return [...current, value]
  return [String(current), value]
}

function isCookieDomain(value: string): boolean {
  return /^\.?[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*$/.test(value)
}

function hasInvalidCookieChars(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i)
    if (code <= 0x1f || code === 0x7f || value[i] === ';') {
      return true
    }
  }

  return false
}

function byteLength(value: string): number {
  if (value.length > 256) return Buffer.byteLength(value, 'utf8')
  for (let i = 0; i < value.length; i++) {
    if (value.charCodeAt(i) > 127) return Buffer.byteLength(value, 'utf8')
  }
  return value.length
}

function endWithStringBody(
  response: Response,
  contentType: string,
  value: string
): Response {
  response.setHeader('Content-Type', contentType)
  response.setHeader('Content-Length', byteLength(value))
  response.end(value)
  markResponseSent(response)
  return response
}

function endWithBufferBody(
  response: Response,
  contentType: string,
  value: Buffer
): Response {
  response.setHeader('Content-Type', contentType)
  response.setHeader('Content-Length', value.length)
  response.end(value)
  markResponseSent(response)
  return response
}

function normalizeSameSite(
  value: CookieOptions['sameSite']
): 'Strict' | 'Lax' | 'None' | undefined {
  if (!value) return undefined

  const normalized = value.toLowerCase()
  if (normalized === 'strict') return 'Strict'
  if (normalized === 'lax') return 'Lax'
  if (normalized === 'none') return 'None'

  throw new TypeError(`Invalid cookie sameSite value: ${String(value)}`)
}

function validateCookieOptions(options: CookieOptions): {
  path: string
  sameSite: 'Strict' | 'Lax' | 'None' | undefined
} {
  const path = options.path ?? '/'
  if (!path.startsWith('/')) {
    throw new TypeError('Cookie path must start with "/"')
  }
  if (hasInvalidCookieChars(path)) {
    throw new TypeError('Cookie path contains invalid characters')
  }

  if (options.domain !== undefined) {
    if (
      hasInvalidCookieChars(options.domain) ||
      !isCookieDomain(options.domain)
    ) {
      throw new TypeError('Cookie domain contains invalid characters')
    }
  }

  const sameSite = normalizeSameSite(options.sameSite)
  if (sameSite === 'None' && options.secure !== true) {
    throw new TypeError('SameSite=None requires Secure')
  }

  return { path, sameSite }
}

export class Response extends ServerResponse<Request> {
  constructor(request: Request) {
    super(request)
    initializeResponse(this)
  }

  get sent(): boolean {
    return getResponseState(this).sent || this.writableEnded
  }

  get contentLength(): number {
    const value = this.getHeader('Content-Length')
    if (typeof value === 'number') return value
    if (typeof value === 'string') return parseInt(value, 10)
    return 0
  }

  json<T extends object>(obj: T): this {
    if (this.sent) return this
    return endWithStringBody(
      this,
      'application/json; charset=utf-8',
      JSON.stringify(obj)
    ) as this
  }

  text(value: string): this {
    if (this.sent) return this
    return endWithStringBody(this, 'text/plain; charset=utf-8', value) as this
  }

  html(value: string): this {
    if (this.sent) return this
    return endWithStringBody(this, 'text/html; charset=utf-8', value) as this
  }

  send(body?: string | object | Buffer): this {
    if (this.sent) return this

    if (body === undefined || body === null) {
      this.end()
      markResponseSent(this)
      return this
    }

    if (Buffer.isBuffer(body)) {
      return endWithBufferBody(this, 'application/octet-stream', body) as this
    }

    if (typeof body === 'object') {
      return this.json(body)
    }

    return this.text(body)
  }

  redirect(url: string, statusCode = 302): this {
    this.setHeader('Location', url)
    this.statusCode = statusCode
    this.end()
    markResponseSent(this)
    return this
  }

  header(key: string, value: number | string | readonly string[]): this {
    this.setHeader(key, value)
    return this
  }

  status(statusCode: number): this {
    this.statusCode = statusCode
    return this
  }

  type(contentType: string): this {
    this.setHeader('Content-Type', contentType)
    return this
  }

  cookie(name: string, value: string, options?: CookieOptions): this
  cookie(input: CookieTuple): this
  cookie(
    nameOrInput: string | CookieTuple,
    value?: string,
    options: CookieOptions = {}
  ): this {
    const [name, resolvedValue, resolvedOptions] = Array.isArray(nameOrInput)
      ? [nameOrInput[0], nameOrInput[1], nameOrInput[2] ?? {}]
      : [nameOrInput, value ?? '', options]
    const { path, sameSite } = validateCookieOptions(resolvedOptions)

    let cookie = `${encodeURIComponent(name)}=${encodeURIComponent(resolvedValue)}`
    cookie += `; Path=${path}`

    if (resolvedOptions.maxAge !== undefined) {
      cookie += `; Max-Age=${resolvedOptions.maxAge}`
    }
    if (resolvedOptions.expires) {
      cookie += `; Expires=${resolvedOptions.expires.toUTCString()}`
    }
    if (resolvedOptions.domain) cookie += `; Domain=${resolvedOptions.domain}`
    if (resolvedOptions.secure) cookie += '; Secure'
    if (resolvedOptions.httpOnly) cookie += '; HttpOnly'
    if (sameSite) {
      cookie += `; SameSite=${sameSite}`
    }

    this.setHeader(
      'Set-Cookie',
      appendHeaderValue(this.getHeader('Set-Cookie'), cookie)
    )
    return this
  }

  clearCookie(name: string, options: Omit<CookieOptions, 'maxAge'> = {}): this {
    return this.cookie(name, '', {
      ...options,
      expires: new Date(0),
      maxAge: 0
    })
  }
}

function ensureResponseState(response: ResponseInternals): ResponseState {
  if (response[RESPONSE_STATE]) return response[RESPONSE_STATE]

  const state: ResponseState = { sent: false }
  Object.defineProperty(response, RESPONSE_STATE, {
    value: state,
    configurable: false,
    enumerable: false,
    writable: false
  })

  return state
}

function initializeResponse(response: ServerResponse): void {
  ensureResponseState(response as ResponseInternals)
}

function getResponseState(response: ServerResponse): ResponseState {
  return ensureResponseState(response as ResponseInternals)
}

function markResponseSent(response: ServerResponse): void {
  getResponseState(response).sent = true
}

export function enhanceResponse(rawResponse: ServerResponse): Response {
  if (Object.getPrototypeOf(rawResponse) !== Response.prototype) {
    Object.setPrototypeOf(rawResponse, Response.prototype)
  }

  initializeResponse(rawResponse)
  return rawResponse as Response
}
