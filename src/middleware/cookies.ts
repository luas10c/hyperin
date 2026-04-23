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
  const secrets =
    options.secret === undefined
      ? []
      : Array.isArray(options.secret)
        ? options.secret
        : [options.secret]

  return async ({ request, next }) => {
    const header = request.headers.cookie

    request.cookies = {}
    request.signedCookies = {}

    if (!header) {
      return void (await next())
    }

    const source = Array.isArray(header) ? header.join(';') : header
    let index = 0

    while (index < source.length) {
      let separator = source.indexOf(';', index)
      if (separator === -1) separator = source.length

      const part = source.slice(index, separator)
      const equals = part.indexOf('=')

      if (equals > 0) {
        const name = trimAscii(part.slice(0, equals))
        const rawValue = trimAscii(part.slice(equals + 1))

        if (name) {
          const decodedName = decode(name)
          if (isUnsafePropertyKey(decodedName)) {
            index = separator + 1
            continue
          }
          const decodedValue = decode(rawValue)

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
