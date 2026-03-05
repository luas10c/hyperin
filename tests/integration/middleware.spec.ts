import { beforeEach, afterEach, describe, it, expect } from '@jest/globals'

import http from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { highen } from '#/instance'
import { cors, json, urlencoded, multipart } from '#/middleware'

// ─────────────────────────────────────────────────────────────
// HTTP test helper (same as instance.test.ts)
// ─────────────────────────────────────────────────────────────

interface TestResponse {
  status: number
  headers: http.IncomingHttpHeaders
  body: string
  json<T = unknown>(): T
}

function request(
  server: http.Server,
  options: {
    method?: string
    path?: string
    headers?: Record<string, string>
    body?: string | Buffer
  } = {}
): Promise<TestResponse> {
  return new Promise((resolve, reject) => {
    const addr = server.address() as { port: number }
    const req = http.request(
      {
        host: '127.0.0.1',
        port: addr.port,
        method: options.method || 'GET',
        path: options.path || '/',
        headers: options.headers || {}
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString()
          resolve({
            status: res.statusCode!,
            headers: res.headers,
            body,
            json<T>() {
              return JSON.parse(body) as T
            }
          })
        })
      }
    )
    req.on('error', reject)
    if (options.body) req.write(options.body)
    req.end()
  })
}

function startServer(app: ReturnType<typeof highen>): Promise<http.Server> {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server))
  })
}

function stopServer(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve()))
  )
}

