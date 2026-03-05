import {
  createServer,
  IncomingMessage,
  ServerOptions,
  Server,
  ServerResponse
} from 'node:http'
import type { Socket } from 'node:net'
import type { ParsedUrlQuery } from 'node:querystring'

import { RadixRouter } from './router'

type NextFunction = () => void | Promise<void>

export type HandlerReturn =
  | void
  | undefined
  | string
  | unknown[]
  | Record<string, unknown>
  | Promise<void | undefined | string | unknown[] | Record<string, unknown>>

export type HandlerContext = {
  request: Request
  response: Response
  next: NextFunction
}

export type ErrorContext = HandlerContext & {
  error: Error
  next: NextFunction
}

export type Handler = (ctx: HandlerContext) => HandlerReturn
export type ErrorMiddleware = (ctx: ErrorContext) => void | Promise<void>

export type HttpMethod =
  | 'GET'
  | 'POST'
  | 'PUT'
  | 'PATCH'
  | 'DELETE'
  | 'HEAD'
  | 'OPTIONS'
  | 'ALL'

export interface RouterOptions {
  prefix?: string
}

export class Request extends IncomingMessage {
  /** Parsed route params e.g. /users/:id → req.params.id */
  params: Record<string, string> = {}
  /** Parsed query string */
  query: ParsedUrlQuery = {}
  /** Parsed body (requires bodyParser middleware) */
  body:
    | Record<string, string>
    | Record<string, unknown>
    | Record<string, string | string[]>
    | string
    | undefined = undefined
  /** Uploaded files (requires multipart middleware) */
  files: Record<string, unknown> = {}
  /** Custom state bag for middleware communication */
  locals: Record<string, unknown> = {}
  /** Parsed cookies — populated automatically from Cookie header */
  cookies: Record<string, string> = {}

  #parsedUrl: URL | null = null

  constructor(socket: Socket) {
    super(socket)
  }

  get parsedUrl(): URL {
    if (!this.#parsedUrl) {
      this.#parsedUrl = new URL(
        this.url || '/',
        `http://${this.headers.host || 'localhost'}`
      )
    }
    return this.#parsedUrl
  }

  resetParsedUrl(): void {
    this.#parsedUrl = null
  }

  get path(): string {
    return this.parsedUrl.pathname
  }

  get ipAddress(): string {
    const forwarded = this.headers['x-forwarded-for']
    if (forwarded) {
      return (Array.isArray(forwarded) ? forwarded[0] : forwarded)
        .split(',')[0]
        .trim()
    }
    return this.socket.remoteAddress || ''
  }

  get(header: string): string | string[] | undefined {
    return this.headers[header.toLowerCase()]
  }

  is(type: string): boolean {
    const contentType = this.headers['content-type'] || ''
    return contentType.includes(type)
  }
}

interface CookieOptions {
  maxAge?: number
  domain?: string
  path?: string
  secure?: boolean
  httpOnly?: boolean
  sameSite?: string
}

export class Response extends ServerResponse<Request> {
  #sent = false

  constructor(request: Request) {
    super(request)
  }

  get sent(): boolean {
    return this.#sent || this.writableEnded
  }

  get contentLength(): number {
    const value = this.getHeader('Content-Length')
    if (typeof value === 'number') return value
    if (typeof value === 'string') return parseInt(value, 10)
    return 0
  }

  json<T extends object>(obj: T): this {
    if (this.sent) return this
    this.setHeader('Content-Type', 'application/json; charset=utf-8')
    const body = JSON.stringify(obj)
    this.setHeader('Content-Length', Buffer.byteLength(body))
    this.end(body)
    this.#sent = true
    return this
  }

  text(value: string): this {
    if (this.sent) return this
    this.setHeader('Content-Type', 'text/plain; charset=utf-8')
    this.setHeader('Content-Length', Buffer.byteLength(value))
    this.end(value)
    this.#sent = true
    return this
  }

  html(value: string): this {
    if (this.sent) return this
    this.setHeader('Content-Type', 'text/html; charset=utf-8')
    this.setHeader('Content-Length', Buffer.byteLength(value))
    this.end(value)
    this.#sent = true
    return this
  }

  send(body?: string | object | Buffer): this {
    if (this.sent) return this

    if (body === undefined || body === null) {
      this.end()
      this.#sent = true
      return this
    }

    if (Buffer.isBuffer(body)) {
      this.setHeader('Content-Type', 'application/octet-stream')
      this.setHeader('Content-Length', body.length)
      this.end(body)
      this.#sent = true
      return this
    }

    if (typeof body === 'object') {
      return this.json(body)
    }

    return this.text(body)
  }

  redirect(url: string, statusCode = 302): this {
    this.setHeader('Location', url)
    this.statusCode = statusCode
    this.end()
    this.#sent = true
    return this
  }

