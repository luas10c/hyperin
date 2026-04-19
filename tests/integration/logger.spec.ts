import { describe, expect, jest, test } from '@jest/globals'
import request, { type Response } from 'supertest'

import hyperin from '#/instance'
import { logger } from '#/middleware/logger'

function stripAnsi(value: string): string {
  return value.replaceAll('\u001B', '').replace(/\[[0-9;]*m/g, '')
}

describe('logger middleware', () => {
  test('escreve uma linha com dados da resposta ao finalizar', async () => {
    const write = jest.fn<() => boolean>().mockReturnValue(true)
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
})
