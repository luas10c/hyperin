import { describe, expect, test } from '@jest/globals'
import { Socket } from 'node:net'

import { Request } from '#/request'

function createRequest(url = '/'): Request {
  const request = new Request(new Socket())
  request.url = url
  request.headers.host = 'example.com'
  return request
}

describe('Request', () => {
  test('parses path from absolute urls and keeps parsedUrl available', () => {
    const request = createRequest('https://example.com/users/42?foo=bar+baz')

    expect(request.path).toBe('/users/42')
    expect(request.parsedUrl.pathname).toBe('/users/42')
    expect(request.parsedUrl.searchParams.get('foo')).toBe('bar baz')
  })

  test('decodes query strings and ignores unsafe keys after parsed target is set', () => {
    const request = createRequest('/search?q=hello%20world&__proto__=x')

    request.setParsedTarget('/search', 'q=hello%20world&__proto__=x')

    expect(request.query).toEqual({ q: 'hello world' })
    expect(({} as Record<string, unknown>).x).toBeUndefined()
  })

  test('recomputes path and query when parsed target changes', () => {
    const request = createRequest('/users?foo=bar')

    request.setParsedTarget('/admin', 'page=2')

    expect(request.path).toBe('/admin')
    expect(request.query).toEqual({ page: '2' })

    request.setParsedTarget('/reports', null)

    expect(request.path).toBe('/reports')
    expect(request.query).toEqual({})
  })

  test('prefers the trusted client ip cached during dispatch', () => {
    const request = createRequest('/health')

    Object.defineProperty(request.socket, 'remoteAddress', {
      value: '10.0.0.1',
      configurable: true
    })

    expect(request.ipAddress).toBe('10.0.0.1')

    request.locals.trustedClientIp = '198.51.100.1'

    expect(request.ipAddress).toBe('198.51.100.1')
  })
})
