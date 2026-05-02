export type LoggerLevel =
  | 'trace'
  | 'debug'
  | 'info'
  | 'warn'
  | 'error'
  | 'fatal'

const LOGGER_LEVEL_VALUES: Record<LoggerLevel, number> = {
  trace: 0,
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  fatal: 50
}

export interface LoggerEvent {
  timestamp: string
  kind: string
  level: LoggerLevel
  message: string
  attributes: Record<string, unknown>
}

export interface LoggerTransportContext {
  event: LoggerEvent
}

export type LoggerTransport = (
  context: LoggerTransportContext
) => void | Promise<void>

export interface LoggerOptions {
  /**
   * Enables or disables all logger output.
   * @default true
   */
  enabled?: boolean

  /**
   * Minimum level emitted by the logger.
   * @default 'info'
   */
  level?: LoggerLevel

  /**
   * Semantic kind used for application log events.
   * @default 'application'
   */
  kind?: string

  /**
   * Custom structured log transports.
   */
  transports?: LoggerTransport[]

  /**
   * Receives transport failures. By default they are ignored.
   */
  onError?: (error: unknown, event: LoggerEvent) => void
}

export type LoggerAttributes = Record<string, unknown>

interface LoggerState {
  enabled: boolean
  kind: string
  minimumLevel: LoggerLevel
  transports: LoggerTransport[]
  onError?: (error: unknown, event: LoggerEvent) => void
}

export interface LoggerInstance {
  trace: (message: string, attributes?: LoggerAttributes) => void
  debug: (message: string, attributes?: LoggerAttributes) => void
  info: (message: string, attributes?: LoggerAttributes) => void
  warn: (message: string, attributes?: LoggerAttributes) => void
  error: (message: string, attributes?: LoggerAttributes) => void
  fatal: (message: string, attributes?: LoggerAttributes) => void
}

function isLevelEnabled(
  level: LoggerLevel,
  minimumLevel: LoggerLevel
): boolean {
  return LOGGER_LEVEL_VALUES[level] >= LOGGER_LEVEL_VALUES[minimumLevel]
}

function createLoggerState(options: LoggerOptions): LoggerState {
  const enabled = options.enabled ?? true
  const kind = options.kind ?? 'application'
  const minimumLevel = options.level ?? 'info'
  const transports: LoggerTransport[] = [...(options.transports ?? [])]

  if (transports.length === 0) {
    transports.push(({ event }) => {
      process.stdout.write(`${JSON.stringify(event)}\n`)
    })
  }

  return {
    enabled,
    kind,
    minimumLevel,
    transports,
    onError: options.onError
  }
}

function emit(context: LoggerTransportContext, state: LoggerState): void {
  const { event } = context
  if (!state.enabled) return
  if (!isLevelEnabled(event.level, state.minimumLevel)) return

  for (const transport of state.transports) {
    Promise.resolve(transport(context)).catch((error: unknown) => {
      state.onError?.(error, event)
    })
  }
}

export function createLogger(options: LoggerOptions = {}): LoggerInstance {
  const state = createLoggerState(options)

  const log = (
    level: LoggerLevel,
    message: string,
    attributes: LoggerAttributes = {}
  ) => {
    emit(
      {
        event: {
          timestamp: new Date().toISOString(),
          kind: state.kind,
          level,
          message,
          attributes
        }
      },
      state
    )
  }

  return {
    trace: (message: string, attributes?: LoggerAttributes) =>
      log('trace', message, attributes),
    debug: (message: string, attributes?: LoggerAttributes) =>
      log('debug', message, attributes),
    info: (message: string, attributes?: LoggerAttributes) =>
      log('info', message, attributes),
    warn: (message: string, attributes?: LoggerAttributes) =>
      log('warn', message, attributes),
    error: (message: string, attributes?: LoggerAttributes) =>
      log('error', message, attributes),
    fatal: (message: string, attributes?: LoggerAttributes) =>
      log('fatal', message, attributes)
  }
}

export const logger = createLogger