  header(key: string, value: number | string | readonly string[]): this {
    this.setHeader(key, value)
    return this
  }

  status(statusCode: number): this {
    this.statusCode = statusCode
    return this
  }

  type(contentType: string): this {
    this.setHeader('Content-Type', contentType)
    return this
  }

  cookie(name: string, value: string, options: CookieOptions = {}): this {
    let cookie = `${encodeURIComponent(name)}=${encodeURIComponent(value)}`
    cookie += `; Path=${options.path ?? '/'}`

    if (options.maxAge) cookie += `; Max-Age=${options.maxAge}`
    if (options.domain) cookie += `; Domain=${options.domain}`
    if (options.secure) cookie += '; Secure'
    if (options.httpOnly) cookie += '; HttpOnly'
    if (options.sameSite) cookie += `; SameSite=${options.sameSite}`
    this.setHeader('Set-Cookie', cookie)
    return this
  }
}

interface RouteChain {
  get(handler: Handler): RouteChain
  get(...handlers: Handler[]): RouteChain
  post(handler: Handler): RouteChain
  post(...handlers: Handler[]): RouteChain
  put(handler: Handler): RouteChain
  put(...handlers: Handler[]): RouteChain
  patch(handler: Handler): RouteChain
  patch(...handlers: Handler[]): RouteChain
  delete(handler: Handler): RouteChain
  delete(...handlers: Handler[]): RouteChain
}

const options: ServerOptions<typeof Request, typeof Response> = {
  IncomingMessage: Request,
  ServerResponse: Response
}

class Highen {
  #router: RadixRouter
  #server: Server<typeof Request, typeof Response> | null = null
  #prefix: string

  constructor(options: RouterOptions = {}) {
    this.#prefix = options.prefix || ''
    this.#router = new RadixRouter()
    /* this.#errorHandler = ({ error, response }) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const status = (error as any).status || (error as any).statusCode || 500
      response.status(status).json({
        error: error.message || 'Internal Server Error',
        ...(process.env.NODE_ENV !== 'production' ? { stack: error.stack } : {})
      })
    } */
  }

  // ──────────────────────────────────────────────
  // Middleware
  // ──────────────────────────────────────────────

  use(handler: ErrorMiddleware): this
  use(handler: Handler): this
  use(path: string, ...handlers: Handler[]): this
  use(path: string | Handler | ErrorMiddleware, ...handlers: Handler[]): this {
    if (typeof path === 'function') {
      this.#router.use(path as Handler)
      for (const h of handlers) this.#router.use(h)
    } else {
      const prefix = path.endsWith('/') ? path.slice(0, -1) : path
      const allHandlers = handlers

      const scoped: Handler = async ({ request, response, next }) => {
        const originalUrl = request.url || '/'

        // Strip do prefixo para o handler ver apenas o path relativo
        const rawPath = originalUrl.split('?')[0]
        const relativePath = rawPath.slice(prefix.length) || '/'
        const qs = originalUrl.includes('?')
          ? originalUrl.slice(originalUrl.indexOf('?'))
          : ''
        request.url = relativePath + qs
        request.resetParsedUrl()

        const chain = [...allHandlers]
        const run = async (i: number): Promise<void> => {
          if (i >= chain.length) {
            request.url = originalUrl
            request.resetParsedUrl()
            return next()
          }
          await chain[i]({ request, response, next: () => run(i + 1) })
        }

        await run(0)

        // Restaura após a cadeia terminar
        request.url = originalUrl
        request.resetParsedUrl()
      }

      // Registra rota exata + wildcard para capturar qualquer subpath
      this.#addRoute('GET', prefix, [scoped])
      this.#addRoute('GET', `${prefix}/*`, [scoped])
      this.#addRoute('HEAD', prefix, [scoped])
      this.#addRoute('HEAD', `${prefix}/*`, [scoped])
    }

    return this
  }

  // ──────────────────────────────────────────────
  // Route registration
  // ──────────────────────────────────────────────

  get(path: string, ...handlers: Handler[]): this {
    return this.#addRoute('GET', path, handlers)
  }

  post(path: string, ...handlers: Handler[]): this {
    return this.#addRoute('POST', path, handlers)
  }

  put(path: string, ...handlers: Handler[]): this {
    return this.#addRoute('PUT', path, handlers)
  }

  patch(path: string, ...handlers: Handler[]): this {
    return this.#addRoute('PATCH', path, handlers)
  }

  delete(path: string, ...handlers: Handler[]): this {
    return this.#addRoute('DELETE', path, handlers)
  }

  head(path: string, ...handlers: Handler[]): this {
    return this.#addRoute('HEAD', path, handlers)
  }

  options(path: string, ...handlers: Handler[]): this {
    return this.#addRoute('OPTIONS', path, handlers)
  }

