import type { Request } from '#/request'
import type { Response } from '#/response'
import type { Middleware } from '#/types'

export interface HstsOptions {
  /**
   * HSTS max-age value in seconds.
   * @default 15552000
   */
  maxAge?: number

  /**
   * Adds the `includeSubDomains` directive to the HSTS header.
   * @default true
   */
  includeSubDomains?: boolean

  /**
   * Adds the `preload` directive to the HSTS header.
   * @default false
   */
  preload?: boolean
}

export interface SecurityOptions {
  /**
   * Value for the `Content-Security-Policy` header.
   * Set to `false` to disable it.
   */
  contentSecurityPolicy?: string | false

  /**
   * Value for the `Cross-Origin-Opener-Policy` header.
   * Set to `false` to disable it.
   */
  crossOriginOpenerPolicy?: string | false

  /**
   * Value for the `Cross-Origin-Resource-Policy` header.
   * Set to `false` to disable it.
   */
  crossOriginResourcePolicy?: string | false

  /**
   * Enables the `Origin-Agent-Cluster` header.
   * @default true
   */
  originAgentCluster?: boolean

  /**
   * Value for the `Referrer-Policy` header.
   * Set to `false` to disable it.
   */
  referrerPolicy?: string | false

  /**
   * Enables the `X-Content-Type-Options: nosniff` header.
   * @default true
   */
  xContentTypeOptions?: boolean

  /**
   * Value for the `X-DNS-Prefetch-Control` header.
   * Set to `false` to disable it.
   */
  xDnsPrefetchControl?: 'off' | 'on' | false

  /**
   * Value for the `X-Frame-Options` header.
   * Set to `false` to disable it.
   */
  xFrameOptions?: 'DENY' | 'SAMEORIGIN' | false

  /**
   * Enables and configures the `Strict-Transport-Security` header.
   * Set to `false` to disable it.
   */
  hsts?: HstsOptions | false
}

const DEFAULT_HSTS: Required<HstsOptions> = {
  maxAge: 15552000,
  includeSubDomains: true,
  preload: false
}

function isSecureRequest(request: Request): boolean {
  const forwardedProtocol = (
    request.locals as { trustedForwardedProtocol?: string }
  ).trustedForwardedProtocol

  if (forwardedProtocol) {
    return forwardedProtocol.toLowerCase() === 'https'
  }

  // Avoid using 'any' in types: inspect TLS status safely
  const sock = request.socket as unknown as { encrypted?: boolean }
  if (typeof sock?.encrypted === 'boolean') {
    return sock.encrypted
  }
  return false
}

function setHeaderIfAbsent(
  response: Response,
  name: string,
  value: string | number | readonly string[]
): void {
  if (!response.hasHeader(name)) {
    response.setHeader(name, value)
  }
}

export function security(options: SecurityOptions = {}): Middleware {
  const hsts =
    options.hsts === false ? false : { ...DEFAULT_HSTS, ...options.hsts }
  const staticHeaders: Array<[string, string]> = []

  if (options.contentSecurityPolicy !== false) {
    staticHeaders.push([
      'Content-Security-Policy',
      options.contentSecurityPolicy ??
        "default-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'self'; object-src 'none'"
    ])
  }

  if (options.crossOriginOpenerPolicy !== false) {
    staticHeaders.push([
      'Cross-Origin-Opener-Policy',
      options.crossOriginOpenerPolicy ?? 'same-origin'
    ])
  }

  if (options.crossOriginResourcePolicy !== false) {
    staticHeaders.push([
      'Cross-Origin-Resource-Policy',
      options.crossOriginResourcePolicy ?? 'same-origin'
    ])
  }

  if (options.originAgentCluster ?? true) {
    staticHeaders.push(['Origin-Agent-Cluster', '?1'])
  }

  if (options.referrerPolicy !== false) {
    staticHeaders.push(['Referrer-Policy', options.referrerPolicy ?? 'no-referrer'])
  }

  if (options.xContentTypeOptions ?? true) {
    staticHeaders.push(['X-Content-Type-Options', 'nosniff'])
  }

  if (options.xDnsPrefetchControl !== false) {
    staticHeaders.push([
      'X-DNS-Prefetch-Control',
      options.xDnsPrefetchControl ?? 'off'
    ])
  }

  if (options.xFrameOptions !== false) {
    staticHeaders.push(['X-Frame-Options', options.xFrameOptions ?? 'SAMEORIGIN'])
  }

  const hstsValue =
    hsts &&
    `${`max-age=${hsts.maxAge}`}${hsts.includeSubDomains ? '; includeSubDomains' : ''}${hsts.preload ? '; preload' : ''}`

  return async ({ request, response, next }) => {
    for (let i = 0; i < staticHeaders.length; i++) {
      const [name, value] = staticHeaders[i]!
      setHeaderIfAbsent(response, name, value)
    }

    if (hstsValue && isSecureRequest(request)) {
      setHeaderIfAbsent(response, 'Strict-Transport-Security', hstsValue)
    }

    await next()
  }
}
