import { hrtime } from 'node:process'

import type { Request } from '../request'
import type { Response } from '../response'

type NextFunction = () => void | Promise<void>

type MiddlewareContext = {
  request: Request
  response: Response
  next: NextFunction
}

type Middleware = (ctx: MiddlewareContext) => void | Promise<void>

export interface LoggerInfo {
  method: string
  path: string
  statusCode: number
  durationMs: number
  bytesWritten: number
  ipAddress: string
}

export interface LoggerOptions {
  immediate?: boolean
  skip?: (request: Request, response: Response) => boolean
  format?: (info: LoggerInfo, request: Request, response: Response) => string
  stream?: { write: (chunk: string) => boolean | void }
  colors?: boolean
}

const ANSI_RESET = '\u001B[0m'
const ANSI_BOLD = '\u001B[1m'
const ANSI_DIM = '\u001B[2m'
const ANSI_CYAN = '\u001B[36m'
const ANSI_GREEN = '\u001B[32m'
const ANSI_YELLOW = '\u001B[33m'
const ANSI_RED = '\u001B[31m'
const ANSI_MAGENTA = '\u001B[35m'

function colorize(value: string, color: string, enabled: boolean): string {
  if (!enabled) return value
  return `${color}${value}${ANSI_RESET}`
}

function style(value: string, ansi: string, enabled: boolean): string {
  if (!enabled) return value
  return `${ansi}${value}${ANSI_RESET}`
}

function formatDuration(durationMs: number): string {
  if (durationMs >= 1000) return `${(durationMs / 1000).toFixed(2)}s`
  if (durationMs >= 10) return `${Math.round(durationMs)}ms`
  return `${durationMs.toFixed(2)}ms`
}

function formatBytes(bytesWritten: number): string {
  if (bytesWritten >= 1024 * 1024) {
    return `${(bytesWritten / (1024 * 1024)).toFixed(2)} MB`
  }

  if (bytesWritten >= 1024) {
    return `${(bytesWritten / 1024).toFixed(2)} kB`
  }

  return `${bytesWritten} B`
}

function statusColor(statusCode: number): string {
  if (statusCode >= 500) return ANSI_RED
  if (statusCode >= 400) return ANSI_YELLOW
  if (statusCode >= 300) return ANSI_MAGENTA
  return ANSI_GREEN
}

function methodColor(method: string): string {
  if (method === 'GET') return ANSI_CYAN
  if (method === 'POST') return ANSI_GREEN
  if (method === 'PUT' || method === 'PATCH') return ANSI_YELLOW
  if (method === 'DELETE') return ANSI_RED
  return ANSI_MAGENTA
}

function shouldUseColors(
  stream: { write: (chunk: string) => boolean | void } & {
    isTTY?: boolean
    getColorDepth?: () => number
  },
  colors: boolean | undefined
): boolean {
  if (colors !== undefined) return colors
  if (!stream.isTTY) return false
  return (stream.getColorDepth?.() ?? 0) > 1
}

function createDefaultFormat(colors: boolean) {
  return (info: LoggerInfo): string => {
    const method = style(
      colorize(info.method, methodColor(info.method), colors),
      ANSI_BOLD,
      colors
    )
    const status = style(
      colorize(String(info.statusCode), statusColor(info.statusCode), colors),
      ANSI_BOLD,
      colors
    )
    const path = style(info.path, ANSI_BOLD, colors)
    const duration = colorize(formatDuration(info.durationMs), ANSI_DIM, colors)
    const size = colorize(formatBytes(info.bytesWritten), ANSI_DIM, colors)

    return `${method} ${path} ${status} ${duration} ${size}`
  }
}

export function logger(options: LoggerOptions = {}): Middleware {
  const stream = options.stream ?? process.stdout
  const colors = shouldUseColors(stream, options.colors)
  const format = options.format ?? createDefaultFormat(colors)
  const skip = options.skip
  const immediate = options.immediate ?? false

  return async ({ request, response, next }) => {
    if (skip?.(request, response)) {
      return void (await next())
    }

    const startedAt = hrtime.bigint()

    const writeLog = () => {
      const info: LoggerInfo = {
        method: request.method || 'GET',
        path: request.path,
        statusCode: response.statusCode,
        durationMs: Number(hrtime.bigint() - startedAt) / 1_000_000,
        bytesWritten: response.socket?.bytesWritten ?? 0,
        ipAddress: request.ipAddress
      }

      stream.write(`${format(info, request, response)}\n`)
    }

    if (immediate) {
      writeLog()
      return void (await next())
    }

    response.once('finish', writeLog)
    response.once('close', () => {
      if (!response.writableFinished) writeLog()
    })

    await next()
  }
}
