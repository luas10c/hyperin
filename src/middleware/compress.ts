import {
  constants,
  createBrotliCompress,
  createDeflate,
  createGzip,
  type BrotliOptions,
  type Deflate,
  type Gzip,
  type ZlibOptions
} from 'node:zlib'

import type { Request } from '../request'
import type { Response } from '../response'

type NextFunction = () => void | Promise<void>

type MiddlewareContext = {
  request: Request
  response: Response
  next: NextFunction
}

type Middleware = (ctx: MiddlewareContext) => void | Promise<void>

type CompressionEncoding = 'br' | 'gzip' | 'deflate'

export interface CompressOptions {
  threshold?: number
  encodings?: readonly CompressionEncoding[]
  filter?: (
    contentType: string | undefined,
    request: Request,
    response: Response
  ) => boolean
  brotli?: BrotliOptions
  gzip?: ZlibOptions
  deflate?: ZlibOptions
}

type CompressionStream =
  | ReturnType<typeof createBrotliCompress>
  | Gzip
  | Deflate

const DEFAULT_ENCODINGS: readonly CompressionEncoding[] = [
  'br',
  'gzip',
  'deflate'
]

function appendVary(
  current: number | string | string[] | readonly string[] | undefined
): string {
  if (current === undefined) return 'Accept-Encoding'

  const source = Array.isArray(current) ? current.join(', ') : String(current)
  if (source.toLowerCase().includes('accept-encoding')) return source
  return `${source}, Accept-Encoding`
}

function parseContentLength(
  value: number | string | string[] | undefined
): number | null {
  if (typeof value === 'number') return value
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value, 10)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function isCompressibleContentType(contentType: string | undefined): boolean {
  if (!contentType) return false

  const normalized = contentType.split(';')[0].trim().toLowerCase()

  return (
    normalized.startsWith('text/') ||
    normalized.includes('json') ||
    normalized.includes('xml') ||
    normalized.includes('javascript') ||
    normalized === 'image/svg+xml' ||
    normalized === 'application/x-www-form-urlencoded'
  )
}

function shouldSkipCompression(request: Request, response: Response): boolean {
  if (
    request.method === 'HEAD' ||
    response.statusCode < 200 ||
    response.statusCode === 204 ||
    response.statusCode === 205 ||
    response.statusCode === 304 ||
    response.hasHeader('Content-Encoding')
  ) {
    return true
  }

  const cacheControl = response.getHeader('Cache-Control')
  if (
    typeof cacheControl === 'string' &&
    /(?:^|,)\s*no-transform\s*(?:,|$)/i.test(cacheControl)
  ) {
    return true
  }

  return false
}

function pickEncoding(
  header: string | string[] | undefined,
  supported: readonly CompressionEncoding[]
): CompressionEncoding | null {
  const value = Array.isArray(header) ? header.join(',') : header
  if (!value) return null

  let best: CompressionEncoding | null = null
  let bestQ = 0

  for (const rawPart of value.split(',')) {
    const [rawEncoding, ...params] = rawPart.trim().toLowerCase().split(';')
    if (!rawEncoding) continue

    let q = 1
    for (const param of params) {
      const trimmed = param.trim()
      if (!trimmed.startsWith('q=')) continue
      const parsed = Number.parseFloat(trimmed.slice(2))
      if (Number.isFinite(parsed)) q = parsed
    }

    if (q <= 0) continue

    for (const encoding of supported) {
      if ((rawEncoding === '*' || rawEncoding === encoding) && q > bestQ) {
        best = encoding
        bestQ = q
      }
    }
  }

  return best
}

function createCompressionStream(
  encoding: CompressionEncoding,
  options: CompressOptions
): CompressionStream {
  if (encoding === 'br') {
    return createBrotliCompress({
      params: {
        [constants.BROTLI_PARAM_QUALITY]: 4,
        ...options.brotli?.params
      },
      ...options.brotli
    })
  }

  if (encoding === 'gzip') {
    return createGzip({ level: constants.Z_BEST_SPEED, ...options.gzip })
  }

  return createDeflate({ level: constants.Z_BEST_SPEED, ...options.deflate })
}

