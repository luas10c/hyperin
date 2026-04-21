import {
  readBody,
  getContentEncoding,
  readDecodedBody,
  parseLimit
} from '../util'

import type { Request } from '../request'
import type { Response } from '../response'

type NextFunction = () => void | Promise<void>

type HandlerContext = {
  request: Request
  response: Response
}

type MiddlewareContext = HandlerContext & { next: NextFunction }

type Middleware = (ctx: MiddlewareContext) => void | Promise<void>

export interface BodyParserOptions {
  /** Maximum body size. Ex: '100kb', '1mb'. Default: '100kb' */
  limit?: string | number
  /**
   * Default charset. Supports 'utf-8' and 'latin1' / 'iso-8859-1'.
   * Default: 'utf-8'
   */
  defaultCharset?: 'utf-8' | 'latin1'
  /** Allows inflating (decompressing) gzip/deflate/br. */
  inflate?: boolean
  /** Verifies the raw body before parsing. */
  /** Throws an error to abort parsing. */
  verify?: (req: Request, res: Response, buf: Buffer, encoding: string) => void
  /** Accepted Content-Type. Type can be string, string[] or function. */
  /** Default for JSON: 'application/json' */
  /** Default for URL-encoded: 'application/x-www-form-urlencoded' */
  type?: string | string[] | ((req: Request) => boolean)
}

export interface JsonOptions extends BodyParserOptions {
  /** strict: only accepts object or array at the top of JSON. */
  /** Default: true */
  strict?: boolean
  /** Reviver passed to JSON.parse. */
  reviver?: (key: string, value: unknown) => unknown
}

export interface UrlencodedOptions extends BodyParserOptions {
  /**
   * extended: usa parser rico (suporta arrays e objetos aninhados).
   * false → querystring nativo (apenas string/string[]).
   * Default: false
   */
  extended?: boolean
  /**
   * Profundidade máxima no modo extended.
   * Default: 32
   */
  depth?: number
  /**
   * Maximum number of parameters.
   * Default: 1000
   */
  parameterLimit?: number
}

// ── helpers internos ──────────────────────────────────────────

/** Extracts the charset from Content-Type, e.g. 'utf-8', 'iso-8859-1' */
function getCharset(contentType: string, fallback: string): string {
  const match = contentType.match(/charset=([^\s;]+)/i)
  const raw = match
    ? match[1].toLowerCase().replace(/^"(.+)"$/, '$1')
    : fallback
  // Normaliza aliases do latin1
  if (raw === 'iso-8859-1' || raw === 'iso8859-1' || raw === 'latin1')
    return 'latin1'
  return raw
}

/** Checa se o Content-Type bate com o `type` configurado */
function matchesType(
  req: Request,
  type: string | string[] | ((req: Request) => boolean)
): boolean {
  if (typeof type === 'function') return type(req)

  const ct = (req.headers['content-type'] || '')
    .split(';')[0]
    .trim()
    .toLowerCase()
  const types = Array.isArray(type) ? type : [type]

  return types.some((t) => {
    t = t.trim().toLowerCase()
    if (t.includes('/')) {
      // mime type exact or wildcard: '*/*', '*/json', 'application/*'
      const [tType, tSubtype] = t.split('/')
      const [ctType, ctSubtype] = ct.split('/')
      return (
        (tType === '*' || tType === ctType) &&
        (tSubtype === '*' || tSubtype === ctSubtype)
      )
    }
    // extension name: 'json' → matches 'application/json'
    return ct.endsWith(`/${t}`) || ct.endsWith(`+${t}`)
  })
}

/** Reads and decompresses the body, respecting the limit */
async function readRawBody(
  req: Request,
  options: { inflate: boolean; limit: number }
): Promise<Buffer> {
  if (!options.inflate) {
    const encoding = getContentEncoding(req)

    if (encoding !== 'identity') {
      throw Object.assign(
        new Error(`Unsupported Content-Encoding: ${encoding}`),
        { status: 415, type: 'encoding.unsupported' }
      )
    }

    return readBody(req, options.limit)
  }

  return readDecodedBody(req, options.limit)
}

/** Resolve the limit in bytes from a string or number */
function resolveLimit(
  limit: string | number | undefined,
  fallback: string
): number {
  if (limit === undefined) return parseLimit(fallback)
  if (typeof limit === 'number') return limit
  return parseLimit(limit)
}

