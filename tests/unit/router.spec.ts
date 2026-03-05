import { describe, it, expect } from '@jest/globals'

import { RadixRouter, type Handler, type ErrorMiddleware } from '#/router'

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

const noop: Handler = async () => {}

function makeHandler(id: string): Handler {
  const fn: Handler = async () => {}
  Object.defineProperty(fn, 'name', { value: id })
  return fn
}

describe('RadixRouter', () => {
  // ─────────────────────────────────────────────────────────────
  // add / match — static routes
  // ─────────────────────────────────────────────────────────────

  describe('static routes', () => {
    it('matches exact path', () => {
      const router = new RadixRouter()
      router.add('GET', '/users', [noop])
      const result = router.match('GET', '/users')
      expect(result).not.toBeNull()
      expect(result!.matched).toBe(true)
    })

    it('returns null for unknown route with no middlewares', () => {
      const router = new RadixRouter()
      const result = router.match('GET', '/unknown')
      expect(result).toBeNull()
    })

    it('does not match wrong method', () => {
      const router = new RadixRouter()
      router.add('GET', '/users', [noop])
      const result = router.match('POST', '/users')
      // no global middlewares → null
      expect(result).toBeNull()
    })

    it('matches ALL method for any HTTP verb', () => {
      const router = new RadixRouter()
      router.add('ALL', '/ping', [noop])
      expect(router.match('GET', '/ping')!.matched).toBe(true)
      expect(router.match('DELETE', '/ping')!.matched).toBe(true)
    })

    it('matches root path /', () => {
      const router = new RadixRouter()
      router.add('GET', '/', [noop])
      const result = router.match('GET', '/')
      expect(result!.matched).toBe(true)
    })

    it('does not match /users for /users/list', () => {
      const router = new RadixRouter()
      router.add('GET', '/users', [noop])
      const result = router.match('GET', '/users/list')
      expect(result).toBeNull()
    })
  })

  // ─────────────────────────────────────────────────────────────
  // Param routes
  // ─────────────────────────────────────────────────────────────

  describe('param routes', () => {
    it('extracts a single param', () => {
      const router = new RadixRouter()
      router.add('GET', '/users/:id', [noop])
      const result = router.match('GET', '/users/42')
      expect(result!.params).toEqual({ id: '42' })
    })

    it('extracts multiple params', () => {
      const router = new RadixRouter()
      router.add('GET', '/users/:userId/posts/:postId', [noop])
      const result = router.match('GET', '/users/1/posts/99')
      expect(result!.params).toEqual({ userId: '1', postId: '99' })
    })

    it('prefers exact match over param match', () => {
      const router = new RadixRouter()
      const exact = makeHandler('exact')
      const param = makeHandler('param')
      router.add('GET', '/users/me', [exact])
      router.add('GET', '/users/:id', [param])
      const result = router.match('GET', '/users/me')
      expect(result!.handlers).toContain(exact)
      expect(result!.handlers).not.toContain(param)
    })
  })

  // ─────────────────────────────────────────────────────────────
  // Wildcard routes
  // ─────────────────────────────────────────────────────────────

  describe('wildcard routes', () => {
    it('matches wildcard and captures rest', () => {
      const router = new RadixRouter()
      router.add('GET', '/files/*', [noop])
      const result = router.match('GET', '/files/a/b/c')
      expect(result!.matched).toBe(true)
      expect(result!.params['*']).toBe('a/b/c')
    })
  })

  // ─────────────────────────────────────────────────────────────
  // Global middlewares
  // ─────────────────────────────────────────────────────────────

  describe('global middlewares via use()', () => {
    it('prepends middleware to matched route handlers', () => {
      const router = new RadixRouter()
      const mw = makeHandler('mw')
      const h = makeHandler('h')
      router.use(mw)
      router.add('GET', '/hello', [h])
      const result = router.match('GET', '/hello')
      expect(result!.handlers[0]).toBe(mw)
      expect(result!.handlers[1]).toBe(h)
    })

    it('returns middlewares-only result for unmatched route', () => {
      const router = new RadixRouter()
      const mw = makeHandler('mw')
      router.use(mw)
      const result = router.match('GET', '/nowhere')
      expect(result).not.toBeNull()
      expect(result!.matched).toBe(false)
      expect(result!.handlers).toContain(mw)
    })

    it('routes error middleware to _errorMiddlewares', () => {
      const router = new RadixRouter()
      const errMw: ErrorMiddleware = async ({ error, response }) => {
        response.status(500).json({ error: error.message })
      }
      router.use(errMw)
      expect(router.errorMiddlewares).toContain(errMw)
    })

    it('useError() adds directly to errorMiddlewares', () => {
      const router = new RadixRouter()
      const errMw: ErrorMiddleware = async ({ error, next }) => {
        console.log(error)
        next()
      }
      router.use(errMw)
      expect(router.errorMiddlewares).toContain(errMw)
    })
  })

  // ─────────────────────────────────────────────────────────────
  // LRU cache
  // ─────────────────────────────────────────────────────────────

  describe('route cache', () => {
    it('returns cached result on second match', () => {
      const router = new RadixRouter()
      router.add('GET', '/cached', [noop])
      const r1 = router.match('GET', '/cached')
      const r2 = router.match('GET', '/cached')
      expect(r1).toBe(r2) // same reference from cache
    })
  })

  // ─────────────────────────────────────────────────────────────
  // routes getter
  // ─────────────────────────────────────────────────────────────

  describe('routes getter', () => {
    it('returns all registered routes', () => {
      const router = new RadixRouter()
      router.add('GET', '/a', [noop])
      router.add('POST', '/b', [noop])
      expect(router.routes).toHaveLength(2)
      expect(router.routes[0][0]).toBe('GET')
      expect(router.routes[1][0]).toBe('POST')
    })
  })
})
