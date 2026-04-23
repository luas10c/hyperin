import { describe, expect, test } from '@jest/globals'
import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import request, { type Response } from 'supertest'

import { hyperin } from '#/instance'
import { serveStatic } from '#/middleware/serve-static'

type StaticErrorResponse = {
  statusCode: number
  message: string
}

describe('serveStatic middleware', () => {
  test('serves file with content-type and cache-control', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hyperin-static-'))
    await writeFile(join(dir, 'hello.txt'), 'oi')

    const app = hyperin()
    app.use('/public', serveStatic(resolve(dir), { maxAge: 60 }))

    const response: Response = await request(app).get('/public/hello.txt')

    expect(response.status).toBe(200)
    expect(response.headers['content-type']).toBe('text/plain; charset=utf-8')
    expect(response.headers['cache-control']).toBe('public, max-age=60')
    expect(response.text).toBe('oi')
  })

  test('serves index.html in directory', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hyperin-static-'))
    await mkdir(join(dir, 'docs'))
    await writeFile(join(dir, 'docs', 'index.html'), '<h1>docs</h1>')

    const app = hyperin()
    app.use('/public', serveStatic(resolve(dir)))

    const response: Response = await request(app).get('/public/docs/')

    expect(response.status).toBe(200)
    expect(response.text).toBe('<h1>docs</h1>')
  })

  test('dotfiles ignore returns 404', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hyperin-static-'))
    await writeFile(join(dir, '.env'), 'secret=true')

    const app = hyperin()
    app.use('/public', serveStatic(resolve(dir), { dotfiles: 'ignore' }))

    const response: Response = await request(app).get('/public/.env')

    expect(response.status).toBe(404)
    expect(response.body as StaticErrorResponse).toEqual({
      statusCode: 404,
      message: 'Not Found'
    })
  })

  test('responds 304 when If-None-Match matches the ETag', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hyperin-static-'))
    await writeFile(join(dir, 'hello.txt'), 'cache')

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
    const dir = await mkdtemp(join(tmpdir(), 'hyperin-static-'))
    await writeFile(join(dir, 'hello.txt'), 'oi')

    const app = hyperin()
    app.use('/public', serveStatic(resolve(dir)))

    const response: Response = await request(app).get('/public/%E0%A4%A')

    expect(response.status).toBe(400)
    expect(response.body).toEqual({
      statusCode: 400,
      message: 'Bad Request'
    })
  })

  test('serves file from root-mounted static middleware when file exists', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hyperin-static-'))
    await writeFile(join(dir, 'avatar.txt'), 'file-content')

    const app = hyperin()
    app.use('/', serveStatic(resolve(dir)))
    app.get('/register', () => ({ route: 'register' }))
    app.get('/login', () => ({ route: 'login' }))

    const response: Response = await request(app).get('/avatar.txt')

    expect(response.status).toBe(200)
    expect(response.text).toBe('file-content')
  })

  test('calls next for root-mounted static middleware when file does not exist', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hyperin-static-'))

    const app = hyperin()
    app.use('/', serveStatic(resolve(dir)))
    app.get('/register', () => ({ route: 'register' }))
    app.get('/login', () => ({ route: 'login' }))

    const registerResponse: Response = await request(app).get('/register')
    const loginResponse: Response = await request(app).get('/login')

    expect(registerResponse.status).toBe(200)
    expect(registerResponse.body).toEqual({ route: 'register' })
    expect(loginResponse.status).toBe(200)
    expect(loginResponse.body).toEqual({ route: 'login' })
  })

  test('blocks symlinks that escape the static root', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hyperin-static-'))
    const externalDir = await mkdtemp(join(tmpdir(), 'hyperin-static-external-'))
    const externalFile = join(externalDir, 'secret.txt')

    await writeFile(externalFile, 'top-secret')
    await symlink(externalFile, join(dir, 'secret-link.txt'))

    const app = hyperin()
    app.use('/public', serveStatic(resolve(dir)))

    const response: Response = await request(app).get('/public/secret-link.txt')

    expect(response.status).toBe(403)
    expect(response.body).toEqual({
      statusCode: 403,
      message: 'Forbidden'
    })
  })
})
