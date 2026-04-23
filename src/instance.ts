import {
  createServer,
  IncomingMessage,
  Server,
  ServerResponse
} from 'node:http'
import type { Socket } from 'node:net'

import { Request } from './request'
import { Response } from './response'
import { errorMiddleware, RadixRouter } from './router'
import { validate } from './validation'
import { describeOperation } from './openapi'
import type { DescribeOperationInput } from './openapi'
import {
  parseForwardedHeader,
  resolveTrustedClientIp,
  shouldTrustForwardedHeaders,
  type TrustProxySetting
} from './utils/trust-proxy'
import type {
  ApplyMiddleware,
  ApplyRouteOptions,
  ErrorMiddleware,
  Handler,
  RequestRefinement,
  RouteSchemaOptions,
  RouteRequest,
  TypedMiddleware
} from './types'

export const HYPERIN_CORE = Symbol.for('hyperin.core')

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
  /**
   * Prefix applied to every route registered by the router instance.
   */
  prefix?: string
}

export interface ShutdownOptions {
  /**
   * Maximum time in ms to wait for ongoing requests to finish.
   * After this time, the remaining connections are forcibly destroyed.
   * Default: 10000 (10s)
   */
  timeout?: number
  /**
   * Callback invoked when all requests have drained successfully.
   */
  onShutdown?: () => void | Promise<void>
  /**
   * Callback invoked if the shutdown exceeds the timeout without draining.
   */
  onTimeout?: () => void | Promise<void>
  /**
   * OS signals to intercept. Default: ['SIGTERM', 'SIGINT']
   */
  signals?: NodeJS.Signals[]
}

export type AppSetting = 'x-powered-by' | 'trust proxy'
/**
 * Accepted values for `app.set('trust proxy', value)`.
 *
 * Prefer explicit IP/CIDR allowlists in production. Use `true` only when the
 * app is reachable exclusively through trusted reverse proxies.
 */
export type TrustProxyConfig = TrustProxySetting

// RouteChain
// ─────────────────────────────────────────────────────────────

interface RouteChain {
  get(...handlers: Handler[]): RouteChain
  post(...handlers: Handler[]): RouteChain
  put(...handlers: Handler[]): RouteChain
  patch(...handlers: Handler[]): RouteChain
  delete(...handlers: Handler[]): RouteChain
}

type RouteObserver = (
  method: HttpMethod,
  path: string,
  handlers: Handler[]
) => void
type MiddlewareObserver = (middleware: Handler) => void

type RouteMiddleware<TRequest extends Request> = TypedMiddleware<
  TRequest,
  RequestRefinement
>

type RouteStep1<TPath extends string> = RouteMiddleware<RouteRequest<TPath>>
type RouteStep2<
  TPath extends string,
  T1 extends RouteStep1<TPath>
> = RouteMiddleware<ApplyMiddleware<RouteRequest<TPath>, T1>>
type RouteStep3<
  TPath extends string,
  T1 extends RouteStep1<TPath>,
  T2 extends RouteStep2<TPath, T1>
> = RouteMiddleware<
  ApplyMiddleware<ApplyMiddleware<RouteRequest<TPath>, T1>, T2>
>
type RouteStep4<
  TPath extends string,
  T1 extends RouteStep1<TPath>,
  T2 extends RouteStep2<TPath, T1>,
  T3 extends RouteStep3<TPath, T1, T2>
> = RouteMiddleware<
  ApplyMiddleware<
    ApplyMiddleware<ApplyMiddleware<RouteRequest<TPath>, T1>, T2>,
    T3
  >
>
type RouteStep5<
  TPath extends string,
  T1 extends RouteStep1<TPath>,
  T2 extends RouteStep2<TPath, T1>,
  T3 extends RouteStep3<TPath, T1, T2>,
  T4 extends RouteStep4<TPath, T1, T2, T3>
> = RouteMiddleware<
  ApplyMiddleware<
    ApplyMiddleware<
      ApplyMiddleware<ApplyMiddleware<RouteRequest<TPath>, T1>, T2>,
      T3
    >,
    T4
  >
>

