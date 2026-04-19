import type { Request } from '../request'
import type { Response } from '../response'

type NextFunction = () => void | Promise<void>

type MiddlewareContext = {
  request: Request
  response: Response
  next: NextFunction
}

type Middleware = (ctx: MiddlewareContext) => void | Promise<void>

export interface HstsOptions {
  maxAge?: number
  includeSubDomains?: boolean
  preload?: boolean
}

export interface SecurityOptions {
  contentSecurityPolicy?: string | false
  crossOriginOpenerPolicy?: string | false
  crossOriginResourcePolicy?: string | false
  originAgentCluster?: boolean
  referrerPolicy?: string | false
  xContentTypeOptions?: boolean
  xDnsPrefetchControl?: 'off' | 'on' | false
  xFrameOptions?: 'DENY' | 'SAMEORIGIN' | false
  hsts?: HstsOptions | false
}

const DEFAULT_HSTS: Required<HstsOptions> = {
  maxAge: 15552000,
  includeSubDomains: true,
  preload: false
}

function isSecureRequest(request: Request): boolean {
  const forwardedProto = request.headers['x-forwarded-proto']
  const protocol = Array.isArray(forwardedProto)
    ? forwardedProto[0]
    : forwardedProto

  if (protocol) {
    return protocol.split(',')[0].trim().toLowerCase() === 'https'
  }

  return 'encrypted' in request.socket && Boolean(request.socket.encrypted)
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

  return async ({ request, response, next }) => {
    if (options.contentSecurityPolicy !== false) {
      setHeaderIfAbsent(
        response,
        'Content-Security-Policy',
        options.contentSecurityPolicy ??
          "default-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'self'; object-src 'none'"
      )
    }

    if (options.crossOriginOpenerPolicy !== false) {
      setHeaderIfAbsent(
        response,
        'Cross-Origin-Opener-Policy',
        options.crossOriginOpenerPolicy ?? 'same-origin'
      )
    }

    if (options.crossOriginResourcePolicy !== false) {
      setHeaderIfAbsent(
        response,
        'Cross-Origin-Resource-Policy',
        options.crossOriginResourcePolicy ?? 'same-origin'
      )
    }

    if (options.originAgentCluster ?? true) {
      setHeaderIfAbsent(response, 'Origin-Agent-Cluster', '?1')
    }

    if (options.referrerPolicy !== false) {
      setHeaderIfAbsent(
        response,
        'Referrer-Policy',
        options.referrerPolicy ?? 'no-referrer'
      )
    }

    if (options.xContentTypeOptions ?? true) {
      setHeaderIfAbsent(response, 'X-Content-Type-Options', 'nosniff')
    }

    if (options.xDnsPrefetchControl !== false) {
      setHeaderIfAbsent(
        response,
        'X-DNS-Prefetch-Control',
        options.xDnsPrefetchControl ?? 'off'
      )
    }

    if (options.xFrameOptions !== false) {
      setHeaderIfAbsent(
        response,
        'X-Frame-Options',
        options.xFrameOptions ?? 'SAMEORIGIN'
      )
    }

    if (hsts && isSecureRequest(request)) {
      let value = `max-age=${hsts.maxAge}`
      if (hsts.includeSubDomains) value += '; includeSubDomains'
      if (hsts.preload) value += '; preload'
      setHeaderIfAbsent(response, 'Strict-Transport-Security', value)
    }

    await next()
  }
}
