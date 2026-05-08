import type { Middleware } from '#/types'

type CorsOriginResolverResult = string | string[] | RegExp | boolean | undefined

type CorsOriginResolver = (
  origin: string | undefined
) => CorsOriginResolverResult | Promise<CorsOriginResolverResult>

export interface CorsOptions {
  /**
   * string     → fixed origin, e.g., 'http://example.com'
   * string[]   → list of allowed origins
   * RegExp     → tests the origin
   * true       → reflect the origin of the request
   * false      → disable CORS completely
   * function   → returns the allowed origin dynamically and may be async
   *
   * When `credentials: true`, prefer an explicit allowlist instead of `'*'`.
   */
  origin?: string | string[] | RegExp | boolean | CorsOriginResolver

  methods?: string | string[]
  allowedHeaders?: string | string[]
  exposedHeaders?: string | string[]
  /**
   * Enables `Access-Control-Allow-Credentials: true`.
   *
   * Browsers reject credentialed CORS responses with `Access-Control-Allow-Origin: *`.
   * Use a fixed origin, allowlist, regexp, or resolver when cookies or auth headers are involved.
   */
  credentials?: boolean
  maxAge?: number
  preflightContinue?: boolean
  optionsSuccessStatus?: number
  strictCredentials?: boolean
}

const DEFAULT_CORS: Required<CorsOptions> = {
  origin: '*',
  methods: 'GET,HEAD,PUT,PATCH,POST,DELETE',
  allowedHeaders: '', // vazio = reflete Access-Control-Request-Headers
  exposedHeaders: '',
  credentials: false,
  maxAge: 0,
  preflightContinue: false,
  optionsSuccessStatus: 204,
  strictCredentials: false
}

function testOriginRegex(regex: RegExp, value: string): boolean {
  regex.lastIndex = 0
  return regex.test(value)
}

function appendVary(
  current: number | string | string[] | readonly string[] | undefined,
  value: string
): string {
  if (current === undefined) return value

  const source = Array.isArray(current) ? current.join(', ') : String(current)
  const normalizedValue = value.toLowerCase()

  for (const part of source.split(',')) {
    if (part.trim().toLowerCase() === normalizedValue) return source
  }

  return `${source}, ${value}`
}

// Normalize string|string[] to string
function toHeaderValue(v: string | string[]): string {
  return Array.isArray(v) ? v.join(', ') : v
}

// Resolve the origin — returns the string to use or false to block
async function resolveOrigin(
  origin: CorsOptions['origin'],
  reqOrigin: string | undefined
): Promise<string | false> {
  if (origin === '*') {
    return '*'
  }

  if (origin === false) {
    return false
  }

  // true -> reflect the origin of the request (or '*' if none provided)
  if (origin === true) {
    return reqOrigin || '*'
  }

  if (typeof origin === 'string') {
    return reqOrigin === origin ? origin : false
  }

  if (origin instanceof RegExp) {
    return reqOrigin && testOriginRegex(origin, reqOrigin) ? reqOrigin : false
  }

  if (Array.isArray(origin)) {
    return reqOrigin &&
      origin.some((o: RegExp | string) =>
        o instanceof RegExp ? testOriginRegex(o, reqOrigin) : o === reqOrigin
      )
      ? reqOrigin
      : false
  }

  if (typeof origin === 'function') {
    return resolveOrigin(await origin(reqOrigin), reqOrigin)
  }

  return false
}

function resolveAllowedOrigin(
  allowOrigin: string | false,
  reqOrigin: string | undefined,
  credentials: boolean
): string | false {
  if (allowOrigin === false) return false
  if (!credentials || allowOrigin !== '*') return allowOrigin
  return reqOrigin || false
}

export function cors(options: CorsOptions = {}): Middleware {
  const cfg = { ...DEFAULT_CORS, ...options }

  if (cfg.strictCredentials && cfg.credentials && cfg.origin === true) {
    throw new TypeError(
      'cors: origin=true with credentials=true is unsafe; use explicit allowlist'
    )
  }

  return async ({ request, response, next }) => {
    const reqOrigin = request.headers['origin'] as string | undefined
    const methods = toHeaderValue(cfg.methods)

    const allowOrigin = resolveAllowedOrigin(
      await resolveOrigin(cfg.origin, reqOrigin),
      reqOrigin,
      cfg.credentials
    )

    // ── Preflight (OPTIONS) ────────────────────────────────────
    if (request.method === 'OPTIONS') {
      if (allowOrigin === false) {
        // origin not allowed — pass to the next handler
        if (cfg.preflightContinue) return void (await next())
        return void response.status(cfg.optionsSuccessStatus).send()
      }

      response.header('Access-Control-Allow-Origin', allowOrigin)

      // Vary: Origin whenever not '*'
      if (allowOrigin !== '*') {
        response.header(
          'Vary',
          appendVary(response.getHeader('Vary'), 'Origin')
        )
      }

      if (cfg.credentials) {
        response.header('Access-Control-Allow-Credentials', 'true')
      }

      response.header('Access-Control-Allow-Methods', methods)

      // allowedHeaders: uses the request headers if not configured
      const allowedHeaders = cfg.allowedHeaders
        ? toHeaderValue(cfg.allowedHeaders)
        : (request.headers['access-control-request-headers'] as
            | string
            | undefined) || ''

      if (allowedHeaders) {
        response.header('Access-Control-Allow-Headers', allowedHeaders)
        // Vary: Access-Control-Request-Headers se refletiu os headers do request
        if (!cfg.allowedHeaders) {
          const vary = response.getHeader('Vary')
          response.header(
            'Vary',
            appendVary(vary, 'Access-Control-Request-Headers')
          )
        }
      }

      if (cfg.maxAge) {
        response.header('Access-Control-Max-Age', String(cfg.maxAge))
      }

      if (cfg.preflightContinue) {
        return void (await next())
      }

      return void response.status(cfg.optionsSuccessStatus).send()
    }

    // ── Normal request ───────────────────────────────────────
    if (allowOrigin === false) {
      return void (await next()) // does not block — only avoids setting headers
    }

    response.header('Access-Control-Allow-Origin', allowOrigin)

    if (allowOrigin !== '*') {
      response.header('Vary', appendVary(response.getHeader('Vary'), 'Origin'))
    }

    if (cfg.credentials) {
      response.header('Access-Control-Allow-Credentials', 'true')
    }

    const exposed = toHeaderValue(cfg.exposedHeaders)
    if (exposed) {
      response.header('Access-Control-Expose-Headers', exposed)
    }

    await next()
  }
}