interface RouteMethod<TSelf> {
  <const TPath extends string>(
    path: TPath,
    ...handlers: [handler: RouteStep1<TPath>]
  ): TSelf
  <const TPath extends string, T1 extends RouteStep1<TPath>>(
    path: TPath,
    ...handlers: [handler: T1, handler: RouteStep2<TPath, T1>]
  ): TSelf
  <
    const TPath extends string,
    T1 extends RouteStep1<TPath>,
    T2 extends RouteStep2<TPath, T1>
  >(
    path: TPath,
    ...handlers: [handler: T1, handler: T2, handler: RouteStep3<TPath, T1, T2>]
  ): TSelf
  <
    const TPath extends string,
    T1 extends RouteStep1<TPath>,
    T2 extends RouteStep2<TPath, T1>,
    T3 extends RouteStep3<TPath, T1, T2>
  >(
    path: TPath,
    ...handlers: [
      handler: T1,
      handler: T2,
      handler: T3,
      handler: RouteStep4<TPath, T1, T2, T3>
    ]
  ): TSelf
  <
    const TPath extends string,
    T1 extends RouteStep1<TPath>,
    T2 extends RouteStep2<TPath, T1>,
    T3 extends RouteStep3<TPath, T1, T2>,
    T4 extends RouteStep4<TPath, T1, T2, T3>
  >(
    path: TPath,
    ...handlers: [
      handler: T1,
      handler: T2,
      handler: T3,
      handler: T4,
      handler: RouteStep5<TPath, T1, T2, T3, T4>
    ]
  ): TSelf
  <const TPath extends string>(
    path: TPath,
    ...handlers: [...Handler[], RouteStep1<TPath>]
  ): TSelf
  <const TPath extends string, T1 extends RouteStep1<TPath>>(
    path: TPath,
    ...handlers: [...Handler[], T1, RouteStep2<TPath, T1>]
  ): TSelf
  <
    const TPath extends string,
    T1 extends RouteStep1<TPath>,
    T2 extends RouteStep2<TPath, T1>
  >(
    path: TPath,
    ...handlers: [...Handler[], T1, T2, RouteStep3<TPath, T1, T2>]
  ): TSelf
  <
    const TPath extends string,
    T1 extends RouteStep1<TPath>,
    T2 extends RouteStep2<TPath, T1>,
    T3 extends RouteStep3<TPath, T1, T2>
  >(
    path: TPath,
    ...handlers: [...Handler[], T1, T2, T3, RouteStep4<TPath, T1, T2, T3>]
  ): TSelf
  <
    const TPath extends string,
    T1 extends RouteStep1<TPath>,
    T2 extends RouteStep2<TPath, T1>,
    T3 extends RouteStep3<TPath, T1, T2>,
    T4 extends RouteStep4<TPath, T1, T2, T3>
  >(
    path: TPath,
    ...handlers: [
      ...Handler[],
      T1,
      T2,
      T3,
      T4,
      RouteStep5<TPath, T1, T2, T3, T4>
    ]
  ): TSelf
  <const TPath extends string, TOptions extends RouteSchemaOptions>(
    path: TPath,
    ...handlers: [
      handler: RouteMiddleware<
        ApplyRouteOptions<RouteRequest<TPath>, TOptions>
      >,
      options: TOptions & RouteSchemaOptions
    ]
  ): TSelf
  <const TPath extends string, TOptions extends RouteSchemaOptions>(
    path: TPath,
    ...handlers: [
      ...Handler[],
      RouteMiddleware<ApplyRouteOptions<RouteRequest<TPath>, TOptions>>,
      TOptions & RouteSchemaOptions
    ]
  ): TSelf
  <
    const TPath extends string,
    TOptions extends RouteSchemaOptions,
    T1 extends RouteMiddleware<ApplyRouteOptions<RouteRequest<TPath>, TOptions>>
  >(
    path: TPath,
    ...handlers: [
      handler: T1,
      handler: RouteMiddleware<
        ApplyMiddleware<ApplyRouteOptions<RouteRequest<TPath>, TOptions>, T1>
      >,
      options: TOptions & RouteSchemaOptions
    ]
  ): TSelf
  <
    const TPath extends string,
    TOptions extends RouteSchemaOptions,
    T1 extends RouteMiddleware<ApplyRouteOptions<RouteRequest<TPath>, TOptions>>
  >(
    path: TPath,
    ...handlers: [
      ...Handler[],
      T1,
      RouteMiddleware<
        ApplyMiddleware<ApplyRouteOptions<RouteRequest<TPath>, TOptions>, T1>
      >,
      TOptions & RouteSchemaOptions
    ]
  ): TSelf
  <
    const TPath extends string,
    TOptions extends RouteSchemaOptions,
    T1 extends RouteMiddleware<
      ApplyRouteOptions<RouteRequest<TPath>, TOptions>
    >,
    T2 extends RouteMiddleware<
      ApplyMiddleware<ApplyRouteOptions<RouteRequest<TPath>, TOptions>, T1>
    >
  >(
    path: TPath,
    ...handlers: [
      handler: T1,
      handler: T2,
      handler: RouteMiddleware<
        ApplyMiddleware<
          ApplyMiddleware<ApplyRouteOptions<RouteRequest<TPath>, TOptions>, T1>,
          T2
        >
      >,
      options: TOptions & RouteSchemaOptions
    ]
  ): TSelf
  <
    const TPath extends string,
    TOptions extends RouteSchemaOptions,
    T1 extends RouteMiddleware<
      ApplyRouteOptions<RouteRequest<TPath>, TOptions>
    >,
    T2 extends RouteMiddleware<
      ApplyMiddleware<ApplyRouteOptions<RouteRequest<TPath>, TOptions>, T1>
    >
  >(
    path: TPath,
    ...handlers: [
      ...Handler[],
      T1,
      T2,
      RouteMiddleware<
        ApplyMiddleware<
          ApplyMiddleware<ApplyRouteOptions<RouteRequest<TPath>, TOptions>, T1>,
          T2
        >
      >,
      TOptions & RouteSchemaOptions
    ]
  ): TSelf
  <
    const TPath extends string,
    TOptions extends RouteSchemaOptions,
    T1 extends RouteMiddleware<
      ApplyRouteOptions<RouteRequest<TPath>, TOptions>
    >,
    T2 extends RouteMiddleware<
      ApplyMiddleware<ApplyRouteOptions<RouteRequest<TPath>, TOptions>, T1>
    >,
    T3 extends RouteMiddleware<
      ApplyMiddleware<
        ApplyMiddleware<ApplyRouteOptions<RouteRequest<TPath>, TOptions>, T1>,
        T2
      >
    >
  >(
    path: TPath,
    ...handlers: [
      handler: T1,
      handler: T2,
      handler: T3,
      handler: RouteMiddleware<
        ApplyMiddleware<
          ApplyMiddleware<
            ApplyMiddleware<
              ApplyRouteOptions<RouteRequest<TPath>, TOptions>,
              T1
            >,
            T2
          >,
          T3
        >
      >,
      options: TOptions & RouteSchemaOptions
    ]
  ): TSelf
  <
    const TPath extends string,
    TOptions extends RouteSchemaOptions,
    T1 extends RouteMiddleware<
      ApplyRouteOptions<RouteRequest<TPath>, TOptions>
    >,
    T2 extends RouteMiddleware<
      ApplyMiddleware<ApplyRouteOptions<RouteRequest<TPath>, TOptions>, T1>
    >,
    T3 extends RouteMiddleware<
      ApplyMiddleware<
        ApplyMiddleware<ApplyRouteOptions<RouteRequest<TPath>, TOptions>, T1>,
        T2
      >
    >
  >(
    path: TPath,
    ...handlers: [
      ...Handler[],
      T1,
      T2,
      T3,
      RouteMiddleware<
        ApplyMiddleware<
          ApplyMiddleware<
            ApplyMiddleware<
              ApplyRouteOptions<RouteRequest<TPath>, TOptions>,
              T1
            >,
            T2
          >,
          T3
        >
      >,
      TOptions & RouteSchemaOptions
    ]
  ): TSelf
  <
    const TPath extends string,
    TOptions extends RouteSchemaOptions,
    T1 extends RouteMiddleware<
      ApplyRouteOptions<RouteRequest<TPath>, TOptions>
    >,
    T2 extends RouteMiddleware<
      ApplyMiddleware<ApplyRouteOptions<RouteRequest<TPath>, TOptions>, T1>
    >,
    T3 extends RouteMiddleware<
      ApplyMiddleware<
        ApplyMiddleware<ApplyRouteOptions<RouteRequest<TPath>, TOptions>, T1>,
        T2
      >
    >,
    T4 extends RouteMiddleware<
      ApplyMiddleware<
        ApplyMiddleware<
          ApplyMiddleware<ApplyRouteOptions<RouteRequest<TPath>, TOptions>, T1>,
          T2
        >,
        T3
      >
    >
  >(
    path: TPath,
    ...handlers: [
      handler: T1,
      handler: T2,
      handler: T3,
      handler: T4,
      handler: RouteMiddleware<
        ApplyMiddleware<
          ApplyMiddleware<
            ApplyMiddleware<
              ApplyMiddleware<
                ApplyRouteOptions<RouteRequest<TPath>, TOptions>,
                T1
              >,
              T2
            >,
            T3
          >,
          T4
        >
      >,
      options: TOptions & RouteSchemaOptions
    ]
  ): TSelf
  <
    const TPath extends string,
    TOptions extends RouteSchemaOptions,
    T1 extends RouteMiddleware<
      ApplyRouteOptions<RouteRequest<TPath>, TOptions>
    >,
    T2 extends RouteMiddleware<
      ApplyMiddleware<ApplyRouteOptions<RouteRequest<TPath>, TOptions>, T1>
    >,
    T3 extends RouteMiddleware<
      ApplyMiddleware<
        ApplyMiddleware<ApplyRouteOptions<RouteRequest<TPath>, TOptions>, T1>,
        T2
      >
    >,
    T4 extends RouteMiddleware<
      ApplyMiddleware<
        ApplyMiddleware<
          ApplyMiddleware<ApplyRouteOptions<RouteRequest<TPath>, TOptions>, T1>,
          T2
        >,
        T3
      >
    >
  >(
    path: TPath,
    ...handlers: [
      ...Handler[],
      T1,
      T2,
      T3,
      T4,
      RouteMiddleware<
        ApplyMiddleware<
          ApplyMiddleware<
            ApplyMiddleware<
              ApplyMiddleware<
                ApplyRouteOptions<RouteRequest<TPath>, TOptions>,
                T1
              >,
              T2
            >,
            T3
          >,
          T4
        >
      >,
      TOptions & RouteSchemaOptions
    ]
  ): TSelf
}

