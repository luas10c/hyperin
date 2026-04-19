import { describe, expect, test } from '@jest/globals'
import request, { type Response } from 'supertest'

import hyperin from '#/instance'
import { security } from '#/middleware/security'

describe('security middleware', () => {
  test('aplica headers defensivos por padrão', async () => {
    const app = hyperin()

    app.use(security())
    app.get('/secure', () => 'ok')

    const response: Response = await request(app).get('/secure')

    expect(response.status).toBe(200)
    expect(response.headers['content-security-policy']).toContain(
      "default-src 'self'"
    )
    expect(response.headers['cross-origin-opener-policy']).toBe('same-origin')
    expect(response.headers['cross-origin-resource-policy']).toBe('same-origin')
    expect(response.headers['origin-agent-cluster']).toBe('?1')
    expect(response.headers['referrer-policy']).toBe('no-referrer')
    expect(response.headers['x-content-type-options']).toBe('nosniff')
    expect(response.headers['x-dns-prefetch-control']).toBe('off')
    expect(response.headers['x-frame-options']).toBe('SAMEORIGIN')
    expect(response.headers['strict-transport-security']).toBeUndefined()
  })

  test('envia HSTS quando a requisição chega por https', async () => {
    const app = hyperin()

    app.use(security())
    app.get('/secure', () => 'ok')

    const response: Response = await request(app)
      .get('/secure')
      .set('X-Forwarded-Proto', 'https')

    expect(response.status).toBe(200)
    expect(response.headers['strict-transport-security']).toBe(
      'max-age=15552000; includeSubDomains'
    )
  })
})
