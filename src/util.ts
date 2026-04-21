import {
  createGunzip,
  createInflate,
  createBrotliDecompress,
  type BrotliDecompress,
  type Inflate,
  type Gunzip
} from 'node:zlib'
import { Readable } from 'node:stream'
import { createReadStream, statSync } from 'node:fs'
import { extname } from 'node:path'

import type { Request } from './request'
import type { Response } from './response'

import type { FileHandler, FileInfo } from './middleware/multipart'

type ParseLimits = {
  fileSize?: number
  files?: number
  fields?: number
}

type ParsedResult = {
  fields: Record<string, string>
  files: Record<string, unknown>
}

export interface UploadedFile {
  fieldname: string
  filename: string
  encoding: string
  mimetype: string
  size: number
  path: string
}

const CRLF = '\r\n'
const DOUBLE_CRLF = '\r\n\r\n'

// ─────────────────────────────────────────────────────────────
// Body Parser
// ─────────────────────────────────────────────────────────────

export function parseLimit(limit: string): number {
  const match = limit.match(/^(\d+(?:\.\d+)?)(b|kb|mb|gb)?$/i)
  if (!match) return 1024 * 1024
  const value = parseFloat(match[1])
  const units: Record<string, number> = {
    b: 1,
    kb: 1024,
    mb: 1024 ** 2,
    gb: 1024 ** 3
  }
  return Math.floor(value * (units[match[2]?.toLowerCase() || 'b'] || 1))
}

export function readBody(stream: Readable, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let total = 0

    stream.on('data', (chunk: Buffer) => {
      total += chunk.length
      if (total > maxBytes) {
        stream.destroy()
        return reject(
          Object.assign(new Error('Payload Too Large'), { status: 413 })
        )
      }
      chunks.push(chunk)
    })
    stream.on('end', () => resolve(Buffer.concat(chunks)))
    stream.on('error', reject)
    stream.on('aborted', () => {
      reject(Object.assign(new Error('Request aborted'), { status: 400 }))
    })
  })
}

export async function parseMultipart(
  request: Request,
  boundary: string,
  limits: ParseLimits = {},
  onFile?: FileHandler
): Promise<ParsedResult> {
  const fields: Record<string, string> = {}
  const files: Record<string, unknown> = {}

  let fileCount = 0
  let fieldCount = 0

  // Collect the entire body into a Buffer
  // (for large streams, consider using an incremental parser like busboy)
  const body = await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    })
    request.on('end', () => resolve(Buffer.concat(chunks)))
    request.on('error', reject)
  })

  const delimiter = Buffer.from(`--${boundary}`)
  const parts = splitBuffer(body, delimiter)

  for (const part of parts) {
    // Ignore the epilogue (last "--")
    if (part.equals(Buffer.from('--\r\n')) || part.equals(Buffer.from('--'))) {
      continue
    }

    // Remove the initial CRLF from each part
    const partContent = part.subarray(0, 2).equals(Buffer.from(CRLF))
      ? part.subarray(2)
      : part

    // Split headers from the body of the part
    const separatorIndex = indexOfDoubleNewline(partContent)
    if (separatorIndex === -1) continue

    const headerSection = partContent
      .subarray(0, separatorIndex)
      .toString('utf8')

    // +4 to skip the \r\n\r\n
    const bodyBuffer = partContent.subarray(separatorIndex + 4)
    // Remove the trailing CRLF from the body
    const bodyContent = partContent
      .subarray(partContent.length - 2)
      .equals(Buffer.from(CRLF))
      ? bodyBuffer.subarray(0, bodyBuffer.length - 2)
      : bodyBuffer

    const headers = parseHeaders(headerSection)
    const disposition = headers['content-disposition'] || ''
    const fieldname = extractParam(disposition, 'name')
    const filename = extractParam(disposition, 'filename')

    if (!fieldname) continue

    if (filename !== null) {
      // It's a file
      if (limits.files !== undefined && fileCount >= limits.files) {
        throw new Error(`Too many files (limit: ${limits.files})`)
      }

      if (
        limits.fileSize !== undefined &&
        bodyContent.length > limits.fileSize
      ) {
        throw new Error(
          `File "${filename}" exceeds size limit of ${limits.fileSize} bytes`
        )
      }

      fileCount++

      const info: FileInfo = {
        fieldname,
        filename: filename || 'unnamed',
        mimetype: headers['content-type'] || 'application/octet-stream',
        encoding: headers['content-transfer-encoding'] || '7bit',
        size: bodyContent.length
      }

      if (onFile) {
        // Create a readable stream from the buffer and pass it to the handler
        const stream = Readable.from(bodyContent)
        files[fieldname] = await onFile(stream, info)
      }
      // If there is no onFile, the file is simply discarded
    } else {
      // It's a text field
      if (limits.fields !== undefined && fieldCount >= limits.fields) {
        throw new Error(`Too many fields (limit: ${limits.fields})`)
      }

      fieldCount++
      fields[fieldname] = bodyContent.toString('utf8')
    }
  }

  return { fields, files }
}

