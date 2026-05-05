import { describe, expect, test } from '@jest/globals'
import request, { type Response } from 'supertest'

import { hyperin } from '#/instance'

type RequestPayload = {
  params: Record<string, string>
  query: Record<string, string | string[]>
  path: string
  contentType: string | null
}

describe('Request integration', () => {
  test('exposes params, query, path and get()', async () => {
    const app = hyperin()

    app.get('/users/:id', ({ request }) => ({
      params: request.params,
      query: request.query,
      path: request.path,
      contentType: request.get('content-type') ?? null
    }))

    const response: Response = await request(app)
      .get('/users/42?foo=bar&baz=1')
      .set('Content-Type', 'application/json')

    expect(response.status).toBe(200)
    expect(response.body as RequestPayload).toEqual({
      params: { id: '42' },
      query: { foo: 'bar', baz: '1' },
      path: '/users/42',
      contentType: 'application/json'
    })
  })

  test('ignores unsafe query keys', async () => {
    const app = hyperin()

    app.get('/users', ({ request }) => request.query)

    const response: Response = await request(app).get(
      '/users?ok=1&__proto__=polluted&constructor=x&prototype=y'
    )

    expect(response.status).toBe(200)
    expect(response.body).toEqual({ ok: '1' })
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })

  test('preserves repeated query keys as arrays', async () => {
    const app = hyperin()

    app.get('/search', ({ request }) => request.query)

    const response: Response = await request(app).get('/search?tag=a&tag=b&tag=c')

    expect(response.status).toBe(200)
    expect(response.body).toEqual({ tag: ['a', 'b', 'c'] })
  })

  test('restores original path for error middleware after scoped middleware throws', async () => {
    const app = hyperin()

    app.use('/welcome', () => {
      throw new Error('scoped failure')
    })

    app.use(({ error, request, response }) => {
      response.status(500).json({
        message: error.message,
        path: request.path,
        query: request.query,
        url: request.url
      })
    })

    const response: Response = await request(app).get('/welcome/admin?foo=bar')

    expect(response.status).toBe(500)
    expect(response.body).toEqual({
      message: 'scoped failure',
      path: '/welcome/admin',
      query: { foo: 'bar' },
      url: '/welcome/admin?foo=bar'
    })
  })
})
