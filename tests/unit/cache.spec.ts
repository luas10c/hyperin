import { describe, it, expect } from '@jest/globals'

import { LRUCache } from '#/cache'

describe('LRUCache', () => {
  // ─────────────────────────────────────────────────────────────
  // Constructor & basic properties
  // ─────────────────────────────────────────────────────────────

  describe('constructor', () => {
    it('starts empty', () => {
      const cache = new LRUCache<string, number>(10)
      expect(cache.size).toBe(0)
    })
  })

  // ─────────────────────────────────────────────────────────────
  // set / get
  // ─────────────────────────────────────────────────────────────

  describe('set / get', () => {
    it('stores and retrieves a value', () => {
      const cache = new LRUCache<string, string>(10)
      cache.set('a', 'hello')
      expect(cache.get('a')).toBe('hello')
    })

    it('returns undefined for missing key', () => {
      const cache = new LRUCache<string, number>(10)
      expect(cache.get('missing')).toBeUndefined()
    })

    it('overwrites existing key', () => {
      const cache = new LRUCache<string, number>(10)
      cache.set('x', 1)
      cache.set('x', 2)
      expect(cache.get('x')).toBe(2)
      expect(cache.size).toBe(1)
    })

    it('stores falsy values correctly (0, false, null)', () => {
      const cache = new LRUCache<string, unknown>(10)
      cache.set('zero', 0)
      cache.set('false', false)
      cache.set('null', null)
      expect(cache.get('zero')).toBe(0)
      expect(cache.get('false')).toBe(false)
      expect(cache.get('null')).toBeNull()
    })
  })

  // ─────────────────────────────────────────────────────────────
  // LRU eviction
  // ─────────────────────────────────────────────────────────────

  describe('LRU eviction', () => {
    it('evicts the least recently used item when full', () => {
      const cache = new LRUCache<string, number>(3)
      cache.set('a', 1)
      cache.set('b', 2)
      cache.set('c', 3)
      // 'a' is LRU — inserting 'd' should evict 'a'
      cache.set('d', 4)
      expect(cache.get('a')).toBeUndefined()
      expect(cache.get('b')).toBe(2)
      expect(cache.get('c')).toBe(3)
      expect(cache.get('d')).toBe(4)
    })

    it('promotes accessed item so it is not evicted', () => {
      const cache = new LRUCache<string, number>(3)
      cache.set('a', 1)
      cache.set('b', 2)
      cache.set('c', 3)
      // access 'a' → it becomes MRU
      cache.get('a')
      // 'b' is now LRU
      cache.set('d', 4)
      expect(cache.get('b')).toBeUndefined()
      expect(cache.get('a')).toBe(1)
    })

    it('re-setting an existing key refreshes its position', () => {
      const cache = new LRUCache<string, number>(3)
      cache.set('a', 1)
      cache.set('b', 2)
      cache.set('c', 3)
      // re-set 'a' → 'a' becomes MRU, 'b' is now LRU
      cache.set('a', 10)
      cache.set('d', 4)
      expect(cache.get('b')).toBeUndefined()
      expect(cache.get('a')).toBe(10)
    })

    it('keeps size at max after multiple insertions', () => {
      const cache = new LRUCache<number, number>(5)
      for (let i = 0; i < 20; i++) cache.set(i, i)
      expect(cache.size).toBe(5)
    })
  })

  // ─────────────────────────────────────────────────────────────
  // has
  // ─────────────────────────────────────────────────────────────

  describe('has', () => {
    it('returns true for existing key', () => {
      const cache = new LRUCache<string, number>(10)
      cache.set('k', 42)
      expect(cache.has('k')).toBe(true)
    })

    it('returns false for missing key', () => {
      const cache = new LRUCache<string, number>(10)
      expect(cache.has('missing')).toBe(false)
    })

    it('returns false after key is deleted', () => {
      const cache = new LRUCache<string, number>(10)
      cache.set('k', 1)
      cache.delete('k')
      expect(cache.has('k')).toBe(false)
    })
  })

  // ─────────────────────────────────────────────────────────────
  // delete
  // ─────────────────────────────────────────────────────────────

  describe('delete', () => {
    it('removes a key', () => {
      const cache = new LRUCache<string, number>(10)
      cache.set('k', 1)
      cache.delete('k')
      expect(cache.get('k')).toBeUndefined()
      expect(cache.size).toBe(0)
    })

    it('is a no-op for missing key', () => {
      const cache = new LRUCache<string, number>(10)
      expect(() => cache.delete('nope')).not.toThrow()
    })
  })

  // ─────────────────────────────────────────────────────────────
  // clear
  // ─────────────────────────────────────────────────────────────

  describe('clear', () => {
    it('removes all entries', () => {
      const cache = new LRUCache<string, number>(10)
      cache.set('a', 1)
      cache.set('b', 2)
      cache.clear()
      expect(cache.size).toBe(0)
      expect(cache.get('a')).toBeUndefined()
      expect(cache.get('b')).toBeUndefined()
    })
  })

  // ─────────────────────────────────────────────────────────────
  // size
  // ─────────────────────────────────────────────────────────────

  describe('size', () => {
    it('tracks size correctly through set/delete', () => {
      const cache = new LRUCache<string, number>(10)
      expect(cache.size).toBe(0)
      cache.set('a', 1)
      expect(cache.size).toBe(1)
      cache.set('b', 2)
      expect(cache.size).toBe(2)
      cache.delete('a')
      expect(cache.size).toBe(1)
    })
  })
})
