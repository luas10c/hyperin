import {
  createGunzip,
  createInflate,
  createBrotliDecompress,
  type BrotliDecompress,
  type Inflate,
  type Gunzip
} from 'node:zlib'
import { Readable } from 'node:stream'

import type { Request } from '#/request'

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
    decoder.on('error', (error: Error & { status?: number; type?: string }) => {
      reject(
        Object.assign(new Error(error.message), {
          status: error.status ?? 400,
          type: error.type ?? 'encoding.invalid'
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
