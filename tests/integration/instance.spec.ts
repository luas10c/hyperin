import { describe, expect, test } from '@jest/globals'
import request, { type Response } from 'supertest'

import hyperin, { hyperin as createInstance } from '#/instance'

type ErrorResponse = {
  error: string
}

describe('Instance integration', () => {
  test('returns text when handler returns string', async () => {
    const app = hyperin()
    app.get('/hello', () => 'ok')

    const response: Response = await request(app).get('/hello')

    expect(response.status).toBe(200)
    expect(response.text).toBe('ok')
    expect(response.headers['x-powered-by']).toBe('Hyperin')
  })

  test('allows disabling the X-Powered-By header', async () => {
    const app = hyperin()

    app.disable('x-powered-by')
    app.get('/hello', () => 'ok')

    const response: Response = await request(app).get('/hello')

    expect(response.status).toBe(200)
    expect(response.headers['x-powered-by']).toBeUndefined()
  })

  test('executes global middlewares before the route', async () => {
    const app = createInstance()
    const calls: string[] = []

    app.use(async ({ next }) => {
      calls.push('mw1-before')
      await next()
      calls.push('mw1-after')
    })

    app.get(
      '/test',
      async ({ next }) => {
        calls.push('route-before')
        await next()
        calls.push('route-after')
      },
      () => {
        calls.push('route-final')
        return { ok: true }
      }
    )

    const response: Response = await request(app).get('/test')

    expect(response.status).toBe(200)
    expect(response.body).toEqual({ ok: true })
    expect(calls).toEqual([
      'mw1-before',
      'route-before',
      'route-final',
      'route-after',
      'mw1-after'
    ])
  })

  test('mount registers sub-app at prefix', async () => {
    const app = createInstance()
    const sub = createInstance()

    sub.get('/health', () => ({ status: 'ok' }))
    app.mount('/api', sub)

    const response: Response = await request(app).get('/api/health')

    expect(response.status).toBe(200)
    expect(response.body).toEqual({ status: 'ok' })
  })

  test('error middleware intercepts exceptions', async () => {
    const app = createInstance()

    app.use(async ({ error, response }) => {
      response.status(418).json({ error: error.message })
    })

    app.get('/boom', () => {
      throw new Error('kaboom')
    })

    const response: Response = await request(app).get('/boom')

    expect(response.status).toBe(418)
    expect(response.body as ErrorResponse).toEqual({ error: 'kaboom' })
  })

  test('returns 404 when route does not exist', async () => {
    const app = createInstance()

    const response: Response = await request(app).get('/missing')
    const body = response.body as ErrorResponse

    expect(response.status).toBe(404)
    expect(body.error).toBe('Not Found')
  })
})
