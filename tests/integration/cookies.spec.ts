import { describe, expect, test } from '@jest/globals'
import { createHmac } from 'node:crypto'
import request, { type Response } from 'supertest'

import hyperin from '#/instance'
import { cookies } from '#/middleware/cookies'

function signCookie(value: string, secret: string): string {
  const signature = createHmac('sha256', secret)
    .update(value)
    .digest('base64')
    .replace(/=+$/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')

  return `s:${value}.${signature}`
}

describe('cookies middleware', () => {
  test('parses simple cookies from the request', async () => {
    const app = hyperin()

    app.use(cookies())
    app.get('/me', ({ request }) => request.cookies)

    const response: Response = await request(app)
      .get('/me')
      .set('Cookie', ['theme=dark', 'session=abc%20123'])

    expect(response.status).toBe(200)
    expect(response.body).toEqual({ theme: 'dark', session: 'abc 123' })
  })

  test('accumulates multiple Set-Cookie headers in the response', async () => {
    const app = hyperin()

    app.use(cookies())
    app.get('/set', ({ response }) => {
      response.cookie('a', '1', { httpOnly: true })
      response.cookie('b', '2', { sameSite: 'Lax' })
      response.send('ok')
    })

    const response: Response = await request(app).get('/set')

    expect(response.status).toBe(200)
    expect(response.headers['set-cookie']).toEqual([
      'a=1; Path=/; HttpOnly',
      'b=2; Path=/; SameSite=Lax'
    ])
  })

  test('accepts tuple-based signature when writing a cookie', async () => {
    const app = hyperin()

    app.get('/tuple', ({ response }) => {
      response.cookie(['aaa', 'aaa', { httpOnly: true }])
      response.send('ok')
    })

    const response: Response = await request(app).get('/tuple')

    expect(response.status).toBe(200)
    expect(response.headers['set-cookie']).toEqual([
      'aaa=aaa; Path=/; HttpOnly'
    ])
  })

  test('ignores unsafe cookie keys', async () => {
    const app = hyperin()

    app.use(cookies())
    app.get('/me', ({ request }) => request.cookies)

    const response: Response = await request(app)
      .get('/me')
      .set('Cookie', ['theme=dark', '__proto__=polluted', 'constructor=x'])

    expect(response.status).toBe(200)
    expect(response.body).toEqual({ theme: 'dark' })
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })

  test('moves valid signed cookies to request.signedCookies', async () => {
    const app = hyperin()
    const secret = 'shhh'

    app.use(cookies({ secret }))
    app.get('/me', ({ request }) => ({
      cookies: request.cookies,
      signedCookies: request.signedCookies
    }))

    const response: Response = await request(app)
      .get('/me')
      .set('Cookie', `session=${signCookie('abc123', secret)}`)

    expect(response.status).toBe(200)
    expect(response.body).toEqual({
      cookies: {},
      signedCookies: { session: 'abc123' }
    })
  })

  test('supports custom decode function', async () => {
    const app = hyperin()

    app.use(cookies({ decode: (value) => value.replaceAll('-', ' ') }))
    app.get('/me', ({ request }) => request.cookies)

    const response: Response = await request(app)
      .get('/me')
      .set('Cookie', ['theme=dark-mode', 'session=abc-123'])

    expect(response.status).toBe(200)
    expect(response.body).toEqual({ theme: 'dark mode', session: 'abc 123' })
  })
})
