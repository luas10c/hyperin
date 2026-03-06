import {
  createGunzip,
  createInflate,
  createBrotliDecompress,
  type Gunzip
} from 'node:zlib'
import { type Readable } from 'node:stream'
import { createWriteStream, createReadStream, statSync } from 'node:fs'
import { join, extname } from 'node:path'
import type { IncomingMessage } from 'node:http'

import type { Request } from './request'
import type { Response } from './response'

export interface UploadedFile {
  fieldname: string
  filename: string
  encoding: string
  mimetype: string
  size: number
  path: string
}

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

export async function readBody(
  stream: Request | Readable | Gunzip,
  maxBytes: number
): Promise<Buffer> {
  const chunks: Buffer[] = []
  let total = 0

  for await (const chunk of stream) {
    total += chunk.length
    if (total > maxBytes)
      throw Object.assign(new Error('Payload Too Large'), { status: 413 })
    chunks.push(chunk)
  }

  return Buffer.concat(chunks)
}

function parsePartHeaders(raw: string): {
  name: string
  filename: string
  contentType: string
  encoding: string
} {
  const result = { name: '', filename: '', contentType: '', encoding: '' }
  for (const line of raw.split('\r\n')) {
    const ci = line.indexOf(':')
    if (ci === -1) continue
    const key = line.slice(0, ci).trim().toLowerCase()
    const val = line.slice(ci + 1).trim()
    if (key === 'content-disposition') {
      const name = val.match(/name="([^"]+)"/)
      const fname = val.match(/filename="([^"]+)"/)
      if (name) result.name = name[1]
      if (fname) result.filename = fname[1]
    } else if (key === 'content-type') {
      result.contentType = val
    } else if (key === 'content-transfer-encoding') {
      result.encoding = val
    }
  }
  return result
}

interface ParseResult {
  fields: Record<string, string>
  files: Record<string, UploadedFile>
}

//

export async function parseMultipart(
  stream: IncomingMessage,
  boundary: string,
  dest: string,
  limits: { fileSize?: number; files?: number; fields?: number }
): Promise<ParseResult> {
  const fields: Record<string, string> = {}
  const files: Record<string, UploadedFile> = {}
  let fieldCount = 0
  let fileCount = 0

  const boundaryBuf = Buffer.from(`--${boundary}`)
  const headerEnd = Buffer.from('\r\n\r\n')

  const indexOf = (haystack: Buffer, needle: Buffer, start: number): number => {
    outer: for (let i = start; i <= haystack.length - needle.length; i++) {
      for (let j = 0; j < needle.length; j++) {
        if (haystack[i + j] !== needle[j]) continue outer
      }
      return i
    }
    return -1
  }

  const rawChunks: Buffer[] = []
  let totalSize = 0
  for await (const chunk of stream) {
    totalSize += chunk.length
    if (limits.fileSize && totalSize > limits.fileSize) {
      throw new Error('File size limit exceeded')
    }

    rawChunks.push(chunk)
  }
  const buf = Buffer.concat(rawChunks)

  // Encontra todas as posições dos boundaries
  const boundaries: number[] = []
  let searchFrom = 0
  while (true) {
    const pos = indexOf(buf, boundaryBuf, searchFrom)
    if (pos === -1) break
    boundaries.push(pos)
    searchFrom = pos + boundaryBuf.length
  }

  for (let b = 0; b < boundaries.length; b++) {
    const boundaryPos = boundaries[b]
    const afterBoundary = boundaryPos + boundaryBuf.length

    // -- no final = epilogue, para de processar
    if (buf[afterBoundary] === 45 && buf[afterBoundary + 1] === 45) break

    // \r\n após o boundary
    const partStart = afterBoundary + 2 // pula \r\n

    // Acha fim dos headers da parte
    const headerEndPos = indexOf(buf, headerEnd, partStart)
    if (headerEndPos === -1) continue

    const hdrs = parsePartHeaders(
      buf.subarray(partStart, headerEndPos).toString()
    )
    const contentStart = headerEndPos + headerEnd.length

    // Fim do conteúdo = próximo boundary - 2 (o \r\n antes do --)
    const contentEnd =
      b + 1 < boundaries.length ? boundaries[b + 1] - 2 : buf.length

    const data = buf.subarray(contentStart, contentEnd)

    const field = hdrs.name
    const filename = hdrs.filename
    const mime = hdrs.contentType || 'application/octet-stream'
    const encoding = hdrs.encoding || '7bit'

    if (!field) continue

    if (filename) {
      if (limits.files !== undefined && fileCount >= limits.files) {
        throw new Error('Too many files')
      }

      const path = join(dest, `${Date.now()}-${filename}`)
      await new Promise<void>((resolve, reject) => {
        const ws = createWriteStream(path)
        ws.write(data)
        ws.end()
        ws.on('finish', resolve)
        ws.on('error', reject)
      })

      files[field] = {
        fieldname: field,
        filename,
        encoding,
        mimetype: mime,
        size: data.length,
        path
      }
      fileCount++
    } else {
      if (limits.fields !== undefined && fieldCount >= limits.fields) {
        throw new Error('Too many fields')
      }
      fields[field] = data.toString('utf-8')
      fieldCount++
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

  // ── Conditional request: If-Modified-Since ─────────────────
  const ifModifiedSince = request.headers['if-modified-since']
  if (ifModifiedSince) {
    const since = new Date(ifModifiedSince).getTime()
    // Trunca para segundos — mesma precisão que o header HTTP
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

export function decompressStream(req: Request) {
  const encoding = req.headers['content-encoding']?.toLowerCase()
  if (encoding === 'gzip') return req.pipe(createGunzip())
  if (encoding === 'deflate') return req.pipe(createInflate())
  if (encoding === 'br') return req.pipe(createBrotliDecompress())

  return req // sem compressão, passa direto
}
