import { describe, expect, test } from '@jest/globals'
import { request as sendHttpRequest } from 'node:http'
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
    expect(direct.body).toEqual({ ip: '127.0.0.1' })

    app.enable('trust proxy')

    const proxied: Response = await request(app)
      .get('/ip')
      .set('X-Forwarded-For', '198.51.100.1, 203.0.113.8')

    expect(proxied.status).toBe(200)
    expect(proxied.body).toEqual({ ip: '198.51.100.1' })
  })

  test('supports trust proxy hop counts through app.set', async () => {
    const app = createInstance()

    app.set('trust proxy', 1)
    app.get('/ip', ({ request }) => ({ ip: request.ipAddress }))

    const response: Response = await request(app)
      .get('/ip')
      .set('X-Forwarded-For', '198.51.100.1, 203.0.113.8')

    expect(response.status).toBe(200)
    expect(response.body).toEqual({ ip: '203.0.113.8' })
  })

  test('supports trust proxy boolean true through app.set', async () => {
    const app = createInstance()

    app.set('trust proxy', true)
    app.get('/ip', ({ request }) => ({ ip: request.ipAddress }))

    const response: Response = await request(app)
      .get('/ip')
      .set('X-Forwarded-For', '198.51.100.1, 203.0.113.8')

    expect(response.status).toBe(200)
    expect(response.body).toEqual({ ip: '198.51.100.1' })
  })

  test('supports trust proxy allowlists through app.set', async () => {
    const app = createInstance()

    app.set('trust proxy', ['127.0.0.1', '::1'])
    app.get('/ip', ({ request }) => ({ ip: request.ipAddress }))

    const response: Response = await request(app)
      .get('/ip')
      .set('X-Forwarded-For', '198.51.100.1')

    expect(response.status).toBe(200)
    expect(response.body).toEqual({ ip: '198.51.100.1' })
  })

  test('supports trust proxy functions through app.set', async () => {
    const app = createInstance()

    app.set('trust proxy', ({ remoteAddress }) => {
      return remoteAddress === '127.0.0.1' || remoteAddress === '::1'
    })
    app.get('/ip', ({ request }) => ({ ip: request.ipAddress }))

    const response: Response = await request(app)
      .get('/ip')
      .set('X-Forwarded-For', '198.51.100.1')

    expect(response.status).toBe(200)
    expect(response.body).toEqual({ ip: '198.51.100.1' })
  })

  test('supports async trust proxy functions through app.set', async () => {
    const app = createInstance()

    app.set('trust proxy', async ({ remoteAddress }) => {
      await new Promise((resolve) => setTimeout(resolve, 1))
      return remoteAddress === '127.0.0.1' || remoteAddress === '::1'
    })
    app.get('/ip', ({ request }) => ({ ip: request.ipAddress }))

    const response: Response = await request(app)
      .get('/ip')
      .set('X-Forwarded-For', '198.51.100.1')

    expect(response.status).toBe(200)
    expect(response.body).toEqual({ ip: '198.51.100.1' })
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

  test('rejects oversized request targets before reaching the app', async () => {
    const app = createInstance()
    let handled = false

    app.get('/ok', () => {
      handled = true
      return { ok: true }
    })

    const server = app.listen(0)
    const address = server.address()
    const port = typeof address === 'object' && address ? address.port : 0

    try {
      const response = await new Promise<{ status: number; body: string }>(
        (resolve, reject) => {
          const req = sendHttpRequest(
            { method: 'GET', port, path: `/${'a'.repeat(20_000)}` },
            (res) => {
              const chunks: Buffer[] = []
              res.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
              res.on('end', () =>
                resolve({
                  status: res.statusCode ?? 0,
                  body: Buffer.concat(chunks).toString('utf8')
                })
              )
            }
          )

          req.on('error', reject)
          req.end()
        }
      )

      expect(response.status).toBe(431)
      expect(handled).toBe(false)
    } finally {
      await app.shutdown()
    }
  })

  test('rejects requests with too many headers before reaching the app', async () => {
    const app = createInstance()
    let handled = false

    app.get('/ok', () => {
      handled = true
      return { ok: true }
    })

    const server = app.listen(0)
    const address = server.address()
    const port = typeof address === 'object' && address ? address.port : 0
    const headers: Record<string, string> = {}

    for (let i = 0; i < 5000; i++) {
      headers[`x-abuse-${i}`] = 'a'
    }

    try {
      const status = await new Promise<number>((resolve, reject) => {
        const req = sendHttpRequest(
          { method: 'GET', port, path: '/ok', headers },
          (res) => {
            res.resume()
            res.on('end', () => resolve(res.statusCode ?? 0))
          }
        )

        req.on('error', reject)
        req.end()
      })

      expect(status).toBe(431)
      expect(handled).toBe(false)
    } finally {
      await app.shutdown()
    }
  })

  test('propagates client abort through request.signal and keeps the server healthy', async () => {
    const app = createInstance()
    let aborted = false

    app.post('/stream', async ({ request }) => {
      await new Promise<void>((resolve) => {
        request.signal.addEventListener(
          'abort',
          () => {
            aborted = true
            resolve()
          },
          { once: true }
        )
      })
    })
    app.get('/health', () => ({ ok: true }))

    const server = app.listen(0)
    const address = server.address()
    const port = typeof address === 'object' && address ? address.port : 0

    try {
      await new Promise<void>((resolve, reject) => {
        const req = sendHttpRequest(
          {
            method: 'POST',
            port,
            path: '/stream',
            headers: {
              'Content-Type': 'application/octet-stream',
              'Content-Length': '1024'
            }
          },
          () => {
            reject(new Error('request should have been aborted by the client'))
          }
        )

        req.on('error', () => resolve())
        req.write('partial-body')
        setTimeout(() => req.destroy(), 10)
      })

      await new Promise((resolve) => setTimeout(resolve, 30))

      expect(aborted).toBe(true)

      const health = await request(app).get('/health')
      expect(health.status).toBe(200)
      expect(health.body).toEqual({ ok: true })
    } finally {
      await app.shutdown()
    }
  })
})
