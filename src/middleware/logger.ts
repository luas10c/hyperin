import { hrtime } from 'node:process'

import type { Request } from '#/request'
import type { Response } from '#/response'
import type { Middleware } from '#/types'
import { bold, cyan, gray, green, purple, red, yellow } from '#/utils/ansi'

export interface LoggerInfo {
  method: string
  path: string
  statusCode: number
  durationMs: number
  bytesWritten: number
  ipAddress: string
}

export type LoggerTokenCallback = (
  request: Request,
  response: Response,
  arg?: string,
  info?: LoggerInfo
) => string | number | undefined | null

export type CompiledLoggerFormat = (
  request: Request,
  response: Response,
  info: LoggerInfo
) => string

export interface LoggerOptions {
  /**
   * Log the request before the response is finished.
   * When disabled, duration and response size are included.
   */
  immediate?: boolean

  /**
   * Skip logging for requests that match this predicate.
   */
  skip?: (request: Request, response: Response) => boolean

  /**
   * Log format name, tokenized format string, or custom formatter.
   */
  format?:
    | string
    | ((info: LoggerInfo, request: Request, response: Response) => string)

  /**
   * Destination stream for log output.
   * Defaults to `process.stdout`.
   */
  stream?: { write: (chunk: string) => boolean | void }

  /**
   * Force-enable or disable ANSI colors.
   * By default colors are enabled only for TTY streams that support them.
   */
  colors?: boolean
}

const loggerTokens = new Map<string, LoggerTokenCallback>()
const namedFormats = new Map<string, string | CompiledLoggerFormat>()

function applyColor(enabled: boolean, formatter: (value: string) => string) {
  return (value: string): string => (enabled ? formatter(value) : value)
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
  if (statusCode >= 500) return 'red'
  if (statusCode >= 400) return 'yellow'
  if (statusCode >= 300) return 'purple'
  return 'green'
}

function methodColor(method: string): string {
  if (method === 'GET') return 'cyan'
  if (method === 'POST') return 'green'
  if (method === 'PUT' || method === 'PATCH') return 'yellow'
  if (method === 'DELETE') return 'red'
  return 'purple'
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
  const withBold = applyColor(colors, bold)
  const withGray = applyColor(colors, gray)
  const palette = {
    cyan: applyColor(colors, cyan),
    green: applyColor(colors, green),
    yellow: applyColor(colors, yellow),
    red: applyColor(colors, red),
    purple: applyColor(colors, purple)
  }

  return (info: LoggerInfo): string => {
    const method = withBold(
      palette[methodColor(info.method) as keyof typeof palette](info.method)
    )
    const status = withBold(
      palette[statusColor(info.statusCode) as keyof typeof palette](
        String(info.statusCode)
      )
    )
    const path = withBold(info.path)
    const duration = withGray(formatDuration(info.durationMs))
    const size = withGray(formatBytes(info.bytesWritten))

    return `${method} ${path} ${status} ${duration} ${size}`
  }
}

function formatDateClf(date: Date): string {
  const months = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec'
  ]

  const pad = (value: number, width = 2): string =>
    String(value).padStart(width, '0')
  const offset = -date.getTimezoneOffset()
  const sign = offset >= 0 ? '+' : '-'
  const absOffset = Math.abs(offset)
  const hours = Math.floor(absOffset / 60)
  const minutes = absOffset % 60

  return `${pad(date.getDate())}/${months[date.getMonth()]}/${date.getFullYear()}:${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())} ${sign}${pad(hours)}${pad(minutes)}`
}

function getHeaderValue(
  value: number | string | string[] | readonly string[] | undefined
): string | undefined {
  if (value === undefined) return undefined
  return Array.isArray(value) ? value.join(', ') : String(value)
}

function getResponseBytesWritten(
  response: Response,
  initialBytesWritten: number
): number {
  const contentLength = getHeaderValue(response.getHeader('Content-Length'))

  if (contentLength) {
    const parsed = Number.parseInt(contentLength, 10)
    if (Number.isFinite(parsed) && parsed >= 0) return parsed
  }

  return Math.max(0, (response.socket?.bytesWritten ?? 0) - initialBytesWritten)
}

function buildLoggerInfo(
  request: Request,
  response: Response,
  startedAt: bigint,
  initialBytesWritten: number
): LoggerInfo {
  return {
    method: request.method || 'GET',
    path: request.path,
    statusCode: response.statusCode,
    durationMs: Number(hrtime.bigint() - startedAt) / 1_000_000,
    bytesWritten: getResponseBytesWritten(response, initialBytesWritten),
    ipAddress: request.ipAddress
  }
}

function compileFormatString(format: string): CompiledLoggerFormat {
  const tokenPattern = /:([a-zA-Z-]+)(?:\[([^\]]+)\])?/g

  return (request, response, info) =>
    format.replace(tokenPattern, (_match, tokenName: string, arg?: string) => {
      const token = loggerTokens.get(tokenName)
      if (!token) return '-'

      const value = token(request, response, arg, info)
      return value === undefined || value === null || value === ''
        ? '-'
        : String(value)
    })
}

