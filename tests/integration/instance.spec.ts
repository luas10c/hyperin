import { describe, expect, test } from '@jest/globals'
import request, { type Response } from 'supertest'

import hyperin, { hyperin as createInstance } from '#/instance'

type ErrorResponse = {
  statusCode?: number
  message?: string
  error?: string
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

  test('preserves request.url in scoped middleware', async () => {
    const app = createInstance()

    app.use('/welcome', ({ request, response }) => {
      response.json({
        url: request.url,
        path: request.path,
        query: request.query
      })
    })

    const response: Response = await request(app).get('/welcome/admin?foo=bar')

    expect(response.status).toBe(200)
    expect(response.body).toEqual({
      url: '/welcome/admin?foo=bar',
      path: '/admin',
      query: { foo: 'bar' }
    })
  })

  test('exposes forwarded ip only when trust proxy is enabled in app flow', async () => {
    const app = createInstance()

    app.get('/ip', ({ request }) => ({ ip: request.ipAddress }))

    const direct: Response = await request(app)
      .get('/ip')
      .set('X-Forwarded-For', '198.51.100.1, 203.0.113.8')
    expect(direct.status).toBe(200)
    expect(direct.body).toEqual({ ip: '::ffff:127.0.0.1' })

    app.enable('trust proxy')

    const proxied: Response = await request(app)
      .get('/ip')
      .set('X-Forwarded-For', '198.51.100.1, 203.0.113.8')

    expect(proxied.status).toBe(200)
    expect(proxied.body).toEqual({ ip: '198.51.100.1' })
  })

  test('shutdown closes the public server instance', async () => {
    const app = createInstance()

    app.get('/health', () => ({ ok: true }))

    const server = app.listen(0)

    await app.shutdown()

    expect(server.listening).toBe(false)
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

  test('error middleware can delegate back to framework with next(error)', async () => {
    const app = createInstance()

    app.use(async ({ error, next }) => {
      await new Promise((resolve) => setTimeout(resolve, 1))
      await next(error)
    })

    app.get('/boom', () => {
      throw new Error('kaboom')
    })

    const response: Response = await request(app).get('/boom')

    expect(response.status).toBe(500)
    expect(response.body as ErrorResponse).toEqual({
      statusCode: 500,
      message: 'kaboom'
    })
  })

  test('falls back to 500 when error middleware does not send a response', async () => {
    const app = createInstance()

    app.use(async ({ next }) => {
      await next()
    })

    app.get('/boom', () => {
      throw new Error('kaboom')
    })

    const response: Response = await request(app).get('/boom')

    expect(response.status).toBe(500)
    expect(response.body as ErrorResponse).toEqual({
      statusCode: 500,
      message: 'kaboom'
    })
  })

  test('runs the default error fallback only once after delegated error middleware', async () => {
    const app = createInstance()
    let messageReads = 0

    app.use(async ({ error, next }) => {
      await next(error)
    })

    app.get('/boom', () => {
      throw {
        statusCode: 500,
        get message() {
          messageReads++
          return 'kaboom'
        }
      }
    })

    const response: Response = await request(app).get('/boom')

    expect(response.status).toBe(500)
    expect(response.body as ErrorResponse).toEqual({
      statusCode: 500,
      message: 'kaboom'
    })
    expect(messageReads).toBe(1)
  })

  test('normal middleware can forward errors with next(error)', async () => {
    const app = createInstance()

    app.use(async ({ next }) => {
      await next(new Error('blocked'))
    })

    app.get('/hello', () => 'ok')

    const response: Response = await request(app).get('/hello')

    expect(response.status).toBe(500)
    expect(response.body as ErrorResponse).toEqual({
      statusCode: 500,
      message: 'blocked'
    })
  })

  test('returns 404 when route does not exist', async () => {
    const app = createInstance()

    const response: Response = await request(app).get('/missing')
    const body = response.body as ErrorResponse

    expect(response.status).toBe(404)
    expect(body).toEqual({ statusCode: 404, message: 'Not Found' })
  })
})
