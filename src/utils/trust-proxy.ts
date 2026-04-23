import { isIP } from 'node:net'

/**
 * Context passed to a custom `trust proxy` resolver.
 *
 * `remoteAddress` is the immediate peer connected to the app.
 */
export type TrustProxyContext = {
  remoteAddress?: string
}

/**
 * Custom `trust proxy` resolver.
 *
 * Return `true` to trust the immediate peer and consume `X-Forwarded-*`.
 * Return `false` to ignore forwarded headers for the current request.
 */
export type TrustProxyFunction = (
  context: TrustProxyContext
) => boolean | Promise<boolean>

/**
 * Supported `trust proxy` configuration formats.
 *
 * - `true`: trust every proxy hop
 * - `number`: trust the closest N hops
 * - `string[]`: trust exact IPs or CIDR ranges
 * - `function`: decide per request from the immediate peer address
 */
export type TrustProxySetting =
  | boolean
  | number
  | readonly string[]
  | TrustProxyFunction

export function normalizeIp(address: string | undefined): string | undefined {
  if (!address) return undefined

  const trimmed = address.trim()
  const zoneIndex = trimmed.indexOf('%')
  const withoutZone = zoneIndex === -1 ? trimmed : trimmed.slice(0, zoneIndex)

  if (withoutZone.startsWith('::ffff:')) {
    const mapped = withoutZone.slice(7)
    if (isIP(mapped) === 4) return mapped
  }

  return withoutZone
}

function parseIpv4(address: string): Uint8Array | null {
  const parts = address.split('.')
  if (parts.length !== 4) return null

  const bytes = new Uint8Array(4)
  for (let i = 0; i < 4; i++) {
    if (!/^\d+$/.test(parts[i]!)) return null
    const value = Number(parts[i])
    if (!Number.isInteger(value) || value < 0 || value > 255) return null
    bytes[i] = value
  }

  return bytes
}

function expandIpv6Token(token: string): number[] | null {
  if (token.includes('.')) {
    const ipv4 = parseIpv4(token)
    if (!ipv4) return null
    return [(ipv4[0]! << 8) | ipv4[1]!, (ipv4[2]! << 8) | ipv4[3]!]
  }

  if (!/^[0-9a-f]{1,4}$/i.test(token)) return null
  return [parseInt(token, 16)]
}

function parseIpv6(address: string): Uint8Array | null {
  const [headSource, tailSource] = address.split('::')
  if (address.split('::').length > 2) return null

  const headTokens = headSource ? headSource.split(':').filter(Boolean) : []
  const tailTokens = tailSource ? tailSource.split(':').filter(Boolean) : []

  const headGroups: number[] = []
  for (const token of headTokens) {
    const groups = expandIpv6Token(token)
    if (!groups) return null
    headGroups.push(...groups)
  }

  const tailGroups: number[] = []
  for (const token of tailTokens) {
    const groups = expandIpv6Token(token)
    if (!groups) return null
    tailGroups.push(...groups)
  }

  const hasCompression = address.includes('::')
  const totalGroups = headGroups.length + tailGroups.length
  if ((!hasCompression && totalGroups !== 8) || totalGroups > 8) return null

  const fillCount = hasCompression ? 8 - totalGroups : 0
  const groups = [...headGroups, ...new Array(fillCount).fill(0), ...tailGroups]
  if (groups.length !== 8) return null

  const bytes = new Uint8Array(16)
  for (let i = 0; i < groups.length; i++) {
    bytes[i * 2] = groups[i]! >> 8
    bytes[i * 2 + 1] = groups[i]! & 0xff
  }

  return bytes
}

function parseIpBytes(
  address: string
): { version: 4 | 6; bytes: Uint8Array } | null {
  const normalized = normalizeIp(address)
  if (!normalized) return null

  const version = isIP(normalized)
  if (version === 4) {
    const bytes = parseIpv4(normalized)
    return bytes ? { version: 4, bytes } : null
  }

  if (version === 6) {
    const bytes = parseIpv6(normalized)
    return bytes ? { version: 6, bytes } : null
  }

  return null
}

function matchesCidr(address: string, cidr: string): boolean {
  const slashIndex = cidr.indexOf('/')
  if (slashIndex === -1) return false

  const base = cidr.slice(0, slashIndex)
  const prefix = Number.parseInt(cidr.slice(slashIndex + 1), 10)
  const candidate = parseIpBytes(address)
  const network = parseIpBytes(base)

  if (!candidate || !network || candidate.version !== network.version) {
    return false
  }

  const maxBits = candidate.version === 4 ? 32 : 128
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > maxBits) return false

  const fullBytes = Math.floor(prefix / 8)
  const partialBits = prefix % 8

  for (let i = 0; i < fullBytes; i++) {
    if (candidate.bytes[i] !== network.bytes[i]) return false
  }

  if (partialBits === 0) return true

  const mask = 0xff << (8 - partialBits)
  return (
    (candidate.bytes[fullBytes]! & mask) === (network.bytes[fullBytes]! & mask)
  )
}

function matchesTrustedEntry(address: string, entry: string): boolean {
  const normalizedAddress = normalizeIp(address)
  const normalizedEntry = normalizeIp(entry)
  if (!normalizedAddress || !normalizedEntry) return false

  if (entry.includes('/')) {
    return matchesCidr(normalizedAddress, normalizedEntry)
  }

  return normalizedAddress === normalizedEntry
}

async function isTrustedHop(
  address: string | undefined,
  trustProxy: TrustProxySetting,
  hop: number
): Promise<boolean> {
  const normalizedAddress = normalizeIp(address)
  if (!normalizedAddress) return false

  if (trustProxy === true) return true
  if (trustProxy === false) return false
  if (typeof trustProxy === 'number') {
    return Number.isInteger(trustProxy) && trustProxy > 0 && hop < trustProxy
  }
  if (Array.isArray(trustProxy)) {
    return trustProxy.some((entry) =>
      matchesTrustedEntry(normalizedAddress, entry)
    )
  }

  const trustProxyFunction = trustProxy as TrustProxyFunction

  return await trustProxyFunction({
    remoteAddress: normalizedAddress
  })
}

export function parseForwardedHeader(
  value: string | string[] | undefined
): string[] {
  const source = Array.isArray(value) ? value.join(',') : value
  if (!source) return []

  return source
    .split(',')
    .map((part) => normalizeIp(part))
    .filter((part): part is string => Boolean(part))
}

export async function shouldTrustForwardedHeaders(
  remoteAddress: string | undefined,
  trustProxy: TrustProxySetting | undefined
): Promise<boolean> {
  if (trustProxy === undefined || trustProxy === false) return false
  return await isTrustedHop(remoteAddress, trustProxy, 0)
}

export async function resolveTrustedClientIp(
  remoteAddress: string | undefined,
  forwardedFor: string | string[] | undefined,
  trustProxy: TrustProxySetting | undefined
): Promise<string> {
  const normalizedRemote = normalizeIp(remoteAddress)
  if (!normalizedRemote || trustProxy === undefined || trustProxy === false) {
    return normalizedRemote ?? ''
  }

  const forwardedChain = parseForwardedHeader(forwardedFor)
  if (forwardedChain.length === 0) return normalizedRemote

  const chain = [...forwardedChain, normalizedRemote]
  for (let i = chain.length - 1; i >= 0; i--) {
    const hop = chain.length - 1 - i
    if (!(await isTrustedHop(chain[i], trustProxy, hop))) {
      return chain[i]!
    }
  }

  return chain[0]!
}
