import { describe, expect, test } from '@jest/globals'
import request, { type Response } from 'supertest'

import hyperin from '#/instance'
import type { Request } from '#/request'
import {
  MemoryRateLimitStore,
  throttler,
  type RateLimitStore
} from '#/middleware/throttler'

describe('throttler middleware', () => {
  test('blocks requests above the limit and sends default headers', async () => {
    const app = hyperin()

    app.use(
      throttler({ limit: 2, windowMs: 60_000, keyGenerator: () => 'same' })
    )
    app.get('/limited', () => 'ok')

    const first: Response = await request(app).get('/limited')
    const second: Response = await request(app).get('/limited')
    const third: Response = await request(app).get('/limited')

    expect(first.status).toBe(200)
    expect(first.headers['ratelimit-limit']).toBe('2')
    expect(first.headers['ratelimit-remaining']).toBe('1')

    expect(second.status).toBe(200)
    expect(second.headers['ratelimit-remaining']).toBe('0')

    expect(third.status).toBe(429)
    expect(third.body).toEqual(
      expect.objectContaining({
        statusCode: 429,
        path: '/limited',
        message: 'Too Many Requests'
      })
    )
    expect(third.headers['retry-after']).toBeDefined()
    expect(third.headers['ratelimit-policy']).toBe('2;w=60')
  })

  test('supports header-based key and legacy headers', async () => {
    const app = hyperin()

    app.use(
      throttler({
        limit: 1,
        windowMs: 60_000,
        keyHeader: 'x-api-key',
        legacyHeaders: true
      })
    )
    app.get('/api', () => 'ok')

    const first: Response = await request(app)
      .get('/api')
      .set('X-Api-Key', 'abc')
    const second: Response = await request(app)
      .get('/api')
      .set('X-Api-Key', 'abc')
    const other: Response = await request(app)
      .get('/api')
      .set('X-Api-Key', 'def')

    expect(first.status).toBe(200)
    expect(first.headers['x-ratelimit-limit']).toBe('1')
    expect(second.status).toBe(429)
    expect(other.status).toBe(200)
  })

  test('accepts a custom store', async () => {
    const app = hyperin()
    const store: RateLimitStore = {
      consume: () => ({
        allowed: false,
        limit: 10,
        remaining: 0,
        resetTime: 10,
        retryAfter: 10
      })
    }

    app.use(throttler({ store, message: 'blocked' }))
    app.get('/custom', () => 'ok')

    const response: Response = await request(app).get('/custom').send()

    expect(response.status).toBe(429)
    expect(response.body).toEqual({
      statusCode: 429,
      path: '/custom',
      message: 'blocked'
    })
  })

  test('supports token bucket algorithm', async () => {
    const app = hyperin()

    app.use(
      throttler({
        store: new MemoryRateLimitStore(),
        algorithm: 'token-bucket',
        limit: 1,
        windowMs: 60_000,
        keyGenerator: () => 'bucket'
      })
    )
    app.get('/bucket', () => 'ok')

    const first: Response = await request(app).get('/bucket')
    const second: Response = await request(app).get('/bucket')

    expect(first.status).toBe(200)
    expect(second.status).toBe(429)
    expect(second.headers['ratelimit-policy']).toBe(
      '1;w=60;policy=token-bucket'
    )
  })

  test('supports skip predicate and disabling standard headers', async () => {
    const app = hyperin()

    app.use(
      throttler({
        limit: 1,
        windowMs: 60_000,
        keyGenerator: () => 'same',
        standardHeaders: false,
        skip: (request) => request.path === '/health'
      })
    )
    app.get('/health', () => 'ok')
    app.get('/limited', () => 'ok')

    const health: Response = await request(app).get('/health')
    const first: Response = await request(app).get('/limited')
    const second: Response = await request(app).get('/limited')

    expect(health.status).toBe(200)
    expect(health.headers['ratelimit-limit']).toBeUndefined()
    expect(first.status).toBe(200)
    expect(first.headers['ratelimit-limit']).toBeUndefined()
    expect(second.status).toBe(429)
  })

  test('uses custom statusCode in the response payload', async () => {
    const app = hyperin()

    app.use(
      throttler({
        limit: 0,
        statusCode: 503,
        keyGenerator: () => 'same',
        message: 'temporarily unavailable'
      })
    )
    app.get('/limited', () => 'ok')

    const response: Response = await request(app).get('/limited')

    expect(response.status).toBe(503)
    expect(response.body).toEqual({
      statusCode: 503,
      path: '/limited',
      message: 'temporarily unavailable'
    })
  })

  test('supports custom handler and requestPropertyName', async () => {
    const app = hyperin()

    app.use(
      throttler({
        limit: 1,
        keyGenerator: () => 'same',
        requestPropertyName: 'throttle',
        handler: (_request, response, _next, options) => {
          response

            .status(options.statusCode)
            .send(`blocked:${options.result.limit}`)
        }
      })
    )
    app.get('/limited', ({ request }) => ({
      limit: (request as Request & { throttle: { limit: number } }).throttle
        .limit
    }))

    const first: Response = await request(app).get('/limited')
    const second: Response = await request(app).get('/limited')

    expect(first.status).toBe(200)
    expect(first.body).toEqual({ limit: 1 })
    expect(second.status).toBe(429)
    expect(second.text).toBe('blocked:1')
  })

  test('supports skipSuccessfulRequests with the memory store', async () => {
    const app = hyperin()

    app.use(
      throttler({
        limit: 1,
        windowMs: 60_000,
        keyGenerator: () => 'same',
        skipSuccessfulRequests: true
      })
    )
    app.get('/limited', () => 'ok')

    const first: Response = await request(app).get('/limited')
    const second: Response = await request(app).get('/limited')

    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
  })
})