export interface Application extends Server<typeof Request, typeof Response> {
  use: {
    (path: string, ...handlers: Handler[]): void
    (handler: Handler): void
    (handler: ErrorMiddleware): void
  }
  /**
   * Disables a built-in boolean app setting.
   *
   * - `disable('x-powered-by')`: stops sending the `X-Powered-By` header
   * - `disable('trust proxy')`: ignores `X-Forwarded-*` headers
   */
  disable: (setting: AppSetting) => Application
  /**
   * Enables a built-in boolean app setting.
   *
   * - `enable('x-powered-by')`: sends the `X-Powered-By` header
   * - `enable('trust proxy')`: trusts forwarded headers from every proxy hop
   *
   * Prefer `app.set('trust proxy', ...)` when you need explicit hops,
   * IP/CIDR allowlists, or custom trust logic.
   */
  enable: (setting: AppSetting) => Application
  /**
   * Configures how the app trusts `X-Forwarded-*` headers.
   *
   * Examples:
   * `app.set('trust proxy', true)`
   * `app.set('trust proxy', 1)`
   * `app.set('trust proxy', ['127.0.0.1', '10.0.0.0/8'])`
   * `app.set('trust proxy', ({ remoteAddress }) => remoteAddress === '::1')`
   * `app.set('trust proxy', async ({ remoteAddress }) => ['::1'].includes(remoteAddress))`
   */
  set: (setting: 'trust proxy', value: TrustProxyConfig) => Application
  mount: (
    prefix: string,
    mounted: Hyperin | Application | { [HYPERIN_CORE]?: Hyperin }
  ) => Application
  get: RouteMethod<Application>
  post: RouteMethod<Application>
  put: RouteMethod<Application>
  patch: RouteMethod<Application>
  delete: RouteMethod<Application>
  head: RouteMethod<Application>
  options: RouteMethod<Application>
  all: RouteMethod<Application>
  route: Hyperin['route']
  shutdown: Hyperin['shutdown']
  graceful: Hyperin['graceful']
  handler: Hyperin['handler']
}

