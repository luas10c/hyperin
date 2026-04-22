import { describe, expect, test } from '@jest/globals'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import request, { type Response } from 'supertest'

import { hyperin } from '#/instance'
import { serveStatic } from '#/middleware/serve-static'

type StaticErrorResponse = {
  statusCode: number
  error: string
  method: string
}

describe('serveStatic middleware', () => {
  test('serves file with content-type and cache-control', async () => {
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

  test('serves index.html in directory', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hyperin-static-'))
    mkdirSync(join(dir, 'docs'))
    writeFileSync(join(dir, 'docs', 'index.html'), '<h1>docs</h1>')

    const app = hyperin()
    app.use('/public', serveStatic(resolve(dir)))

    const response: Response = await request(app).get('/public/docs/')

    expect(response.status).toBe(200)
    expect(response.text).toBe('<h1>docs</h1>')
  })

  test('dotfiles ignore returns 404', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hyperin-static-'))
    writeFileSync(join(dir, '.env'), 'secret=true')

    const app = hyperin()
    app.use('/public', serveStatic(resolve(dir), { dotfiles: 'ignore' }))

    const response: Response = await request(app).get('/public/.env')

    expect(response.status).toBe(404)
    expect(response.body as StaticErrorResponse).toEqual({
      statusCode: 404,
      path: '/public/.env',
      message: 'Not Found'
    })
  })

  test('responds 304 when If-None-Match matches the ETag', async () => {
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

  test('returns 400 for malformed encoded path', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hyperin-static-'))
    writeFileSync(join(dir, 'hello.txt'), 'oi')

    const app = hyperin()
    app.use('/public', serveStatic(resolve(dir)))

    const response: Response = await request(app).get('/public/%E0%A4%A')

    expect(response.status).toBe(400)
    expect(response.body).toEqual({
      statusCode: 400,
      path: '/public/%E0%A4%A',
      message: 'Bad Request'
    })
  })
})
