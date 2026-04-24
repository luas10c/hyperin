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

  test('falls back to param route when exact branch has no terminal handler', () => {
    const router = new RadixRouter()
    const pageHandler: Handler = () => undefined
    const aboutSectionHandler: Handler = () => undefined

    router.add('GET', '/:page', [pageHandler])
    router.add('GET', '/about/:section', [aboutSectionHandler])

    const match = router.match('GET', '/about')

    expect(match).not.toBeNull()
    expect(match?.matched).toBe(true)
    expect(match?.handlers).toEqual([pageHandler])
    expect(match?.params).toEqual({ page: 'about' })
  })

  test('falls back to param route when deeper exact branch has no handler', () => {
    const router = new RadixRouter()
    const userHandler: Handler = () => undefined
    const settingsHandler: Handler = () => undefined

    router.add('GET', '/users/:id', [userHandler])
    router.add('GET', '/users/me/settings', [settingsHandler])

    const match = router.match('GET', '/users/me')

    expect(match).not.toBeNull()
    expect(match?.matched).toBe(true)
    expect(match?.handlers).toEqual([userHandler])
    expect(match?.params).toEqual({ id: 'me' })
  })

  test('falls back to wildcard route when exact branch has no terminal handler', () => {
    const router = new RadixRouter()
    const wildcardHandler: Handler = () => undefined
    const exactChildHandler: Handler = () => undefined

    router.add('GET', '/files/*', [wildcardHandler])
    router.add('GET', '/files/public/image', [exactChildHandler])

    const match = router.match('GET', '/files/public')

    expect(match).not.toBeNull()
    expect(match?.matched).toBe(true)
    expect(match?.handlers).toEqual([wildcardHandler])
    expect(match?.params).toEqual({ '*': 'public' })
  })

  test('rejects conflicting param names for the same route shape', () => {
    const router = new RadixRouter()
    const handler: Handler = () => undefined

    router.add('GET', '/users/:id', [handler])

    expect(() => router.add('POST', '/users/:name', [handler])).toThrow(
      'Conflicting param name for route shape'
    )
  })

  test('normalizes trailing slash for static routes', () => {
    const router = new RadixRouter()
    const handler: Handler = () => undefined

    router.add('GET', '/users/', [handler])

    const match = router.match('GET', '/users')

    expect(match).not.toBeNull()
    expect(match?.matched).toBe(true)
    expect(match?.handlers).toEqual([handler])
  })

  test('normalizes trailing slash for dynamic routes', () => {
    const router = new RadixRouter()
    const handler: Handler = () => undefined

    router.add('GET', '/users/:id/', [handler])

    const match = router.match('GET', '/users/42/')

    expect(match).not.toBeNull()
    expect(match?.matched).toBe(true)
    expect(match?.handlers).toEqual([handler])
    expect(match?.params).toEqual({ id: '42' })
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
