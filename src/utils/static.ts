import { createReadStream, type Stats } from 'node:fs'
import { extname } from 'node:path'

import type { Request } from '#/request'
import type { Response } from '#/response'

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
  stat: Stats,
  request: Request,
  response: Response,
  options: { maxAge: number; etag: boolean }
): void {
  const ext = extname(filePath).toLowerCase()
  const mime = mimeTypes[ext] || 'application/octet-stream'
  const lastModified = stat.mtime.toUTCString()
  const etagValue = `"${stat.size}-${stat.mtimeMs}"`

  if (options.etag) {
    const ifNoneMatch = request.headers['if-none-match']
    if (ifNoneMatch && ifNoneMatch === etagValue) {
      response.statusCode = 304
      response.end()
      return
    }
  }

  const ifModifiedSince = request.headers['if-modified-since']
  if (ifModifiedSince) {
    const since = new Date(ifModifiedSince).getTime()
    if (
      !isNaN(since) &&
      Math.floor(stat.mtimeMs / 1000) <= Math.floor(since / 1000)
    ) {
      response.statusCode = 304
      response.end()
      return
    }
  }

  response.setHeader('Content-Type', mime)
  response.setHeader('Content-Length', stat.size)
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
