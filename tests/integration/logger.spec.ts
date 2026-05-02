import { describe, expect, jest, test } from '@jest/globals'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import request from 'supertest'

import hyperin from '#/instance'
import { logger, type LoggerEvent } from '#/logger'

describe('logger plugin', () => {
  test('registers structured request logging on the app', async () => {
    const events: LoggerEvent[] = []
    const app = hyperin()

    const returned = logger(app, {
      levels: ['info'],
      transport: (event) => events.push(event)
    })

    app.get('/health', () => 'ok')

    const response = await request(app).get('/health')

    expect(returned).toBe(app)
    expect(response.status).toBe(200)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      level: 'info',
      method: 'GET',
      path: '/health',
      statusCode: 200
    })
  })

  test('filters structured logs by level', async () => {
    const events: LoggerEvent[] = []
    const app = hyperin()

    logger(app, {
      levels: ['warn', 'error'],
      transport: (event) => events.push(event)
    })
    app.get('/health', () => 'ok')

    await request(app).get('/health')
    await request(app).get('/missing')

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      level: 'warn',
      method: 'GET',
      path: '/missing',
      statusCode: 404
    })
  })

  test('writes structured logs to a local file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hyperin-logger-'))
    const file = join(dir, 'access.log')
    const app = hyperin()

    try {
      logger(app, { levels: ['info'], file })
      app.get('/health', () => 'ok')

      await request(app).get('/health').set('X-Request-Id', 'req-1')

      const [line] = (await readFile(file, 'utf8')).trim().split('\n')
      const event = JSON.parse(line) as LoggerEvent

      expect(event).toMatchObject({
        level: 'info',
        method: 'GET',
        path: '/health',
        statusCode: 200,
        requestId: 'req-1'
      })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('exports structured events through generic exporters', async () => {
    const exporter = jest.fn()
    const app = hyperin()

    logger(app, {
      levels: ['info'],
      exporter: { export: exporter }
    })
    app.get('/health', () => 'ok')

    await request(app).get('/health').set('User-Agent', 'hyperin-test')

    expect(exporter).toHaveBeenCalledTimes(1)
    expect(exporter.mock.calls[0]?.[0]).toMatchObject({
      level: 'info',
      message: 'GET /health 200',
      method: 'GET',
      path: '/health',
      statusCode: 200,
      userAgent: 'hyperin-test'
    })
  })

  test('emits application logs through the configured global logger', () => {
    const events: LoggerEvent[] = []
    const app = hyperin()

    logger(app, {
      levels: ['info', 'success', 'error'],
      transport: (event) => events.push(event)
    })

    logger.info('user created', { userId: '123' })
    logger.success('cache warmed')
    logger.debug('debug hidden')
    logger.error('payment failed', { orderId: 'ord-1' })

    expect(events).toEqual([
      expect.objectContaining({
        kind: 'application',
        level: 'info',
        message: 'user created',
        attributes: { userId: '123' }
      }),
      expect.objectContaining({
        kind: 'application',
        level: 'success',
        message: 'cache warmed',
        attributes: {}
      }),
      expect.objectContaining({
        kind: 'application',
        level: 'error',
        message: 'payment failed',
        attributes: { orderId: 'ord-1' }
      })
    ])
  })
})
