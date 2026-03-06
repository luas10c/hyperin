import { beforeEach, afterEach, describe, it, expect } from '@jest/globals'
import http from 'node:http'
import { hyperin, type Handler } from '#/instance'

// ─────────────────────────────────────────────────────────────
// HTTP test helper
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

function startServer(app: ReturnType<typeof hyperin>): Promise<http.Server> {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server))
  })
}

function stopServer(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve()))
  )
}

// ─────────────────────────────────────────────────────────────
// Routing
// ─────────────────────────────────────────────────────────────

describe('Routing', () => {
  let server: http.Server
  let app: ReturnType<typeof hyperin>

  beforeEach(async () => {
    app = hyperin()
    server = await startServer(app)
  })

  afterEach(async () => {
    await stopServer(server)
  })

  it('GET / returns 200', async () => {
    app.get('/', async () => ({ ok: true }))
    const res = await request(server, { path: '/' })
    expect(res.status).toBe(200)
    expect(res.json()).toEqual({ ok: true })
  })

  it('returns 404 for unregistered route', async () => {
    const res = await request(server, { path: '/nope' })
    expect(res.status).toBe(404)
  })

  it('matches route params', async () => {
    app.get('/users/:id', async ({ request: req }) => ({ id: req.params.id }))
    const res = await request(server, { path: '/users/42' })
    expect(res.json()).toEqual({ id: '42' })
  })

  it('matches multiple params', async () => {
    app.get('/a/:x/b/:y', async ({ request: req }) => req.params)
    const res = await request(server, { path: '/a/foo/b/bar' })
    expect(res.json()).toEqual({ x: 'foo', y: 'bar' })
  })

  it('parses query string', async () => {
    app.get('/search', async ({ request: req }) => ({ q: req.query.q }))
    const res = await request(server, { path: '/search?q=hello' })
    expect(res.json()).toEqual({ q: 'hello' })
  })

  it('POST route receives body via middleware', async () => {
    const { json: jsonMw } = await import('#/body')
    app.use(jsonMw())
    app.post('/echo', async ({ request: req }) => req.body)
    const res = await request(server, {
      method: 'POST',
      path: '/echo',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hello: 'world' })
    })
    expect(res.json()).toEqual({ hello: 'world' })
  })

  it('PUT route works', async () => {
    app.put('/item/:id', async ({ request: req }) => ({
      updated: req.params.id
    }))
    const res = await request(server, { method: 'PUT', path: '/item/5' })
    expect(res.json()).toEqual({ updated: '5' })
  })

  it('PATCH route works', async () => {
    app.patch('/item/:id', async ({ request: req }) => ({
      patched: req.params.id
    }))
    const res = await request(server, { method: 'PATCH', path: '/item/7' })
    expect(res.json()).toEqual({ patched: '7' })
  })

  it('DELETE route works', async () => {
    app.delete('/item/:id', async ({ request: req }) => ({
      deleted: req.params.id
    }))
    const res = await request(server, { method: 'DELETE', path: '/item/3' })
    expect(res.json()).toEqual({ deleted: '3' })
  })

  it('ALL matches any method', async () => {
    app.all('/any', async () => ({ matched: true }))
    const get = await request(server, { method: 'GET', path: '/any' })
    const post = await request(server, { method: 'POST', path: '/any' })
    expect(get.json()).toEqual({ matched: true })
    expect(post.json()).toEqual({ matched: true })
  })

  it('handler returning a string sends text/plain', async () => {
    app.get('/text', async () => 'hello text')
    const res = await request(server, { path: '/text' })
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toContain('text/plain')
    expect(res.body).toBe('hello text')
  })

  it('handler returning an array sends JSON', async () => {
    app.get('/list', async () => [1, 2, 3])
    const res = await request(server, { path: '/list' })
    expect(res.json()).toEqual([1, 2, 3])
  })

  it('wildcard route captures rest', async () => {
    app.get('/files/*', async ({ request: req }) => ({ rest: req.params['*'] }))
    const res = await request(server, { path: '/files/a/b/c' })
    expect(res.json()).toEqual({ rest: 'a/b/c' })
  })
})

// ─────────────────────────────────────────────────────────────
// Middleware chain
// ─────────────────────────────────────────────────────────────

