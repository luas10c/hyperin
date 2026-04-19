import { setTimeout as delay } from 'node:timers/promises'

import { describe, expect, test } from '@jest/globals'
import request, { type Response } from 'supertest'

import hyperin from '#/instance'
import { timeout } from '#/middleware/timeout'

describe('timeout middleware', () => {
  test('responde com timeout quando a request demora demais', async () => {
    const app = hyperin()

    app.use(timeout({ delay: 20 }))
    app.get('/slow', async () => {
      await delay(50)
      return 'late'
    })

    const response: Response = await request(app).get('/slow')

    expect(response.status).toBe(408)
    expect(response.body).toEqual({ error: 'Request Timeout' })
    expect(response.headers.connection).toBe('close')
  })

  test('permite customizar status e handler de timeout', async () => {
    const app = hyperin()

    app.use(
      timeout({
        delay: 20,
        statusCode: 503,
        onTimeout: (_request, response) => {
          response.status(503).json({ error: 'Service Unavailable' })
        }
      })
    )
    app.get('/slow', async () => {
      await delay(50)
      return 'late'
    })

    const response: Response = await request(app).get('/slow')

    expect(response.status).toBe(503)
    expect(response.body).toEqual({ error: 'Service Unavailable' })
  })

  test('não interfere em requests rápidas', async () => {
    const app = hyperin()

    app.use(timeout({ delay: 100 }))
    app.get('/fast', () => 'ok')

    const response: Response = await request(app).get('/fast')

    expect(response.status).toBe(200)
    expect(response.text).toBe('ok')
  })
})
