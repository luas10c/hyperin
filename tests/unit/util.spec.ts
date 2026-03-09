import { describe, expect, test } from '@jest/globals'

import { parseLimit } from '#/util'

describe('parseLimit', () => {
  test('converte bytes, kb, mb e gb', () => {
    expect(parseLimit('10b')).toBe(10)
    expect(parseLimit('1kb')).toBe(1024)
    expect(parseLimit('2mb')).toBe(2 * 1024 * 1024)
    expect(parseLimit('1gb')).toBe(1024 * 1024 * 1024)
  })

  test('aceita valores decimais', () => {
    expect(parseLimit('1.5kb')).toBe(1536)
  })

  test('usa 1mb como fallback para entrada inválida', () => {
    expect(parseLimit('abc')).toBe(1024 * 1024)
  })
})
