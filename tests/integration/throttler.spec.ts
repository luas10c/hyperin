import { describe, expect, test } from '@jest/globals'
import request, { type Response } from 'supertest'

import hyperin from '#/instance'
import {
  MemoryRateLimitStore,
  throttler,
  type RateLimitStore
} from '#/middleware/throttler'

describe('throttler middleware', () => {
  test('bloqueia requests acima do limite e envia headers padrão', async () => {
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
    expect(third.body).toEqual({ error: 'Too Many Requests' })
    expect(third.headers['retry-after']).toBeDefined()
    expect(third.headers['ratelimit-policy']).toBe('2;w=60')
  })

  test('suporta chave baseada em header e legacy headers', async () => {
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

  test('aceita store custom', async () => {
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

    const response: Response = await request(app).get('/custom')

    expect(response.status).toBe(429)
    expect(response.text).toBe('blocked')
  })

  test('suporta algoritmo token bucket', async () => {
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
})
