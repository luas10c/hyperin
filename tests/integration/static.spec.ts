import { describe, expect, test } from '@jest/globals'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import request, { type Response } from 'supertest'

import { hyperin } from '#/instance'
import { serveStatic } from '#/serve-static'

type StaticErrorResponse = {
  statusCode: number
  error: string
  method: string
}

describe('serveStatic middleware', () => {
  test('serve arquivo com content-type e cache-control', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hyperin-static-'))
    writeFileSync(join(dir, 'hello.txt'), 'oi')

    const app = hyperin()
    app.use('/public', serveStatic(resolve(dir), { maxAge: 60 }))

    const response: Response = await request(app).get('/public/hello.txt')

    expect(response.status).toBe(200)
    expect(response.headers['content-type']).toBe('text/plain; charset=utf-8')
    expect(response.headers['cache-control']).toBe('public, max-age=60')
    expect(response.text).toBe('oi')
  })

  test('serve index.html em diretório', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hyperin-static-'))
    mkdirSync(join(dir, 'docs'))
    writeFileSync(join(dir, 'docs', 'index.html'), '<h1>docs</h1>')

    const app = hyperin()
    app.use('/public', serveStatic(resolve(dir)))

    const response: Response = await request(app).get('/public/docs/')

    expect(response.status).toBe(200)
    expect(response.text).toBe('<h1>docs</h1>')
  })

  test('dotfiles ignore retorna 404', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hyperin-static-'))
    writeFileSync(join(dir, '.env'), 'secret=true')

    const app = hyperin()
    app.use('/public', serveStatic(resolve(dir), { dotfiles: 'ignore' }))

    const response: Response = await request(app).get('/public/.env')

    expect(response.status).toBe(404)
    expect(response.body as StaticErrorResponse).toEqual({
      statusCode: 404,
      error: 'Not Found',
      method: 'GET'
    })
  })

  test('responde 304 quando If-None-Match casa com o ETag', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hyperin-static-'))
    writeFileSync(join(dir, 'hello.txt'), 'cache')

    const app = hyperin()
    app.use('/public', serveStatic(resolve(dir), { etag: true }))

    const first: Response = await request(app).get('/public/hello.txt')
    const etag = first.headers.etag
    const second: Response = await request(app)
      .get('/public/hello.txt')
      .set('If-None-Match', etag ?? '')

    expect(first.status).toBe(200)
    expect(etag).toBeTruthy()
    expect(second.status).toBe(304)
  })
})
