import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { hrtime } from 'node:process'

import type { Application } from './instance'
import type { Request } from './request'
import type { Response } from './response'
import type { Middleware } from './types'

export type LoggerLevel = 'debug' | 'info' | 'success' | 'warn' | 'error'

export interface LoggerEvent {
  timestamp: string
  kind: 'request' | 'application'
  level: LoggerLevel
  message: string
  method?: string
  path?: string
  statusCode?: number
  durationMs?: number
  bytesWritten?: number
  ipAddress?: string
  userAgent?: string
  requestId?: string
  attributes: Record<string, unknown>
}

export type LoggerTransport = (
  event: LoggerEvent
) => void | Promise<void>

export interface LoggerExporter {
  export: LoggerTransport
}

export interface LoggerPluginOptions {
  /**
   * Enabled log levels for structured access logs.
   * @default ['info', 'warn', 'error']
   */
  levels?: LoggerLevel[]

  /**
   * Local file destination for newline-delimited JSON logs.
   */
  file?: string

  /**
   * Custom structured log transports.
   */
  transport?: LoggerTransport
  transports?: LoggerTransport[]

  /**
   * Named exporter adapters for external observability services.
   * Examples: OpenTelemetry, Loki, Datadog, New Relic or any HTTP collector.
   */
  exporter?: LoggerExporter | LoggerTransport
  exporters?: Array<LoggerExporter | LoggerTransport>

  /**
   * Header used to populate `requestId`.
   * @default 'x-request-id'
   */
  requestIdHeader?: string | false

  /**
   * Allows customizing severity from the request/response event.
   */
  level?: (event: Omit<LoggerEvent, 'level' | 'message'>) => LoggerLevel

  /**
   * Receives transport failures. By default they are ignored.
   */
  onError?: (error: unknown, event: LoggerEvent) => void

  /**
   * Log the request before the response is finished.
   */
  immediate?: boolean

  /**
   * Skip logging for requests that match this predicate.
   */
  skip?: (request: Request, response: Response) => boolean
}

export type LoggerAttributes = Record<string, unknown>

export interface LoggerFunction {
  <TApp extends Pick<Application, 'use'>>(
    app: TApp,
    options?: LoggerPluginOptions
  ): TApp
  debug: (message: string, attributes?: LoggerAttributes) => void
  info: (message: string, attributes?: LoggerAttributes) => void
  success: (message: string, attributes?: LoggerAttributes) => void
  warn: (message: string, attributes?: LoggerAttributes) => void
  error: (message: string, attributes?: LoggerAttributes) => void
}

interface LoggerState {
  enabledLevels: Set<LoggerLevel>
  transports: LoggerTransport[]
  requestIdHeader: string | false
  level?: (event: Omit<LoggerEvent, 'level' | 'message'>) => LoggerLevel
  onError?: (error: unknown, event: LoggerEvent) => void
}

function getHeaderValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value.join(', ') : value
}

function getResponseBytesWritten(
  response: Response,
  initialBytesWritten: number
): number {
  const contentLength = response.getHeader('Content-Length')
  const value = Array.isArray(contentLength)
    ? contentLength[0]
    : contentLength

  if (value !== undefined) {
    const parsed = Number.parseInt(String(value), 10)
    if (Number.isFinite(parsed) && parsed >= 0) return parsed
  }

  return Math.max(0, (response.socket?.bytesWritten ?? 0) - initialBytesWritten)
}

function getDefaultLevel(statusCode: number): LoggerLevel {
  if (statusCode >= 500) return 'error'
  if (statusCode >= 400) return 'warn'
  return 'info'
}

function createFileTransport(file: string): LoggerTransport {
  mkdirSync(dirname(file), { recursive: true })

  return (event) => {
    appendFileSync(file, `${JSON.stringify(event)}\n`, 'utf8')
  }
}

function normalizeExporter(
  exporter: LoggerExporter | LoggerTransport
): LoggerTransport {
  return typeof exporter === 'function' ? exporter : exporter.export
}

