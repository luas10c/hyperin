import type { Readable } from 'node:stream'

import { parseMultipart } from '#/utils/multipart'
import type { Middleware, MultipartLimits } from '#/types'

export type FileInfo = {
  filename: string
  mimetype: string
  encoding: string
  fieldname: string
  size: number
}

export type FileHandlerContext = {
  stream: Readable
  info: FileInfo
}

export type FileHandler = (
  context: FileHandlerContext
) => Promise<unknown> | unknown

export type MultipartFieldConfig =
  | {
      kind: 'single'
      totalSize?: number
    }
  | {
      kind: 'array'
      maxFiles: number
      totalSize?: number
    }

export type MultipartFieldMap = Record<string, MultipartFieldConfig>

export interface MultipartStreamOptions {
  /**
   * High water mark used for file streams exposed to `onFile`.
   */
  highWaterMark?: number
}

export interface MultipartOptions {
  /**
   * Function called for each received file.
   * Receives the file stream and metadata.
   * The returned value is available in `request.files[fieldname]`.
   *
   * @example Upload to S3
   * ```ts
   * onFile: async ({ stream, info }) => {
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
   * onFile: ({ stream, info }) => {
   *   const dest = path.join('./uploads', info.filename)
   *   stream.pipe(fs.createWriteStream(dest))
   * }
   * ```
   */
  onFile?: FileHandler
  /**
   * Optional allowlist and per-field limits for uploaded files.
   *
   * When provided, file fields not present here are rejected.
   */
  fields?: MultipartFieldMap
  /**
   * Global multipart limits.
   */
  limits?: MultipartLimits
  /**
   * Stream settings used for file streams exposed to `onFile`.
   */
  stream?: MultipartStreamOptions
}

export function multipart(options: MultipartOptions = {}): Middleware {
  const { onFile, limits = {} } = options
  const totalSizeLimit = limits.totalSize ?? 10 * 1024 * 1024

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

    if (Number.isFinite(contentLength) && contentLength > totalSizeLimit) {
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
        options,
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
