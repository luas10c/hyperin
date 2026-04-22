import { describe, expect, test } from '@jest/globals'
import request, { type Response } from 'supertest'

import { hyperin } from '#/instance'

type RequestPayload = {
  params: Record<string, string>
  query: Record<string, string>
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
})
