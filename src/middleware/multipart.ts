import type { Readable } from 'node:stream'

import { parseMultipart } from '#/util'
import type { Middleware, MultipartLimits } from '#/types'

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
   * @example Upload to S3
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
   * @example Save locally (old behavior)
   * ```ts
   * onFile: (stream, info) => {
   *   const dest = path.join('./uploads', info.filename)
   *   stream.pipe(fs.createWriteStream(dest))
   * }
   * ```
   */
  onFile?: FileHandler
  limits?: MultipartLimits
}

export function multipart(options: MultipartOptions = {}): Middleware {
  const { onFile, limits = {} } = options
  const bodyLimit = limits.bodySize ?? 10 * 1024 * 1024

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

    const contentLengthHeader = request.headers['content-length']
    const contentLength = Number(
      Array.isArray(contentLengthHeader)
        ? contentLengthHeader[0]
        : contentLengthHeader
    )

    if (Number.isFinite(contentLength) && contentLength > bodyLimit) {
      return void response.status(413).json({
        statusCode: 413,
        error: 'Payload Too Large',
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
      const statusCode =
        typeof err === 'object' && err !== null && 'status' in err
          ? ((err as { status?: number }).status ?? 400)
          : 400

      return void response.status(statusCode).json({
        statusCode,
        error: message,
        method: request.method
      })
    }

    await next()
  }
}
