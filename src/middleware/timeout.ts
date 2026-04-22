import type { Request } from '#/request'
import type { Response } from '#/response'
import type { Middleware } from '#/types'

export interface TimeoutOptions {
  delay?: number
  statusCode?: number
  message?: string | Record<string, unknown>
  skip?: (request: Request, response: Response) => boolean
  onTimeout?: (request: Request, response: Response) => void | Promise<void>
}

export function timeout(options: TimeoutOptions = {}): Middleware {
  const delay = options.delay ?? 30_000
  const statusCode = options.statusCode ?? 408
  const message = options.message ?? { error: 'Request Timeout' }

  return async ({ request, response, next }) => {
    if (options.skip?.(request, response)) {
      return void (await next())
    }

    request.locals.abortSignal = request.signal

    let timedOut = false

    const clear = () => {
      clearTimeout(timer)
      response.off('finish', clear)
      response.off('close', clear)
    }

    const timer = setTimeout(async () => {
      if (response.sent || response.writableEnded) return

      timedOut = true
      clear()
      request.locals.timeout = true
      request.abort(new Error('Request Timeout'))

      response.setHeader('Connection', 'close')

      if (options.onTimeout) {
        await options.onTimeout(request, response)
        return
      }

      response.status(statusCode)

      if (typeof message === 'string') {
        response.text(message)
      } else {
        response.json(message)
      }
    }, delay)

    timer.unref?.()

    response.once('finish', clear)
    response.once('close', clear)

    await next()

    if (timedOut || response.sent || response.writableEnded) {
      clear()
    }
  }
}
