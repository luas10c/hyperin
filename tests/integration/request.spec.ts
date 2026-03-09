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
  test('expõe params, query, path e get()', async () => {
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
})
