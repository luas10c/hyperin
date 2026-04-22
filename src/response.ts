import { ServerResponse } from 'node:http'

import type { Request } from './request'

// ─────────────────────────────────────────────────────────────
// Response
// ─────────────────────────────────────────────────────────────

export interface CookieOptions {
  maxAge?: number
  expires?: Date
  domain?: string
  path?: string
  secure?: boolean
  httpOnly?: boolean
  sameSite?: 'Strict' | 'Lax' | 'None' | 'strict' | 'lax' | 'none'
}

type CookieTuple = [name: string, value: string, options?: CookieOptions]

function appendHeaderValue(
  current: number | string | string[] | readonly string[] | undefined,
  value: string
): string | readonly string[] {
  if (current === undefined) return value
  if (Array.isArray(current)) return [...current, value]
  return [String(current), value]
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
    if (str.length > 256) return Buffer.byteLength(str, 'utf8')
    for (let i = 0; i < str.length; i++) {
      if (str.charCodeAt(i) > 127) return Buffer.byteLength(str, 'utf8')
    }
    return str.length
  }

  #endWithStringBody(contentType: string, value: string): this {
    this.setHeader('Content-Type', contentType)
    this.setHeader('Content-Length', this.#byteLength(value))
    this.end(value)
    this.#sent = true
    return this
  }

  #endWithBufferBody(contentType: string, value: Buffer): this {
    this.setHeader('Content-Type', contentType)
    this.setHeader('Content-Length', value.length)
    this.end(value)
    this.#sent = true
    return this
  }

  json<T extends object>(obj: T): this {
    if (this.sent) return this
    return this.#endWithStringBody(
      'application/json; charset=utf-8',
      JSON.stringify(obj)
    )
  }

  text(value: string): this {
    if (this.sent) return this
    return this.#endWithStringBody('text/plain; charset=utf-8', value)
  }

  html(value: string): this {
    if (this.sent) return this
    return this.#endWithStringBody('text/html; charset=utf-8', value)
  }

  send(body?: string | object | Buffer): this {
    if (this.sent) return this

    if (body === undefined || body === null) {
      this.end()
      this.#sent = true
      return this
    }

    if (Buffer.isBuffer(body)) {
      return this.#endWithBufferBody('application/octet-stream', body)
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

    let cookie = `${encodeURIComponent(name)}=${encodeURIComponent(resolvedValue)}`
    cookie += `; Path=${resolvedOptions.path ?? '/'}`

    if (resolvedOptions.maxAge !== undefined) {
      cookie += `; Max-Age=${resolvedOptions.maxAge}`
    }
    if (resolvedOptions.expires) {
      cookie += `; Expires=${resolvedOptions.expires.toUTCString()}`
    }
    if (resolvedOptions.domain) cookie += `; Domain=${resolvedOptions.domain}`
    if (resolvedOptions.secure) cookie += '; Secure'
    if (resolvedOptions.httpOnly) cookie += '; HttpOnly'
    if (resolvedOptions.sameSite) {
      cookie += `; SameSite=${resolvedOptions.sameSite}`
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
