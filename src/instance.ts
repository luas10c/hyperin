import {
  createServer,
  IncomingMessage,
  Server,
  ServerResponse
} from 'node:http'
import type { Socket } from 'node:net'

import { Request } from './request'
import { Response } from './response'
import { RadixRouter } from './router'

// ─────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────

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

export interface ShutdownOptions {
  /**
   * Tempo máximo em ms para aguardar requests em andamento terminarem.
   * Após esse tempo, as conexões restantes são destruídas forçadamente.
   * Default: 10000 (10s)
   */
  timeout?: number
  /**
   * Callback chamado quando todos os requests drenaram com sucesso.
   */
  onShutdown?: () => void | Promise<void>
  /**
   * Callback chamado se o shutdown exceder o timeout sem drenar.
   */
  onTimeout?: () => void | Promise<void>
  /**
   * Sinais do SO a interceptar. Default: ['SIGTERM', 'SIGINT']
   */
  signals?: NodeJS.Signals[]
}

// RouteChain
// ─────────────────────────────────────────────────────────────

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

// ─────────────────────────────────────────────────────────────
// Hyperin
// ─────────────────────────────────────────────────────────────

class Hyperin {
  #router: RadixRouter
  #server: Server | null = null
  #prefix: string

  // ── Graceful shutdown state ──────────────────────────────────
  // Every open TCP socket, so we can destroy idle keep-alive
  // connections that would prevent the process from exiting.
  #openSockets = new Set<Socket>()
  // Counter of requests currently being processed.
  #activeRequests = 0
  // Flipped to true on the first shutdown() call to reject new work.
  #shuttingDown = false
  // Resolves the drain Promise when #activeRequests reaches 0.
  #drainResolve: (() => void) | null = null
  // Signal handlers registered by graceful(), kept for cleanup.
  #signalHandlers: Array<{ signal: NodeJS.Signals; handler: () => void }> = []

  constructor(opts: RouterOptions = {}) {
    this.#prefix = opts.prefix || ''
    this.#router = new RadixRouter()
  }

  // ──────────────────────────────────────────────
  // Middleware
  // ──────────────────────────────────────────────

  use(handler: ErrorMiddleware): this
  use(handler: Handler): this
  use(path: string, ...handlers: Handler[]): this
  use(path: string | Handler | ErrorMiddleware, ...handlers: Handler[]): this {
    if (typeof path === 'function') {
      // If it comes without ErrorMiddleware(), try a safe fallback based on rarity type.
      this.#router.use(path as Handler)
      for (const h of handlers) this.#router.use(h)
    } else {
      const prefix = path.endsWith('/') ? path.slice(0, -1) : path
      const allHandlers = handlers

      const scoped: Handler = async ({ request, response, next }) => {
        const originalUrl = request.url || '/'
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
        request.url = originalUrl
        request.resetParsedUrl()
      }

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
      get: (...h: Handler[]) => {
        this.get(path, ...h)

        return chain
      },

      post: (...h: Handler[]) => {
        this.post(path, ...h)

        return chain
      },
      put: (...h: Handler[]) => {
        this.put(path, ...h)
        return chain
      },
      patch: (...h: Handler[]) => {
        this.patch(path, ...h)
        return chain
      },
      delete: (...h: Handler[]) => {
        this.delete(path, ...h)
        return chain
      }
    }
    return chain
  }

  /** Mount a sub-router or Hyperin instance */
  mount(prefix: string, app: Hyperin): this {
    for (const [method, path, handlers] of app.#getRoutes()) {
      this.#router.add(method, prefix + path, handlers)
    }
    return this
  }