export const mimeTypes: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.zip': 'application/zip',
  '.gz': 'application/gzip'
} as const

export function pipeFile(
  filePath: string,
  stat: ReturnType<typeof statSync>,
  request: Request,
  response: Response,
  options: { maxAge: number; etag: boolean }
): void {
  const ext = extname(filePath).toLowerCase()
  const mime = mimeTypes[ext] || 'application/octet-stream'
  const lastModified = stat!.mtime.toUTCString()
  const etagValue = `"${stat!.size}-${stat!.mtimeMs}"`

  // ── Conditional request: If-None-Match (ETag) ──────────────
  if (options.etag) {
    const ifNoneMatch = request.headers['if-none-match']
    if (ifNoneMatch && ifNoneMatch === etagValue) {
      response.statusCode = 304
      response.end()
      return
    }
  }

  //  ── Conditional request: If-Modified-Since ─────────────────
  const ifModifiedSince = request.headers['if-modified-since']
  if (ifModifiedSince) {
    const since = new Date(ifModifiedSince).getTime()
    // Truncate to seconds — same precision as the HTTP header
    if (
      !isNaN(since) &&
      Math.floor((stat!.mtimeMs as number) / 1000) <= Math.floor(since / 1000)
    ) {
      response.statusCode = 304
      response.end()
      return
    }
  }

  response.setHeader('Content-Type', mime)
  response.setHeader('Content-Length', stat!.size as number)
  response.setHeader('Last-Modified', lastModified)
  response.setHeader(
    'Cache-Control',
    options.maxAge ? `public, max-age=${options.maxAge}` : 'no-cache'
  )
  if (options.etag) {
    response.setHeader('ETag', etagValue)
  }

  response.statusCode = 200
  const stream = createReadStream(filePath)
  stream.on('error', () => {
    if (!response.headersSent) response.statusCode = 500
    response.end()
  })
  stream.pipe(response)
}

export function getContentEncoding(
  req: Request
): 'identity' | 'gzip' | 'deflate' | 'br' {
  const raw = req.headers['content-encoding']
  const value = Array.isArray(raw) ? raw[0] : raw

  if (!value) return 'identity'

  const encoding = value.split(',')[0].trim().toLowerCase()

  if (encoding === '' || encoding === 'identity') return 'identity'
  if (encoding === 'gzip' || encoding === 'x-gzip') return 'gzip'
  if (encoding === 'deflate') return 'deflate'
  if (encoding === 'br') return 'br'

  throw Object.assign(new Error(`Unsupported Content-Encoding: ${encoding}`), {
    status: 415,
    type: 'encoding.unsupported'
  })
}

