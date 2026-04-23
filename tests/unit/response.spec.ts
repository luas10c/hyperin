import { describe, expect, jest, test } from '@jest/globals'
import { Socket } from 'node:net'

import { Request } from '#/request'
import { Response } from '#/response'

function createResponse() {
  const request = new Request(new Socket())
  const response = new Response(request)
  const end = jest
    .fn<(chunk?: string | Buffer) => Response>()
    .mockReturnValue(response)

  response.end = end as typeof response.end

  return { response, end }
}

describe('Response', () => {
  test('send serializes objects as json', () => {
    const { response, end } = createResponse()

    response.send({ ok: true })

    expect(response.getHeader('Content-Type')).toBe(
      'application/json; charset=utf-8'
    )
    expect(response.getHeader('Content-Length')).toBe(
      Buffer.byteLength(JSON.stringify({ ok: true }))
    )
    expect(end).toHaveBeenCalledWith(JSON.stringify({ ok: true }))
  })

  test('text calculates utf-8 content length for non-ascii payloads', () => {
    const { response } = createResponse()

    response.text('olá')

    expect(response.getHeader('Content-Type')).toBe('text/plain; charset=utf-8')
    expect(response.getHeader('Content-Length')).toBe(
      Buffer.byteLength('olá', 'utf8')
    )
  })

  test('cookie appends multiple set-cookie headers and clearCookie expires values', () => {
    const { response } = createResponse()

    response.cookie('session', 'abc')
    response.clearCookie('token', { httpOnly: true })

    expect(response.getHeader('Set-Cookie')).toEqual([
      'session=abc; Path=/',
      'token=; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly'
    ])
  })

  test('cookie normalizes sameSite casing', () => {
    const { response } = createResponse()

    response.cookie('session', 'abc', { sameSite: 'lax' })

    expect(response.getHeader('Set-Cookie')).toBe(
      'session=abc; Path=/; SameSite=Lax'
    )
  })

  test('cookie requires secure when sameSite is none', () => {
    const { response } = createResponse()

    expect(() => {
      response.cookie('session', 'abc', { sameSite: 'None' })
    }).toThrow('SameSite=None requires Secure')
  })

  test('cookie rejects invalid domain characters', () => {
    const { response } = createResponse()

    expect(() => {
      response.cookie('session', 'abc', { domain: 'example.com;evil' })
    }).toThrow('Cookie domain contains invalid characters')
  })

  test('cookie rejects invalid path values', () => {
    const { response } = createResponse()

    expect(() => {
      response.cookie('session', 'abc', { path: 'admin' })
    }).toThrow('Cookie path must start with "/"')

    expect(() => {
      response.cookie('session', 'abc', { path: '/admin\nset-cookie' })
    }).toThrow('Cookie path contains invalid characters')
  })

  test('ignores subsequent body writes after the response was sent', () => {
    const { response, end } = createResponse()

    response.send('first')
    response.json({ ok: false })

    expect(end).toHaveBeenCalledTimes(1)
    expect(end).toHaveBeenCalledWith('first')
    expect(response.getHeader('Content-Type')).toBe('text/plain; charset=utf-8')
  })
})