// ─────────────────────────────────────────────────────────────
// json()
// ─────────────────────────────────────────────────────────────

export function json(options: JsonOptions = {}): Middleware {
  const inflate = options.inflate ?? true
  const strict = options.strict ?? true
  const defaultCharset = options.defaultCharset ?? 'utf-8'
  const reviver = options.reviver
  const verify = options.verify
  const limit = resolveLimit(options.limit, '100kb')
  const type = options.type ?? 'application/json'

  return async ({ request, response, next }) => {
    // 0. Skip rápido se não há body esperado (GET, HEAD, etc.)
    if (
      !request.headers['content-length'] &&
      !request.headers['transfer-encoding']
    ) {
      return void (await next())
    }

    // 1. Only processes if the Content-Type matches.
    if (!matchesType(request, type)) {
      return void (await next())
    }

    // 2. Charset — JSON accepts only utf-8 / utf-16 / utf-32 (RFC 4627)
    //    Na prática, só permitimos utf-8 e latin1 como fallback.
    const charset = getCharset(
      request.headers['content-type'] || '',
      defaultCharset
    )

    if (charset !== 'utf-8' && charset !== 'latin1') {
      return void response.status(415).json({
        error: `Unsupported charset: ${charset}`,
        type: 'charset.unsupported'
      })
    }

    // 3. Read the body
    let buf: Buffer
    try {
      buf = await readRawBody(request, { inflate, limit })
    } catch (err) {
      const e = err as { status?: number; type?: string; message: string }
      return void response
        .status(e.status === 413 ? 413 : e.status === 415 ? 415 : 400)
        .json({ error: e.message, type: e.type })
    }

    // 4. Body vazio
    if (buf.length === 0) {
      return void (await next())
    }

    // 5. verify hook
    if (verify) {
      try {
        verify(request, response, buf, charset)
      } catch (err) {
        const e = err as { status?: number; message: string; type?: string }
        return void response
          .status(e.status ?? 403)
          .json({ error: e.message, type: e.type ?? 'entity.verify.failed' })
      }
    }

    // 6. Decodifica bytes → string
    const text = buf.toString(charset as BufferEncoding)

    // 7. strict mode: só aceita objeto ou array no topo
    if (strict) {
      const first = text.trimStart()[0]
      if (first !== '{' && first !== '[') {
        return void response.status(400).json({
          error: 'Invalid JSON — strict mode only accepts objects and arrays',
          type: 'entity.parse.failed'
        })
      }
    }

    // 8. Parseia
    try {
      request.body = JSON.parse(text, reviver)
    } catch {
      return void response
        .status(400)
        .json({ error: 'Invalid JSON body', type: 'entity.parse.failed' })
    }

    await next()
  }
}

// ─────────────────────────────────────────────────────────────
// urlencoded()
// ─────────────────────────────────────────────────────────────

/** Simple parser (extended: false) — equivalent to the native `querystring`.
 * Supports only string and string[] per key.
 */
function parseSimple(
  text: string,
  parameterLimit: number
): Record<string, string | string[]> {
  const result: Record<string, string | string[]> = {}
  const pairs = text.split('&')

  if (pairs.length > parameterLimit) {
    const err = Object.assign(new Error('Too many parameters'), {
      status: 413,
      type: 'parameters.too.many'
    })
    throw err
  }

  for (const pair of pairs) {
    if (!pair) continue
    const eqIdx = pair.indexOf('=')
    const decode = (str: string) => decodeURIComponent(str.replace(/\+/g, ' '))

    const key = decode(eqIdx === -1 ? pair : pair.slice(0, eqIdx))
    const value = eqIdx === -1 ? '' : decode(pair.slice(eqIdx + 1))

    if (!key) continue

    const existing = result[key]
    if (existing === undefined) {
      result[key] = value
    } else if (Array.isArray(existing)) {
      existing.push(value)
    } else {
      result[key] = [existing, value]
    }
  }

  return result
}

/** Rich parser (extended: true) — supports nested objects and arrays.
 * Example: `user[name]=John&user[age]=30&tags[]=a&tags[]=b`
 */
