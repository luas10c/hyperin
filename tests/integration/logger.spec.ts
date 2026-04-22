import { describe, expect, jest, test } from '@jest/globals'
import request, { type Response } from 'supertest'

import hyperin from '#/instance'
import { logger } from '#/middleware/logger'

function stripAnsi(value: string): string {
  return value.replaceAll('\u001B', '').replace(/\[[0-9;]*m/g, '')
}

describe('logger middleware', () => {
  test('logs a line with response data when finishing', async () => {
    const write = jest.fn<(chunk: string) => boolean>().mockReturnValue(true)
    const app = hyperin()

    app.use(logger({ stream: { write }, colors: true }))
    app.get('/health', () => 'ok')

    const response: Response = await request(app).get('/health')

    expect(response.status).toBe(200)
    expect(write).toHaveBeenCalledTimes(1)
    expect(write.mock.calls[0]?.[0]).toContain('\u001B[')
    expect(stripAnsi(write.mock.calls[0]?.[0] ?? '')).toMatch(
      /^GET \/health 200 (?:[\d.]+ms|[\d.]+s) (?:\d+ B|[\d.]+ kB|[\d.]+ MB)\n$/
    )
  })

  test('supports skip and immediate options', async () => {
    const write = jest.fn<(chunk: string) => boolean>().mockReturnValue(true)
    const app = hyperin()

    app.use(
      logger({
        stream: { write },
        colors: false,
        immediate: true,
        skip: (request) => request.path === '/skip'
      })
    )
    app.get('/health', () => 'ok')
    app.get('/skip', () => 'ok')

    const health: Response = await request(app).get('/health')
    const skip: Response = await request(app).get('/skip')

    expect(health.status).toBe(200)
    expect(skip.status).toBe(200)
    expect(write).toHaveBeenCalledTimes(1)
    expect(write.mock.calls[0]?.[0]).toMatch(/^GET \/health /)
  })

  test('supports named formats and custom tokens', async () => {
    const write = jest.fn<(chunk: string) => boolean>().mockReturnValue(true)
    const app = hyperin()

    logger.token(
      'request-id',
      (request) => (request.get('x-request-id') as string) || 'missing'
    )
    logger.format('with-id', ':request-id :method :url :status')

    app.use(logger({ stream: { write }, colors: false, format: 'with-id' }))
    app.get('/health', () => 'ok')

    const response: Response = await request(app)
      .get('/health')
      .set('X-Request-Id', 'abc-123')

    expect(response.status).toBe(200)
    expect(write).toHaveBeenCalledTimes(1)
    expect(write.mock.calls[0]?.[0]).toBe('abc-123 GET /health 200\n')
  })

  test('supports tiny format string compatibility', async () => {
    const write = jest.fn<(chunk: string) => boolean>().mockReturnValue(true)
    const app = hyperin()

    app.use(logger({ stream: { write }, colors: false, format: 'tiny' }))
    app.get('/health', () => 'ok')

    const response: Response = await request(app).get('/health')

    expect(response.status).toBe(200)
    expect(write.mock.calls[0]?.[0]).toMatch(
      /^GET \/health 200 (?:\d+|-) - [\d.]+ ms\n$/
    )
  })

  test('prefers content-length for json responses', async () => {
    const write = jest.fn<(chunk: string) => boolean>().mockReturnValue(true)
    const app = hyperin()

    app.use(logger({ stream: { write }, colors: false }))
    app.get('/', () => ({ ok: true }))

    const response: Response = await request(app).get('/')

    expect(response.status).toBe(200)
    expect(write).toHaveBeenCalledTimes(1)
    expect(write.mock.calls[0]?.[0]).toMatch(
      /^GET \/ 200 (?:[\d.]+ms|[\d.]+s) 11 B\n$/
    )
  })
})
