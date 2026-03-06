import { ServerResponse } from 'node:http'

import type { Request } from './request'

// ─────────────────────────────────────────────────────────────
// Response
// ─────────────────────────────────────────────────────────────

interface CookieOptions {
  maxAge?: number
  domain?: string
  path?: string
  secure?: boolean
  httpOnly?: boolean
  sameSite?: string
}

export class Response extends ServerResponse<Request> {
  #sent = false

  constructor(request: Request) {
    super(request)
  }

  get sent(): boolean {
    return this.#sent || this.writableEnded
  }

  get contentLength(): number {
    const value = this.getHeader('Content-Length')
    if (typeof value === 'number') return value
    if (typeof value === 'string') return parseInt(value, 10)
    return 0
  }

  /** Calculates byte length, avoiding Buffer.byteLength when only ASCII data is present. */
  #byteLength(str: string): number {
    // Fast path: ASCII puro — byte length === char length
    for (let i = 0; i < str.length; i++) {
      if (str.charCodeAt(i) > 127) return Buffer.byteLength(str, 'utf8')
    }
    return str.length
  }

  json<T extends object>(obj: T): this {
    if (this.sent) return this
    this.setHeader('Content-Type', 'application/json; charset=utf-8')
    const body = JSON.stringify(obj)
    this.setHeader('Content-Length', this.#byteLength(body))
    this.end(body)
    this.#sent = true
    return this
  }

  text(value: string): this {
    if (this.sent) return this
    this.setHeader('Content-Type', 'text/plain; charset=utf-8')
    this.setHeader('Content-Length', this.#byteLength(value))
    this.end(value)
    this.#sent = true
    return this
  }

  html(value: string): this {
    if (this.sent) return this
    this.setHeader('Content-Type', 'text/html; charset=utf-8')
    this.setHeader('Content-Length', this.#byteLength(value))
    this.end(value)
    this.#sent = true
    return this
  }

  send(body?: string | object | Buffer): this {
    if (this.sent) return this

    if (body === undefined || body === null) {
      this.end()
      this.#sent = true
      return this
    }

    if (Buffer.isBuffer(body)) {
      this.setHeader('Content-Type', 'application/octet-stream')
      this.setHeader('Content-Length', body.length)
      this.end(body)
      this.#sent = true
      return this
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
    this.#sent = true
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

  cookie(name: string, value: string, options: CookieOptions = {}): this {
    let cookie = `${encodeURIComponent(name)}=${encodeURIComponent(value)}`
    cookie += `; Path=${options.path ?? '/'}`

    if (options.maxAge) cookie += `; Max-Age=${options.maxAge}`
    if (options.domain) cookie += `; Domain=${options.domain}`
    if (options.secure) cookie += '; Secure'
    if (options.httpOnly) cookie += '; HttpOnly'
    if (options.sameSite) cookie += `; SameSite=${options.sameSite}`
    this.setHeader('Set-Cookie', cookie)
    return this
  }
}
