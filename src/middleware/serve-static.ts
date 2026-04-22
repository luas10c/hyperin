import { stat } from 'node:fs/promises'
import { resolve, join, relative, isAbsolute, sep } from 'node:path'
import type { Stats } from 'node:fs'

import { pipeFile } from '#/util'
import type { Middleware } from '#/types'

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
    // request.path is relative to the mounted prefix, while request.url stays original.
    let urlPath: string
    try {
      urlPath = decodeURIComponent(request.path || '/')
    } catch {
      return void response.status(400).json({
        statusCode: 400,
        path: request.url ?? '/',
        message: 'Bad Request'
      })
    }

    // Prevent path traversal
    const filePath = resolve(directory, '.' + sep + urlPath)
    const rel = relative(directory, filePath)
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      return void response.status(403).json({
        statusCode: 403,
        path: request.url ?? '/',
        message: 'Forbidden'
      })
    }

    // Dotfiles
    const hasDot = urlPath
      .split('/')
      .some((s) => s.startsWith('.') && s.length > 1)
    if (hasDot) {
      if (dotfiles === 'deny') {
        return void response.status(403).json({
          statusCode: 403,
          path: request.url ?? '/',
          message: 'Forbidden'
        })
      }
      if (dotfiles === 'ignore') {
        return void response.status(404).json({
          statusCode: 404,
          path: request.url ?? '/',
          message: 'Not Found'
        })
      }
    }

    let fileStat: Stats
    try {
      fileStat = await stat(filePath)
    } catch {
      return void response.status(404).json({
        statusCode: 404,
        path: request.url ?? '/',
        message: 'Not Found'
      })
    }

    // Directory → attempts to serve index
    if (fileStat.isDirectory()) {
      if (!index) {
        return void response.status(404).json({
          statusCode: 404,
          path: request.url ?? '/',
          message: 'Not Found'
        })
      }
      const indexFile = index === true ? 'index.html' : index
      const indexPath = join(filePath, indexFile)
      let indexStat: Stats
      try {
        indexStat = await stat(indexPath)
      } catch {
        return void response.status(404).json({
          statusCode: 404,
          path: request.url ?? '/',
          message: 'Not Found'
        })
      }

      return void pipeFile(indexPath, indexStat, request, response, {
        maxAge,
        etag
      })
    }

    pipeFile(filePath, fileStat, request, response, { maxAge, etag })
  }
}
