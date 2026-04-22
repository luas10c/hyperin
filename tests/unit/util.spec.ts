import { describe, expect, test } from '@jest/globals'

import { parseLimit } from '#/util'

describe('parseLimit', () => {
  test('converts bytes, kb, mb and gb', () => {
    expect(parseLimit('10b')).toBe(10)
    expect(parseLimit('1kb')).toBe(1024)
    expect(parseLimit('2mb')).toBe(2 * 1024 * 1024)
    expect(parseLimit('1gb')).toBe(1024 * 1024 * 1024)
  })

  test('accepts decimal values', () => {
    expect(parseLimit('1.5kb')).toBe(1536)
  })

  test('uses 1mb as fallback for invalid input', () => {
    expect(parseLimit('abc')).toBe(1024 * 1024)
  })
})
