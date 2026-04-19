import { describe, expect, test } from '@jest/globals'
import request from 'supertest'

import hyperin from '#/instance'
import { compress } from '#/middleware/compress'

function bufferParser(
  res: NodeJS.ReadableStream & {
    on: (event: string, listener: (chunk?: Buffer) => void) => void
  },
  callback: (error: Error | null, body: Buffer) => void
): void {
  const chunks: Buffer[] = []

  res.on('data', (chunk?: Buffer) => {
    if (chunk) chunks.push(Buffer.from(chunk))
  })

  res.on('end', () => {
    callback(null, Buffer.concat(chunks))
  })

  res.on('error', (error?: Buffer) => {
    callback(
      error instanceof Error ? error : new Error('stream error'),
      Buffer.alloc(0)
    )
  })
}

describe('compress middleware', () => {
  test('comprime respostas textuais com gzip', async () => {
    const app = hyperin()

    app.use(compress({ encodings: ['gzip'], threshold: 32 }))
    app.get('/payload', () => 'a'.repeat(256))

    const response = await request(app)
      .get('/payload')
      .set('Accept-Encoding', 'gzip')
      .buffer(true)
      .parse(bufferParser)

    expect(response.status).toBe(200)
    expect(response.headers['content-encoding']).toBe('gzip')
    expect(response.headers.vary).toContain('Accept-Encoding')
    expect(response.body.toString('utf8')).toBe('a'.repeat(256))
  })

  test('prefere brotli quando disponível', async () => {
    const app = hyperin()

    app.use(compress({ threshold: 32 }))
    app.get('/json', () => ({ message: 'x'.repeat(256) }))

    const response = await request(app)
      .get('/json')
      .set('Accept-Encoding', 'br, gzip;q=0.8')
      .buffer(true)
      .parse(bufferParser)

    expect(response.status).toBe(200)
    expect(response.headers['content-encoding']).toBe('br')
    expect(JSON.parse(response.body.toString('utf8'))).toEqual({
      message: 'x'.repeat(256)
    })
  })

  test('não comprime payloads abaixo do threshold', async () => {
    const app = hyperin()

    app.use(compress({ threshold: 2048 }))
    app.get('/small', () => 'small payload')

    const response = await request(app)
      .get('/small')
      .set('Accept-Encoding', 'gzip')

    expect(response.status).toBe(200)
    expect(response.headers['content-encoding']).toBeUndefined()
    expect(response.text).toBe('small payload')
  })
})