function createDecoder(
  encoding: 'gzip' | 'deflate' | 'br'
): Gunzip | Inflate | BrotliDecompress {
  if (encoding === 'gzip') return createGunzip()
  if (encoding === 'deflate') return createInflate()
  return createBrotliDecompress()
}

export function decompressStream(
  req: Request
): Request | Gunzip | Inflate | BrotliDecompress {
  const encoding = getContentEncoding(req)
  if (encoding === 'identity') return req
  return req.pipe(createDecoder(encoding))
}

async function decodeCompressedBuffer(
  payload: Buffer,
  encoding: 'gzip' | 'deflate' | 'br',
  maxBytes: number
): Promise<Buffer> {
  const decoder = createDecoder(encoding)
  const source = Readable.from(payload)

  return await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = []
    let total = 0

    source.on('error', reject)

    decoder.on('data', (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      total += buffer.length

      if (total > maxBytes) {
        decoder.destroy(
          Object.assign(new Error('Body exceeds limit'), {
            status: 413,
            type: 'entity.too.large'
          })
        )
        return
      }

      chunks.push(buffer)
    })

    decoder.on('end', () => resolve(Buffer.concat(chunks)))
    decoder.on('error', (error: Error) => {
      reject(
        Object.assign(new Error(error.message), {
          status: 400,
          type: 'encoding.invalid'
        })
      )
    })

    source.pipe(decoder)
  })
}

function parseSerializedBufferPayload(payload: Buffer): Buffer | null {
  if (payload.length === 0 || payload[0] !== 0x7b) return null

  try {
    const parsed = JSON.parse(payload.toString('utf8')) as {
      type?: unknown
      data?: unknown
    }

    if (parsed?.type !== 'Buffer' || !Array.isArray(parsed.data)) return null

    for (const value of parsed.data) {
      if (
        typeof value !== 'number' ||
        !Number.isInteger(value) ||
        value < 0 ||
        value > 255
      ) {
        return null
      }
    }

    return Buffer.from(parsed.data)
  } catch {
    return null
  }
}

export async function readDecodedBody(
  req: Request,
  maxBytes: number
): Promise<Buffer> {
  const encoding = getContentEncoding(req)

  if (encoding === 'identity') {
    return readBody(req, maxBytes)
  }

  const compressed = await readBody(req, maxBytes)

  try {
    return await decodeCompressedBuffer(compressed, encoding, maxBytes)
  } catch (error) {
    const normalized = parseSerializedBufferPayload(compressed)
    if (!normalized) throw error
    return await decodeCompressedBuffer(normalized, encoding, maxBytes)
  }
}

function splitBuffer(buffer: Buffer, delimiter: Buffer): Buffer[] {
  const parts: Buffer[] = []
  let start = 0

  while (true) {
    const idx = buffer.indexOf(delimiter, start)
    if (idx === -1) {
      parts.push(buffer.subarray(start))
      break
    }
    parts.push(buffer.subarray(start, idx))
    start = idx + delimiter.length
  }

  return parts.filter((part) => part.length > 0)
}

function indexOfDoubleNewline(buffer: Buffer): number {
  const needle = Buffer.from(DOUBLE_CRLF)
  return buffer.indexOf(needle)
}

function parseHeaders(raw: string): Record<string, string> {
  const headers: Record<string, string> = {}
  for (const line of raw.split(CRLF)) {
    const colon = line.indexOf(':')
    if (colon === -1) continue
    const key = line.slice(0, colon).trim().toLowerCase()
    const value = line.slice(colon + 1).trim()
    headers[key] = value
  }
  return headers
}

function extractParam(header: string, param: string): string | null {
  const regex = new RegExp(`${param}="([^"]*)"`, 'i')
  const match = header.match(regex)
  // filename may exist without quotes
  if (!match && param === 'filename') {
    const bare = header.match(/filename=([^;]+)/i)
    return bare ? bare[1].trim() : null
  }
  return match ? match[1] : null
}