function parseRequestTarget(rawUrl: string): {
  path: string
  rawQuery: string | null
} {
  if (!rawUrl) {
    return { path: '/', rawQuery: null }
  }

  let pathStart = 0

  if (rawUrl.startsWith('http://') || rawUrl.startsWith('https://')) {
    const authorityStart = rawUrl.indexOf('//')
    const firstSlash = rawUrl.indexOf('/', authorityStart + 2)

    if (firstSlash === -1) {
      return { path: '/', rawQuery: null }
    }

    pathStart = firstSlash
  }

  let pathEnd = rawUrl.length
  const queryStart = rawUrl.indexOf('?', pathStart)
  if (queryStart !== -1 && queryStart < pathEnd) pathEnd = queryStart

  const hashStart = rawUrl.indexOf('#', pathStart)
  if (hashStart !== -1 && hashStart < pathEnd) pathEnd = hashStart

  const rawPath = rawUrl.slice(pathStart, pathEnd)
  const path = rawPath
    ? rawPath.charCodeAt(0) === 47
      ? rawPath
      : `/${rawPath}`
    : '/'

  if (queryStart === -1) {
    return { path, rawQuery: null }
  }

  const queryEnd =
    hashStart !== -1 && hashStart > queryStart ? hashStart : rawUrl.length

  return {
    path,
    rawQuery: rawUrl.slice(queryStart + 1, queryEnd)
  }
}

function isPromiseLike<T>(value: T | PromiseLike<T>): value is PromiseLike<T> {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof (value as { then?: unknown }).then === 'function'
  )
}

function isRouteSchemaOptions(value: unknown): value is RouteSchemaOptions {
  return value != null && typeof value === 'object' && !Array.isArray(value)
}

