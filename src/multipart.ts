import type { Readable } from 'node:stream'

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

export type FileInfo = {
  filename: string
  mimetype: string
  encoding: string
  fieldname: string
  size: number
}

export type FileHandler = (
  stream: Readable,
  info: FileInfo
) => Promise<unknown> | unknown

export interface MultipartOptions {
  /**
   * Function called for each received file.
   * Receives the file stream and metadata.
   * The returned value is available in `request.files[fieldname]`.
   *
   * @example Upload para S3
   * ```ts
   * onFile: async (stream, info) => {
   *   const upload = new Upload({
   *     client: s3,
   *     params: { Bucket: 'my-bucket', Key: info.filename, Body: stream }
   *   })
   *   return upload.done() // { Location, Key, ... }
   * }
   * ```
   *
   * @example Salvar localmente (comportamento antigo)
   * ```ts
   * onFile: (stream, info) => {
   *   const dest = path.join('./uploads', info.filename)
   *   stream.pipe(fs.createWriteStream(dest))
   * }
   * ```
   */
  onFile?: FileHandler
  limits?: {
    fileSize?: number
    files?: number
    fields?: number
  }
}

export function multipart(options: MultipartOptions = {}): Middleware {
  const { onFile, limits = {} } = options

  return async ({ request, response, next }) => {
    const contentType = request.headers['content-type'] || ''

    if (!contentType.includes('multipart/form-data')) {
      return void (await next())
    }

    const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i)
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
        limits,
        onFile
      )

      request.body = fields
      request.files = files
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Multipart parsing failed'

      return void response.status(400).json({
        statusCode: 400,
        error: message,
        method: request.method
      })
    }

    await next()
  }
}
