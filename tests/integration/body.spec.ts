import { describe, expect, test } from '@jest/globals'
import request, { type Response } from 'supertest'
import { gzipSync } from 'node:zlib'

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

function gzipJson(value: unknown): Buffer {
  return gzipSync(Buffer.from(JSON.stringify(value)))
}

describe('body parsers', () => {
  test('json parseia body válido', async () => {
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

  test('json strict rejeita primitivo', async () => {
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

  test('json verify pode bloquear request', async () => {
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

  test('json aceita gzip quando inflate=true', async () => {
    const app = hyperin()
    app.use(json())
    app.post('/json', ({ request }) => request.body)

    const response: Response = await request(app)
      .post('/json')
      .set('Content-Type', 'application/json')
      .set('Content-Encoding', 'gzip')
      .send(gzipJson({ ok: true }))

    expect(response.status).toBe(200)
    expect(response.body).toEqual({ ok: true })
  })

  test('urlencoded simple parseia pares repetidos', async () => {
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

  test('urlencoded extended suporta objetos e arrays', async () => {
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

  test('urlencoded respeita parameterLimit', async () => {
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
})
