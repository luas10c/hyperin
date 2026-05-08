import { describe, expect, test } from '@jest/globals'
import request, { type Response } from 'supertest'
import { createGzip } from 'node:zlib'
import { Readable } from 'node:stream'

import { json, urlencoded } from '#/middleware/body'
import { hyperin } from '#/instance'
import type { Request } from '#/request'
import type { Response as HyperinResponse } from '#/response'

type JsonObject = Record<string, unknown>

type ErrorBody = {
  error: string
  type: string
}

interface ErrorWithStatus extends Error {
  status?: number
}

async function gzipJson(value: unknown): Promise<Buffer> {
  const input = Buffer.from(JSON.stringify(value))
  const gzip = createGzip()
  const chunks: Buffer[] = []

  return await new Promise((resolve, reject) => {
    gzip.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
    gzip.on('end', () => resolve(Buffer.concat(chunks)))
    gzip.on('error', reject)

    Readable.from(input).pipe(gzip)
  })
}

describe('body parsers', () => {
  test('json parses valid body', async () => {
    const app = hyperin()
    app.use(json())
    app.post('/json', ({ request }) => request.body as JsonObject)

    const response: Response = await request(app)
      .post('/json')
      .set('Content-Type', 'application/json')
      .send({ hello: 'world' })

    expect(response.status).toBe(200)
    expect(response.body).toEqual({ hello: 'world' })
  })

  test('json strict rejects primitive', async () => {
    const app = hyperin()
    app.use(json())
    app.post('/json', ({ request }) => request.body)

    const response: Response = await request(app)
      .post('/json')
      .set('Content-Type', 'application/json')
      .send('"abc"')

    expect(response.status).toBe(400)
    expect(response.body as ErrorBody).toEqual({
      error: 'Invalid JSON — strict mode only accepts objects and arrays',
      type: 'entity.parse.failed'
    })
  })

  test('json strict=false accepts primitive payloads', async () => {
    const app = hyperin()
    app.use(json({ strict: false }))
    app.post('/json', ({ request }) => ({ value: request.body }))

    const response: Response = await request(app)
      .post('/json')
      .set('Content-Type', 'application/json')
      .send('"abc"')

    expect(response.status).toBe(200)
    expect(response.body).toEqual({ value: 'abc' })
  })

  test('json accepts payloads larger than 100kb when limit is increased', async () => {
    const app = hyperin()
    app.use(json({ limit: '1mb' }))
    app.post('/json', ({ request }) => ({
      size: (request.body as { payload: string }).payload.length
    }))

    const largePayload = { payload: 'x'.repeat(220 * 1024) }

    const response: Response = await request(app)
      .post('/json')
      .set('Content-Type', 'application/json')
      .send(largePayload)

    expect(response.status).toBe(200)
    expect(response.body).toEqual({
      size: largePayload.payload.length
    })
  })

  test('json enforces 1mb boundary reliably', async () => {
    const app = hyperin()
    app.use(json({ limit: '1mb' }))
    app.post('/json', ({ request }) => ({
      size: (request.body as { payload: string }).payload.length
    }))

    const withinLimitPayload = { payload: 'x'.repeat(1024 * 1024 - 1024) }
    const exceedingLimitPayload = { payload: 'x'.repeat(1024 * 1024 + 2048) }

    const okResponse: Response = await request(app)
      .post('/json')
      .set('Content-Type', 'application/json')
      .send(withinLimitPayload)

    expect(okResponse.status).toBe(200)
    expect(okResponse.body).toEqual({ size: withinLimitPayload.payload.length })

    const failResponse: Response = await request(app)
      .post('/json')
      .set('Content-Type', 'application/json')
      .send(exceedingLimitPayload)

    expect(failResponse.status).toBe(413)
    expect(failResponse.body).toEqual({
      error: 'Payload Too Large',
      type: 'entity.too.large'
    })
  })

  test('json enforces maxDepth option', async () => {
    const app = hyperin()
    app.use(json({ maxDepth: 1 }))
    app.post('/json', ({ request }) => request.body)

    const response: Response = await request(app)
      .post('/json')
      .set('Content-Type', 'application/json')
      .send({ a: { b: { c: 1 } } })

    expect(response.status).toBe(413)
    expect(response.body).toEqual({
      error: 'JSON depth limit exceeded',
      type: 'entity.too.deep'
    })
  })

  test('json enforces maxKeys option', async () => {
    const app = hyperin()
    app.use(json({ maxKeys: 2 }))
    app.post('/json', ({ request }) => request.body)

    const response: Response = await request(app)
      .post('/json')
      .set('Content-Type', 'application/json')
      .send({ a: 1, b: 2, c: 3 })

    expect(response.status).toBe(413)
    expect(response.body).toEqual({
      error: 'JSON keys limit exceeded',
      type: 'entity.too.many_keys'
    })
  })

  test('json verify can block request', async () => {
    const app = hyperin()

    app.use(
      json({
        verify: (_req: Request, _res: HyperinResponse, buf: Buffer) => {
          if (buf.toString('utf8').includes('forbidden')) {
            const err: ErrorWithStatus = new Error('blocked')
            err.status = 401
            throw err
          }
        }
      })
    )

    app.post('/json', ({ request }) => request.body as JsonObject)

    const response: Response = await request(app)
      .post('/json')
      .set('Content-Type', 'application/json')
      .send({ forbidden: true })

    expect(response.status).toBe(401)
    expect(response.body as ErrorBody).toEqual({
      error: 'blocked',
      type: 'entity.verify.failed'
    })
  })

  test('json accepts gzip when inflate=true', async () => {
    const app = hyperin()
    app.use(json())
    app.post('/json', ({ request }) => request.body)
    const body = await gzipJson({ ok: true })

    const response: Response = await request(app)
      .post('/json')
      .set('Content-Type', 'application/json')
      .set('Content-Encoding', 'gzip')
      .send(body)

    expect(response.status).toBe(200)
    expect(response.body).toEqual({ ok: true })
  })

  test('json rejects compressed payload when inflate=false', async () => {
    const app = hyperin()
    app.use(json({ inflate: false }))
    app.post('/json', ({ request }) => request.body)
    const body = await gzipJson({ ok: true })

    const response: Response = await request(app)
      .post('/json')
      .set('Content-Type', 'application/json')
      .set('Content-Encoding', 'gzip')
      .send(body)

    expect(response.status).toBe(415)
    expect(response.body).toEqual({
      error: 'Unsupported Content-Encoding: gzip',
      type: 'encoding.unsupported'
    })
  })

  test('json rejects gzip payloads that inflate beyond the configured limit', async () => {
    const app = hyperin()
    app.use(json({ limit: '8kb' }))
    app.post('/json', ({ request }) => request.body)
    const body = await gzipJson({ payload: 'x'.repeat(512 * 1024) })

    const response: Response = await request(app)
      .post('/json')
      .set('Content-Type', 'application/json')
      .set('Content-Encoding', 'gzip')
      .send(body)

    expect(response.status).toBe(413)
    expect(response.body).toEqual({
      error: 'Body exceeds limit',
      type: 'entity.too.large'
    })
  })

  test('json rejects compressed payloads when compression ratio exceeds the configured limit', async () => {
    const app = hyperin()
    app.use(json({ limit: '1mb', maxCompressionRatio: 5 }))
    app.post('/json', ({ request }) => request.body)
    const body = await gzipJson({ payload: 'x'.repeat(256 * 1024) })

    const response: Response = await request(app)
      .post('/json')
      .set('Content-Type', 'application/json')
      .set('Content-Encoding', 'gzip')
      .send(body)

    expect(response.status).toBe(413)
    expect(response.body).toEqual({
      error: 'Compression ratio exceeds limit',
      type: 'encoding.ratio.exceeded'
    })
  })

  test('json rejects early when content-length exceeds limit', async () => {
    const app = hyperin()
    app.use(json({ limit: '1kb' }))
    app.post('/json', ({ request }) => request.body)

    const response: Response = await request(app)
      .post('/json')
      .set('Content-Type', 'application/json')
      .send({ payload: 'x'.repeat(32 * 1024) })

    expect(response.status).toBe(413)
    expect(response.body).toEqual({
      error: 'Payload Too Large',
      type: 'entity.too.large'
    })
  })

  test('urlencoded parses repeated pairs', async () => {
    const app = hyperin()
    app.use(urlencoded())
    app.post('/form', ({ request }) => request.body as JsonObject)

    const response: Response = await request(app)
      .post('/form')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send('tag=a&tag=b&name=luciano')

    expect(response.status).toBe(200)
    expect(response.body).toEqual({
      tag: ['a', 'b'],
      name: 'luciano'
    })
  })

  test('urlencoded extended supports objects and arrays', async () => {
    const app = hyperin()
    app.use(urlencoded({ extended: true }))
    app.post('/form', ({ request }) => request.body as JsonObject)

    const response: Response = await request(app)
      .post('/form')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send('user[name]=Ana&user[role]=admin&tags[]=a&tags[]=b')

    expect(response.status).toBe(200)
    expect(response.body).toEqual({
      user: { name: 'Ana', role: 'admin' },
      tags: ['a', 'b']
    })
  })

  test('urlencoded respects parameterLimit', async () => {
    const app = hyperin()
    app.use(urlencoded({ parameterLimit: 1 }))
    app.post('/form', ({ request }) => request.body as JsonObject)

    const response: Response = await request(app)
      .post('/form')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send('a=1&b=2')

    expect(response.status).toBe(413)
    expect(response.body as ErrorBody).toEqual({
      error: 'Too many parameters',
      type: 'parameters.too.many'
    })
  })

  test('urlencoded ignores unsafe keys in simple mode', async () => {
    const app = hyperin()
    app.use(urlencoded())
    app.post('/form', ({ request }) => request.body as JsonObject)

    const response: Response = await request(app)
      .post('/form')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send('ok=1&__proto__=polluted&constructor=x')

    expect(response.status).toBe(200)
    expect(response.body).toEqual({ ok: '1' })
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })

  test('urlencoded ignores unsafe keys in extended mode', async () => {
    const app = hyperin()
    app.use(urlencoded({ extended: true }))
    app.post('/form', ({ request }) => request.body as JsonObject)

    const response: Response = await request(app)
      .post('/form')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send('user[name]=Ana&user[__proto__]=polluted&constructor[admin]=1')

    expect(response.status).toBe(200)
    expect(response.body).toEqual({ user: { name: 'Ana' } })
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })

  test('urlencoded extended enforces configured depth limit', async () => {
    const app = hyperin()
    app.use(urlencoded({ extended: true, depth: 1 }))
    app.post('/form', ({ request }) => request.body as JsonObject)

    const response: Response = await request(app)
      .post('/form')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send('user[name][first]=Ana')

    expect(response.status).toBe(400)
    expect(response.body).toEqual({
      error: 'Object depth limit (1) exceeded',
      type: 'parameters.depth.exceeded'
    })
  })

  test('urlencoded enforces 1mb boundary reliably', async () => {
    const app = hyperin()
    app.use(urlencoded({ limit: '1mb' }))
    app.post('/form', ({ request }) => ({
      size: (request.body as { payload: string }).payload.length
    }))

    const withinLimit = `payload=${'x'.repeat(1024 * 1024 - 2048)}`
    const overLimit = `payload=${'x'.repeat(1024 * 1024 + 2048)}`

    const okResponse: Response = await request(app)
      .post('/form')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send(withinLimit)

    expect(okResponse.status).toBe(200)
    expect(okResponse.body).toEqual({ size: 1024 * 1024 - 2048 })

    const failResponse: Response = await request(app)
      .post('/form')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send(overLimit)

    expect(failResponse.status).toBe(413)
    expect(failResponse.body).toEqual({
      error: 'Payload Too Large',
      type: 'entity.too.large'
    })
  })
})