function buildRouteOptionHandlers(options: RouteSchemaOptions): Handler[] {
  const handlers: Handler[] = []

  if (options.params !== undefined)
    handlers.push(validate.params(options.params))
  if (options.query !== undefined) handlers.push(validate.query(options.query))
  if (options.body !== undefined) handlers.push(validate.body(options.body))

  const operation: DescribeOperationInput = {
    ...(typeof options.summary === 'string'
      ? { summary: options.summary }
      : {}),
    ...(typeof options.description === 'string'
      ? { description: options.description }
      : {}),
    ...(typeof options.operationId === 'string'
      ? { operationId: options.operationId }
      : {}),
    ...(Array.isArray(options.tags) ? { tags: options.tags } : {}),
    ...(typeof options.deprecated === 'boolean'
      ? { deprecated: options.deprecated }
      : {}),
    ...(options.responses
      ? { responses: options.responses as DescribeOperationInput['responses'] }
      : {})
  }

  if (Object.keys(operation).length > 0) {
    handlers.push(describeOperation(operation))
  }

  return handlers
}

// ─────────────────────────────────────────────────────────────
// Hyperin
// ─────────────────────────────────────────────────────────────

class Hyperin {
  #router: RadixRouter
  #server: Server | null = null
  #boundServer: Server | null = null
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
  #routeObservers = new Set<RouteObserver>()
  #middlewareObservers = new Set<MiddlewareObserver>()
  #xPoweredByEnabled = true
  #trustProxy: TrustProxySetting = false

  constructor(opts: RouterOptions = {}) {
    this.#prefix = opts.prefix || ''
    this.#router = new RadixRouter()
  }

  // ──────────────────────────────────────────────
  // Middleware
  // ──────────────────────────────────────────────

  use(handler: Handler | ErrorMiddleware): this
  use(path: string, ...handlers: Handler[]): this
  use(path: string | Handler | ErrorMiddleware, ...handlers: Handler[]): this {
    if (typeof path === 'function') {
      const middlewareCount = this.#router.middlewaresList.length
      this.#router.use(path as Handler)
      if (this.#router.middlewaresList.length > middlewareCount) {
        this.#notifyMiddlewareObservers(path as Handler)
      }
      for (const h of handlers) this.#router.use(h)
    } else {
      const prefix = path.endsWith('/') ? path.slice(0, -1) : path
      const allHandlers = handlers

      const scoped: Handler = async ({ request, response, next }) => {
        const originalUrl = request.url || '/'
        const queryStart = originalUrl.indexOf('?')
        const rawPath =
          queryStart === -1 ? originalUrl : originalUrl.slice(0, queryStart)

        const matchesPrefix =
          prefix === '' ||
          rawPath === prefix ||
          rawPath.startsWith(prefix + '/')

        if (!matchesPrefix) return next()

        const relativePath = rawPath.slice(prefix.length) || '/'
        const relativeQuery =
          queryStart === -1 ? null : originalUrl.slice(queryStart + 1)
        request.setParsedTarget(relativePath, relativeQuery)

        const run = async (i: number): Promise<void> => {
          if (i >= allHandlers.length) {
            request.setParsedTarget(
              rawPath,
              queryStart === -1 ? null : originalUrl.slice(queryStart + 1)
            )
            return next()
          }
          await allHandlers[i]({ request, response, next: () => run(i + 1) })
        }

        await run(0)
        request.setParsedTarget(
          rawPath,
          queryStart === -1 ? null : originalUrl.slice(queryStart + 1)
        )
      }

      this.#router.use(scoped as Handler)
      this.#notifyMiddlewareObservers(scoped)
    }

    return this
  }

  // ──────────────────────────────────────────────
  // Route registration
  // ──────────────────────────────────────────────

  get(
    path: string,
    ...handlers: [...Handler[], RouteSchemaOptions] | Handler[]
  ): this {
    return this.#addRoute('GET', path, handlers)
  }

  post(
    path: string,
    ...handlers: [...Handler[], RouteSchemaOptions] | Handler[]
  ): this {
    return this.#addRoute('POST', path, handlers)
  }

  put(
    path: string,
    ...handlers: [...Handler[], RouteSchemaOptions] | Handler[]
  ): this {
    return this.#addRoute('PUT', path, handlers)
  }

  patch(
    path: string,
    ...handlers: [...Handler[], RouteSchemaOptions] | Handler[]
  ): this {
    return this.#addRoute('PATCH', path, handlers)
  }

  delete(
    path: string,
    ...handlers: [...Handler[], RouteSchemaOptions] | Handler[]
  ): this {
    return this.#addRoute('DELETE', path, handlers)
  }

  head(
    path: string,
    ...handlers: [...Handler[], RouteSchemaOptions] | Handler[]
  ): this {
    return this.#addRoute('HEAD', path, handlers)
  }

  options(
    path: string,
    ...handlers: [...Handler[], RouteSchemaOptions] | Handler[]
  ): this {
    return this.#addRoute('OPTIONS', path, handlers)
  }

