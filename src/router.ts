import type { Request } from './request'
import type { ErrorMiddleware, Handler } from './types'

export type { ErrorMiddleware, Handler } from './types'

// ─────────────────────────────────────────────────────────────
// Error middleware marker
// ─────────────────────────────────────────────────────────────

/** Symbol used to mark a function as an error middleware. */
export const ERROR_MIDDLEWARE_SYMBOL = Symbol.for('hyperin.errorMiddleware')

/**
 * Marks `fn` as an error middleware so it is routed to the error handler chain.
 *
 * @example
 * app.use(errorMiddleware(({ error, request, response }) => {
 *   response.status(500).json({ error: error.message })
 * }))
 */
export function errorMiddleware<TRequest extends Request = Request>(
  fn: ErrorMiddleware<TRequest>
): ErrorMiddleware<TRequest> {
  ;(fn as unknown as Record<symbol, boolean>)[ERROR_MIDDLEWARE_SYMBOL] = true
  return fn
}

export type HttpMethod =
  | 'GET'
  | 'POST'
  | 'PUT'
  | 'PATCH'
  | 'DELETE'
  | 'HEAD'
  | 'OPTIONS'
  | 'ALL'

interface TrieNode {
  children: Map<string, TrieNode>
  paramChild: TrieNode | null
  wildcardChild: TrieNode | null
  paramName: string | null
  handlers: Map<HttpMethod, Handler[]>
  isEnd: boolean
}

function createNode(): TrieNode {
  return {
    children: new Map(),
    paramChild: null,
    wildcardChild: null,
    paramName: null,
    handlers: new Map(),
    isEnd: false
  }
}

function isDynamicPath(path: string): boolean {
  for (let i = 0; i < path.length; i++) {
    const code = path.charCodeAt(i)
    if (code === 42 || code === 58) return true
  }

  return false
}

export interface MatchResult {
  handlers: Handler[]
  middlewares: Handler[]
  params: Record<string, string>
  matched: boolean
}

interface DynamicMatch {
  node: TrieNode
  paramNames: string[]
  paramValues: string[]
  paramCount: number
}

type DynamicFallback =
  | {
      kind: 'param'
      node: TrieNode
      index: number
      name: string
      value: string
      paramCount: number
    }
  | {
      kind: 'wildcard'
      node: TrieNode
      start: number
      paramCount: number
    }

function forEachPathSegment(
  path: string,
  callback: (segment: string) => void
): void {
  let index = 0

  while (index < path.length) {
    while (index < path.length && path.charCodeAt(index) === 47) index++
    if (index >= path.length) return

    let end = index + 1
    while (end < path.length && path.charCodeAt(end) !== 47) end++

    callback(path.slice(index, end))
    index = end + 1
  }
}

const errorMwCache = new WeakMap<object, boolean>()
const SOURCE_SCAN_LIMIT = 320

function getSourceScanWindow(fn: Handler | ErrorMiddleware): string {
  const source = fn.toString()
  return source.length > SOURCE_SCAN_LIMIT
    ? source.slice(0, SOURCE_SCAN_LIMIT)
    : source
}

function detectDestructuredErrorParam(source: string): boolean | null {
  const parenIndex = source.indexOf('(')
  if (parenIndex === -1) return null

  let index = parenIndex + 1
  while (index < source.length && /\s/.test(source[index])) index++
  if (source[index] !== '{') return null

  const closingBraceIndex = source.indexOf('}', index + 1)
  if (closingBraceIndex === -1) return null

  return /\berror\b/.test(source.slice(index + 1, closingBraceIndex))
}

function isErrorMiddleware(fn: Handler | ErrorMiddleware): boolean {
  if (
    (fn as unknown as Record<symbol, unknown>)[ERROR_MIDDLEWARE_SYMBOL] === true
  ) {
    return true
  }

  const cached = errorMwCache.get(fn)
  if (cached !== undefined) return cached

  const src = getSourceScanWindow(fn)
  if (!src.includes('error')) {
    errorMwCache.set(fn, false)
    return false
  }

  const destructured = detectDestructuredErrorParam(src)

  if (destructured !== null) {
    errorMwCache.set(fn, destructured)
    return destructured
  }

  const result = /\b(?:var|let|const)\s+(?:\{[^}]*\berror\b|error\s*=)/.test(
    src
  )
  errorMwCache.set(fn, result)
  return result
}

export class RadixRouter {
  private readonly root: TrieNode = createNode()
  private readonly staticRoutes = new Map<HttpMethod, Map<string, Handler[]>>()
  private readonly middlewares: Handler[] = []
  private readonly _errorMiddlewares: ErrorMiddleware[] = []
  private readonly _routes: [HttpMethod, string, Handler[]][] = []
  private hasDynamicRoutes = false

  get routes(): [HttpMethod, string, Handler[]][] {
    return this._routes
  }

  get errorMiddlewares() {
    return this._errorMiddlewares
  }

  get middlewaresList() {
    return this.middlewares
  }

  use(middleware: Handler): void
  use(middleware: ErrorMiddleware): void
  use(middleware: Handler | ErrorMiddleware): void {
    if (isErrorMiddleware(middleware)) {
      this.errorMiddlewares.push(middleware as ErrorMiddleware)
    } else {
      this.middlewares.push(middleware as Handler)
    }
  }

