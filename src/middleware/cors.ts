import type { Request } from '../request'
import type { Response } from '../response'

type NextFunction = () => void | Promise<void>

type HandlerContext = {
  request: Request
  response: Response
}

type MiddlewareContext = HandlerContext & { next: NextFunction }

type Middleware = (ctx: MiddlewareContext) => void | Promise<void>

export interface CorsOptions {
  /**
   * string     → fixed origin, e.g., 'http://example.com'
   * string[]   → list of allowed origins
   * RegExp     → tests the origin
   * true       → reflect the origin of the request (equivalent to '*' with credentials)
   * false      → disable CORS completely
   * function   → asynchronous callback(origin, cb), same as express/cors
   */
  origin?:
    | string
    | string[]
    | RegExp
    | boolean
    | ((
        origin: string | undefined,
        cb: (err: Error | null, allow?: boolean | string) => void
      ) => void)

  methods?: string | string[]
  allowedHeaders?: string | string[]
  exposedHeaders?: string | string[]
  credentials?: boolean
  maxAge?: number
  preflightContinue?: boolean
  optionsSuccessStatus?: number
}

const DEFAULT_CORS: Required<CorsOptions> = {
  origin: '*',
  methods: 'GET,HEAD,PUT,PATCH,POST,DELETE',
  allowedHeaders: '', // vazio = reflete Access-Control-Request-Headers
  exposedHeaders: '',
  credentials: false,
  maxAge: 0,
  preflightContinue: false,
  optionsSuccessStatus: 204
}

// Normalize string|string[] to string
function toHeaderValue(v: string | string[]): string {
  return Array.isArray(v) ? v.join(', ') : v
}

// Resolve the origin — returns the string to use or false to block
function resolveOrigin(
  origin: CorsOptions['origin'],
  reqOrigin: string | undefined
): Promise<string | false> {
  return new Promise((resolve, reject) => {
    if (origin === '*') {
      return resolve('*')
    }

    if (origin === false) {
      return resolve(false)
    }

    // true -> reflect the origin of the request (or '*' if none provided)
    if (origin === true) {
      return resolve(reqOrigin || '*')
    }

    if (typeof origin === 'string') {
      return resolve(reqOrigin === origin ? origin : false)
    }

    if (origin instanceof RegExp) {
      return resolve(reqOrigin && origin.test(reqOrigin) ? reqOrigin : false)
    }

    if (Array.isArray(origin)) {
      return resolve(
        reqOrigin &&
          origin.some((o: RegExp | string) =>
            o instanceof RegExp ? o.test(reqOrigin) : o === reqOrigin
          )
          ? reqOrigin
          : false
      )
    }

    if (typeof origin === 'function') {
      return origin(reqOrigin, (err, result) => {
        if (err) return reject(err)

        if (result === true) return resolve(reqOrigin || '*')
        if (result === false) return resolve(false)
        if (typeof result === 'string') return resolve(result)

        // result pode ser qualquer tipo permitido por CorsOptions['origin']
        resolveOrigin(result as CorsOptions['origin'], reqOrigin)
          .then(resolve)
          .catch(reject)
      })
    }

    resolve(false)
  })
}

export function cors(options: CorsOptions = {}): Middleware {
  const cfg = { ...DEFAULT_CORS, ...options }

  return async ({ request, response, next }) => {
    const reqOrigin = request.headers['origin'] as string | undefined
    const methods = toHeaderValue(cfg.methods)

    const allowOrigin = await resolveOrigin(cfg.origin, reqOrigin)

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
        response.header('Vary', 'Origin')
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
            vary
              ? `${vary}, Access-Control-Request-Headers`
              : 'Access-Control-Request-Headers'
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
      response.header('Vary', 'Origin')
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
