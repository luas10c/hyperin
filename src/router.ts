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

export interface MatchResult {
  handlers: Handler[]
  middlewares: Handler[]
  params: Record<string, string>
  matched: boolean
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
  private readonly middlewares: Handler[] = []
  private readonly _errorMiddlewares: ErrorMiddleware[] = []
  private readonly _routes: [HttpMethod, string, Handler[]][] = []

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
    const params: Record<string, string> = {}
    const node = this.#traverse(this.root, path, 0, params)

    const routeHandlers = node?.isEnd
      ? node.handlers.get(method as HttpMethod) || node.handlers.get('ALL')
      : null

    const result: MatchResult | null = routeHandlers
      ? {
          handlers: routeHandlers,
          middlewares: this.middlewares,
          params,
          matched: true
        }
      : this.middlewares.length > 0
        ? {
            handlers: [],
            middlewares: this.middlewares,
            params: {},
            matched: false
          }
        : null

    return result
  }

  #traverse(
    node: TrieNode,
    path: string,
    index: number,
    params: Record<string, string>
  ): TrieNode | null {
    let start = index
    while (start < path.length && path.charCodeAt(start) === 47) start++
    if (start >= path.length) return node

    let end = start + 1
    while (end < path.length && path.charCodeAt(end) !== 47) end++

    const nextIndex = end
    const segment = path.slice(start, end)

    // 1. Exact match (fastest path)
    const exactChild = node.children.get(segment)

    if (exactChild) {
      const result = this.#traverse(exactChild, path, nextIndex, params)
      if (result) return result
    }

    // 2. Param match
    if (node.paramChild) {
      const paramName = node.paramChild.paramName!
      const hadKey = paramName in params
      const prevValue = params[paramName]
      params[paramName] = segment
      const result = this.#traverse(node.paramChild, path, nextIndex, params)
      if (result) return result
      // Restore params on backtrack — without allocating an object
      if (hadKey) {
        params[paramName] = prevValue
      } else {
        delete params[paramName]
      }
    }

    // 3. Wildcard match
    if (node.wildcardChild) {
      let wildcardEnd = path.length
      while (wildcardEnd > start && path.charCodeAt(wildcardEnd - 1) === 47) {
        wildcardEnd--
      }
      params['*'] = path.slice(start, wildcardEnd)
      return node.wildcardChild
    }

    return null
  }
}
