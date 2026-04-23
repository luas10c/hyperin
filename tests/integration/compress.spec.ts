import { describe, expect, test } from '@jest/globals'
import request from 'supertest'

import type { Stream } from 'node:stream'

import hyperin from '#/instance'
import { compress } from '#/middleware/compress'

function bufferParser(
  stream: Stream,
  callback: (error: Error | null, body: unknown) => void
): void {
  const chunks: Buffer[] = []

  stream.on('data', (chunk?: Buffer) => {
    if (chunk) chunks.push(Buffer.from(chunk))
  })

  stream.on('end', () => {
    callback(null, Buffer.concat(chunks))
  })

  stream.on('error', (error?: Buffer) => {
    callback(
      error instanceof Error ? error : new Error('stream error'),
      Buffer.alloc(0)
    )
  })
}

describe('compress middleware', () => {
  test('compresses textual responses with gzip', async () => {
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

  test('prefers brotli when available', async () => {
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

  test('does not compress payloads below the threshold', async () => {
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

  test('compresses chunked streaming responses', async () => {
    const app = hyperin()
    const payload = 'stream-'.repeat(256)

    app.use(compress({ encodings: ['gzip'], threshold: 32 }))
    app.get('/stream', ({ response }) => {
      response.type('text/plain; charset=utf-8')

      for (let i = 0; i < 4; i++) {
        response.write(payload)
      }

      response.end()
    })

    const response = await request(app)
      .get('/stream')
      .set('Accept-Encoding', 'gzip')
      .buffer(true)
      .parse(bufferParser)

    expect(response.status).toBe(200)
    expect(response.headers['content-encoding']).toBe('gzip')
    expect(response.body.toString('utf8')).toBe(payload.repeat(4))
  })
})
