import { IncomingMessage, ServerResponse } from 'node:http'
import { Socket } from 'node:net'
import { Readable } from 'node:stream'
import type { ReadableStream as NodeReadableStream } from 'node:stream/web'

import { Request } from '#/request'
import { Response } from '#/response'

type NodeHandler = (
  request: IncomingMessage,
  response: ServerResponse
) => Promise<void>

function appendHeader(
  headers: IncomingMessage['headers'],
  key: string,
  value: string
): void {
  const current = headers[key]

  if (current === undefined) {
    headers[key] = value
    return
  }

  if (Array.isArray(current)) {
    current.push(value)
    return
  }

  headers[key] = [current, value]
}

function collectResponseHeaders(response: Response): Headers {
  const headers = new Headers()

  for (const name of response.getHeaderNames()) {
    const value = response.getHeader(name)
    if (value === undefined) continue

    if (Array.isArray(value)) {
      for (const entry of value) headers.append(name, String(entry))
      continue
    }

    headers.set(name, String(value))
  }

  return headers
}

function canResponseHaveBody(request: Request, statusCode: number): boolean {
  return (
    request.method !== 'HEAD' &&
    statusCode !== 204 &&
    statusCode !== 205 &&
    statusCode !== 304
  )
}

function createNodeRequestFromWebRequest(webRequest: globalThis.Request): Request {
  const request = new Request(new Socket())
  const target = new URL(webRequest.url)
  const socket = request.socket as Socket & {
    encrypted?: boolean
    _read?: (size?: number) => void
  }

  request.method = webRequest.method
  request.url = `${target.pathname}${target.search}` || '/'
  request.headers = {}
  request.rawHeaders = []

  Object.defineProperty(socket, 'encrypted', {
    value: target.protocol === 'https:',
    configurable: true,
    enumerable: false,
    writable: true
  })

  const headers = request.headers
  for (const [key, value] of webRequest.headers) {
    request.rawHeaders.push(key, value)
    appendHeader(headers, key.toLowerCase(), value)
  }

  if (!headers.host) {
    headers.host = target.host
    request.rawHeaders.push('host', target.host)
  }

  if (webRequest.body && !headers['content-length']) {
    headers['transfer-encoding'] = 'chunked'
  }

  if (!webRequest.body) {
    queueMicrotask(() => {
      request.push(null)
    })
    return request
  }

  const source = Readable.fromWeb(
    webRequest.body as unknown as NodeReadableStream
  )
  const abortRequest = () => {
    request.emit('aborted')
    source.destroy(Object.assign(new Error('Request aborted'), { status: 400 }))
    request.destroy(Object.assign(new Error('Request aborted'), { status: 400 }))
  }

  if (webRequest.signal.aborted) {
    queueMicrotask(abortRequest)
    return request
  }

  webRequest.signal.addEventListener('abort', abortRequest, { once: true })

  socket._read = () => {
    if (source.isPaused()) {
      source.resume()
    }
  }

  source.on('data', (chunk: Buffer | string) => {
    const accepted = request.push(
      Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    )

    if (!accepted) {
      source.pause()
    }
  })
  source.on('end', () => {
    webRequest.signal.removeEventListener('abort', abortRequest)
    request.push(null)
  })
  source.on('error', (error: Error) => {
    webRequest.signal.removeEventListener('abort', abortRequest)
    request.destroy(error)
  })

  return request
}

function normalizeBodyChunk(
  chunk?: Buffer | Uint8Array | string | null,
  encoding?: BufferEncoding
): Buffer | null {
  if (chunk == null) return null
  if (Buffer.isBuffer(chunk)) return chunk
  if (chunk instanceof Uint8Array) return Buffer.from(chunk)
  return Buffer.from(chunk, encoding)
}

function createWebResponseBridge(
  request: Request
): {
  response: Response
  started: Promise<globalThis.Response>
} {
  const response = new Response(request)
  let committed = false
  let ended = false
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null
  let responseStarted!: (value: globalThis.Response) => void
  let responseFailed!: (reason?: unknown) => void

  const started = new Promise<globalThis.Response>((resolve, reject) => {
    responseStarted = resolve
    responseFailed = reject
  })

  const commit = (): void => {
    if (committed) return
    committed = true

    const status = response.statusCode || 200
    const headers = collectResponseHeaders(response)
    const body = canResponseHaveBody(request, status)
      ? new ReadableStream<Uint8Array>({
          start(streamController) {
            controller = streamController
          }
        })
      : null

    responseStarted(new globalThis.Response(body, { status, headers }))
  }

  Object.defineProperty(response, 'headersSent', {
    configurable: true,
    enumerable: true,
    get() {
      return committed
    }
  })

  Object.defineProperty(response, 'writableEnded', {
    configurable: true,
    enumerable: true,
    get() {
      return ended
    }
  })

  response.once('error', (error: Error) => {
    if (!committed) {
      responseFailed(error)
      return
    }

    controller?.error(error)
  })

  response.write = ((
    chunk: Buffer | string,
    encoding?: BufferEncoding | ((error?: Error | null) => void),
    cb?: (error?: Error | null) => void
  ) => {
    let resolvedEncoding: BufferEncoding | undefined
    let callback: ((error?: Error | null) => void) | undefined

    if (typeof encoding === 'function') {
      callback = encoding
    } else {
      resolvedEncoding = encoding
      callback = cb
    }

    const buffer = normalizeBodyChunk(chunk, resolvedEncoding)
    commit()

    if (buffer && controller) {
      controller.enqueue(new Uint8Array(buffer))
    }

    callback?.()
    return true
  }) as typeof response.write

  response.end = ((
    chunk?: Buffer | string | (() => void),
    encoding?: BufferEncoding | (() => void),
    cb?: () => void
  ) => {
    let bodyChunk: Buffer | string | undefined
    let resolvedEncoding: BufferEncoding | undefined
    let callback: (() => void) | undefined

    if (typeof chunk === 'function') {
      callback = chunk
    } else if (typeof encoding === 'function') {
      bodyChunk = chunk
      callback = encoding
    } else {
      bodyChunk = chunk
      resolvedEncoding = encoding
      callback = cb
    }

    const buffer = normalizeBodyChunk(bodyChunk, resolvedEncoding)
    commit()

    if (buffer && controller) {
      controller.enqueue(new Uint8Array(buffer))
    }

    ended = true
    controller?.close()
    callback?.()
    response.emit('finish')
    return response
  }) as typeof response.end

  return { response, started }
}

export function createFetchHandler(
  handler: NodeHandler
): (request: globalThis.Request) => Promise<globalThis.Response> {
  return async function fetch(
    request: globalThis.Request
  ): Promise<globalThis.Response> {
    const nodeRequest = createNodeRequestFromWebRequest(request)
    const { response, started } = createWebResponseBridge(nodeRequest)

    await handler(nodeRequest, response)
    return await started
  }
}
