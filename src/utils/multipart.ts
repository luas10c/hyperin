import { extname, basename } from 'node:path'
import { PassThrough } from 'node:stream'

import type {
  FileHandler,
  FileInfo,
  MultipartFieldConfig,
  MultipartOptions
} from '#/middleware/multipart'
import type { Request } from '#/request'

type ParsedResult = {
  fields: Record<string, string>
  files: Record<string, unknown>
}

const CRLF = '\r\n'
const DOUBLE_CRLF = '\r\n\r\n'

function isUnsafePropertyKey(key: string): boolean {
  return key === '__proto__' || key === 'constructor' || key === 'prototype'
}

function parseHeaders(raw: string): Record<string, string> {
  const headers: Record<string, string> = {}
  for (const line of raw.split(CRLF)) {
    if (line.trim() === '') continue
    const colon = line.indexOf(':')
    if (colon <= 0) {
      throw Object.assign(new Error('Malformed multipart headers'), {
        status: 400
      })
    }

    const key = line.slice(0, colon).trim().toLowerCase()
    const value = line.slice(colon + 1).trim()

    if (headers[key] !== undefined) {
      throw Object.assign(new Error(`Duplicate multipart header: ${key}`), {
        status: 400
      })
    }

    headers[key] = value
  }
  return headers
}

function extractParam(header: string, param: string): string | null {
  const regex = new RegExp(`${param}="([^"]*)"`, 'i')
  const match = header.match(regex)
  if (!match && param === 'filename') {
    const bare = header.match(/filename=([^;]+)/i)
    return bare ? bare[1].trim() : null
  }
  return match ? match[1] : null
}

function getNormalizedFieldConfig(
  fieldname: string,
  fieldConfigs: MultipartOptions['fields']
): MultipartFieldConfig | null {
  if (!fieldConfigs) return { kind: 'single' }
  return fieldConfigs[fieldname] ?? null
}

function normalizeMimeType(mimetype: string): string {
  return mimetype.split(';', 1)[0].trim().toLowerCase()
}

function getReceivedMimeTypes(mimetype: string): string[] {
  return mimetype
    .split(',')
    .map((value) => normalizeMimeType(value))
    .filter(Boolean)
}

function getMimeTypeFromFilename(filename: string): string | null {
  switch (extname(filename).toLowerCase()) {
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg'
    case '.png':
      return 'image/png'
    case '.gif':
      return 'image/gif'
    case '.webp':
      return 'image/webp'
    case '.svg':
      return 'image/svg+xml'
    case '.pdf':
      return 'application/pdf'
    case '.txt':
      return 'text/plain'
    default:
      return null
  }
}

function isAllowedMimeType(
  mimetype: string,
  filename: string,
  allowedMimeTypes: string[]
): boolean {
  const allowed = allowedMimeTypes.map((allowedMimeType) =>
    normalizeMimeType(allowedMimeType)
  )
  const receivedMimeTypes = getReceivedMimeTypes(mimetype)

  if (
    receivedMimeTypes.some((receivedMimeType) =>
      allowed.includes(receivedMimeType)
    )
  ) {
    return true
  }

  if (!receivedMimeTypes.includes('application/octet-stream')) return false

  const inferredMimeType = getMimeTypeFromFilename(filename)
  return inferredMimeType !== null && allowed.includes(inferredMimeType)
}

function resolveFileMimeType(
  mimetype: string,
  filename: string,
  allowedMimeTypes: string[] | undefined
): string {
  const inferredMimeType = getMimeTypeFromFilename(filename)
  if (inferredMimeType) return inferredMimeType

  const receivedMimeTypes = getReceivedMimeTypes(mimetype)
  if (receivedMimeTypes.length === 0) return 'application/octet-stream'
  if (!allowedMimeTypes?.length) return receivedMimeTypes[0]

  const allowed = allowedMimeTypes.map((allowedMimeType) =>
    normalizeMimeType(allowedMimeType)
  )

  return (
    receivedMimeTypes.find((receivedMimeType) =>
      allowed.includes(receivedMimeType)
    ) ?? receivedMimeTypes[0]
  )
}

function isRequiredField(config: MultipartFieldConfig): boolean {
  return config.required !== false
}