function parseExtended(
  text: string,
  parameterLimit: number,
  maxDepth: number
): Record<string, unknown> {
  const flat = parseSimple(text, parameterLimit)
  const result: Record<string, unknown> = {}

  for (const [rawKey, rawVal] of Object.entries(flat)) {
    const values = Array.isArray(rawVal) ? rawVal : [rawVal]
    for (const val of values) {
      assignDeep(result, rawKey, val, maxDepth)
    }
  }

  return result
}

/** Assigns `value` to `obj` following the notation `key[sub][sub2]` */
function assignDeep(
  obj: Record<string, unknown>,
  key: string,
  value: string,
  maxDepth: number,
  depth = 0
): void {
  if (depth > maxDepth) {
    const err = Object.assign(
      new Error(`Object depth limit (${maxDepth}) exceeded`),
      { status: 400, type: 'parameters.depth.exceeded' }
    )
    throw err
  }

  const bracketIdx = key.indexOf('[')

  // Simple key: no brackets
  if (bracketIdx === -1) {
    const existing = obj[key]
    if (existing === undefined) {
      obj[key] = value
    } else if (Array.isArray(existing)) {
      ;(existing as string[]).push(value)
    } else {
      obj[key] = [existing, value]
    }
    return
  }

  const head = key.slice(0, bracketIdx)
  const rest = key.slice(bracketIdx + 1, key.indexOf(']', bracketIdx))
  const tail = key.slice(key.indexOf(']', bracketIdx) + 1)

  // tags[] -> array
  if (rest === '') {
    if (!Array.isArray(obj[head])) obj[head] = []
    ;(obj[head] as unknown[]).push(value)
    return
  }

  // user[name] -> object
  if (!obj[head] || typeof obj[head] !== 'object') {
    obj[head] = {}
  }

  assignDeep(
    obj[head] as Record<string, unknown>,
    rest + tail,
    value,
    maxDepth,
    depth + 1
  )
}

export function urlencoded(options: UrlencodedOptions = {}): Middleware {
  const inflate = options.inflate ?? true
  const extended = options.extended ?? false
  const parameterLimit = options.parameterLimit ?? 1000
  const depth = options.depth ?? 32
  const defaultCharset = options.defaultCharset ?? 'utf-8'
  const verify = options.verify
  const limit = resolveLimit(options.limit, '100kb')
  const type = options.type ?? 'application/x-www-form-urlencoded'

  return async ({ request, response, next }) => {
    // 0. Skip quickly if there is no expected body (GET, HEAD, etc.)
    if (
      !request.headers['content-length'] &&
      !request.headers['transfer-encoding']
    ) {
      return void (await next())
    }

    // 1. Content-Type
    if (!matchesType(request, type)) {
      return void (await next())
    }

    // 2. Charset — urlencoded supports utf-8 and latin1
    const charset = getCharset(
      request.headers['content-type'] || '',
      defaultCharset
    )

    if (charset !== 'utf-8' && charset !== 'latin1') {
      return void response.status(415).json({
        error: `Unsupported charset: ${charset}`,
        type: 'charset.unsupported'
      })
    }

    // 3. Lê o body
    let buf: Buffer
    try {
      buf = await readRawBody(request, { inflate, limit })
    } catch (err) {
      const e = err as { status?: number; type?: string; message: string }
      return void response
        .status(e.status === 413 ? 413 : e.status === 415 ? 415 : 400)
        .json({ error: e.message, type: e.type })
    }

    // 4. Body vazio
    if (buf.length === 0) {
      return void (await next())
    }

    // 5. verify hook
    if (verify) {
      try {
        verify(request, response, buf, charset)
      } catch (err) {
        const e = err as { status?: number; message: string; type?: string }
        return void response
          .status(e.status ?? 403)
          .json({ error: e.message, type: e.type ?? 'entity.verify.failed' })
      }
    }

    // 6. Decodifica
    const text = buf.toString(charset as BufferEncoding)

    // 7. Parseia
    try {
      request.body = extended
        ? parseExtended(text, parameterLimit, depth)
        : parseSimple(text, parameterLimit)
    } catch (err) {
      const e = err as { status?: number; type?: string; message: string }
      return void response
        .status(e.status ?? 400)
        .json({ error: e.message, type: e.type ?? 'entity.parse.failed' })
    }

    await next()
  }
}
