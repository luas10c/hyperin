import { IncomingMessage } from 'node:http'
import type { Socket } from 'node:net'
import type { ParsedUrlQuery } from 'node:querystring'

// ─────────────────────────────────────────────────────────────
// Request
// ─────────────────────────────────────────────────────────────

export class Request extends IncomingMessage {
  /** Parsed route params e.g. /users/:id → req.params.id */
  params: Record<string, string> = {}
  /** Parsed query string */
  query: ParsedUrlQuery = {}
  /** Parsed body (requires bodyParser middleware) */
  body:
    | Record<string, string>
    | Record<string, unknown>
    | Record<string, string | string[]>
    | string
    | undefined = undefined
  /** Uploaded files (requires multipart middleware) */
  files: Record<string, unknown> = {}
  /** Custom state bag for middleware communication */
  locals: Record<string, unknown> = {}

  #parsedUrl: URL | null = null

  constructor(socket: Socket) {
    super(socket)
  }

  get parsedUrl(): URL {
    if (!this.#parsedUrl) {
      this.#parsedUrl = new URL(
        this.url || '/',
        `http://${this.headers.host || 'localhost'}`
      )
    }
    return this.#parsedUrl
  }

  resetParsedUrl(): void {
    this.#parsedUrl = null
  }

  get path(): string {
    return this.parsedUrl.pathname
  }

  get ipAddress(): string {
    const forwarded = this.headers['x-forwarded-for']
    if (forwarded) {
      return (Array.isArray(forwarded) ? forwarded[0] : forwarded)
        .split(',')[0]
        .trim()
    }
    return this.socket?.remoteAddress || ''
  }

  get(header: string): string | string[] | undefined {
    return this.headers[header.toLowerCase()]
  }

  is(type: string): boolean {
    const contentType = this.headers['content-type'] || ''
    return contentType.includes(type)
  }
}