  add(method: HttpMethod, path: string, handlers: Handler[]): void {
    this._routes.push([method, path, handlers])

    if (!isDynamicPath(path)) {
      let routesByMethod = this.staticRoutes.get(method)

      if (!routesByMethod) {
        routesByMethod = new Map<string, Handler[]>()
        this.staticRoutes.set(method, routesByMethod)
      }

      routesByMethod.set(path, handlers)
      return
    }

    this.hasDynamicRoutes = true

    let node = this.root

    forEachPathSegment(path, (segment) => {
      if (segment.startsWith(':')) {
        if (!node.paramChild) {
          node.paramChild = createNode()
          node.paramChild.paramName = segment.slice(1)
        }
        node = node.paramChild
      } else if (segment === '*') {
        if (!node.wildcardChild) {
          node.wildcardChild = createNode()
        }
        node = node.wildcardChild
      } else {
        if (!node.children.has(segment)) {
          node.children.set(segment, createNode())
        }
        node = node.children.get(segment)!
      }
    })

    node.isEnd = true
    node.handlers.set(method, handlers)
  }

  match(method: string, path: string): MatchResult | null {
    const staticHandlers =
      this.staticRoutes.get(method as HttpMethod)?.get(path) ??
      this.staticRoutes.get('ALL')?.get(path)

    if (staticHandlers) {
      return {
        handlers: staticHandlers,
        middlewares: this.middlewares,
        params: {},
        matched: true
      }
    }

    // HEAD → GET fallback for static routes (auto-handles HEAD for any GET route)
    if (method === 'HEAD') {
      const getHandlers = this.staticRoutes.get('GET')?.get(path)
      if (getHandlers) {
        return {
          handlers: getHandlers,
          middlewares: this.middlewares,
          params: {},
          matched: true
        }
      }
    }

    if (!this.hasDynamicRoutes) {
      if (this.middlewares.length > 0) {
        return {
          handlers: [],
          middlewares: this.middlewares,
          params: {},
          matched: false
        }
      }

      return null
    }

    const dynamicMatch = this.#traverse(path)

    const routeHandlers = dynamicMatch?.node.isEnd
      ? dynamicMatch.node.handlers.get(method as HttpMethod) ||
        dynamicMatch.node.handlers.get('ALL') ||
        // HEAD → GET fallback for dynamic routes
        (method === 'HEAD'
          ? (dynamicMatch.node.handlers.get('GET') ?? null)
          : null)
      : null

    if (dynamicMatch && routeHandlers) {
      return {
        handlers: routeHandlers,
        middlewares: this.middlewares,
        params: this.#buildParams(
          dynamicMatch.paramNames,
          dynamicMatch.paramValues,
          dynamicMatch.paramCount
        ),
        matched: true
      }
    }

    if (this.middlewares.length > 0) {
      return {
        handlers: [],
        middlewares: this.middlewares,
        params: {},
        matched: false
      }
    }

    return null
  }

  #traverse(path: string): DynamicMatch | null {
    const paramNames: string[] = []
    const paramValues: string[] = []
    const fallbacks: DynamicFallback[] = []
    let node = this.root
    let index = 0
    let paramCount = 0

    traverse: while (true) {
      let start = index
      while (start < path.length && path.charCodeAt(start) === 47) start++

      if (start >= path.length) {
        return {
          node,
          paramNames,
          paramValues,
          paramCount
        }
      }

      let end = start + 1
      while (end < path.length && path.charCodeAt(end) !== 47) end++

      const nextIndex = end
      const segment = path.slice(start, end)

      if (node.wildcardChild) {
        fallbacks.push({
          kind: 'wildcard',
          node: node.wildcardChild,
          start,
          paramCount
        })
      }

      if (node.paramChild) {
        fallbacks.push({
          kind: 'param',
          node: node.paramChild,
          index: nextIndex,
          name: node.paramChild.paramName!,
          value: segment,
          paramCount
        })
      }

      const exactChild = node.children.get(segment)
      if (exactChild) {
        node = exactChild
        index = nextIndex
        continue
      }

      while (fallbacks.length > 0) {
        const fallback = fallbacks.pop()!

        if (fallback.kind === 'param') {
          paramNames[fallback.paramCount] = fallback.name
          paramValues[fallback.paramCount] = fallback.value
          paramCount = fallback.paramCount + 1
          node = fallback.node
          index = fallback.index
          continue traverse
        }

        let wildcardEnd = path.length
        while (
          wildcardEnd > fallback.start &&
          path.charCodeAt(wildcardEnd - 1) === 47
        ) {
          wildcardEnd--
        }

        paramNames[fallback.paramCount] = '*'
        paramValues[fallback.paramCount] = path.slice(
          fallback.start,
          wildcardEnd
        )

        return {
          node: fallback.node,
          paramNames,
          paramValues,
          paramCount: fallback.paramCount + 1
        }
      }

      return null
    }
  }

  #buildParams(
    names: string[],
    values: string[],
    count: number
  ): Record<string, string> {
    if (count === 0) return {}

    const params: Record<string, string> = {}

    for (let i = 0; i < count; i++) {
      params[names[i]] = values[i]
    }

    return params
  }
}