  all(path: string, ...handlers: Handler[]): this {
    return this.#addRoute('ALL', path, handlers)
  }

  route(path: string): RouteChain {
    const chain: RouteChain = {
      get: (...handlers: Handler[]) => {
        this.get(path, ...handlers)
        return chain
      },
      post: (...handlers: Handler[]) => {
        this.post(path, ...handlers)
        return chain
      },
      put: (...handlers: Handler[]) => {
        this.put(path, ...handlers)
        return chain
      },
      patch: (...handlers: Handler[]) => {
        this.patch(path, ...handlers)
        return chain
      },
      delete: (...handlers: Handler[]) => {
        this.delete(path, ...handlers)
        return chain
      }
    }

    return chain
  }

  /** Mount a sub-router or Highen instance */
  mount(prefix: string, app: Highen): this {
    //app.#prefix = prefix
    // Merge routes from sub-app into parent's router
    for (const [method, path, handlers] of app.#getRoutes()) {
      this.#router.add(method, prefix + path, handlers)
      //this.#addRoute(method as HttpMethod, prefix + path, handlers)
    }
    return this
  }

  #getRoutes(): [HttpMethod, string, Handler[]][] {
    return this.#router.routes
  }

  #addRoute(
    method: HttpMethod,
    path: string,
    handlers: (Handler | Handler)[]
  ): this {
    const fullPath = this.#prefix + path
    this.#router.add(method, fullPath || '/', handlers)
    return this
  }

  // ──────────────────────────────────────────────
  // Request dispatch
  // ──────────────────────────────────────────────

  async #dispatch(request: Request, response: Response): Promise<void> {
    // intercepta status >= 400 e redireciona para error middlewares
    const originalStatus = response.status.bind(response)
    response.status = (code: number) => {
      if (code >= 400 && !response.sent) {
        const err = Object.assign(new Error(String(code)), {
          statusCode: code
        })
        // agenda para depois do return chain terminar
        Promise.resolve().then(() => {
          if (!response.sent) this.#runErrorMiddlewares(err, request, response)
        })
      }
      return originalStatus(code)
    }

    // Parse query string once
    const rawUrl = request.url || ''
    const url =
      rawUrl.startsWith('http://') || rawUrl.startsWith('https://')
        ? new URL(rawUrl)
        : new URL(rawUrl, `http://${request.headers?.host || 'localhost'}`)
    request.query = Object.fromEntries(url.searchParams)

    const path = request.path || '/'
    const method = request.method || 'GET'
    const match = this.#router.match(method, path)

    if (!match) {
      return void response
        .status(404)
        .json({ error: 'Not Found', path, method })
    }

    request.params = match.params

    const { handlers } = match
    let idx = 0

    const next = async (): Promise<void> => {
      if (idx >= handlers.length) {
        if (!match.matched && !response.sent) {
          response.status(404).json({ error: 'Not Found', path, method })
        }
        return
      }

      const handler = handlers[idx++]
      try {
        const result = await handler({ request, response, next })
        if (result !== undefined && !response.sent) {
          if (typeof result === 'string') {
            response.text(result as string)
          } else {
            response.json(result as object)
          }
        }
      } catch (err) {
        // redireciona para error middlewares que estão na cadeia (ex: logger → errorHandler)
        await this.#runErrorMiddlewares(err as Error, request, response)
      }
    }

    await next()
  }

  async #runErrorMiddlewares(
    err: Error,
    request: Request,
    response: Response
  ): Promise<void> {
    const handlers = this.#router.errorMiddlewares

    if (handlers.length === 0) {
      const statusCode =
        (err as unknown as { statusCode: number }).statusCode || 500
      response.status(statusCode).json({
        error: err.message,
        ...(process.env.NODE_ENV !== 'production' ? { stack: err.stack } : {})
      })
      return
    }

    let i = 0
    const next = async (): Promise<void> => {
      if (i >= handlers.length) return
      await handlers[i++]({ error: err, request, response, next })
    }

    await next()
  }

  // ──────────────────────────────────────────────
  // Server
  // ──────────────────────────────────────────────

  listen(port: number, hostname?: string, callback?: () => void): Server {
    this.#server = createServer(options)
    this.#server.on('request', (request: Request, response: Response) => {
      this.#dispatch(request, response)
    })

    const cb = callback || (() => {})

    if (hostname) {
      this.#server.listen(port, hostname, cb)
    } else {
      this.#server.listen(port, cb)
    }

    return this.#server
  }

  close(callback?: (err?: Error) => void): void {
    this.#server?.close(callback)
  }

  /** Returns a Node.js-compatible request handler (for testing / serverless) */
  get handler() {
    return (request: Request, response: Response) =>
      this.#dispatch(request, response)
  }
}

export function highen(): Highen {
  return new Highen()
}

export default highen