function getCompiledFormat(
  format: string | CompiledLoggerFormat,
  colors: boolean
): CompiledLoggerFormat {
  if (typeof format === 'function') return format

  const named = namedFormats.get(format)
  if (typeof named === 'function') return named
  if (typeof named === 'string') return compileFormatString(named)

  if (format === 'dev') {
    const palette = {
      cyan: applyColor(colors, cyan),
      green: applyColor(colors, green),
      yellow: applyColor(colors, yellow),
      red: applyColor(colors, red),
      purple: applyColor(colors, purple)
    }

    return (request, response, info) => {
      const methodName = request.method || 'GET'
      const method =
        palette[methodColor(methodName) as keyof typeof palette](methodName)
      const status = palette[
        statusColor(info.statusCode) as keyof typeof palette
      ](String(info.statusCode))
      const bytes = getHeaderValue(response.getHeader('Content-Length')) ?? '-'
      return `${method} ${request.path} ${status} ${info.durationMs.toFixed(3)} ms - ${bytes}`
    }
  }

  return compileFormatString(format)
}

function registerDefaultToken(
  name: string,
  callback: LoggerTokenCallback
): void {
  if (!loggerTokens.has(name)) loggerTokens.set(name, callback)
}

function registerDefaultFormat(
  name: string,
  format: string | CompiledLoggerFormat
): void {
  if (!namedFormats.has(name)) namedFormats.set(name, format)
}

registerDefaultToken('method', (request) => request.method || 'GET')
registerDefaultToken('url', (request) => request.url || request.path)
registerDefaultToken('status', (_request, response) => response.statusCode)
registerDefaultToken('remote-addr', (request) => request.ipAddress || '-')
registerDefaultToken('remote-user', () => '-')
registerDefaultToken('http-version', (request) => request.httpVersion)
registerDefaultToken(
  'referrer',
  (request) =>
    getHeaderValue(request.get('referer')) ??
    getHeaderValue(request.get('referrer')) ??
    '-'
)
registerDefaultToken(
  'user-agent',
  (request) => getHeaderValue(request.get('user-agent')) ?? '-'
)
registerDefaultToken('date', (_request, _response, arg) => {
  const date = new Date()
  if (arg === 'iso') return date.toISOString()
  if (arg === 'clf') return formatDateClf(date)
  if (arg === 'web') return date.toUTCString()
  return date.toUTCString()
})
registerDefaultToken('response-time', (_request, _response, arg, info) => {
  const digits = arg ? Number.parseInt(arg, 10) : 3
  return info?.durationMs.toFixed(Number.isNaN(digits) ? 3 : digits)
})
registerDefaultToken('total-time', (_request, _response, arg, info) => {
  const digits = arg ? Number.parseInt(arg, 10) : 3
  return info?.durationMs.toFixed(Number.isNaN(digits) ? 3 : digits)
})
registerDefaultToken('req', (request, _response, arg) =>
  arg ? getHeaderValue(request.get(arg)) : undefined
)
registerDefaultToken('res', (_request, response, arg) =>
  arg ? getHeaderValue(response.getHeader(arg)) : undefined
)

registerDefaultFormat(
  'combined',
  ':remote-addr - :remote-user [:date[clf]] ":method :url HTTP/:http-version" :status :res[content-length] ":referrer" ":user-agent"'
)
registerDefaultFormat(
  'common',
  ':remote-addr - :remote-user [:date[clf]] ":method :url HTTP/:http-version" :status :res[content-length]'
)
registerDefaultFormat(
  'short',
  ':remote-addr :method :url HTTP/:http-version :status :res[content-length] - :response-time ms'
)
registerDefaultFormat(
  'tiny',
  ':method :url :status :res[content-length] - :response-time ms'
)

type LoggerMiddlewareFactory = ((options?: LoggerOptions) => Middleware) & {
  token: (
    name: string,
    callback: LoggerTokenCallback
  ) => LoggerMiddlewareFactory
  compile: (format: string) => CompiledLoggerFormat
  format: (
    name: string,
    format: string | CompiledLoggerFormat
  ) => LoggerMiddlewareFactory
}

const createLoggerMiddleware = (options: LoggerOptions = {}): Middleware => {
  const stream = options.stream ?? process.stdout
  const colors = shouldUseColors(stream, options.colors)
  const skip = options.skip
  const immediate = options.immediate ?? false
  const resolvedFormat = options.format
    ? getCompiledFormat(options.format as string | CompiledLoggerFormat, colors)
    : undefined
  const defaultFormat = options.format ? undefined : createDefaultFormat(colors)

  return async ({ request, response, next }) => {
    if (skip?.(request, response)) {
      return void (await next())
    }

    const startedAt = hrtime.bigint()
    const initialBytesWritten = response.socket?.bytesWritten ?? 0
    let logged = false

    const writeLog = () => {
      if (logged) return
      logged = true

      const info = buildLoggerInfo(
        request,
        response,
        startedAt,
        initialBytesWritten
      )
      const line = resolvedFormat
        ? resolvedFormat(request, response, info)
        : (defaultFormat as (info: LoggerInfo) => string)(info)

      stream.write(`${line}\n`)
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

export const logger: LoggerMiddlewareFactory = Object.assign(
  createLoggerMiddleware,
  {
    token(
      name: string,
      callback: LoggerTokenCallback
    ): LoggerMiddlewareFactory {
      loggerTokens.set(name, callback)
      return logger
    },

    compile(format: string): CompiledLoggerFormat {
      return compileFormatString(format)
    },

    format(
      name: string,
      format: string | CompiledLoggerFormat
    ): LoggerMiddlewareFactory {
      namedFormats.set(name, format)
      return logger
    }
  }
)
