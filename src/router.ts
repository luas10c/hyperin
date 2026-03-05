import { LRUCache } from './cache'
import type { Request, Response } from './instance'

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
  params: Record<string, string>
  matched: boolean
}

export class RadixRouter {
  private readonly root: TrieNode = createNode()
  private readonly middlewares: Handler[] = []
  private readonly _errorMiddlewares: ErrorMiddleware[] = []
  private readonly _routes: [HttpMethod, string, Handler[]][] = []
  readonly #cache = new LRUCache<string, MatchResult | null>(512)

  get routes(): [HttpMethod, string, Handler[]][] {
    return this._routes
  }

  get errorMiddlewares() {
    return this._errorMiddlewares
  }

  use(middleware: Handler): void
  use(middleware: ErrorMiddleware): void
  use(middleware: Handler | ErrorMiddleware): void {
    const src = middleware.toString()
    // captura o primeiro parâmetro e checa se desestrutura `error`
    const firstParam = src.match(
      /^(?:async\s*)?\(?(?:function\s*)?\w*\s*\(?\s*(\{[^)]+\})/
    )
    const isError = firstParam ? /\berror\b/.test(firstParam[1]) : false

    if (isError) {
      this.errorMiddlewares.push(middleware as ErrorMiddleware)
    } else {
      this.middlewares.push(middleware as Handler)
    }
  }

  add(method: HttpMethod, path: string, handlers: Handler[]): void {
    this._routes.push([method, path, handlers])
    const segments = path.split('/').filter(Boolean)
    let node = this.root

    for (const segment of segments) {
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
    }

    node.isEnd = true
    node.handlers.set(method, handlers)
  }

  match(method: string, path: string): MatchResult | null {
    const key = `${method}:${path}`

    const cached = this.#cache.get(key)
    if (this.#cache.has(key)) return cached!

    const params: Record<string, string> = {}
    const node = this.#traverse(
      this.root,
      path.split('/').filter(Boolean),
      0,
      params
    )

    const routeHandlers = node?.isEnd
      ? node.handlers.get(method as HttpMethod) || node.handlers.get('ALL')
      : null

    const result: MatchResult | null = routeHandlers
      ? {
          handlers: [...this.middlewares, ...routeHandlers],
          params,
          matched: true
        }
      : this.middlewares.length > 0
        ? { handlers: [...this.middlewares], params: {}, matched: false }
        : null

    this.#cache.set(key, result)
    return result
  }

  #traverse(
    node: TrieNode,
    segments: string[],
    index: number,
    params: Record<string, string>
  ): TrieNode | null {
    if (index === segments.length) return node

    const segment = segments[index]

    // 1. Exact match (fastest path)
    const exactChild = node.children.get(segment)

    if (exactChild) {
      const result = this.#traverse(exactChild, segments, index + 1, params)
      if (result) return result
    }

    // 2. Param match
    if (node.paramChild) {
      const savedParams = { ...params }
      params[node.paramChild.paramName!] = segment
      const result = this.#traverse(
        node.paramChild,
        segments,
        index + 1,
        params
      )
      if (result) return result
      // Restore params on backtrack
      Object.keys(params).forEach((k) => {
        if (!(k in savedParams)) delete params[k]
      })
    }

    // 3. Wildcard match
    if (node.wildcardChild) {
      params['*'] = segments.slice(index).join('/')
      return node.wildcardChild
    }

    return null
  }
}