function toBuffer(chunk: Buffer | string, encoding?: BufferEncoding): Buffer {
  if (Buffer.isBuffer(chunk)) return chunk
  return encoding ? Buffer.from(chunk, encoding) : Buffer.from(chunk)
}

export function compress(options: CompressOptions = {}): Middleware {
  const threshold = options.threshold ?? 1024
  const supportedEncodings = options.encodings ?? DEFAULT_ENCODINGS
  const filter = options.filter ?? isCompressibleContentType

  return async ({ request, response, next }) => {
    const selectedEncoding = pickEncoding(
      request.headers['accept-encoding'],
      supportedEncodings
    )

    if (!selectedEncoding) {
      return void (await next())
    }

    const originalWrite = response.write.bind(response)
    const originalEnd = response.end.bind(response)

    let buffered: Buffer[] = []
    let bufferedLength = 0
    let compressionStream: CompressionStream | null = null
    let started = false
    let passthrough = false

    const flushBufferedPassthrough = (): void => {
      if (buffered.length === 0) return
      for (const chunk of buffered) originalWrite(chunk)
      buffered = []
      bufferedLength = 0
    }

    const startCompression = (): void => {
      if (started) return

      started = true
      compressionStream = createCompressionStream(selectedEncoding, options)
      compressionStream.on('data', (chunk: Buffer) => {
        originalWrite(chunk)
      })
      compressionStream.on('end', () => {
        originalEnd()
      })
      compressionStream.on('error', (error: Error) => {
        response.destroy(error)
      })

      response.removeHeader('Content-Length')
      response.setHeader('Content-Encoding', selectedEncoding)
      response.setHeader('Vary', appendVary(response.getHeader('Vary')))

      for (const chunk of buffered) compressionStream.write(chunk)
      buffered = []
      bufferedLength = 0
    }

    const shouldCompress = (ending: boolean): boolean => {
      if (shouldSkipCompression(request, response)) return false
      if (response.headersSent) return false

      const contentType = response.getHeader('Content-Type')
      const normalizedType = Array.isArray(contentType)
        ? contentType[0]
        : typeof contentType === 'number'
          ? String(contentType)
          : contentType

      if (!filter(normalizedType, request, response)) return false

      const contentLength = parseContentLength(
        response.getHeader('Content-Length') as
          | number
          | string
          | string[]
          | undefined
      )

      if (contentLength !== null) return contentLength >= threshold
      if (!ending) return bufferedLength >= threshold
      return bufferedLength >= threshold
    }

    response.write = ((
      chunk: Buffer | string,
      encoding?: BufferEncoding,
      cb?: (error?: Error | null) => void
    ) => {
      if (passthrough) {
        if (encoding) return originalWrite(chunk, encoding, cb)
        return originalWrite(chunk, cb)
      }

      const buffer = toBuffer(chunk, encoding)

      if (compressionStream) {
        const wrote = compressionStream.write(buffer)
        if (cb) cb()
        return wrote
      }

      buffered.push(buffer)
      bufferedLength += buffer.length

      if (shouldCompress(false)) {
        startCompression()
        if (cb) cb()
        return true
      }

      if (response.headersSent) {
        passthrough = true
        flushBufferedPassthrough()
      }

      if (cb) cb()
      return true
    }) as typeof response.write

    response.end = ((
      chunk?: Buffer | string,
      encoding?: BufferEncoding,
      cb?: () => void
    ) => {
      if (typeof chunk === 'function') {
        cb = chunk
        chunk = undefined
        encoding = undefined
      } else if (typeof encoding === 'function') {
        cb = encoding
        encoding = undefined
      }

      if (chunk !== undefined) {
        if (encoding) {
          response.write(chunk, encoding)
        } else {
          response.write(chunk)
        }
      }

      if (passthrough) {
        return cb ? originalEnd(cb) : originalEnd()
      }

      if (!compressionStream && shouldCompress(true)) {
        startCompression()
      }

      if (compressionStream) {
        compressionStream.end()
        if (cb) response.once('finish', cb)
        return response
      }

      passthrough = true
      flushBufferedPassthrough()
      return cb ? originalEnd(cb) : originalEnd()
    }) as typeof response.end

    await next()
  }
}
