import { stat } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { pipeFile } from '../util'
import type { Stats } from 'node:fs'

import type { Request } from '../request'
import type { Response } from '../response'

type NextFunction = () => void | Promise<void>

type HandlerContext = {
  request: Request
  response: Response
}

type MiddlewareContext = HandlerContext & { next: NextFunction }

type Middleware = (ctx: MiddlewareContext) => void | Promise<void>

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
    // request.path already stripped by use() — e.g., '/photo.jpg' instead of '/uploads/photo.jpg'
    const urlPath = decodeURIComponent(request.path || '/')

    // Prevent path traversal
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

    // Directory → attempts to serve index
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
