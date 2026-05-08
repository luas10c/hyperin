import { createHmac, timingSafeEqual } from 'node:crypto'

import type { Middleware } from '#/types'

function isUnsafePropertyKey(key: string): boolean {
  return key === '__proto__' || key === 'constructor' || key === 'prototype'
}

export interface CookiesOptions {
  /**
   * Custom decoder applied to each cookie value before it is exposed on the request.
   * Defaults to `decodeURIComponent` with a safe fallback.
   */
  decode?: (value: string) => string

  /**
   * Secret or secret rotation list used to verify signed cookies.
   */
  secret?: string | readonly string[]

  /** Maximum accepted Cookie header size in bytes. */
  maxCookieHeaderSize?: number
  /** Maximum number of cookies parsed from a single header. */
  maxCookies?: number
  /** Maximum size for a single cookie value. */
  maxCookieSize?: number
  /**
   * Enforces a recommended minimum secret size.
   * @default true
   */
  enforceSecretLength?: boolean
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function trimAscii(value: string): string {
  let start = 0
  let end = value.length

  while (start < end && value.charCodeAt(start) <= 32) start++
  while (end > start && value.charCodeAt(end - 1) <= 32) end--

  return start === 0 && end === value.length ? value : value.slice(start, end)
}

function unsignCookie(
  value: string,
  secrets: readonly string[]
): string | false {
  if (!value.startsWith('s:')) return false

  const unsigned = value.slice(2)
  const dot = unsigned.lastIndexOf('.')
  if (dot <= 0) return false

  const payload = unsigned.slice(0, dot)
  const signature = unsigned.slice(dot + 1)

  for (const secret of secrets) {
    const expected = createHmac('sha256', secret)
      .update(payload)
      .digest('base64')
      .replace(/=+$/g, '')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')

    const actualBuffer = Buffer.from(signature)
    const expectedBuffer = Buffer.from(expected)

    if (
      actualBuffer.length === expectedBuffer.length &&
      timingSafeEqual(actualBuffer, expectedBuffer)
    ) {
      return payload
    }
  }

  return false
}

export function cookies(options: CookiesOptions = {}): Middleware {
  const decode = options.decode ?? safeDecode
  const maxCookieHeaderSize = options.maxCookieHeaderSize ?? 8 * 1024
  const maxCookies = options.maxCookies ?? 100
  const maxCookieSize = options.maxCookieSize ?? 4096
  const enforceSecretLength = options.enforceSecretLength ?? true
  const secrets =
    options.secret === undefined
      ? []
      : Array.isArray(options.secret)
        ? options.secret
        : [options.secret]

  if (
    enforceSecretLength &&
    secrets.length > 0 &&
    secrets.some((secret) => Buffer.byteLength(secret, 'utf8') < 32)
  ) {
    throw new TypeError(
      'cookies: secret must be at least 32 bytes (set enforceSecretLength=false to override)'
    )
  }

  return async ({ request, next }) => {
    const header = request.headers.cookie

    request.cookies = {}
    request.signedCookies = {}

    if (!header) {
      return void (await next())
    }

    const source = Array.isArray(header) ? header.join(';') : header
    if (Buffer.byteLength(source, 'utf8') > maxCookieHeaderSize) {
      throw Object.assign(new Error('Cookie header too large'), {
        statusCode: 400
      })
    }

    let index = 0
    let cookieCount = 0

    while (index < source.length) {
      let separator = source.indexOf(';', index)
      if (separator === -1) separator = source.length

      const part = source.slice(index, separator)
      const equals = part.indexOf('=')

      if (equals > 0) {
        cookieCount++
        if (cookieCount > maxCookies) {
          throw Object.assign(new Error('Too many cookies'), {
            statusCode: 400
          })
        }

        const name = trimAscii(part.slice(0, equals))
        const rawValue = trimAscii(part.slice(equals + 1))
        if (Buffer.byteLength(rawValue, 'utf8') > maxCookieSize) {
          index = separator + 1
          continue
        }

        if (name) {
          let decodedName: string
          let decodedValue: string
          try {
            decodedName = decode(name)
            decodedValue = decode(rawValue)
          } catch {
            index = separator + 1
            continue
          }

          if (isUnsafePropertyKey(decodedName)) {
            index = separator + 1
            continue
          }

          if (secrets.length > 0) {
            const unsigned = unsignCookie(decodedValue, secrets)
            if (unsigned !== false) {
              request.signedCookies[decodedName] = unsigned
            } else {
              request.cookies[decodedName] = decodedValue
            }
          } else {
            request.cookies[decodedName] = decodedValue
          }
        }
      }

      index = separator + 1
    }

    await next()
  }
}
