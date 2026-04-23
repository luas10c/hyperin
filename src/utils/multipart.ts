import { PassThrough } from 'node:stream'

import type { FileHandler, FileInfo } from '#/middleware/multipart'
import type { Request } from '#/request'
import type { MultipartLimits } from '#/types'

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

export async function parseMultipart(
  request: Request,
  boundary: string,
  limits: MultipartLimits = {},
  onFile?: FileHandler
): Promise<ParsedResult> {
  const fields = Object.create(null) as Record<string, string>
  const files = Object.create(null) as Record<string, unknown>
  let fieldCount = 0
  let fileCount = 0
  let partCount = 0
  const bodyLimit = limits.bodySize ?? 10 * 1024 * 1024

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
      if (limits.fileSize !== undefined && part.size > limits.fileSize) {
        fail(
          `File "${part.filename}" exceeds size limit of ${limits.fileSize} bytes`,
          413
        )
      }

      if (part.info) part.info.size = part.size
      await writeToFileStream(part.stream, chunk)
      return
    }

    if (limits.fieldSize !== undefined && part.size > limits.fieldSize) {
      fail(
        `Field "${part.fieldname}" exceeds size limit of ${limits.fieldSize} bytes`,
        413
      )
    }

    part.buffers.push(chunk)
  }

  const finalizeCurrentPart = async (): Promise<void> => {
    const part = ensurePart()

    if (part.filename !== null) {
      part.stream?.end()
    } else {
      fields[part.fieldname] = Buffer.concat(part.buffers).toString('utf8')
    }

    currentPart = null
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

    partCount++
    if (limits.parts !== undefined && partCount > limits.parts) {
      fail('Too many multipart parts', 413)
    }

    if (filename !== null) {
      fileCount++
      if (limits.files !== undefined && fileCount > limits.files) {
        fail('Too many uploaded files', 413)
      }

      const info: FileInfo = {
        fieldname,
        filename: filename || 'unnamed',
        mimetype: headers['content-type'] || 'application/octet-stream',
        encoding: headers['content-transfer-encoding'] || '7bit',
        size: 0
      }

      const stream = onFile ? new PassThrough() : undefined
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
        const pending = Promise.resolve()
          .then(() => onFile(stream, info))
          .then((result) => {
            files[fieldname] = result

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
      }

      return
    }

    fieldCount++
    if (limits.fields !== undefined && fieldCount > limits.fields) {
      fail('Too many multipart fields', 413)
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
      if (totalBytes > bodyLimit) {
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
          if (separatorIndex === -1) break

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
    return { fields, files }
  } catch (error) {
    destroyCurrentPartStream(error as Error)
    throw error
  } finally {
    request.off('aborted', handleRequestAbort)
  }
}
