import { describe, expect, test } from '@jest/globals'
import request, { type Response } from 'supertest'

import hyperin from '#/instance'
import { cookies } from '#/middleware/cookies'

describe('cookies middleware', () => {
  test('parseia cookies simples da requisição', async () => {
    const app = hyperin()

    app.use(cookies())
    app.get('/me', ({ request }) => request.cookies)

    const response: Response = await request(app)
      .get('/me')
      .set('Cookie', ['theme=dark', 'session=abc%20123'])

    expect(response.status).toBe(200)
    expect(response.body).toEqual({ theme: 'dark', session: 'abc 123' })
  })

  test('acumula multiplos Set-Cookie na resposta', async () => {
    const app = hyperin()

    app.use(cookies())
    app.get('/set', ({ response }) => {
      response.cookie('a', '1', { httpOnly: true })
      response.cookie('b', '2', { sameSite: 'Lax' })
      response.send('ok')
    })

    const response: Response = await request(app).get('/set')

    expect(response.status).toBe(200)
    expect(response.headers['set-cookie']).toEqual([
      'a=1; Path=/; HttpOnly',
      'b=2; Path=/; SameSite=Lax'
    ])
  })

  test('aceita assinatura por tupla ao escrever cookie', async () => {
    const app = hyperin()

    app.get('/tuple', ({ response }) => {
      response.cookie(['aaa', 'aaa', { httpOnly: true }])
      response.send('ok')
    })

    const response: Response = await request(app).get('/tuple')

    expect(response.status).toBe(200)
    expect(response.headers['set-cookie']).toEqual([
      'aaa=aaa; Path=/; HttpOnly'
    ])
  })
})
