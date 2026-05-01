import type { Readable } from 'node:stream'

import { parseMultipart } from '#/utils/multipart'
import type { Request } from '#/request'
import type { MultipartLimits, TypedMiddleware } from '#/types'

const multipartMiddlewareKey = Symbol.for('hyperin.multipart.middleware')
const multipartFieldsKey = Symbol.for('hyperin.multipart.fields')

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

export type FileHandler<TFile = unknown> = (
  context: FileHandlerContext
) => Promise<TFile> | TFile

type MultipartFieldRules = {
  /**
   * Field description used by generated OpenAPI documentation.
   */
  description?: string
  /**
   * Whether this file field must be present in the multipart payload.
   *
   * @default true
   */
  required?: boolean
  /**
   * Allowed MIME types for files in this field.
   *
   * When omitted, any file type is accepted.
   *
   * @example Restrict avatar uploads to PNG and JPEG
   * ```ts
   * multipart({
   *   fields: {
   *     gallery: {
   *       kind: 'array',
   *       maxFiles: 4, // optional; unlimited when omitted
   *       maxFileSize: 512 * 1024, // optional; unlimited when omitted
   *       mimeTypes: ['image/png', 'image/jpeg']
   *     }
   *   }
   * })
   * ```
   */
  mimeTypes?: string[]
}

export type MultipartFieldConfig =
  | ({
      kind: 'single'
      /**
       * Maximum size, in bytes, allowed for the single file in this field.
       *
       * When omitted, the file can have any size.
       */
      maxFileSize?: number
    } & MultipartFieldRules)
  | ({
      kind: 'array'
      /**
       * Maximum number of files allowed in this field.
       *
       * When omitted, this field accepts any number of files.
       */
      maxFiles?: number
      /**
       * Maximum size, in bytes, allowed for each file in this field.
       *
       * When omitted, each file can have any size.
       * When both `maxFiles` and `maxFileSize` are defined, the field total
       * size is derived automatically from `maxFileSize * maxFiles`.
       */
      maxFileSize?: number
    } & MultipartFieldRules)

export type MultipartFieldMap = Record<string, MultipartFieldConfig>

type MultipartFileField<
  TConfig extends MultipartFieldConfig,
  TFile
> = TConfig extends { kind: 'array' } ? TFile[] : TFile

export type MultipartFiles<
  TFields extends MultipartFieldMap | undefined,
  TFile = unknown
> = undefined extends TFields
  ? Record<string, TFile | TFile[]>
  : {
      [TKey in keyof TFields as TFields[TKey] extends { required: false }
        ? never
        : TKey]: MultipartFileField<TFields[TKey] & MultipartFieldConfig, TFile>
    } & {
      [TKey in keyof TFields as TFields[TKey] extends { required: false }
        ? TKey
        : never]?: MultipartFileField<
        TFields[TKey] & MultipartFieldConfig,
        TFile
      >
    }

export interface MultipartStreamOptions {
  /**
   * High water mark used for file streams exposed to `onFile`.
   */
  highWaterMark?: number
}

export interface MultipartOptions<
  TFields extends MultipartFieldMap | undefined = MultipartFieldMap | undefined,
  TFile = unknown
> {
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
  onFile?: FileHandler<TFile>
  /**
   * Optional allowlist and per-field limits for uploaded files.
   *
   * When provided, file fields not present here are rejected.
   */
  fields?: TFields
  /**
   * Global multipart limits.
   */
  limits?: MultipartLimits
  /**
   * Stream settings used for file streams exposed to `onFile`.
   */
  stream?: MultipartStreamOptions
}

export function multipart<
  const TFields extends MultipartFieldMap | undefined = undefined,
  TFile = unknown
>(
  options: MultipartOptions<TFields, TFile> = {}
): TypedMiddleware<
  Request,
  {
    body: Record<string, string>
    files: MultipartFiles<TFields, Awaited<TFile>>
  }
> {
  const { onFile, limits = {} } = options
  const totalSizeLimit = limits.totalSize ?? 10 * 1024 * 1024

  const middleware: TypedMiddleware = async ({ request, response, next }) => {
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

      response.setHeader('Connection', 'close')
      response.once('finish', () => {
        if (!request.complete && !request.destroyed) {
          request.destroy()
        }
      })

      return void response.status(statusCode).json({
        statusCode,
        error: message,
        method: request.method
      })
    }

    await next()
  }

  ;(middleware as unknown as Record<symbol, true>)[multipartMiddlewareKey] =
    true
  ;(middleware as unknown as Record<symbol, unknown>)[multipartFieldsKey] =
    options.fields
  return middleware as TypedMiddleware<
    Request,
    {
      body: Record<string, string>
      files: MultipartFiles<TFields, Awaited<TFile>>
    }
  >
}