describe('Middleware chain', () => {
  let server: http.Server
  let app: ReturnType<typeof hyperin>

  beforeEach(async () => {
    app = hyperin()
    server = await startServer(app)
  })

  afterEach(async () => {
    await stopServer(server)
  })

  it('middleware runs before handler', async () => {
    const order: string[] = []
    app.use(async ({ next }) => {
      order.push('mw')
      await next()
    })
    app.get('/', async () => {
      order.push('handler')
      return {}
    })
    await request(server, { path: '/' })
    expect(order).toEqual(['mw', 'handler'])
  })

  it('multiple middlewares run in order', async () => {
    const order: string[] = []
    app.use(async ({ next }) => {
      order.push('1')
      await next()
    })
    app.use(async ({ next }) => {
      order.push('2')
      await next()
    })
    app.get('/', async () => {
      order.push('h')
      return {}
    })
    await request(server, { path: '/' })
    expect(order).toEqual(['1', '2', 'h'])
  })

  it('middleware can short-circuit without calling next', async () => {
    app.use(async ({ response }) => {
      response.status(401).json({ error: 'Unauthorized' })
    })
    app.get('/', async () => ({ should: 'not reach' }))
    const res = await request(server, { path: '/' })
    expect(res.status).toBe(401)
  })

  it('middleware can set locals for handler', async () => {
    app.use(async ({ request: req, next }) => {
      req.locals.user = { id: 99 }
      await next()
    })
    app.get('/', async ({ request: req }) => req.locals)
    const res = await request(server, { path: '/' })
    expect(res.json<{ user: { id: number } }>().user.id).toBe(99)
  })

  it('route-level handlers run in sequence', async () => {
    const order: string[] = []
    const mw: Handler = async ({ next }) => {
      order.push('mw')
      await next()
    }
    const h: Handler = async () => {
      order.push('h')
      return {}
    }
    app.get('/', mw, h)
    await request(server, { path: '/' })
    expect(order).toEqual(['mw', 'h'])
  })
})

// ─────────────────────────────────────────────────────────────
// Error handling
// ─────────────────────────────────────────────────────────────

describe('Error handling', () => {
  let server: http.Server
  let app: ReturnType<typeof hyperin>

  beforeEach(async () => {
    app = hyperin()
    server = await startServer(app)
  })

  afterEach(async () => {
    await stopServer(server)
  })

  it('default error handler returns 500 on thrown error', async () => {
    app.get('/boom', async () => {
      throw new Error('kaboom')
    })
    const res = await request(server, { path: '/boom' })
    expect(res.status).toBe(500)
    expect(res.json<{ error: string }>().error).toBe('kaboom')
  })

  it('custom error middleware handles thrown errors', async () => {
    app.use(async ({ error, response }) => {
      response.status(503).json({ custom: error.message })
    })
    app.get('/boom', async () => {
      throw new Error('oops')
    })
    const res = await request(server, { path: '/boom' })
    expect(res.status).toBe(503)
    expect(res.json<{ custom: string }>().custom).toBe('oops')
  })

  it('error middleware receives error with statusCode', async () => {
    app.use(async ({ error, response }) => {
      const status =
        (error as unknown as { statusCode: number }).statusCode || 500
      response.status(status).json({ code: status })
    })
    app.get('/err', async () => {
      throw Object.assign(new Error('bad'), { statusCode: 422 })
    })
    const res = await request(server, { path: '/err' })
    expect(res.json<{ code: number }>().code).toBe(422)
  })
})

// ─────────────────────────────────────────────────────────────
// Response methods
// ─────────────────────────────────────────────────────────────