function createLoggerState(options: LoggerPluginOptions): LoggerState {
  const enabledLevels = new Set<LoggerLevel>(
    options.levels ?? ['info', 'warn', 'error']
  )
  const requestIdHeader = options.requestIdHeader ?? 'x-request-id'
  const exporters = [
    ...(options.exporter ? [options.exporter] : []),
    ...(options.exporters ?? [])
  ].map(normalizeExporter)
  const transports: LoggerTransport[] = [
    ...(options.transport ? [options.transport] : []),
    ...(options.transports ?? []),
    ...(options.file ? [createFileTransport(options.file)] : []),
    ...exporters
  ]

  if (transports.length === 0) {
    transports.push((event) => {
      process.stdout.write(`${JSON.stringify(event)}\n`)
    })
  }

  return {
    enabledLevels,
    transports,
    requestIdHeader,
    level: options.level,
    onError: options.onError
  }
}

let currentState = createLoggerState({})

function emit(event: LoggerEvent, state = currentState): void {
  if (!state.enabledLevels.has(event.level)) return

  for (const transport of state.transports) {
    Promise.resolve(transport(event)).catch((error: unknown) => {
      state.onError?.(error, event)
    })
  }
}

function log(level: LoggerLevel, message: string, attributes: LoggerAttributes = {}) {
  emit({
    timestamp: new Date().toISOString(),
    kind: 'application',
    level,
    message,
    attributes
  })
}

function createStructuredLoggerMiddleware(state: LoggerState): Middleware {
  const requestIdHeader = state.requestIdHeader

  return async ({ request, response, next }) => {
    const startedAt = hrtime.bigint()
    const initialBytesWritten = response.socket?.bytesWritten ?? 0
    let logged = false

    const writeLog = () => {
      if (logged) return
      logged = true

      const durationMs = Number(hrtime.bigint() - startedAt) / 1_000_000
      const baseEvent = {
        timestamp: new Date().toISOString(),
        kind: 'request' as const,
        method: request.method || 'GET',
        path: request.path,
        statusCode: response.statusCode,
        durationMs,
        bytesWritten: getResponseBytesWritten(response, initialBytesWritten),
        ipAddress: request.ipAddress,
        userAgent: getHeaderValue(request.headers['user-agent']),
        requestId:
          requestIdHeader === false
            ? undefined
            : getHeaderValue(request.headers[requestIdHeader.toLowerCase()]),
        attributes: {}
      }
      const level = state.level?.(baseEvent) ?? getDefaultLevel(response.statusCode)

      emit({
        ...baseEvent,
        level,
        message: `${baseEvent.method} ${baseEvent.path} ${baseEvent.statusCode}`
      }, state)
    }

    response.once('finish', writeLog)
    response.once('close', () => {
      if (!response.writableFinished) writeLog()
    })

    await next()
  }
}

function configureLogger<TApp extends Pick<Application, 'use'>>(
  app: TApp,
  options: LoggerPluginOptions = {}
): TApp {
  const state = createLoggerState(options)
  currentState = state

  app.use(async ({ request, response, next }) => {
    if (options.skip?.(request, response)) {
      return void (await next())
    }

    if (options.immediate) {
      const startedAt = hrtime.bigint()
      const event: LoggerEvent = {
        timestamp: new Date().toISOString(),
        kind: 'request',
        level: 'info',
        message: `${request.method || 'GET'} ${request.path} ${response.statusCode}`,
        method: request.method || 'GET',
        path: request.path,
        statusCode: response.statusCode,
        durationMs: Number(hrtime.bigint() - startedAt) / 1_000_000,
        bytesWritten: 0,
        ipAddress: request.ipAddress,
        userAgent: getHeaderValue(request.headers['user-agent']),
        requestId:
          state.requestIdHeader === false
            ? undefined
            : getHeaderValue(request.headers[state.requestIdHeader.toLowerCase()]),
        attributes: {}
      }
      emit(event, state)
      return void (await next())
    }

    await createStructuredLoggerMiddleware(state)({ request, response, next })
  })

  return app
}

export const logger: LoggerFunction = Object.assign(configureLogger, {
  debug: (message: string, attributes?: LoggerAttributes) =>
    log('debug', message, attributes),
  info: (message: string, attributes?: LoggerAttributes) =>
    log('info', message, attributes),
  success: (message: string, attributes?: LoggerAttributes) =>
    log('success', message, attributes),
  warn: (message: string, attributes?: LoggerAttributes) =>
    log('warn', message, attributes),
  error: (message: string, attributes?: LoggerAttributes) =>
    log('error', message, attributes)
})
