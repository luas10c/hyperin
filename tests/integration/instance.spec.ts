import { afterEach, describe, expect, jest, test } from '@jest/globals'
import {
  Agent,
  IncomingMessage,
  ServerResponse,
  request as sendHttpRequest
} from 'node:http'
import type { Socket } from 'node:net'
import { Duplex } from 'node:stream'
import request, { type Response } from 'supertest'

import hyperin, { hyperin as createInstance } from '#/instance'
import { json } from '#/middleware'

type ErrorResponse = {
  statusCode?: number
  message?: string
  error?: string
}

function emailSchema() {
  return {
    '~standard': {
      validate(value: unknown) {
        return typeof value === 'string' && value.includes('@')
          ? { value }
          : { issues: [{ message: 'Expected valid email' }] }
      }
    }
  }
}

describe('Instance integration', () => {
  afterEach(() => {
    jest.restoreAllMocks()
  })

  test('returns string handler output as text with x-powered-by header enabled', async () => {
    const app = hyperin()
    app.get('/hello', () => 'ok')

    app.enable('x-powered-by')

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

  test('supports app.fetch for Web Request handlers', async () => {
    const app = createInstance()

    app.get('/hello', ({ request, response }) => {
      return response.status(201).json({
        runtime: request.get('x-runtime'),
        host: request.get('host')
      })
    })

    const response = await app.fetch(
      new Request('https://example.com/hello', {
        headers: { 'x-runtime': 'fetch' }
      })
    )

    expect(response.status).toBe(201)
    await expect(response.json()).resolves.toEqual({
      runtime: 'fetch',
      host: 'example.com'
    })
  })

  test('supports app.fetch with json body parsing', async () => {
    const app = createInstance()

    app.use(json())
    app.post('/users', ({ request }) => request.body as Record<string, unknown>)

    const response = await app.fetch(
      new Request('https://example.com/users', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Ada' })
      })
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ name: 'Ada' })
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

  test('validates route params declared as a schema field map', async () => {
    const app = createInstance()

    app.get('/:email', ({ request }) => ({ email: request.params.email }), {
      params: { email: emailSchema() }
    })

    const validResponse = await request(app).get('/john@example.com')
    const invalidResponse = await request(app).get('/invalid-email')

    expect(validResponse.status).toBe(200)
    expect(validResponse.body).toEqual({ email: 'john@example.com' })
    expect(invalidResponse.status).toBe(422)
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

  test('handler initializes request and response helpers on plain node:http objects', async () => {
    const app = createInstance()
    const socket = new Duplex({
      read() {},
      write(_chunk, _encoding, callback) {
        callback()
      }
    })
    const rawRequest = new IncomingMessage(socket as unknown as Socket)
    const rawResponse = new ServerResponse(rawRequest)

    rawRequest.url = '/health'
    rawRequest.method = 'GET'
    rawRequest.headers = { host: 'localhost' }
    delete (rawRequest as unknown as { locals?: unknown }).locals
    delete (rawRequest as unknown as { params?: unknown }).params
    delete (rawRequest as unknown as { files?: unknown }).files
    delete (rawRequest as unknown as { cookies?: unknown }).cookies
    delete (rawRequest as unknown as { signedCookies?: unknown }).signedCookies

    app.get('/health', ({ request }) => ({
      locals: request.locals,
      params: request.params,
      files: request.files,
      cookies: request.cookies,
      signedCookies: request.signedCookies
    }))

    const end = jest
      .fn<(chunk?: string | Buffer) => ServerResponse>()
      .mockReturnValue(rawResponse)
    rawResponse.end = end as typeof rawResponse.end

    await expect(app.handler(rawRequest, rawResponse)).resolves.toBeUndefined()

    const payload = JSON.parse(end.mock.calls[0][0] as string) as Record<
      string,
      unknown
    >

    expect(payload).toMatchObject({
      params: {},
      files: {},
      cookies: {},
      signedCookies: {}
    })
    expect(payload.locals).toEqual(expect.any(Object))
    expect(rawResponse.getHeader('Content-Type')).toBe(
      'application/json; charset=utf-8'
    )
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

  test('ignores forwarded ip when trust proxy function rejects peer', async () => {
    const app = createInstance()

    app.set('trust proxy', ({ remoteAddress }) => remoteAddress === '10.0.0.1')
    app.get('/ip', ({ request }) => ({ ip: request.ipAddress }))

    const response: Response = await request(app)
      .get('/ip')
      .set('X-Forwarded-For', '198.51.100.1')

    expect(response.status).toBe(200)
    expect(response.body).toEqual({ ip: '127.0.0.1' })
  })

  test('supports async trust proxy functions through app.set', async () => {
    const app = createInstance()
    let calls = 0

    app.set('trust proxy', async ({ remoteAddress }) => {
      calls++
      await new Promise((resolve) => setTimeout(resolve, 1))
      return remoteAddress === '127.0.0.1' || remoteAddress === '::1'
    })
    app.get('/ip', ({ request }) => ({ ip: request.ipAddress }))

    const response: Response = await request(app)
      .get('/ip')
      .set('X-Forwarded-For', '198.51.100.1')

    expect(response.status).toBe(200)
    expect(response.body).toEqual({ ip: '198.51.100.1' })
    expect(calls).toBe(1)
  })

  test('ignores forwarded ip when async trust proxy function rejects peer', async () => {
    const app = createInstance()

    app.set('trust proxy', async () => false)
    app.get('/ip', ({ request }) => ({ ip: request.ipAddress }))

    const response: Response = await request(app)
      .get('/ip')
      .set('X-Forwarded-For', '198.51.100.1')

    expect(response.status).toBe(200)
    expect(response.body).toEqual({ ip: '127.0.0.1' })
  })

  test('disable trust proxy ignores forwarded headers after enable', async () => {
    const app = createInstance()

    app.enable('trust proxy')
    app.disable('trust proxy')
    app.get('/ip', ({ request }) => ({ ip: request.ipAddress }))

    const response: Response = await request(app)
      .get('/ip')
      .set('X-Forwarded-For', '198.51.100.1')

    expect(response.status).toBe(200)
    expect(response.body).toEqual({ ip: '127.0.0.1' })
  })

  test('rejects invalid trust proxy values through app.set', () => {
    const app = createInstance()

    expect(() => app.set('trust proxy', -1)).toThrow(
      'trust proxy hop count must be a non-negative integer'
    )
    expect(() => app.set('trust proxy', 1.5)).toThrow(
      'trust proxy hop count must be a non-negative integer'
    )
    expect(() =>
      app.set('trust proxy', '127.0.0.1' as unknown as never)
    ).toThrow('Invalid value for trust proxy')
  })

  test('shutdown closes the public server instance', async () => {
    const app = createInstance()

    app.get('/health', () => ({ ok: true }))

    const server = app.listen(0)

    await app.shutdown()

    expect(server.listening).toBe(false)
  })

  test('shutdown runs onShutdown when requests are drained', async () => {
    const app = createInstance()
    const onShutdown = jest.fn<() => void>()

    app.get('/health', () => ({ ok: true }))
    app.listen(0)

    await app.shutdown({ onShutdown })

    expect(onShutdown).toHaveBeenCalledTimes(1)
  })

  test('shutdown waits for in-flight requests before resolving', async () => {
    const app = createInstance()
    const onShutdown = jest.fn<() => void>()
    let releaseRequest!: () => void
    const requestReleased = new Promise<void>((resolve) => {
      releaseRequest = resolve
    })
    let requestStarted!: () => void
    const requestStartedPromise = new Promise<void>((resolve) => {
      requestStarted = resolve
    })

    app.get('/slow', async () => {
      requestStarted()
      await requestReleased
      return { ok: true }
    })

    const server = app.listen(0)
    const address = server.address()
    const port = typeof address === 'object' && address ? address.port : 0

    const responsePromise = new Promise<{ status: number; body: string }>(
      (resolve, reject) => {
        const req = sendHttpRequest(
          {
            method: 'GET',
            port,
            path: '/slow',
            headers: { Connection: 'close' },
            agent: false
          },
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

    try {
      await requestStartedPromise

      let shutdownResolved = false
      const shutdownPromise = app
        .shutdown({
          timeout: 1_000,
          onShutdown
        })
        .then(() => {
          shutdownResolved = true
        })

      await Promise.resolve()
      expect(shutdownResolved).toBe(false)

      releaseRequest()
      const response = await responsePromise
      await shutdownPromise

      expect(response.status).toBe(200)
      expect(JSON.parse(response.body)).toEqual({ ok: true })
      expect(onShutdown).toHaveBeenCalledTimes(1)
      expect(shutdownResolved).toBe(true)
    } finally {
      if (server.listening) await app.shutdown()
    }
  })

  test('shutdown runs onTimeout when in-flight requests do not drain', async () => {
    const app = createInstance()
    const onShutdown = jest.fn<() => void>()
    const onTimeout = jest.fn<() => void>()
    let releaseRequest!: () => void
    const requestReleased = new Promise<void>((resolve) => {
      releaseRequest = resolve
    })
    let requestStarted!: () => void
    const requestStartedPromise = new Promise<void>((resolve) => {
      requestStarted = resolve
    })

    app.get('/hang', async () => {
      requestStarted()
      await requestReleased
    })

    const server = app.listen(0)
    const address = server.address()
    const port = typeof address === 'object' && address ? address.port : 0
    const responsePromise = new Promise<void>((resolve) => {
      const req = sendHttpRequest(
        { method: 'GET', port, path: '/hang' },
        (res) => {
          res.resume()
          res.on('end', resolve)
        }
      )
      req.on('error', () => resolve())
      req.end()
    })

    try {
      await requestStartedPromise
      await app.shutdown({ timeout: 1, onShutdown, onTimeout })
      releaseRequest()
      await responsePromise
    } finally {
      releaseRequest()
      if (server.listening) await app.shutdown()
    }

    expect(onTimeout).toHaveBeenCalledTimes(1)
    expect(onShutdown).not.toHaveBeenCalled()
  })

  test('rejects keep-alive requests that arrive after shutdown starts', async () => {
    const app = createInstance()
    const agent = new Agent({ keepAlive: true, maxSockets: 1 })
    let releaseFirstRequest!: () => void
    const firstRequestReleased = new Promise<void>((resolve) => {
      releaseFirstRequest = resolve
    })
    let firstRequestStarted!: () => void
    const firstRequestStartedPromise = new Promise<void>((resolve) => {
      firstRequestStarted = resolve
    })

    app.get('/slow', async () => {
      firstRequestStarted()
      await firstRequestReleased
      return { ok: true }
    })
    app.get('/next', () => ({ ok: true }))

    const server = app.listen(0)
    const address = server.address()
    const port = typeof address === 'object' && address ? address.port : 0

    try {
      const firstResponsePromise = new Promise<number>((resolve, reject) => {
        const req = sendHttpRequest(
          { agent, method: 'GET', port, path: '/slow' },
          (res) => {
            res.resume()
            res.on('end', () => resolve(res.statusCode ?? 0))
          }
        )
        req.on('error', reject)
        req.end()
      })

      await firstRequestStartedPromise
      const shutdownPromise = app.shutdown({ timeout: 1_000 })

      const secondResponsePromise = new Promise<number>((resolve, reject) => {
        const req = sendHttpRequest(
          { agent, method: 'GET', port, path: '/next' },
          (res) => {
            res.resume()
            res.on('end', () => resolve(res.statusCode ?? 0))
          }
        )
        req.on('error', reject)
        req.end()
      })

      releaseFirstRequest()

      await expect(firstResponsePromise).resolves.toBe(200)
      await expect(secondResponsePromise).resolves.toBe(503)
      await shutdownPromise
    } finally {
      agent.destroy()
      if (server.listening) await app.shutdown()
    }
  })

  test('graceful registers signal handlers and runs configured callbacks', async () => {
    const app = createInstance()
    const handlers = new Map<string | symbol, (...args: unknown[]) => void>()
    const onShutdown = jest.fn<() => void>()
    const onGracefulExit = jest.fn<(ctx: { code: number }) => void>()

    jest.spyOn(process, 'once').mockImplementation((event, listener) => {
      handlers.set(event, listener as (...args: unknown[]) => void)
      return process
    })

    const result = app.graceful({
      autoExit: false,
      exitCode: 7,
      signals: ['SIGUSR2'],
      onShutdown,
      onGracefulExit
    })

    expect(result).toBe(app)
    expect(process.once).toHaveBeenCalledWith('SIGUSR2', expect.any(Function))

    handlers.get('SIGUSR2')?.()
    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(onShutdown).toHaveBeenCalledTimes(1)
    expect(onGracefulExit).toHaveBeenCalledWith({ code: 7 })
  })

  test('gracefulExit runs shutdown and graceful exit hooks without exiting when autoExit is false', async () => {
    const app = createInstance()
    const exitSpy = jest.spyOn(process, 'exit')
    const onShutdown = jest.fn<() => void>()
    const onGracefulExit = jest.fn<(ctx: { code: number }) => void>()

    await app.gracefulExit(2, {
      autoExit: false,
      onShutdown,
      onGracefulExit
    })

    expect(onShutdown).toHaveBeenCalledTimes(1)
    expect(onGracefulExit).toHaveBeenCalledWith({ code: 2 })
    expect(exitSpy).not.toHaveBeenCalled()
  })

  test('gracefulExit exits with the provided code when autoExit is true', async () => {
    const app = createInstance()
    const exitSpy = jest
      .spyOn(process, 'exit')
      .mockImplementation((() => undefined) as never)

    await app.gracefulExit(3, { autoExit: true })

    expect(exitSpy).toHaveBeenCalledWith(3)
  })

  test('gracefulExit propagates onGracefulExit errors when autoExit is false', async () => {
    const app = createInstance()

    await expect(
      app.gracefulExit(0, {
        autoExit: false,
        onGracefulExit() {
          throw new Error('graceful exit failed')
        }
      })
    ).rejects.toThrow('graceful exit failed')
  })

  test('gracefulExit propagates shutdown errors when autoExit is false', async () => {
    const app = createInstance()

    await expect(
      app.gracefulExit(0, {
        autoExit: false,
        onShutdown() {
          throw new Error('shutdown failed')
        }
      })
    ).rejects.toThrow('shutdown failed')
  })

  test('gracefulExit rejects when onGracefulExit exceeds the timeout and autoExit is false', async () => {
    const app = createInstance()

    await expect(
      app.gracefulExit(0, {
        autoExit: false,
        timeout: 1,
        onGracefulExit: () => new Promise(() => undefined)
      })
    ).rejects.toThrow('Graceful exit timed out')
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
      message: 'Internal Server Error'
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
      message: 'Internal Server Error'
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
      message: 'Internal Server Error'
    })
    expect(messageReads).toBe(0)
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
      message: 'Internal Server Error'
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
    let requestAborted!: () => void
    const requestAbortedPromise = new Promise<void>((resolve) => {
      requestAborted = resolve
    })

    app.post('/stream', async ({ request }) => {
      await new Promise<void>((resolve) => {
        request.signal.addEventListener(
          'abort',
          () => {
            aborted = true
            requestAborted()
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

      await requestAbortedPromise

      expect(aborted).toBe(true)

      const health = await request(app).get('/health')
      expect(health.status).toBe(200)
      expect(health.body).toEqual({ ok: true })
    } finally {
      await app.shutdown()
    }
  })
})