  all(
    path: string,
    ...handlers: [...Handler[], RouteSchemaOptions] | Handler[]
  ): this {
    return this.#addRoute('ALL', path, handlers)
  }

  route(path: string): RouteChain {
    const chain: RouteChain = {
      get: (...handlers: Handler[]) => {
        this.#addRoute('GET', path, handlers)

        return chain
      },

      post: (...handlers: Handler[]) => {
        this.#addRoute('POST', path, handlers)

        return chain
      },
      put: (...handlers: Handler[]) => {
        this.#addRoute('PUT', path, handlers)
        return chain
      },
      patch: (...handlers: Handler[]) => {
        this.#addRoute('PATCH', path, handlers)
        return chain
      },
      delete: (...handlers: Handler[]) => {
        this.#addRoute('DELETE', path, handlers)
        return chain
      }
    }
    return chain
  }

  /** Mount a sub-router or Hyperin instance */
  mount(prefix: string, app: Hyperin | { [HYPERIN_CORE]?: Hyperin }): this {
    const target = app instanceof Hyperin ? app : app?.[HYPERIN_CORE]

    if (!(target instanceof Hyperin)) {
      throw new TypeError('mount() expects an app created by hyperin()')
    }

    for (const [method, path, handlers] of target.#getRoutes()) {
      const fullPath = prefix + path
      this.#router.add(method, fullPath, handlers)
      this.#notifyRouteObservers(method, fullPath, handlers)
    }
    return this
  }

  disable(setting: AppSetting): this {
    if (setting === 'x-powered-by') {
      this.#xPoweredByEnabled = false
    }
    if (setting === 'trust proxy') {
      this.#trustProxy = false
    }
    return this
  }

  enable(setting: AppSetting): this {
    if (setting === 'x-powered-by') {
      this.#xPoweredByEnabled = true
    }
    if (setting === 'trust proxy') {
      this.#trustProxy = true
    }
    return this
  }

  set(setting: 'trust proxy', value: TrustProxySetting): this
  set(setting: 'trust proxy', value: TrustProxySetting): this {
    if (
      typeof value === 'boolean' ||
      typeof value === 'number' ||
      Array.isArray(value) ||
      typeof value === 'function'
    ) {
      if (typeof value === 'number') {
        if (!Number.isInteger(value) || value < 0) {
          throw new TypeError(
            'trust proxy hop count must be a non-negative integer'
          )
        }
      }

      this.#trustProxy = value
      return this
    }

    throw new TypeError('Invalid value for trust proxy')
  }

