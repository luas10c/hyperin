import { realpath, stat } from 'node:fs/promises'
import { resolve, join, relative, isAbsolute, sep } from 'node:path'
import type { Stats } from 'node:fs'

import { mimeTypes, pipeFile } from '#/utils/static'
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
  const metadataTtlMs = 5_000
  const metadataCacheMaxEntries = 512
  const resolvedDirectory = resolve(directory)
  const rootDirectoryPromise = realpath(resolvedDirectory).catch(
    () => resolvedDirectory
  )
  const metadataCache = new Map<
    string,
    {
      expiresAt: number
      stat: Stats
      contentType: string
      etagValue: string
      lastModified: string
    }
  >()
  const isMissingPathError = (error: unknown): boolean => {
    const code = (error as NodeJS.ErrnoException | undefined)?.code
    return code === 'ENOENT' || code === 'ENOTDIR'
  }

  const resolvePathWithinRoot = async (
    targetPath: string
  ): Promise<{ path: string; stat: Stats }> => {
    const [rootDirectory, resolvedTarget] = await Promise.all([
      rootDirectoryPromise,
      realpath(targetPath)
    ])
    const rel = relative(rootDirectory, resolvedTarget)

    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw Object.assign(new Error('Forbidden'), { status: 403 })
    }

    return {
      path: resolvedTarget,
      stat: await stat(resolvedTarget)
    }
  }

  const getMetadata = async (
    resolvedPath: string,
    fileStat: Stats
  ): Promise<{
    stat: Stats
    contentType: string
    etagValue: string
    lastModified: string
  }> => {
    const now = Date.now()
    const cached = metadataCache.get(resolvedPath)
    if (cached && cached.expiresAt > now) {
      return {
        stat: cached.stat,
        contentType: cached.contentType,
        etagValue: cached.etagValue,
        lastModified: cached.lastModified
      }
    }

    const ext = resolvedPath.slice(resolvedPath.lastIndexOf('.')).toLowerCase()
    const contentType = mimeTypes[ext] || 'application/octet-stream'
    const etagValue = `"${fileStat.size}-${fileStat.mtimeMs}"`
    const lastModified = fileStat.mtime.toUTCString()

    if (metadataCache.size >= metadataCacheMaxEntries) {
      const oldest = metadataCache.keys().next().value
      if (oldest) metadataCache.delete(oldest)
    }

    metadataCache.set(resolvedPath, {
      expiresAt: now + metadataTtlMs,
      stat: fileStat,
      contentType,
      etagValue,
      lastModified
    })

    return { stat: fileStat, contentType, etagValue, lastModified }
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

    let resolvedFile: { path: string; stat: Stats }
    try {
      resolvedFile = await resolvePathWithinRoot(filePath)
    } catch (error) {
      if ((error as { status?: number }).status === 403) {
        return void response.status(403).json({
          statusCode: 403,
          message: 'Forbidden'
        })
      }

      if (isMissingPathError(error)) {
        await next()
        return
      }

      return void response.status(404).json({
        statusCode: 404,
        message: 'Not Found'
      })
    }

    const fileStat = resolvedFile.stat

    // Directory → attempts to serve index
    if (fileStat.isDirectory()) {
      if (!index) {
        await next()
        return
      }

      const indexFile = index === true ? 'index.html' : index
      const indexPath = join(resolvedFile.path, indexFile)
      let resolvedIndex: { path: string; stat: Stats }
      try {
        resolvedIndex = await resolvePathWithinRoot(indexPath)
      } catch (error) {
        if ((error as { status?: number }).status === 403) {
          return void response.status(403).json({
            statusCode: 403,
            message: 'Forbidden'
          })
        }

        if (isMissingPathError(error)) {
          await next()
          return
        }

        return void response.status(404).json({
          statusCode: 404,
          message: 'Not Found'
        })
      }

      return void pipeFile(
        resolvedIndex.path,
        resolvedIndex.stat,
        request,
        response,
        {
          maxAge,
          etag
        }
      )
    }

    if (request.method === 'HEAD') {
      const metadata = await getMetadata(resolvedFile.path, fileStat)
      if (etag) {
        const ifNoneMatch = request.headers['if-none-match']
        if (ifNoneMatch && ifNoneMatch === metadata.etagValue) {
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
          Math.floor(metadata.stat.mtimeMs / 1000) <= Math.floor(since / 1000)
        ) {
          response.statusCode = 304
          response.end()
          return
        }
      }

      response.setHeader('Content-Type', metadata.contentType)
      response.setHeader('Content-Length', metadata.stat.size)
      response.setHeader('Last-Modified', metadata.lastModified)
      response.setHeader(
        'Cache-Control',
        maxAge ? `public, max-age=${maxAge}` : 'no-cache'
      )
      if (etag) {
        response.setHeader('ETag', metadata.etagValue)
      }
      response.statusCode = 200
      response.end()
      return
    }

    pipeFile(resolvedFile.path, fileStat, request, response, { maxAge, etag })
  }
}