export async function parseMultipart(
  request: Request,
  boundary: string,
  options: MultipartOptions = {},
  onFile?: FileHandler
): Promise<ParsedResult> {
  const {
    fields: fieldConfigs,
    limits = {},
    stream: streamOptions = {}
  } = options
  const fields = Object.create(null) as Record<string, string>
  const files = Object.create(null) as Record<string, unknown>
  const totalSizeLimit = limits.totalSize ?? 10 * 1024 * 1024
  const maxHeaderSize = limits.maxHeaderSize ?? 16 * 1024
  const fieldFileCounts = new Map<string, number>()
  const fieldFileSizes = new Map<string, number>()

  const initialBoundary = Buffer.from(`--${boundary}`)
  const boundaryDelimiter = Buffer.from(`\r\n--${boundary}`)
  const doubleCrlf = Buffer.from(DOUBLE_CRLF)
  const crlf = Buffer.from(CRLF)
  const trailingBytes = boundaryDelimiter.length
  const pendingFiles: Promise<void>[] = []
  let terminalError: Error | null = null

  type CurrentPart = {
    fieldname: string
    filename: string | null
    buffers: Buffer[]
    size: number
    stream?: PassThrough
    info?: FileInfo
    pending?: Promise<void>
  }

  let totalBytes = 0
  let buffer = Buffer.alloc(0)
  let phase: 'start-boundary' | 'headers' | 'body' | 'after-boundary' | 'done' =
    'start-boundary'
  let currentPart: CurrentPart | null = null

  const fail = (message: string, status = 400): never => {
    throw Object.assign(new Error(message), { status })
  }

  const normalizeError = (error: unknown): Error =>
    error instanceof Error ? error : new Error(String(error))

  const getTerminalError = (): Error | null => terminalError

  const setTerminalError = (error: unknown): Error => {
    const normalized = normalizeError(error)
    if (!terminalError) {
      terminalError = normalized
    }
    return terminalError
  }

  const ensurePart = (): CurrentPart => {
    const part = currentPart
    if (part === null) {
      throw Object.assign(new Error('Multipart parsing failed'), {
        status: 400
      })
    }
    return part
  }

  const destroyCurrentPartStream = (error: Error): void => {
    if (currentPart?.stream && !currentPart.stream.destroyed) {
      currentPart.stream.destroy(error)
    }
  }

  const handleRequestAbort = (): void => {
    const error = setTerminalError(
      Object.assign(new Error('Request aborted'), { status: 400 })
    )
    destroyCurrentPartStream(error)
  }

  request.once('aborted', handleRequestAbort)

  const writeToFileStream = async (
    stream: PassThrough | undefined,
    chunk: Buffer
  ): Promise<void> => {
    if (!stream || chunk.length === 0) return

    const error = getTerminalError()
    if (error) throw error
    if (stream.destroyed || !stream.writable) {
      throw new Error('Multipart file stream is no longer writable')
    }

    if (!stream.write(chunk)) {
      await new Promise<void>((resolve, reject) => {
        const cleanup = (): void => {
          stream.off('drain', onDrain)
          stream.off('error', onError)
          stream.off('close', onClose)
        }

        const onDrain = (): void => {
          cleanup()
          resolve()
        }

        const onError = (error: Error): void => {
          cleanup()
          reject(error)
        }

        const onClose = (): void => {
          cleanup()
          reject(
            getTerminalError() ??
              new Error('Multipart file stream closed before draining')
          )
        }

        stream.once('drain', onDrain)
        stream.once('error', onError)
        stream.once('close', onClose)
      })
    }

    const nextError = getTerminalError()
    if (nextError) throw nextError
  }

  const appendPartData = async (chunk: Buffer): Promise<void> => {
    if (chunk.length === 0) return

    const error = getTerminalError()
    if (error) throw error

    const part = ensurePart()
    part.size += chunk.length

    if (part.filename !== null) {
      const config = getNormalizedFieldConfig(part.fieldname, fieldConfigs)
      if (config?.maxFileSize !== undefined && part.size > config.maxFileSize) {
        fail(
          `Field "${part.fieldname}" exceeds maxFileSize limit of ${config.maxFileSize} bytes`,
          413
        )
      }

      const nextFieldSize =
        (fieldFileSizes.get(part.fieldname) ?? 0) + part.size
      let fieldTotalSizeLimit: number | undefined
      if (config?.kind === 'array') {
        fieldTotalSizeLimit =
          config.maxFileSize !== undefined && config.maxFiles !== undefined
            ? config.maxFileSize * config.maxFiles
            : undefined
      }

      if (
        fieldTotalSizeLimit !== undefined &&
        nextFieldSize > fieldTotalSizeLimit
      ) {
        fail(
          `Field "${part.fieldname}" exceeds totalSize limit of ${fieldTotalSizeLimit} bytes`,
          413
        )
      }

      if (part.info) part.info.size = part.size
      await writeToFileStream(part.stream, chunk)
      return
    }

    part.buffers.push(chunk)
  }

  const finalizeCurrentPart = async (): Promise<void> => {
    const part = ensurePart()

    if (part.filename !== null) {
      part.stream?.end()
      await part.pending
    } else {
      fields[part.fieldname] = Buffer.concat(part.buffers).toString('utf8')
    }

    currentPart = null
  }

  const validateRequiredFiles = (): void => {
    if (!fieldConfigs) return

    for (const [fieldname, config] of Object.entries(fieldConfigs)) {
      if (!isRequiredField(config)) continue
      if ((fieldFileCounts.get(fieldname) ?? 0) > 0) continue

      fail(`Missing required multipart file field "${fieldname}"`, 400)
    }
  }

  const startPart = (headerSection: string): void => {
    const headers = parseHeaders(headerSection)
    const disposition = headers['content-disposition'] || ''
    const fieldname = extractParam(disposition, 'name')
    const filename = extractParam(disposition, 'filename')

    if (!fieldname) {
      currentPart = null
      return
    }

    if (isUnsafePropertyKey(fieldname)) {
      currentPart = null
      return
    }

    if (filename !== null) {
      const config = getNormalizedFieldConfig(fieldname, fieldConfigs)
      if (config === null) {
        fail(`Unexpected multipart file field "${fieldname}"`, 400)
      }

      const currentCount = fieldFileCounts.get(fieldname) ?? 0
      if (config?.kind === 'single' && currentCount >= 1) {
        fail(`Field "${fieldname}" only accepts a single file`, 413)
      }
      if (
        config?.kind === 'array' &&
        config.maxFiles !== undefined &&
        currentCount >= config.maxFiles
      ) {
        fail(
          `Field "${fieldname}" exceeds maxFiles limit of ${config.maxFiles}`,
          413
        )
      }

      const mimetype = headers['content-type'] || 'application/octet-stream'
      // Sanitize and normalize the incoming filename to prevent path traversal
      const rawFilename = filename ?? 'unnamed'
      // Keep only the basename and replace unsafe characters with underscores
      const sanitized = basename(rawFilename).replace(/[^a-zA-Z0-9._-]/g, '_')
      const resolvedFilename = sanitized || 'unnamed'
      const resolvedMimeType = resolveFileMimeType(
        mimetype,
        resolvedFilename,
        config?.mimeTypes
      )

      if (
        config?.mimeTypes?.length &&
        !isAllowedMimeType(mimetype, resolvedFilename, config.mimeTypes)
      ) {
        fail(
          `Field "${fieldname}" only accepts files with MIME types: ${config.mimeTypes.join(', ')}. Received: ${normalizeMimeType(mimetype)}`,
          415
        )
      }

      const info: FileInfo = {
        fieldname,
        filename: resolvedFilename,
        mimetype: resolvedMimeType,
        encoding: headers['content-transfer-encoding'] || '7bit',
        size: 0
      }

      const stream = onFile
        ? new PassThrough({
            highWaterMark: streamOptions.highWaterMark
          })
        : undefined
      stream?.on('error', () => {
        // Prevent unhandled stream errors when file processing aborts early.
      })
      currentPart = {
        fieldname,
        filename: info.filename,
        buffers: [],
        size: 0,
        stream,
        info
      }

      if (onFile && stream) {
        const normalizedConfig = config ?? ({ kind: 'single' } as const)
        const pending = Promise.resolve()
          .then(() => onFile({ stream, info }))
          .then((result) => {
            if (normalizedConfig.kind === 'array') {
              const current = files[fieldname]
              if (Array.isArray(current)) {
                current.push(result)
              } else {
                files[fieldname] = [result]
              }
            } else {
              files[fieldname] = result
            }

            // If the handler resolved before consuming the entire stream,
            // drain the remaining bytes so multipart parsing can continue.
            if (!stream.destroyed && !stream.readableEnded) {
              stream.resume()
            }
          })
          .catch((error) => {
            const normalized = setTerminalError(error)
            if (!stream.destroyed) {
              stream.destroy(normalized)
            }
            throw normalized
          })

        pending.catch(() => undefined)
        pendingFiles.push(pending)
        currentPart.pending = pending
      }

      return
    }

    currentPart = {
      fieldname,
      filename: null,
      buffers: [],
      size: 0
    }
  }

  try {
    for await (const incoming of request) {
      const chunk = Buffer.isBuffer(incoming)
        ? Buffer.from(incoming)
        : Buffer.from(incoming as string)

      totalBytes += chunk.length
      if (totalBytes > totalSizeLimit) {
        fail('Payload Too Large', 413)
      }

      buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk])

      while (true) {
        if (phase === 'done') {
          buffer = Buffer.alloc(0)
          break
        }

        if (phase === 'start-boundary') {
          if (buffer.length < initialBoundary.length + 2) break
          if (
            !buffer.subarray(0, initialBoundary.length).equals(initialBoundary)
          ) {
            fail('Malformed multipart body')
          }

          const suffix = buffer.subarray(
            initialBoundary.length,
            initialBoundary.length + 2
          )

          if (suffix.equals(Buffer.from('--'))) {
            phase = 'done'
            buffer = buffer.subarray(initialBoundary.length + 2)
            continue
          }

          if (!suffix.equals(crlf)) {
            fail('Malformed multipart body')
          }

          buffer = buffer.subarray(initialBoundary.length + 2)
          phase = 'headers'
          continue
        }

        if (phase === 'headers') {
          const separatorIndex = buffer.indexOf(doubleCrlf)
          if (separatorIndex === -1) {
            if (buffer.length > maxHeaderSize) {
              fail('Multipart part headers too large', 413)
            }

            break
          }

          if (separatorIndex > maxHeaderSize) {
            fail('Multipart part headers too large', 413)
          }

          const headerSection = buffer
            .subarray(0, separatorIndex)
            .toString('utf8')
          buffer = buffer.subarray(separatorIndex + doubleCrlf.length)
          startPart(headerSection)
          phase = 'body'
          continue
        }

        if (phase === 'body') {
          const delimiterIndex = buffer.indexOf(boundaryDelimiter)
          if (delimiterIndex === -1) {
            if (buffer.length <= trailingBytes) break

            const flushable = buffer.subarray(0, buffer.length - trailingBytes)
            buffer = buffer.subarray(buffer.length - trailingBytes)

            if (currentPart) {
              await appendPartData(flushable)
            }

            break
          }

          if (currentPart) {
            await appendPartData(buffer.subarray(0, delimiterIndex))
            const part = ensurePart()

            if (part.filename !== null) {
              const fieldname = part.fieldname
              const nextFieldSize = fieldFileSizes.get(fieldname) ?? 0
              fieldFileSizes.set(fieldname, nextFieldSize + part.size)
              fieldFileCounts.set(
                fieldname,
                (fieldFileCounts.get(fieldname) ?? 0) + 1
              )
            }
            await finalizeCurrentPart()
          }

          buffer = buffer.subarray(delimiterIndex + boundaryDelimiter.length)
          phase = 'after-boundary'
          continue
        }

        if (phase === 'after-boundary') {
          if (buffer.length < 2) break

          const suffix = buffer.subarray(0, 2)
          if (suffix.equals(Buffer.from('--'))) {
            buffer = buffer.subarray(2)
            phase = 'done'
            continue
          }

          if (!suffix.equals(crlf)) {
            fail('Malformed multipart body')
          }

          buffer = buffer.subarray(2)
          phase = 'headers'
        }
      }
    }

    if (phase !== 'done') {
      fail('Unexpected end of multipart body')
    }

    await Promise.all(pendingFiles)
    validateRequiredFiles()
    return { fields, files }
  } catch (error) {
    destroyCurrentPartStream(error as Error)
    throw error
  } finally {
    request.off('aborted', handleRequestAbort)
  }
}