  #getRoutes(): [HttpMethod, string, Handler[]][] {
    return this.#router.routes
  }

  getRoutesSnapshot(): [HttpMethod, string, Handler[]][] {
    return [...this.#router.routes]
  }

  onRouteRegistered(observer: RouteObserver): () => void {
    this.#routeObservers.add(observer)
    return () => this.#routeObservers.delete(observer)
  }

  getMiddlewaresSnapshot(): Handler[] {
    return [...this.#router.middlewaresList]
  }

  onMiddlewareRegistered(observer: MiddlewareObserver): () => void {
    this.#middlewareObservers.add(observer)
    return () => this.#middlewareObservers.delete(observer)
  }

  #notifyRouteObservers(
    method: HttpMethod,
    path: string,
    handlers: Handler[]
  ): void {
    for (const observer of this.#routeObservers) {
      observer(method, path, handlers)
    }
  }

  #notifyMiddlewareObservers(middleware: Handler): void {
    for (const observer of this.#middlewareObservers) {
      observer(middleware)
    }
  }

  #addRoute(
    method: HttpMethod,
    path: string,
    handlers: [...Handler[], RouteSchemaOptions] | Handler[]
  ): this {
    const fullPath = this.#prefix + path
    const lastHandler = handlers[handlers.length - 1]
    const normalizedHandlers =
      handlers.length > 0 && isRouteSchemaOptions(lastHandler)
        ? (() => {
            const routeHandlers = handlers.slice(0, -1) as Handler[]
            const optionHandlers = buildRouteOptionHandlers(lastHandler)

            if (routeHandlers.length === 0) return optionHandlers

            return [
              ...routeHandlers.slice(0, -1),
              ...optionHandlers,
              routeHandlers[routeHandlers.length - 1]
            ]
          })()
        : (handlers as Handler[])

    this.#router.add(method, fullPath || '/', normalizedHandlers)
    this.#notifyRouteObservers(method, fullPath || '/', normalizedHandlers)
    return this
  }

  #writeHandlerResult(response: Response, result: unknown): void {
    if (result === undefined || response.sent) return

    if (typeof result === 'string') {
      response.text(result)
      return
    }

    response.json(result as object)
  }

  #writeErrorResponse(response: Response, error: Error): void {
    if (response.sent || response.writableEnded) return

    const statusCode =
      (error as unknown as { statusCode?: number }).statusCode ?? 500
    response.status(statusCode).json({ statusCode, message: error.message })
  }

  #bindServer(server: Server): Server {
    if (this.#boundServer === server) {
      this.#server = server
      return server
    }

    this.#server = server
    this.#boundServer = server

    // Track every TCP socket so we can destroy idle keep-alive
    // connections during shutdown without waiting for their timeout.
    server.on('connection', (socket: Socket) => {
      this.#openSockets.add(socket)
      socket.once('close', () => this.#openSockets.delete(socket))
    })

    // Mark the socket as busy while a request is in flight so shutdown()
    // knows not to destroy it before the response finishes.
    server.on(
      'request',
      async (request: IncomingMessage, response: ServerResponse) => {
        await this.#dispatch(request, response).catch((err) => {
          console.error('[listen] uncaught dispatch error:', err)

          if (!response.headersSent && !response.writableEnded) {
            response.statusCode = 500
            response.setHeader(
              'Content-Type',
              'application/json; charset=utf-8'
            )
            response.end(
              JSON.stringify({
                statusCode: 500,
                message:
                  err instanceof Error ? err.message : 'Internal Server Error'
              })
            )
          }
        })
      }
    )

    return server
  }

  attachServer(server: Server): Server {
    return this.#bindServer(server)
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
    const socket = rawRequest.socket as Socket & { _busy?: boolean }
    socket._busy = true
    let finalized = false
    const finalizeRequest = () => {
      if (finalized) return
      finalized = true
      socket._busy = false
      this.#activeRequests--
      if (this.#shuttingDown && this.#activeRequests === 0) {
        this.#drainResolve?.()
      }
    }
    rawResponse.once('finish', finalizeRequest)
    rawResponse.once('close', finalizeRequest)

    const request = rawRequest as Request
    const response = rawResponse as Response

    rawRequest.once('aborted', () => {
      request.abort(new Error('Request aborted'))
    })

    // Expose app-level proxy trust settings to the request instance
    request.locals.trustProxy = this.#trustProxy
    request.locals.trustedClientIp = await resolveTrustedClientIp(
      request.socket?.remoteAddress,
      request.headers['x-forwarded-for'],
      this.#trustProxy
    )

    if (
      await shouldTrustForwardedHeaders(
        request.socket?.remoteAddress,
        this.#trustProxy
      )
    ) {
      request.locals.trustedForwardedProtocol = parseForwardedHeader(
        request.headers['x-forwarded-proto']
      )[0]
    } else {
      request.locals.trustedForwardedProtocol = undefined
    }

    if (this.#xPoweredByEnabled && !response.hasHeader('X-Powered-By')) {
      response.setHeader('X-Powered-By', 'Hyperin')
    }

    const rawUrl = request.url || '/'
    const { path, rawQuery } = parseRequestTarget(rawUrl)
    request.setParsedTarget(path, rawQuery)

    const method = request.method || 'GET'
    const match = this.#router.match(method, path)

    if (!match) {
      return void response
        .status(404)
        .json({ statusCode: 404, message: 'Not Found' })
    }

    request.params = match.params

    const { handlers, middlewares } = match
    // It iterates through global middlewares followed by route handlers without creating a new array.
    const mLen = middlewares.length
    const hLen = handlers.length
    const total = mLen + hLen
    let idx = 0
    const context = {
      request,
      response,
      next: undefined as unknown as (error?: Error) => Promise<void>
    }

    const dispatchError = (error: Error): Promise<void> =>
      this.#runErrorMiddlewares(error, request, response)

    const dispatchNext = (): Promise<void> | void => {
      while (idx < total) {
        const handler = idx < mLen ? middlewares[idx++] : handlers[idx++ - mLen]

        let result: unknown
        try {
          result = handler(context)
        } catch (err) {
          return dispatchError(err as Error)
        }

        if (isPromiseLike(result)) {
          return Promise.resolve(result).then(
            (value) => {
              this.#writeHandlerResult(response, value)
            },
            (err) => dispatchError(err as Error)
          )
        }

        this.#writeHandlerResult(response, result)
        return
      }

      if (!match.matched && !response.sent) {
        response.status(404).json({ statusCode: 404, message: 'Not Found' })
      }
    }

    const next = (error?: Error): Promise<void> => {
      if (error) {
        return dispatchError(error)
      }

      const result = dispatchNext()
      return isPromiseLike(result) ? result : Promise.resolve()
    }

    context.next = next

    const initialResult = dispatchNext()
    if (isPromiseLike(initialResult)) {
      await initialResult
    }
  }

  async #runErrorMiddlewares(
    err: Error,
    request: Request,
    response: Response
  ): Promise<void> {
    const handlers = this.#router.errorMiddlewares
    let currentError = err

    if (handlers.length === 0) {
      this.#writeErrorResponse(response, currentError)
      return
    }

    let i = 0
    let defaultResponseWritten = false

    const writeDefaultErrorResponse = (): void => {
      defaultResponseWritten = true
      this.#writeErrorResponse(response, currentError)
    }

    const next = async (forwardedError?: Error): Promise<void> => {
      if (forwardedError) {
        currentError = forwardedError
      }

      if (i >= handlers.length) {
        writeDefaultErrorResponse()
        return
      }

      try {
        const result = handlers[i++]({
          error: currentError,
          request,
          response,
          next
        })

        if (isPromiseLike(result)) {
          await result
        }
      } catch (error) {
        currentError = error as Error
        await next(currentError)
      }
    }

    await next()

    if (!defaultResponseWritten && !response.sent && !response.writableEnded) {
      writeDefaultErrorResponse()
    }
  }

  // ──────────────────────────────────────────────
  // Server lifecycle
  // ──────────────────────────────────────────────

  listen(port: number, hostname?: string, callback?: () => void): Server {
    const server = this.#bindServer(
      createServer({
        IncomingMessage: Request,
        ServerResponse: Response
      })
    )

    const cb = callback || (() => {})
    if (hostname) {
      server.listen(port, hostname, cb)
    } else {
      server.listen(port, cb)
    }

    return server
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
  get handler(): (
    request: IncomingMessage,
    response: ServerResponse
  ) => Promise<void> {
    return async (request: IncomingMessage, response: ServerResponse) =>
      await this.#dispatch(request, response)
  }
}

