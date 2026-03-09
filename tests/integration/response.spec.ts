import { describe, expect, test } from '@jest/globals'
import request, { type Response } from 'supertest'

import { hyperin } from '#/instance'

type JsonResponse = {
  ok: boolean
}

describe('Response integration', () => {
  test('response.json envia content-type e content-length', async () => {
    const app = hyperin()
    app.get('/json', ({ response }) => {
      response.status(201).json({ ok: true })
    })

    const response: Response = await request(app).get('/json')

    expect(response.status).toBe(201)
    expect(response.headers['content-type']).toContain('application/json')
    expect(response.headers['content-length']).toBe(
      String(Buffer.byteLength(JSON.stringify({ ok: true })))
    )
    expect(response.body as JsonResponse).toEqual({ ok: true })
  })

  test('response.redirect define location', async () => {
    const app = hyperin()
    app.get('/from', ({ response }) => {
      response.redirect('/to', 301)
    })

    const response: Response = await request(app)
      .get('/from')
      .redirects(0)
      .ok((res) => res.status < 400)

    expect(response.status).toBe(301)
    expect(response.headers.location).toBe('/to')
  })

  test('response.cookie serializa opções', async () => {
    const app = hyperin()
    app.get('/cookie', ({ response }) => {
      response.cookie('token', 'abc 123', {
        httpOnly: true,
        secure: true,
        sameSite: 'Strict',
        maxAge: 60
      })
      response.send('ok')
    })

    const response: Response = await request(app).get('/cookie')

    const setCookie = response.headers['set-cookie']?.[0] ?? ''
    expect(setCookie).toContain('token=abc%20123')
    expect(setCookie).toContain('Path=/')
    expect(setCookie).toContain('Max-Age=60')
    expect(setCookie).toContain('HttpOnly')
    expect(setCookie).toContain('Secure')
    expect(setCookie).toContain('SameSite=Strict')
  })

  test('response.send com Buffer envia octet-stream', async () => {
    const app = hyperin()
    app.get('/buffer', ({ response }) => {
      response.send(Buffer.from('abc'))
    })

    const response: Response = await request(app).get('/buffer')

    expect(response.headers['content-type']).toBe('application/octet-stream')
    expect(Buffer.isBuffer(response.body)).toBe(true)
    expect((response.body as Buffer).toString('utf8')).toBe('abc')
  })
})
