import { describe, expect, test } from '@jest/globals'

import {
  normalizeIp,
  parseForwardedHeader,
  resolveTrustedClientIp,
  shouldTrustForwardedHeaders
} from '#/utils/trust-proxy'

describe('trust proxy utilities', () => {
  test('normalizes IPv4-mapped IPv6 addresses', () => {
    expect(normalizeIp('::ffff:127.0.0.1')).toBe('127.0.0.1')
    expect(normalizeIp('fe80::1%lo0')).toBe('fe80::1')
  })

  test('parses forwarded header chains', () => {
    expect(parseForwardedHeader('198.51.100.1, 203.0.113.8')).toEqual([
      '198.51.100.1',
      '203.0.113.8'
    ])
  })

  test('resolves client ip for trusted hop counts', async () => {
    await expect(
      resolveTrustedClientIp('10.0.0.1', '198.51.100.1, 203.0.113.8', 1)
    ).resolves.toBe('203.0.113.8')

    await expect(
      resolveTrustedClientIp('10.0.0.1', '198.51.100.1, 203.0.113.8', 2)
    ).resolves.toBe('198.51.100.1')
  })

  test('resolves client ip for trusted CIDR allowlists', async () => {
    await expect(
      resolveTrustedClientIp('10.1.2.3', '198.51.100.1', ['10.0.0.0/8'])
    ).resolves.toBe('198.51.100.1')

    await expect(
      resolveTrustedClientIp('10.1.2.3', '198.51.100.1', ['192.168.0.0/16'])
    ).resolves.toBe('10.1.2.3')
  })

  test('supports async custom trust proxy functions', async () => {
    const trustProxy = async ({
      remoteAddress
    }: {
      remoteAddress?: string
    }) => {
      await new Promise((resolve) => setTimeout(resolve, 1))
      return remoteAddress === '127.0.0.1'
    }

    await expect(
      resolveTrustedClientIp('127.0.0.1', '198.51.100.1', trustProxy)
    ).resolves.toBe('198.51.100.1')

    await expect(
      shouldTrustForwardedHeaders('127.0.0.1', trustProxy)
    ).resolves.toBe(true)
  })
})