export type Instance = Application
export { errorMiddleware }

type RouteMethodName =
  | 'get'
  | 'post'
  | 'put'
  | 'patch'
  | 'delete'
  | 'head'
  | 'options'
  | 'all'

export function hyperin(): Application {
  const core = new Hyperin()

  // Create the http.Server immediately with the custom classes.
  // This is necessary so that supertest(app) receives a real Server
  // and uses the proper Request/Response implementations, instead of
  // creating a generic http.createServer internally.
  const server = createServer({
    IncomingMessage: Request,
    ServerResponse: Response
  })
  core.attachServer(server)

  function use(path: string, ...handlers: Handler[]): void
  function use(handler: Handler): void
  function use(handler: ErrorMiddleware): void
  function use(
    path: string | Handler | ErrorMiddleware,
    ...handlers: Handler[]
  ): void {
    if (typeof path === 'string') {
      core.use(path, ...handlers)
      return
    }

    core.use(path)
  }

  function createRouteMethod(
    method: RouteMethodName
  ): RouteMethod<Application> {
    function register(path: string, ...handlers: unknown[]): Application {
      ;(core[method] as (...args: unknown[]) => unknown)(path, ...handlers)
      return app
    }

    return register as RouteMethod<Application>
  }

  function set(setting: 'trust proxy', value: TrustProxySetting): Application
  function set(setting: 'trust proxy', value: TrustProxySetting): Application {
    core.set(setting, value)
    return app
  }

  // The app is the server itself — thus supertest(app) works directly.
  // Métodos de rota e middleware são adicionados via Object.assign.
  const app = Object.assign(server, {
    use,
    disable: (setting: AppSetting) => {
      core.disable(setting)
      return app
    },
    enable: (setting: AppSetting) => {
      core.enable(setting)
      return app
    },
    set,
    mount: (
      prefix: string,
      mounted: Hyperin | { [HYPERIN_CORE]?: Hyperin }
    ) => {
      core.mount(prefix, mounted)
      return app
    },
    [HYPERIN_CORE]: core,
    get: createRouteMethod('get'),
    post: createRouteMethod('post'),
    put: createRouteMethod('put'),
    patch: createRouteMethod('patch'),
    delete: createRouteMethod('delete'),
    head: createRouteMethod('head'),
    options: createRouteMethod('options'),
    all: createRouteMethod('all'),
    route: core.route.bind(core),
    shutdown: core.shutdown.bind(core),
    graceful: core.graceful.bind(core),
    handler: core.handler
  }) as Application

  // listen() optionally accepts the hostname, preserving the original signature.
  const serverListen = server.listen.bind(server)

  Object.assign(app, {
    listen: (
      port: number,
      hostname?: string | (() => void),
      callback?: () => void
    ) => {
      const cb = typeof hostname === 'function' ? hostname : callback
      const host = typeof hostname === 'string' ? hostname : undefined
      if (host) {
        serverListen(port, host, cb)
      } else {
        serverListen(port, cb)
      }
      return server
    }
  })

  return app as Application
}

export default hyperin
