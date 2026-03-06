import { existsSync, mkdirSync } from 'node:fs'

import { parseMultipart } from './util'

import type { Request } from './request'
import type { Response } from './response'

type NextFunction = () => void | Promise<void>

type HandlerContext = {
  request: Request
  response: Response
}

type MiddlewareContext = HandlerContext & { next: NextFunction }

type Middleware = (ctx: MiddlewareContext) => void | Promise<void>

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
