import { describe, expect, test } from '@jest/globals'

import { RadixRouter, type Handler } from '#/router'

describe('RadixRouter', () => {
  test('matches exact route', () => {
    const router = new RadixRouter()
    const handler: Handler = () => undefined

    router.add('GET', '/users', [handler])

    const match = router.match('GET', '/users')

    expect(match).not.toBeNull()
    expect(match?.matched).toBe(true)
    expect(match?.handlers).toEqual([handler])
    expect(match?.params).toEqual({})
  })

  test('extracts dynamic parameters', () => {
    const router = new RadixRouter()
    const handler: Handler = () => undefined

    router.add('GET', '/users/:id/posts/:postId', [handler])

    const match = router.match('GET', '/users/42/posts/99')

    expect(match?.params).toEqual({ id: '42', postId: '99' })
  })

  test('captures wildcard', () => {
    const router = new RadixRouter()
    const handler: Handler = () => undefined

    router.add('GET', '/assets/*', [handler])

    const match = router.match('GET', '/assets/css/app.css')

    expect(match?.params).toEqual({ '*': 'css/app.css' })
  })

  test('uses fast path for static route with ALL method', () => {
    const router = new RadixRouter()
    const handler: Handler = () => undefined

    router.add('ALL', '/health', [handler])

    const match = router.match('GET', '/health')

    expect(match).not.toBeNull()
    expect(match?.matched).toBe(true)
    expect(match?.handlers).toEqual([handler])
    expect(match?.params).toEqual({})
  })

  test('falls back from HEAD to GET for static routes', () => {
    const router = new RadixRouter()
    const handler: Handler = () => undefined

    router.add('GET', '/health', [handler])

    const match = router.match('HEAD', '/health')

    expect(match).not.toBeNull()
    expect(match?.matched).toBe(true)
    expect(match?.handlers).toEqual([handler])
  })

  test('falls back from HEAD to GET for dynamic routes', () => {
    const router = new RadixRouter()
    const handler: Handler = () => undefined

    router.add('GET', '/users/:id', [handler])

    const match = router.match('HEAD', '/users/42')

    expect(match).not.toBeNull()
    expect(match?.matched).toBe(true)
    expect(match?.handlers).toEqual([handler])
    expect(match?.params).toEqual({ id: '42' })
  })

  test('prioritizes static route before falling back to dynamic path', () => {
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

  test('prioritizes param matches before wildcard fallbacks', () => {
    const router = new RadixRouter()
    const paramHandler: Handler = () => undefined
    const wildcardHandler: Handler = () => undefined

    router.add('GET', '/files/:name', [paramHandler])
    router.add('GET', '/files/*', [wildcardHandler])

    const match = router.match('GET', '/files/readme')

    expect(match).not.toBeNull()
    expect(match?.matched).toBe(true)
    expect(match?.handlers).toEqual([paramHandler])
    expect(match?.params).toEqual({ name: 'readme' })
  })

  test('returns global middlewares even when no route matches', () => {
    const router = new RadixRouter()
    const middleware: Handler = () => undefined

    router.use(middleware)

    const match = router.match('GET', '/missing')

    expect(match).not.toBeNull()
    expect(match?.matched).toBe(false)
    expect(match?.middlewares).toEqual([middleware])
    expect(match?.handlers).toEqual([])
  })

  test('detects error middleware by signature', () => {
    const router = new RadixRouter()
    const errorMw = ({ error, next }: { error: Error; next: () => void }) => {
      void error
      return next()
    }

    router.use(errorMw)

    expect(router.errorMiddlewares).toHaveLength(1)
  })
})
