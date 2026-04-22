import { describe, expect, test } from '@jest/globals'
import { setTimeout } from 'node:timers/promises'
import request, { type Response } from 'supertest'

import hyperin from '#/instance'
import { timeout } from '#/middleware/timeout'

describe('timeout middleware', () => {
  test('responds with timeout when request takes too long', async () => {
    const app = hyperin()

    app.use(timeout({ delay: 20 }))
    app.get('/slow', async () => {
      await setTimeout(50)
      return 'late'
    })

    const response: Response = await request(app).get('/slow')

    expect(response.status).toBe(408)
    expect(response.body).toEqual({ error: 'Request Timeout' })
    expect(response.headers.connection).toBe('close')
  })

  test('allows customizing timeout status and handler', async () => {
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
      await setTimeout(50)
      return 'late'
    })

    const response: Response = await request(app).get('/slow')

    expect(response.status).toBe(503)
    expect(response.body).toEqual({ error: 'Service Unavailable' })
  })

  test('does not affect fast requests', async () => {
    const app = hyperin()

    app.use(timeout({ delay: 100 }))
    app.get('/fast', () => 'ok')

    const response: Response = await request(app).get('/fast')

    expect(response.status).toBe(200)
    expect(response.text).toBe('ok')
  })

  test('exposes cooperative cancellation through request.signal', async () => {
    const app = hyperin()
    let completed = false

    app.use(timeout({ delay: 20 }))
    app.get('/slow', async ({ request }) => {
      await new Promise<void>((resolve) => {
        const timer = globalThis.setTimeout(() => {
          completed = true
          resolve()
        }, 50)

        request.signal.addEventListener(
          'abort',
          () => {
            clearTimeout(timer)
            resolve()
          },
          { once: true }
        )
        })
    })

    const response: Response = await request(app).get('/slow')

    await setTimeout(60)

    expect(response.status).toBe(408)
    expect(completed).toBe(false)
  })
})
