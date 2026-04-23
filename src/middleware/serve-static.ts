import { realpath, stat } from 'node:fs/promises'
import { resolve, join, relative, isAbsolute, sep } from 'node:path'
import type { Stats } from 'node:fs'

import { pipeFile } from '#/utils/static'
import type { Middleware } from '#/types'

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
  const resolvedDirectory = resolve(directory)
  const rootDirectoryPromise = realpath(resolvedDirectory).catch(
    () => resolvedDirectory
  )
  const isMissingPathError = (error: unknown): boolean => {
    const code = (error as NodeJS.ErrnoException | undefined)?.code
    return code === 'ENOENT' || code === 'ENOTDIR'
  }

  const isPathInsideRoot = async (targetPath: string): Promise<boolean> => {
    const [rootDirectory, resolvedTarget] = await Promise.all([
      rootDirectoryPromise,
      realpath(targetPath)
    ])

    const rel = relative(rootDirectory, resolvedTarget)
    return !(rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel))
  }

  return async ({ request, response, next }) => {
    // request.path is relative to the mounted prefix, while request.url stays original.
    let urlPath: string
    try {
      urlPath = decodeURIComponent(request.path || '/')
    } catch {
      return void response.status(400).json({
        statusCode: 400,
        message: 'Bad Request'
      })
    }

    // Prevent path traversal
    const filePath = resolve(resolvedDirectory, '.' + sep + urlPath)
    const rel = relative(resolvedDirectory, filePath)
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      return void response.status(403).json({
        statusCode: 403,
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
          message: 'Forbidden'
        })
      }
      if (dotfiles === 'ignore') {
        return void response.status(404).json({
          statusCode: 404,
          message: 'Not Found'
        })
      }
    }

    let fileStat: Stats
    try {
      fileStat = await stat(filePath)
    } catch (error) {
      if (isMissingPathError(error)) {
        await next()
        return
      }

      return void response.status(404).json({
        statusCode: 404,
        message: 'Not Found'
      })
    }

    // Directory → attempts to serve index
    if (fileStat.isDirectory()) {
      if (!index) {
        await next()
        return
      }

      const indexFile = index === true ? 'index.html' : index
      const indexPath = join(filePath, indexFile)
      let indexStat: Stats
      try {
        indexStat = await stat(indexPath)
      } catch (error) {
        if (isMissingPathError(error)) {
          await next()
          return
        }

        return void response.status(404).json({
          statusCode: 404,
          message: 'Not Found'
        })
      }

      if (!(await isPathInsideRoot(filePath))) {
        return void response.status(403).json({
          statusCode: 403,
          message: 'Forbidden'
        })
      }

      return void pipeFile(indexPath, indexStat, request, response, {
        maxAge,
        etag
      })
    }

    if (!(await isPathInsideRoot(filePath))) {
      return void response.status(403).json({
        statusCode: 403,
        message: 'Forbidden'
      })
    }

    pipeFile(filePath, fileStat, request, response, { maxAge, etag })
  }
}
