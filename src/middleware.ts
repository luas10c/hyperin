import { existsSync, mkdirSync, type Stats } from 'node:fs'
import { stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import {
  parseLimit,
  readBody,
  decompressStream,
  parseMultipart,
  pipeFile
} from './util'

import type { Request, Response } from './instance'

type NextFunction = () => void | Promise<void>

type HandlerContext = {
  request: Request
  response: Response
}

type MiddlewareContext = HandlerContext & { next: NextFunction }

type Middleware = (ctx: MiddlewareContext) => void | Promise<void>

// ─────────────────────────────────────────────────────────────
// CORS
// ─────────────────────────────────────────────────────────────

export interface CorsOptions {
  /**
   * string     → origin fixo, ex: 'http://example.com'
   * string[]   → lista de origens permitidas
   * RegExp     → testa a origem
   * true       → reflete a origem da requisição (equivale a '*' com credenciais)
   * false      → desabilita CORS completamente
   * function   → callback(origin, cb) assíncrono, igual ao express/cors
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

// Normaliza string|string[] para string
function toHeaderValue(v: string | string[]): string {
  return Array.isArray(v) ? v.join(', ') : v
}

// Resolve a origem — retorna a string a usar ou false para bloquear
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

    // true → reflete a origem do request (ou '*' se não vier origem)
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
        // origem não permitida — deixa passar para o próximo handler
        if (cfg.preflightContinue) return void (await next())
        return void response.status(cfg.optionsSuccessStatus).send()
      }

      response.header('Access-Control-Allow-Origin', allowOrigin)

      // Vary: Origin sempre que não for '*'
      if (allowOrigin !== '*') {
        response.header('Vary', 'Origin')
      }

      if (cfg.credentials) {
        response.header('Access-Control-Allow-Credentials', 'true')
      }

      response.header('Access-Control-Allow-Methods', methods)

      // allowedHeaders: usa o que veio no request se não foi configurado
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

    // ── Requisição normal ──────────────────────────────────────
    if (allowOrigin === false) {
      return void (await next()) // não bloqueia — só não seta os headers
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

// ─────────────────────────────────────────────────────────────
// Body Parser
// ─────────────────────────────────────────────────────────────

export interface BodyParserOptions {
  /** Tamanho máximo do body. Ex: '100kb', '1mb'. Default: '100kb' */
  limit?: string | number
  /**
   * Charset padrão. Suporta 'utf-8' e 'latin1' / 'iso-8859-1'.
   * Default: 'utf-8'
   */
  defaultCharset?: 'utf-8' | 'latin1'
  /**
   * Permite inflar (descomprimir) gzip/deflate/br.
   * Default: true
   */
  inflate?: boolean
  /**
   * Verifica o body cru antes de parsear.
   * Lança um erro para abortar o parse.
   */
  verify?: (req: Request, res: Response, buf: Buffer, encoding: string) => void
  /**
   * Tipo de Content-Type aceito.
   * String, array de strings ou função.
   * Default para json: 'application/json'
   * Default para urlencoded: 'application/x-www-form-urlencoded'
   */
  type?: string | string[] | ((req: Request) => boolean)
}

export interface JsonOptions extends BodyParserOptions {
  /**
   * strict: só aceita objeto ou array no topo do JSON.
   * Default: true
   */
  strict?: boolean
  /**
   * Reviver passado ao JSON.parse.
   */
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
   * Número máximo de parâmetros.
   * Default: 1000
   */
  parameterLimit?: number
}

// ── helpers internos ──────────────────────────────────────────

/** Extrai o charset do Content-Type, ex: 'utf-8', 'iso-8859-1' */
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
      // mime type exato ou wildcard: '*/*', '*/json', 'application/*'
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

/** Lê e descomprime o body, respeitando o limite */
async function readRawBody(
  req: Request,
  options: { inflate: boolean; limit: number }
): Promise<Buffer> {
  if (!options.inflate) {
    const encoding = req.headers['content-encoding']?.toLowerCase()
    if (encoding && encoding !== 'identity') {
      const err = Object.assign(
        new Error(`Unsupported Content-Encoding: ${encoding}`),
        { status: 415, type: 'encoding.unsupported', charset: encoding }
      )
      throw err
    }
    return readBody(req, options.limit)
  }

  return readBody(decompressStream(req), options.limit)
}

/** Resolve o limite em bytes a partir de string ou number */
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
    // 1. Só processa se o Content-Type bater
    if (!matchesType(request, type)) {
      return void (await next())
    }

    // 2. Charset — JSON aceita apenas utf-8 / utf-16 / utf-32 (RFC 4627)
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

/**
 * Parser simples (extended: false) — equivalente ao `querystring` nativo.
 * Suporta apenas string e string[] por chave.
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

/**
 * Parser rico (extended: true) — suporta objetos aninhados e arrays.
 * Ex: `user[name]=John&user[age]=30&tags[]=a&tags[]=b`
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

/** Atribui `value` em `obj` seguindo a notação `key[sub][sub2]` */
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

  // Chave simples: sem colchetes
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

  // tags[] → array
  if (rest === '') {
    if (!Array.isArray(obj[head])) obj[head] = []
    ;(obj[head] as unknown[]).push(value)
    return
  }

  // user[name] → objeto
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
    // 1. Content-Type
    if (!matchesType(request, type)) {
      return void (await next())
    }

    // 2. Charset — urlencoded suporta utf-8 e latin1
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

// ─────────────────────────────────────────────────────────────
// Multipart
// ─────────────────────────────────────────────────────────────

export interface MultipartOptions {
  dest?: string
  limits?: {
    fileSize?: number
    files?: number
    fields?: number
  }
}

export function multipart(options: MultipartOptions = {}): Middleware {
  const dest = options.dest || './uploads'
  const limits = options.limits || {}

  if (!existsSync(dest)) {
    mkdirSync(dest, { recursive: true })
  }

  return async ({ request, response, next }) => {
    const ct = request.headers['content-type'] || ''
    if (!ct.includes('multipart/form-data')) {
      await next()
      return
    }

    const boundaryMatch = ct.match(/boundary=(?:"([^"]+)"|([^;]+))/i)
    const boundary = boundaryMatch?.[1] || boundaryMatch?.[2]

    if (!boundary) {
      return void response.status(400).json({
        statusCode: 400,
        error: 'Missing multipart boundary',
        method: request.method
      })
    }

    try {
      const { fields, files } = await parseMultipart(
        request,
        boundary,
        dest,
        limits
      )
      request.body = fields
      request.files = files
    } catch (err) {
      if (err instanceof Error) {
        return void response
          .status(400)
          .json({ statusCode: 400, error: err.message, method: request.method })
      }
    }

    await next()
  }
}

// ─────────────────────────────────────────────────────────────
// Static file serving
// ─────────────────────────────────────────────────────────────

export interface StaticOptions {
  /** Serve index.html for directory requests (default: true) */
  index?: boolean | string
  /** Set max-age for Cache-Control in seconds (default: 0) */
  maxAge?: number
  /** Add ETag header (default: true) */
  etag?: boolean
  /** Dotfiles: 'allow' | 'deny' | 'ignore' (default: 'ignore') */
  dotfiles?: 'allow' | 'deny' | 'ignore'
}

export function serveStatic(
  directory: string,
  options: StaticOptions = {}
): Middleware {
  const { index = true, maxAge = 0, etag = true, dotfiles = 'ignore' } = options

  return async ({ request, response }) => {
    // request.path já chegou stripado pelo use() — ex: '/foto.jpg' em vez de '/uploads/foto.jpg'
    const urlPath = decodeURIComponent(request.path || '/')

    // Previne path traversal
    const filePath = resolve(join(directory, urlPath))
    if (!filePath.startsWith(directory)) {
      return void response
        .status(403)
        .json({ statusCode: 403, error: 'Forbidden', method: request.method })
    }

    // Dotfiles
    const hasDot = urlPath
      .split('/')
      .some((s) => s.startsWith('.') && s.length > 1)
    if (hasDot) {
      if (dotfiles === 'deny') {
        return void response
          .status(403)
          .json({ statusCode: 403, error: 'Forbidden', method: request.method })
      }
      if (dotfiles === 'ignore') {
        return void response
          .status(404)
          .json({ statusCode: 404, error: 'Not Found', method: request.method })
      }
    }

    let fileStat: Stats
    try {
      fileStat = await stat(filePath)
    } catch {
      return void response
        .status(404)
        .json({ statusCode: 404, error: 'Not Found', method: request.method })
    }

    // Diretório → tenta servir index
    if (fileStat.isDirectory()) {
      if (!index) {
        return void response
          .status(404)
          .json({ statusCode: 404, error: 'Not Found', method: request.method })
      }
      const indexFile = index === true ? 'index.html' : index
      const indexPath = join(filePath, indexFile)
      let indexStat: Stats
      try {
        indexStat = await stat(indexPath)
      } catch {
        return void response
          .status(404)
          .json({ statusCode: 404, error: 'Not Found', method: request.method })
      }

      return void pipeFile(indexPath, indexStat, request, response, {
        maxAge,
        etag
      })
    }

    pipeFile(filePath, fileStat, request, response, { maxAge, etag })
  }
}