  #getRoutes(): [HttpMethod, string, Handler[]][] {
    return this.#router.routes
  }

  #addRoute(method: HttpMethod, path: string, handlers: Handler[]): this {
    const fullPath = this.#prefix + path
    this.#router.add(method, fullPath || '/', handlers)
    return this
  }

  // ──────────────────────────────────────────────
  // Request dispatch
  // ──────────────────────────────────────────────

  async #dispatch(
    rawRequest: IncomingMessage,
    rawResponse: ServerResponse
  ): Promise<void> {
    // During shutdown, reject requests that slip through on keep-alive
    // sockets that were open before server.close() was called.
    if (this.#shuttingDown) {
      rawResponse.setHeader('Connection', 'close')
      rawResponse.statusCode = 503
      rawResponse.end('Service Unavailable')
      return
    }

    // Track in-flight count so shutdown() knows when it's safe to exit.
    this.#activeRequests++
    rawResponse.once('finish', () => {
      this.#activeRequests--
      if (this.#shuttingDown && this.#activeRequests === 0) {
        this.#drainResolve?.()
      }
    })

    const request = rawRequest as Request
    const response = rawResponse as Response

    // It builds the URL only once and reuses it for query and path.
    const rawUrl = request.url || ''
    const parsedUrl =
      rawUrl.startsWith('http://') || rawUrl.startsWith('https://')
        ? new URL(rawUrl)
        : new URL(rawUrl, `http://${request.headers?.host || 'localhost'}`)

    request.query = Object.fromEntries(parsedUrl.searchParams)

    const path = request.parsedUrl.pathname || '/'
    const method = request.method || 'GET'
    const match = this.#router.match(method, path)

    if (!match) {
      return void response
        .status(404)
        .json({ error: 'Not Found', path, method })
    }

    request.params = match.params

    const { handlers, middlewares } = match
    // It iterates through global middlewares followed by route handlers without creating a new array.
    const mLen = middlewares.length
    const hLen = handlers.length
    const total = mLen + hLen
    let idx = 0

    const next = async (): Promise<void> => {
      if (idx >= total) {
        if (!match.matched && !response.sent) {
          response.status(404).json({ error: 'Not Found', path, method })
        }
        return
      }

      const handler = idx < mLen ? middlewares[idx++] : handlers[idx++ - mLen]
      try {
        const result = await handler({ request, response, next })
        if (result !== undefined && !response.sent) {
          if (typeof result === 'string') {
            response.text(result)
          } else {
            response.json(result as object)
          }
        }
      } catch (err) {
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
  // Server lifecycle
  // ──────────────────────────────────────────────

  listen(port: number, hostname?: string, callback?: () => void): Server {
    this.#server = createServer({
      IncomingMessage: Request,
      ServerResponse: Response
    })

    // Track every TCP socket so we can destroy idle keep-alive
    // connections during shutdown without waiting for their timeout.
    this.#server.on('connection', (socket: Socket) => {
      this.#openSockets.add(socket)
      socket.once('close', () => this.#openSockets.delete(socket))
    })

    // Mark the socket as busy while a request is in flight so shutdown()
    // knows not to destroy it before the response finishes.
    this.#server.on('request', (req: IncomingMessage, res: ServerResponse) => {
      const socket = req.socket as Socket & { _busy?: boolean }
      socket._busy = true
      res.once('finish', () => {
        socket._busy = false
      })
      this.#dispatch(req, res)
    })

    const cb = callback || (() => {})
    if (hostname) {
      this.#server.listen(port, hostname, cb)
    } else {
      this.#server.listen(port, cb)
    }

    return this.#server
  }

  /**
   * Gracefully shuts down the server:
   *
   * 1. Stops accepting new connections (`server.close()`)
   * 2. Immediately destroys idle keep-alive sockets
   * 3. Waits for in-flight requests to finish
   * 4. Force-destroys remaining sockets after `timeout` ms
   * 5. Calls `onShutdown` or `onTimeout` accordingly
   */
  async shutdown(options: ShutdownOptions = {}): Promise<void> {
    if (this.#shuttingDown) return
    this.#shuttingDown = true

    const timeout = options.timeout ?? 10_000

    // Step 1 — stop accepting new TCP connections
    await new Promise<void>((resolve) => {
      if (!this.#server) return resolve()
      this.#server.close(() => resolve())
    })

    // Step 2 — destroy sockets that are idle (no request in flight).
    // Sockets currently serving a request are left open; they'll be
    // cleaned up naturally when their response 'finish' event fires.
    for (const socket of this.#openSockets) {
      const s = socket as Socket & { _busy?: boolean }
      if (!s._busy) {
        socket.destroy()
        this.#openSockets.delete(socket)
      }
    }

    // Step 3 — wait for in-flight requests to drain, with a hard timeout
    if (this.#activeRequests > 0) {
      await Promise.race([
        new Promise<void>((resolve) => {
          this.#drainResolve = resolve
        }),
        new Promise<void>((resolve) => {
          setTimeout(() => {
            // Timeout exceeded — destroy whatever sockets are left
            for (const socket of this.#openSockets) socket.destroy()
            this.#openSockets.clear()
            resolve()
          }, timeout)
        })
      ])
    }

    // Step 4 — run the appropriate callback
    if (this.#activeRequests > 0 && options.onTimeout) {
      await options.onTimeout()
    } else if (options.onShutdown) {
      await options.onShutdown()
    }
  }

  /**
   * Registers OS signal handlers (SIGTERM, SIGINT by default) that
   * call `shutdown()` and exit the process when done.
   *
   * Call this once after `listen()`:
   * @example
   * app.listen(3000)
   * app.graceful({ timeout: 15_000, onShutdown: () => db.close() })
   */
  graceful(options: ShutdownOptions = {}): this {
    const signals =
      options.signals ?? (['SIGTERM', 'SIGINT'] as NodeJS.Signals[])

    for (const signal of signals) {
      const handler = () => {
        this.shutdown(options)
          .then(() => process.exit(0))
          .catch(() => process.exit(1))
      }
      process.once(signal, handler)
      this.#signalHandlers.push({ signal, handler })
    }

    return this
  }

  /**
   * Immediately closes the server and destroys all sockets.
   * Does not wait for in-flight requests — use `shutdown()` for that.
   * Primarily useful in tests.
   */
  close(callback?: (err?: Error) => void): void {
    // Clean up signal handlers to prevent leaks across test runs
    for (const { signal, handler } of this.#signalHandlers) {
      process.removeListener(signal, handler)
    }
    this.#signalHandlers = []

    for (const socket of this.#openSockets) socket.destroy()
    this.#openSockets.clear()

    this.#server?.close(callback)
  }

  /** Returns a Node.js-compatible request handler (for testing / serverless) */
  get handler() {
    return (req: IncomingMessage, res: ServerResponse) =>
      this.#dispatch(req, res)
  }
}

export function hyperin(): Hyperin {
  return new Hyperin()
}

export default hyperin