function buildMultipartBody(
  boundary: string,
  parts: {
    name: string
    filename?: string
    contentType?: string
    data: string
  }[]
): Buffer {
  const chunks: Buffer[] = []
  for (const part of parts) {
    chunks.push(Buffer.from(`--${boundary}\r\n`))
    let disp = `Content-Disposition: form-data; name="${part.name}"`
    if (part.filename) disp += `; filename="${part.filename}"`
    chunks.push(Buffer.from(disp + '\r\n'))
    if (part.contentType)
      chunks.push(Buffer.from(`Content-Type: ${part.contentType}\r\n`))
    chunks.push(Buffer.from('\r\n'))
    chunks.push(Buffer.from(part.data))
    chunks.push(Buffer.from('\r\n'))
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`))
  return Buffer.concat(chunks)
}

// ─────────────────────────────────────────────────────────────
// CORS middleware
// ─────────────────────────────────────────────────────────────

describe('cors()', () => {
  let server: http.Server
  let app: ReturnType<typeof highen>

  beforeEach(async () => {
    app = highen()
    server = await startServer(app)
  })

  afterEach(async () => {
    await stopServer(server)
  })

  it('sets Access-Control-Allow-Origin: * by default', async () => {
    app.use(cors())
    app.get('/', async () => ({}))
    const res = await request(server, {
      path: '/',
      headers: { origin: 'http://example.com' }
    })
    expect(res.headers['access-control-allow-origin']).toBe('*')
  })

  it('reflects origin when origin: true', async () => {
    app.use(cors({ origin: true }))
    app.get('/', async () => ({}))
    const res = await request(server, {
      path: '/',
      headers: { origin: 'http://foo.com' }
    })
    expect(res.headers['access-control-allow-origin']).toBe('http://foo.com')
  })

  it('allows specific origin string', async () => {
    app.use(cors({ origin: 'http://allowed.com' }))
    app.get('/', async () => ({}))
    const res = await request(server, {
      path: '/',
      headers: { origin: 'http://allowed.com' }
    })
    expect(res.headers['access-control-allow-origin']).toBe(
      'http://allowed.com'
    )
  })

  it('does not set header for disallowed origin string', async () => {
    app.use(cors({ origin: 'http://allowed.com' }))
    app.get('/', async () => ({}))
    const res = await request(server, {
      path: '/',
      headers: { origin: 'http://bad.com' }
    })
    expect(res.headers['access-control-allow-origin']).toBeUndefined()
  })

  it('allows origin from array', async () => {
    app.use(cors({ origin: ['http://a.com', 'http://b.com'] }))
    app.get('/', async () => ({}))
    const res = await request(server, {
      path: '/',
      headers: { origin: 'http://b.com' }
    })
    expect(res.headers['access-control-allow-origin']).toBe('http://b.com')
  })

  it('allows origin matching RegExp', async () => {
    app.use(cors({ origin: /\.example\.com$/ }))
    app.get('/', async () => ({}))
    const res = await request(server, {
      path: '/',
      headers: { origin: 'http://sub.example.com' }
    })
    expect(res.headers['access-control-allow-origin']).toBe(
      'http://sub.example.com'
    )
  })

  it('sets credentials header when credentials: true', async () => {
    app.use(cors({ credentials: true }))
    app.get('/', async () => ({}))
    const res = await request(server, {
      path: '/',
      headers: { origin: 'http://x.com' }
    })
    expect(res.headers['access-control-allow-credentials']).toBe('true')
  })

  it('handles OPTIONS preflight and returns 204', async () => {
    app.use(cors())
    app.options('/', async ({ response }) => {
      response.send()
    })
    const res = await request(server, {
      method: 'OPTIONS',
      path: '/',
      headers: {
        'origin': 'http://example.com',
        'access-control-request-method': 'POST'
      }
    })
    expect(res.status).toBe(204)
    expect(res.headers['access-control-allow-methods']).toBeDefined()
  })

  it('sets Vary: Origin when not wildcard', async () => {
    app.use(cors({ origin: true }))
    app.get('/', async () => ({}))
    const res = await request(server, {
      path: '/',
      headers: { origin: 'http://x.com' }
    })
    expect(res.headers['vary']).toContain('Origin')
  })

  it('sets maxAge on preflight when configured', async () => {
    app.use(cors({ maxAge: 600 }))
    app.options('/', async ({ response }) => {
      response.send()
    })
    const res = await request(server, {
      method: 'OPTIONS',
      path: '/',
      headers: {
        'origin': 'http://x.com',
        'access-control-request-method': 'GET'
      }
    })
    expect(res.headers['access-control-max-age']).toBe('600')
  })

  it('sets exposed headers', async () => {
    app.use(cors({ exposedHeaders: ['X-Custom', 'X-Other'] }))
    app.get('/', async () => ({}))
    const res = await request(server, {
      path: '/',
      headers: { origin: 'http://x.com' }
    })
    expect(res.headers['access-control-expose-headers']).toContain('X-Custom')
  })

  it('origin function callback is supported', async () => {
    app.use(
      cors({
        origin: (_origin, cb) => cb(null, true)
      })
    )
    app.get('/', async () => ({}))
    const res = await request(server, {
      path: '/',
      headers: { origin: 'http://cb.com' }
    })
    expect(res.headers['access-control-allow-origin']).toBe('http://cb.com')
  })
})

// ─────────────────────────────────────────────────────────────
// json() middleware
// ─────────────────────────────────────────────────────────────

describe('json()', () => {
  let server: http.Server
  let app: ReturnType<typeof highen>

  beforeEach(async () => {
    app = highen()
    app.use(json())
    app.post('/echo', async ({ request }) => request.body)
    server = await startServer(app)
  })

  afterEach(async () => {
    await stopServer(server)
  })

  it('parses JSON body', async () => {
    const res = await request(server, {
      method: 'POST',
      path: '/echo',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Alice' })
    })
    expect(res.json()).toEqual({ name: 'Alice' })
  })

  it('skips non-JSON content-type', async () => {
    const app2 = highen()
    app2.use(json())
    app2.post('/check', async ({ request: req }) => ({
      hasBody: req.body !== undefined
    }))
    const server2 = await startServer(app2)
    const res = await request(server2, {
      method: 'POST',
      path: '/check',
      headers: { 'content-type': 'text/plain' },
      body: 'hello'
    })
    expect(res.json<{ hasBody: boolean }>().hasBody).toBe(false)
    await stopServer(server2)
  })

  it('returns 400 for invalid JSON', async () => {
    const res = await request(server, {
      method: 'POST',
      path: '/echo',
      headers: { 'content-type': 'application/json' },
      body: '{invalid json'
    })
    expect(res.status).toBe(400)
  })

  it('returns 400 for non-object in strict mode', async () => {
    const res = await request(server, {
      method: 'POST',
      path: '/echo',
      headers: { 'content-type': 'application/json' },
      body: '"just a string"'
    })
    expect(res.status).toBe(400)
  })

  it('allows primitive in non-strict mode', async () => {
    const app2 = highen()
    app2.use(json({ strict: false }))
    app2.post('/echo', async ({ request: req }) => ({ val: req.body }))
    const server2 = await startServer(app2)
    const res = await request(server2, {
      method: 'POST',
      path: '/echo',
      headers: { 'content-type': 'application/json' },
      body: '"hello"'
    })
    expect(res.json<{ val: string }>().val).toBe('hello')
    await stopServer(server2)
  })

  it('returns 413 when body exceeds limit', async () => {
    const app2 = highen()
    app2.use(json({ limit: '10b' }))
    app2.post('/echo', async ({ request }) => request.body)
    const server2 = await startServer(app2)
    const res = await request(server2, {
      method: 'POST',
      path: '/echo',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ data: 'x'.repeat(100) })
    })
    expect(res.status).toBe(413)
    await stopServer(server2)
  })

  it('passes empty body through without setting req.body', async () => {
    const app2 = highen()
    app2.use(json())
    app2.post('/check', async ({ request: req }) => ({
      hasBody: req.body !== undefined
    }))
    const server2 = await startServer(app2)
    const res = await request(server2, {
      method: 'POST',
      path: '/check',
      headers: { 'content-type': 'application/json' },
      body: ''
    })
    expect(res.json<{ hasBody: boolean }>().hasBody).toBe(false)
    await stopServer(server2)
  })

  it('parses JSON array', async () => {
    const res = await request(server, {
      method: 'POST',
      path: '/echo',
      headers: { 'content-type': 'application/json' },
      body: '[1,2,3]'
    })
    expect(res.json()).toEqual([1, 2, 3])
  })

  it('calls verify hook before parsing', async () => {
    let verifiedBuf = ''
    const app2 = highen()
    app2.use(
      json({
        verify: (_req, _res, buf) => {
          verifiedBuf = buf.toString()
        }
      })
    )
    app2.post('/v', async ({ request }) => request.body)
    const server2 = await startServer(app2)
    await request(server2, {
      method: 'POST',
      path: '/v',
      headers: { 'content-type': 'application/json' },
      body: '{"x":1}'
    })
    expect(verifiedBuf).toBe('{"x":1}')
    await stopServer(server2)
  })
})

// ─────────────────────────────────────────────────────────────
// urlencoded() middleware
// ─────────────────────────────────────────────────────────────

describe('urlencoded()', () => {
  let server: http.Server
  let app: ReturnType<typeof highen>

  beforeEach(async () => {
    app = highen()
    app.use(urlencoded())
    app.post('/echo', async ({ request }) => request.body)
    server = await startServer(app)
  })

  afterEach(async () => {
    await stopServer(server)
  })

  it('parses simple key=value pairs', async () => {
    const res = await request(server, {
      method: 'POST',
      path: '/echo',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'name=Alice&age=30'
    })
    expect(res.json()).toEqual({ name: 'Alice', age: '30' })
  })

  it('decodes + as space', async () => {
    const res = await request(server, {
      method: 'POST',
      path: '/echo',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'msg=Hello+World'
    })
    expect(res.json<{ msg: string }>().msg).toBe('Hello World')
  })

  it('decodes %XX encoding', async () => {
    const res = await request(server, {
      method: 'POST',
      path: '/echo',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'email=user%40example.com'
    })
    expect(res.json<{ email: string }>().email).toBe('user@example.com')
  })

  it('collects duplicate keys into array', async () => {
    const res = await request(server, {
      method: 'POST',
      path: '/echo',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'tag=a&tag=b&tag=c'
    })
    expect(res.json<{ tag: string[] }>().tag).toEqual(['a', 'b', 'c'])
  })

  it('skips non-urlencoded content-type', async () => {
    const app2 = highen()
    app2.use(urlencoded())
    app2.post('/check', async ({ request: req }) => ({
      has: req.body !== undefined
    }))
    const server2 = await startServer(app2)
    const res = await request(server2, {
      method: 'POST',
      path: '/check',
      headers: { 'content-type': 'application/json' },
      body: '{}'
    })
    expect(res.json<{ has: boolean }>().has).toBe(false)
    await stopServer(server2)
  })

  it('parses nested objects with extended: true', async () => {
    const app2 = highen()
    app2.use(urlencoded({ extended: true }))
    app2.post('/echo', async ({ request }) => request.body)
    const server2 = await startServer(app2)
    const res = await request(server2, {
      method: 'POST',
      path: '/echo',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'user[name]=Bob&user[age]=25'
    })
    expect(res.json<{ user: { name: string; age: string } }>().user).toEqual({
      name: 'Bob',
      age: '25'
    })
    await stopServer(server2)
  })

  it('parses arrays with extended: true', async () => {
    const app2 = highen()
    app2.use(urlencoded({ extended: true }))
    app2.post('/echo', async ({ request }) => request.body)
    const server2 = await startServer(app2)
    const res = await request(server2, {
      method: 'POST',
      path: '/echo',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'tags[]=x&tags[]=y'
    })
    expect(res.json<{ tags: string[] }>().tags).toEqual(['x', 'y'])
    await stopServer(server2)
  })

  it('returns 413 when body exceeds limit', async () => {
    const app2 = highen()
    app2.use(urlencoded({ limit: '10b' }))
    app2.post('/echo', async ({ request }) => request.body)
    const server2 = await startServer(app2)
    const res = await request(server2, {
      method: 'POST',
      path: '/echo',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'data=' + 'x'.repeat(100)
    })
    expect(res.status).toBe(413)
    await stopServer(server2)
  })
})

// ─────────────────────────────────────────────────────────────
// multipart() middleware
// ─────────────────────────────────────────────────────────────

describe('multipart()', () => {
  let server: http.Server
  let app: ReturnType<typeof highen>
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'highen-mw-test-'))
    app = highen()
    app.use(multipart({ dest: tmpDir }))
    app.post('/upload', async ({ request: req }) => ({
      fields: req.body,
      files: Object.fromEntries(
        Object.entries(
          req.files as Record<string, { filename: string; size: number }>
        ).map(([k, v]) => [k, { filename: v.filename, size: v.size }])
      )
    }))
    server = await startServer(app)
  })

  afterEach(async () => {
    await stopServer(server)
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('parses text fields from multipart', async () => {
    const boundary = 'testboundary123'
    const body = buildMultipartBody(boundary, [
      { name: 'username', data: 'alice' }
    ])
    const res = await request(server, {
      method: 'POST',
      path: '/upload',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      body
    })
    expect(res.json<{ fields: { username: string } }>().fields.username).toBe(
      'alice'
    )
  })

  it('parses file uploads', async () => {
    const boundary = 'fileboundary456'
    const body = buildMultipartBody(boundary, [
      {
        name: 'doc',
        filename: 'hello.txt',
        contentType: 'text/plain',
        data: 'hello world'
      }
    ])
    const res = await request(server, {
      method: 'POST',
      path: '/upload',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      body
    })
    expect(
      res.json<{ files: { doc: { filename: string } } }>().files.doc.filename
    ).toBe('hello.txt')
    expect(
      res.json<{ files: { doc: { size: number } } }>().files.doc.size
    ).toBe(11)
  })

  it('handles 6 consecutive requests without corruption', async () => {
    for (let i = 0; i < 6; i++) {
      const boundary = `bound${i}`
      const body = buildMultipartBody(boundary, [
        { name: 'iter', data: String(i) }
      ])
      const res = await request(server, {
        method: 'POST',
        path: '/upload',
        headers: {
          'content-type': `multipart/form-data; boundary=${boundary}`
        },
        body
      })
      expect(res.json<{ fields: { iter: number } }>().fields.iter).toBe(
        String(i)
      )
    }
  })

  it('returns 400 for missing boundary', async () => {
    const res = await request(server, {
      method: 'POST',
      path: '/upload',
      headers: { 'content-type': 'multipart/form-data' },
      body: 'no boundary here'
    })
    expect(res.status).toBe(400)
  })

  it('skips non-multipart requests', async () => {
    const app2 = highen()
    app2.use(multipart({ dest: tmpDir }))
    app2.post('/check', async ({ request: req }) => ({
      body: req.body ?? null
    }))
    const server2 = await startServer(app2)
    const res = await request(server2, {
      method: 'POST',
      path: '/check',
      headers: { 'content-type': 'application/json' },
      body: '{}'
    })
    expect(res.json<{ body: object }>().body).toBeNull()
    await stopServer(server2)
  })
})
