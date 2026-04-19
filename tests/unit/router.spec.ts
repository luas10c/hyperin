import { describe, expect, test } from '@jest/globals'

import { RadixRouter, type Handler } from '#/router'

describe('RadixRouter', () => {
  test('faz match de rota exata', () => {
    const router = new RadixRouter()
    const handler: Handler = () => undefined

    router.add('GET', '/users', [handler])

    const match = router.match('GET', '/users')

    expect(match).not.toBeNull()
    expect(match?.matched).toBe(true)
    expect(match?.handlers).toEqual([handler])
    expect(match?.params).toEqual({})
  })

  test('extrai parâmetros dinâmicos', () => {
    const router = new RadixRouter()
    const handler: Handler = () => undefined

    router.add('GET', '/users/:id/posts/:postId', [handler])

    const match = router.match('GET', '/users/42/posts/99')

    expect(match?.params).toEqual({ id: '42', postId: '99' })
  })

  test('captura wildcard', () => {
    const router = new RadixRouter()
    const handler: Handler = () => undefined

    router.add('GET', '/assets/*', [handler])

    const match = router.match('GET', '/assets/css/app.css')

    expect(match?.params).toEqual({ '*': 'css/app.css' })
  })

  test('usa fast path para rota estática com método ALL', () => {
    const router = new RadixRouter()
    const handler: Handler = () => undefined

    router.add('ALL', '/health', [handler])

    const match = router.match('GET', '/health')

    expect(match).not.toBeNull()
    expect(match?.matched).toBe(true)
    expect(match?.handlers).toEqual([handler])
    expect(match?.params).toEqual({})
  })

  test('prioriza rota estática antes de cair para caminho dinâmico', () => {
    const router = new RadixRouter()
    const staticHandler: Handler = () => undefined
    const dynamicHandler: Handler = () => undefined

    router.add('GET', '/users/me', [staticHandler])
    router.add('GET', '/users/:id', [dynamicHandler])

    const match = router.match('GET', '/users/me')

    expect(match).not.toBeNull()
    expect(match?.handlers).toEqual([staticHandler])
    expect(match?.params).toEqual({})
  })

  test('retorna middlewares globais mesmo sem rota casada', () => {
    const router = new RadixRouter()
    const middleware: Handler = () => undefined

    router.use(middleware)

    const match = router.match('GET', '/missing')

    expect(match).not.toBeNull()
    expect(match?.matched).toBe(false)
    expect(match?.middlewares).toEqual([middleware])
    expect(match?.handlers).toEqual([])
  })

  test('detecta error middleware pela assinatura', () => {
    const router = new RadixRouter()
    const errorMw = ({ error, next }: { error: Error; next: () => void }) => {
      void error
      return next()
    }

    router.use(errorMw)

    expect(router.errorMiddlewares).toHaveLength(1)
  })
})