describe('Response methods', () => {
  let server: http.Server
  let app: ReturnType<typeof hyperin>

  beforeEach(async () => {
    app = hyperin()
    server = await startServer(app)
  })

  afterEach(async () => {
    await stopServer(server)
  })

  it('response.json() sends JSON', async () => {
    app.get('/', async ({ response }) => {
      response.json({ a: 1 })
    })
    const res = await request(server, { path: '/' })
    expect(res.headers['content-type']).toContain('application/json')
    expect(res.json()).toEqual({ a: 1 })
  })

  it('response.text() sends plain text', async () => {
    app.get('/', async ({ response }) => {
      response.text('hi')
    })
    const res = await request(server, { path: '/' })
    expect(res.headers['content-type']).toContain('text/plain')
    expect(res.body).toBe('hi')
  })

  it('response.html() sends HTML', async () => {
    app.get('/', async ({ response }) => {
      response.html('<h1>hi</h1>')
    })
    const res = await request(server, { path: '/' })
    expect(res.headers['content-type']).toContain('text/html')
    expect(res.body).toBe('<h1>hi</h1>')
  })

  it('response.status() sets status code', async () => {
    app.get('/', async ({ response }) => {
      response.status(201).json({ created: true })
    })
    const res = await request(server, { path: '/' })
    expect(res.status).toBe(201)
  })

  it('response.redirect() sends 302 by default', async () => {
    app.get('/old', async ({ response }) => {
      response.redirect('/new')
    })
    const res = await request(server, { path: '/old' })
    expect(res.status).toBe(302)
    expect(res.headers['location']).toBe('/new')
  })

  it('response.redirect() accepts custom status', async () => {
    app.get('/moved', async ({ response }) => {
      response.redirect('/new', 301)
    })
    const res = await request(server, { path: '/moved' })
    expect(res.status).toBe(301)
  })

  it('response.send() with no body sends empty 200', async () => {
    app.get('/', async ({ response }) => {
      response.send()
    })
    const res = await request(server, { path: '/' })
    expect(res.status).toBe(200)
    expect(res.body).toBe('')
  })

  it('response.cookie() sets Set-Cookie header', async () => {
    app.get('/', async ({ response }) => {
      response.cookie('token', 'abc123', { httpOnly: true }).json({})
    })
    const res = await request(server, { path: '/' })
    expect(res.headers['set-cookie']).toBeDefined()
    expect(res.headers['set-cookie']![0]).toContain('token=abc123')
    expect(res.headers['set-cookie']![0]).toContain('HttpOnly')
  })

  it('response.header() sets custom header', async () => {
    app.get('/', async ({ response }) => {
      response.header('X-Custom', 'value').json({})
    })
    const res = await request(server, { path: '/' })
    expect(res.headers['x-custom']).toBe('value')
  })
})

// ─────────────────────────────────────────────────────────────
// Request properties
// ─────────────────────────────────────────────────────────────

describe('Request properties', () => {
  let server: http.Server
  let app: ReturnType<typeof hyperin>

  beforeEach(async () => {
    app = hyperin()
    server = await startServer(app)
  })

  afterEach(async () => {
    await stopServer(server)
  })

  it('req.path returns pathname', async () => {
    app.get('/test', async ({ request: req }) => ({ path: req.path }))
    const res = await request(server, { path: '/test?foo=bar' })
    expect(res.json<{ path: string }>().path).toBe('/test')
  })

  it('req.query parses query string', async () => {
    app.get('/q', async ({ request: req }) => ({ v: req.query.v }))
    const res = await request(server, { path: '/q?v=42' })
    expect(res.json<{ v: string }>().v).toBe('42')
  })

  it('req.is() checks content-type', async () => {
    const { json: jsonMw } = await import('#/body')
    app.use(jsonMw())
    app.post('/check', async ({ request: req }) => ({
      isJson: req.is('application/json')
    }))
    const res = await request(server, {
      method: 'POST',
      path: '/check',
      headers: { 'content-type': 'application/json' },
      body: '{}'
    })
    expect(res.json<{ isJson: boolean }>().isJson).toBe(true)
  })

  it('req.get() retrieves header value', async () => {
    app.get('/hdr', async ({ request: req }) => ({
      ua: req.get('x-custom-header')
    }))
    const res = await request(server, {
      path: '/hdr',
      headers: { 'x-custom-header': 'testval' }
    })
    expect(res.json<{ ua: string }>().ua).toBe('testval')
  })
})

// ─────────────────────────────────────────────────────────────
// mount() & route()
// ─────────────────────────────────────────────────────────────

describe('mount() and route()', () => {
  let server: http.Server
  let app: ReturnType<typeof hyperin>

  beforeEach(async () => {
    app = hyperin()
    server = await startServer(app)
  })

  afterEach(async () => {
    await stopServer(server)
  })

  it('mount() merges sub-app routes under prefix', async () => {
    const sub = hyperin()
    sub.get('/hello', async () => ({ from: 'sub' }))
    app.mount('/api', sub)
    const res = await request(server, { path: '/api/hello' })
    expect(res.json()).toEqual({ from: 'sub' })
  })

  it('route() chains methods', async () => {
    app
      .route('/item')
      .get(async () => ({ method: 'GET' }))
      .post(() => ({ method: 'POST' }))

    const get = await request(server, { method: 'GET', path: '/item' })
    const post = await request(server, { method: 'POST', path: '/item' })
    expect(get.json()).toEqual({ method: 'GET' })
    expect(post.json()).toEqual({ method: 'POST' })
  })
})
