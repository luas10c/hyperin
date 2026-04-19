import type { ErrorMiddleware, Handler } from './types'

export type { ErrorMiddleware, Handler } from './types'

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

function createStaticRouteKey(method: string, path: string): string {
  return `${method} ${path}`
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

/** Cache para não re-executar toString + regex na mesma função */
const errorMwCache = new WeakMap<object, boolean>()

/**
 * Detecta se a função é um ErrorMiddleware inspecionando o primeiro parâmetro.
 * Cobre dois padrões:
 *  1. Desestruturação nativa:  ({ error, ... }) =>
 *  2. Compilado TS/Babel:      function(_a) { var error = _a.error  /  let { error } = _ref
 * Resultado cacheado em WeakMap — custo pago uma única vez por função registrada.
 */
function isErrorMiddleware(fn: Handler | ErrorMiddleware): boolean {
  const cached = errorMwCache.get(fn)
  if (cached !== undefined) return cached

  const src = fn.toString()

  // Padrão 1: desestruturação nativa no primeiro parâmetro — ({ error, ... })
  const nativeMatch = src.match(/^[^(]*\(\s*\{([^}]*)/)
  if (nativeMatch) {
    const result = /\berror\b/.test(nativeMatch[1])
    errorMwCache.set(fn, result)
    return result
  }

  // Padrão 2: código compilado pelo TypeScript/Babel
  //   function(_a) { var error = _a.error ... }
  //   (_ref) => { let { error } = _ref ... }
  const result = /\b(?:var|let|const)\s+(?:\{[^}]*\berror\b|error\s*=)/.test(
    src
  )
  return result
}

export class RadixRouter {
  private readonly root: TrieNode = createNode()
  private readonly staticRoutes = new Map<string, Handler[]>()
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
      this.staticRoutes.set(createStaticRouteKey(method, path), handlers)
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
      this.staticRoutes.get(createStaticRouteKey(method, path)) ??
      this.staticRoutes.get(createStaticRouteKey('ALL', path))

    if (staticHandlers) {
      return {
        handlers: staticHandlers,
        middlewares: this.middlewares,
        params: {},
        matched: true
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

    const dynamicMatch = this.#traverse(this.root, path, 0, [], [])

    const routeHandlers = dynamicMatch?.node.isEnd
      ? dynamicMatch.node.handlers.get(method as HttpMethod) ||
        dynamicMatch.node.handlers.get('ALL')
      : null

    if (dynamicMatch && routeHandlers) {
      return {
        handlers: routeHandlers,
        middlewares: this.middlewares,
        params: this.#buildParams(
          dynamicMatch.paramNames,
          dynamicMatch.paramValues
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

  #traverse(
    node: TrieNode,
    path: string,
    index: number,
    paramNames: string[],
    paramValues: string[]
  ): DynamicMatch | null {
    let start = index
    while (start < path.length && path.charCodeAt(start) === 47) start++
    if (start >= path.length) {
      return {
        node,
        paramNames: [...paramNames],
        paramValues: [...paramValues]
      }
    }

    let end = start + 1
    while (end < path.length && path.charCodeAt(end) !== 47) end++

    const nextIndex = end
    const segment = path.slice(start, end)

    // 1. Exact match (fastest path)
    const exactChild = node.children.get(segment)

    if (exactChild) {
      const result = this.#traverse(
        exactChild,
        path,
        nextIndex,
        paramNames,
        paramValues
      )
      if (result) return result
    }

    // 2. Param match
    if (node.paramChild) {
      paramNames.push(node.paramChild.paramName!)
      paramValues.push(segment)
      const result = this.#traverse(
        node.paramChild,
        path,
        nextIndex,
        paramNames,
        paramValues
      )
      if (result) return result
      paramNames.pop()
      paramValues.pop()
    }

    // 3. Wildcard match
    if (node.wildcardChild) {
      let wildcardEnd = path.length
      while (wildcardEnd > start && path.charCodeAt(wildcardEnd - 1) === 47) {
        wildcardEnd--
      }
      return {
        node: node.wildcardChild,
        paramNames: [...paramNames, '*'],
        paramValues: [...paramValues, path.slice(start, wildcardEnd)]
      }
    }

    return null
  }

  #buildParams(names: string[], values: string[]): Record<string, string> {
    if (names.length === 0) return {}

    const params: Record<string, string> = {}

    for (let i = 0; i < names.length; i++) {
      params[names[i]] = values[i]
    }

    return params
  }
}
