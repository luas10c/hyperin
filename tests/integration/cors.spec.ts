import { describe, expect, test } from '@jest/globals'
import request, { type Response } from 'supertest'

import { cors } from '#/middleware/cors'
import { hyperin } from '#/instance'

describe('CORS middleware', () => {
  test('preflight default responds with CORS headers', async () => {
    const app = hyperin()
    app.use(cors())
    app.get('/resource', () => ({ ok: true }))

    const response: Response = await request(app)
      .options('/resource')
      .set('Origin', 'https://example.com')
      .set('Access-Control-Request-Method', 'POST')

    expect(response.status).toBe(204)
    expect(response.headers['access-control-allow-origin']).toBe('*')
    expect(response.headers['access-control-allow-methods']).toContain('POST')
  })

  test('origin: true reflects origin and sends Vary and credentials', async () => {
    const app = hyperin()
    app.use(cors({ origin: true, credentials: true }))
    app.get('/resource', ({ response }) => {
      response.send('ok')
    })

    const response: Response = await request(app)
      .get('/resource')
      .set('Origin', 'https://client.test')

    expect(response.headers['access-control-allow-origin']).toBe(
      'https://client.test'
    )
    expect(response.headers['access-control-allow-credentials']).toBe('true')
    expect(response.headers.vary).toBe('Origin')
  })

  test('static origin blocks disallowed origin on simple request', async () => {
    const app = hyperin()
    app.use(cors({ origin: 'https://allowed.test' }))
    app.get('/resource', ({ response }) => {
      response.send('ok')
    })

    const response: Response = await request(app)
      .get('/resource')
      .set('Origin', 'https://blocked.test')

    expect(response.status).toBe(200)
    expect(response.headers['access-control-allow-origin']).toBeUndefined()
  })

  test('reflects request origin when credentials are enabled with wildcard origin', async () => {
    const app = hyperin()
    app.use(cors({ credentials: true }))
    app.get('/resource', ({ response }) => {
      response.send('ok')
    })

    const response: Response = await request(app)
      .get('/resource')
      .set('Origin', 'https://client.test')

    expect(response.status).toBe(200)
    expect(response.headers['access-control-allow-origin']).toBe(
      'https://client.test'
    )
    expect(response.headers['access-control-allow-credentials']).toBe('true')
    expect(response.headers.vary).toBe('Origin')
  })

  test('reflects requested headers on preflight when allowedHeaders is omitted', async () => {
    const app = hyperin()
    app.use(cors())
    app.post('/resource', () => ({ ok: true }))

    const response: Response = await request(app)
      .options('/resource')
      .set('Origin', 'https://example.com')
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'X-Trace-Id, Authorization')

    expect(response.status).toBe(204)
    expect(response.headers['access-control-allow-headers']).toBe(
      'X-Trace-Id, Authorization'
    )
    expect(response.headers.vary).toContain('Access-Control-Request-Headers')
  })

  test('supports dynamic async origin resolver', async () => {
    const app = hyperin()
    app.use(
      cors({
        origin: async (origin) => origin === 'https://allowed.test'
      })
    )
    app.get('/resource', ({ response }) => {
      response.send('ok')
    })

    const allowed: Response = await request(app)
      .get('/resource')
      .set('Origin', 'https://allowed.test')
    const blocked: Response = await request(app)
      .get('/resource')
      .set('Origin', 'https://blocked.test')

    expect(allowed.headers['access-control-allow-origin']).toBe(
      'https://allowed.test'
    )
    expect(blocked.headers['access-control-allow-origin']).toBeUndefined()
  })
})
