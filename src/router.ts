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
  paramHead: DynamicParam | null
  paramCount: number
}

type DynamicTraversalState = DynamicMatch & { index: number }

interface DynamicParam {
  name: string
  value: string
  previous: DynamicParam | null
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

function normalizeRoutePath(path: string): string {
  if (path.length > 1 && path.endsWith('/')) return path.slice(0, -1)
  return path || '/'
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
    path = normalizeRoutePath(path)
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
        const paramName = segment.slice(1)
        if (!node.paramChild) {
          node.paramChild = createNode()
          node.paramChild.paramName = paramName
        } else if (node.paramChild.paramName !== paramName) {
          throw new TypeError(
            `Conflicting param name for route shape: expected ":${node.paramChild.paramName}", received ":${paramName}"`
          )
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
    path = normalizeRoutePath(path)
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

    const dynamicMatch = this.#traverse(method, path)

    const routeHandlers = dynamicMatch
      ? this.#getNodeHandlers(dynamicMatch.node, method)
      : null

    if (dynamicMatch && routeHandlers) {
      return {
        handlers: routeHandlers,
        middlewares: this.middlewares,
        params: this.#buildParams(
          dynamicMatch.paramHead,
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

  #getNodeHandlers(node: TrieNode, method: string): Handler[] | null {
    if (!node.isEnd) return null

    return (
      node.handlers.get(method as HttpMethod) ||
      node.handlers.get('ALL') ||
      (method === 'HEAD' ? (node.handlers.get('GET') ?? null) : null)
    )
  }

  #traverse(method: string, path: string): DynamicMatch | null {
    const stack: DynamicTraversalState[] = []
    let state: DynamicTraversalState = {
      node: this.root,
      index: 0,
      paramHead: null,
      paramCount: 0
    }

    while (true) {
      const { node, index, paramCount } = state
      let start = index
      while (start < path.length && path.charCodeAt(start) === 47) start++

      if (start >= path.length) {
        if (this.#getNodeHandlers(node, method)) {
          return state
        }

        const fallback = stack.pop()
        if (!fallback) return null
        state = fallback
        continue
      }

      let end = start + 1
      while (end < path.length && path.charCodeAt(end) !== 47) end++

      const nextIndex = end
      const segment = path.slice(start, end)

      if (node.wildcardChild) {
        let wildcardEnd = path.length
        while (wildcardEnd > start && path.charCodeAt(wildcardEnd - 1) === 47) {
          wildcardEnd--
        }

        stack.push({
          node: node.wildcardChild,
          index: path.length,
          paramHead: {
            name: '*',
            value: path.slice(start, wildcardEnd),
            previous: state.paramHead
          },
          paramCount: paramCount + 1
        })
      }

      if (node.paramChild) {
        stack.push({
          node: node.paramChild,
          index: nextIndex,
          paramHead: {
            name: node.paramChild.paramName!,
            value: segment,
            previous: state.paramHead
          },
          paramCount: paramCount + 1
        })
      }

      const exactChild = node.children.get(segment)
      if (exactChild) {
        state = {
          node: exactChild,
          index: nextIndex,
          paramHead: state.paramHead,
          paramCount
        }
        continue
      }

      const fallback = stack.pop()
      if (!fallback) return null
      state = fallback
    }
  }

  #buildParams(
    paramHead: DynamicParam | null,
    count: number
  ): Record<string, string> {
    if (count === 0) return {}

    const params: Record<string, string> = {}
    const entries = new Array<DynamicParam>(count)
    let entry = paramHead

    for (let i = count - 1; i >= 0 && entry; i--) {
      entries[i] = entry
      entry = entry.previous
    }

    for (let i = 0; i < count; i++) {
      const entry = entries[i]!
      params[entry.name] = entry.value
    }

    return params
  }
}
