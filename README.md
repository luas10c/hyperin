# hyperin

🚀 A fast, lightweight Node.js HTTP framework built on a Radix trie router with zero dependencies.

## Installation

```bash
npm install hyperin
```

## Quick Start

```typescript
import hyperin from 'hyperin'

const app = hyperin()

app.get('/', async () => ({
  message: 'Hello, World!'
}))

app.listen(3000, '0.0.0.0', () => {
  console.log('Server running on http://localhost:3000')
})
```

---

## Routing

### Basic routes

```typescript
app.get('/users', async () => ({ users: [] }))
app.post('/users', async ({ request }) => ({ created: request.body }))
app.put('/users/:id', async ({ request }) => ({ updated: request.params.id }))
app.patch('/users/:id', async ({ request }) => ({ patched: request.params.id }))
app.delete('/users/:id', async ({ request }) => ({
  deleted: request.params.id
}))
app.head('/users', async ({ response }) => {
  response.status(200).send()
})
app.options('/users', async ({ response }) => {
  response.status(204).send()
})
app.all('/ping', async () => ({ pong: true }))
```

### Route parameters

```typescript
app.get('/users/:id', async ({ request }) => {
  return { id: request.params.id }
})

app.get('/posts/:postId/comments/:commentId', async ({ request }) => {
  return request.params // { postId: '...', commentId: '...' }
})
```

### Wildcard

```typescript
app.get('/files/*', async ({ request }) => {
  return { path: request.params['*'] } // e.g. 'images/photo.png'
})
```

### Query string

```typescript
app.get('/search', async ({ request }) => {
  return { q: request.query.q }
})
// GET /search?q=hello → { q: 'hello' }
```

### route() — chaining multiple methods on the same path

```typescript
app
  .route('/users/:id')
  .get(async ({ request }) => ({ id: request.params.id }))
  .put(async ({ request }) => ({ updated: request.params.id }))
  .delete(async ({ request }) => ({ deleted: request.params.id }))
```

---

## Handlers

Every handler receives `{ request, response, next }`. You can either return a value or use `response` directly.

### Returning a value (automatic serialization)

```typescript
// Object → JSON
app.get('/json', async () => ({ hello: 'world' }))

// Array → JSON
app.get('/list', async () => [1, 2, 3])

// String → text/plain
app.get('/text', async () => 'Hello!')

// void → you handle the response manually
app.get('/manual', async ({ response }) => {
  response.status(201).json({ created: true })
})
```

### Multiple handlers (middleware chain per route)

```typescript
async function auth({ request, next }) {
  if (!request.headers['authorization']) {
    return { error: 'Unauthorized' }
  }
  await next()
}

app.get('/protected', auth, async ({ request }) => ({
  user: request.locals.user
}))
```

---

## Request

| Property            | Type                            | Description                                 |
| ------------------- | ------------------------------- | ------------------------------------------- |
| `request.params`    | `Record<string, string>`        | Route params (`:id`, `*`)                   |
| `request.query`     | `ParsedUrlQuery`                | Parsed query string                         |
| `request.body`      | `object \| string \| undefined` | Parsed body (requires middleware)           |
| `request.files`     | `Record<string, UploadedFile>`  | Uploaded files (requires `multipart`)       |
| `request.locals`    | `Record<string, unknown>`       | State bag for passing data between handlers |
| `request.ipAddress` | `string`                        | Client IP (respects `X-Forwarded-For`)      |

```typescript
request.get('authorization') // get a header value
request.is('application/json') // check content-type
```

---

## Response

All methods are chainable.

```typescript
response.status(201).json({ created: true })
response.status(200).text('Hello')
response.status(200).html('<h1>Hello</h1>')
response.send({ auto: 'detect' }) // json, text, or Buffer
response.redirect('/new-path') // 302 by default
response.redirect('/moved', 301)
response.header('X-Custom', 'value')
response.type('application/xml')
response.cookie('token', 'abc', {
  httpOnly: true,
  secure: true,
  maxAge: 3600,
  sameSite: 'Strict'
})
```

| Method                              | Description                                          |
| ----------------------------------- | ---------------------------------------------------- |
| `response.json(obj)`                | Send JSON with `Content-Type: application/json`      |
| `response.text(str)`                | Send plain text                                      |
| `response.html(str)`                | Send HTML                                            |
| `response.send(body?)`              | Auto-detect: object→JSON, string→text, Buffer→binary |
| `response.status(code)`             | Set status code (chainable)                          |
| `response.header(key, val)`         | Set a response header (chainable)                    |
| `response.redirect(url, code?)`     | Redirect (default 302)                               |
| `response.cookie(name, val, opts?)` | Set a cookie                                         |
| `response.type(mime)`               | Set Content-Type                                     |
| `response.sent`                     | `boolean` — whether the response was already sent    |

---

## Middlewares

### Global middleware

```typescript
app.use(async ({ request, next }) => {
  console.log(request.method, request.path)
  await next()
})
```

### Path-scoped middleware

```typescript
app.use('/api', someMiddleware, anotherMiddleware)
```

### Error middleware

Destructure `error` in the first parameter to register an error handler:

```typescript
app.use(async ({ error, response }) => {
  const status = (error as any).statusCode ?? 500
  response.status(status).json({ error: error.message })
})
```

---

## Built-in Middlewares

### CORS — `cors(options?)`

```typescript
import hyperin from 'hyperin'
import {
  cors,
  json,
  multipart,
  serveStatic,
  urlencoded
} from 'hyperin/middleware'

// Allow all origins
app.use(cors())

// Fixed origin
app.use(cors({ origin: 'https://myapp.com' }))

// Array of origins
app.use(cors({ origin: ['https://a.com', 'https://b.com'] }))

// RegExp
app.use(cors({ origin: /\.myapp\.com$/ }))

// Reflect request origin (required with credentials)
app.use(cors({ origin: true, credentials: true }))

// Disable CORS headers entirely
app.use(cors({ origin: false }))

// Async callback
app.use(
  cors({
    origin: (origin, cb) => {
      const allowed = checkDatabase(origin)
      cb(null, allowed)
    }
  })
)
```

| Option                 | Type                                                  | Default                            | Description                            |
| ---------------------- | ----------------------------------------------------- | ---------------------------------- | -------------------------------------- |
| `origin`               | `string \| string[] \| RegExp \| boolean \| function` | `'*'`                              | Allowed origins                        |
| `methods`              | `string \| string[]`                                  | `'GET,HEAD,PUT,PATCH,POST,DELETE'` | Allowed methods                        |
| `allowedHeaders`       | `string \| string[]`                                  | reflects request                   | Allowed headers                        |
| `exposedHeaders`       | `string \| string[]`                                  | `''`                               | Headers exposed to the browser         |
| `credentials`          | `boolean`                                             | `false`                            | Set `Access-Control-Allow-Credentials` |
| `maxAge`               | `number`                                              | `0`                                | Preflight cache duration in seconds    |
| `preflightContinue`    | `boolean`                                             | `false`                            | Pass OPTIONS to next handler           |
| `optionsSuccessStatus` | `number`                                              | `204`                              | Status for successful preflight        |

---

### JSON body parser — `json(options?)`

```typescript
app.use(json())

app.post('/data', async ({ request }) => {
  console.log(request.body) // parsed object
  return { received: true }
})
```

| Option           | Type                             | Default              | Description                                                             |
| ---------------- | -------------------------------- | -------------------- | ----------------------------------------------------------------------- |
| `limit`          | `string \| number`               | `'100kb'`            | Max body size. Supports `'500b'`, `'100kb'`, `'1mb'`, `'1gb'`           |
| `strict`         | `boolean`                        | `true`               | Only accept objects and arrays at the top level                         |
| `inflate`        | `boolean`                        | `true`               | Decompress gzip/deflate/br bodies                                       |
| `defaultCharset` | `'utf-8' \| 'latin1'`            | `'utf-8'`            | Charset fallback                                                        |
| `reviver`        | `function`                       | —                    | `JSON.parse` reviver function                                           |
| `verify`         | `function`                       | —                    | `(req, res, buf, encoding) => void` — inspect raw buffer before parsing |
| `type`           | `string \| string[] \| function` | `'application/json'` | Content-Type matcher                                                    |

---

### URL-encoded body parser — `urlencoded(options?)`

```typescript
app.use(urlencoded({ extended: true }))

app.post('/form', async ({ request }) => {
  console.log(request.body) // { name: 'Alice', tags: ['a', 'b'] }
  return { received: true }
})
```

| Option           | Type                             | Default                               | Description                                                   |
| ---------------- | -------------------------------- | ------------------------------------- | ------------------------------------------------------------- |
| `extended`       | `boolean`                        | `false`                               | `true` enables nested objects and arrays (`user[name]=Alice`) |
| `limit`          | `string \| number`               | `'100kb'`                             | Max body size                                                 |
| `parameterLimit` | `number`                         | `1000`                                | Max number of parameters                                      |
| `depth`          | `number`                         | `32`                                  | Max nesting depth (extended mode)                             |
| `inflate`        | `boolean`                        | `true`                                | Decompress gzip/deflate/br                                    |
| `defaultCharset` | `'utf-8' \| 'latin1'`            | `'utf-8'`                             | Charset fallback                                              |
| `verify`         | `function`                       | —                                     | `(req, res, buf, encoding) => void`                           |
| `type`           | `string \| string[] \| function` | `'application/x-www-form-urlencoded'` | Content-Type matcher                                          |

Extended mode examples:

```
user[name]=Alice&user[age]=30  →  { user: { name: 'Alice', age: '30' } }
tags[]=a&tags[]=b              →  { tags: ['a', 'b'] }
name=Hello+World               →  { name: 'Hello World' }
email=user%40example.com       →  { email: 'user@example.com' }
```

---

### Multipart / file uploads — `multipart(options?)`

```typescript
import { join } from 'node:path'

app.use(
  multipart({
    dest: join(import.meta.dirname, 'uploads'),
    limits: {
      fileSize: 5 * 1024 * 1024, // 5mb
      files: 5,
      fields: 20
    }
  })
)

app.post('/upload', async ({ request }) => {
  console.log(request.body) // text fields
  console.log(request.files) // uploaded files
  return { uploaded: true }
})
```

Each entry in `request.files` is an `UploadedFile`:

```typescript
interface UploadedFile {
  fieldname: string // form field name
  filename: string // original filename
  encoding: string // e.g. '7bit'
  mimetype: string // e.g. 'image/png'
  size: number // bytes
  path: string // absolute path on disk
}
```

| Option            | Type     | Default       | Description                      |
| ----------------- | -------- | ------------- | -------------------------------- |
| `dest`            | `string` | `'./uploads'` | Directory to save uploaded files |
| `limits.fileSize` | `number` | —             | Max file size in bytes           |
| `limits.files`    | `number` | —             | Max number of files              |
| `limits.fields`   | `number` | —             | Max number of text fields        |

---

### Static files — `serveStatic(directory, options?)`

```typescript
import { join } from 'node:path'

app.use('/public', serveStatic(join(import.meta.dirname, 'public')))
```

| Option     | Type                            | Default    | Description                               |
| ---------- | ------------------------------- | ---------- | ----------------------------------------- |
| `index`    | `boolean \| string`             | `true`     | Serve `index.html` for directory requests |
| `maxAge`   | `number`                        | `0`        | `Cache-Control: max-age` in seconds       |
| `etag`     | `boolean`                       | `true`     | Enable ETag header                        |
| `dotfiles` | `'allow' \| 'deny' \| 'ignore'` | `'ignore'` | Handling of dotfiles                      |

---

## Sub-routers & mount

```typescript
const users = hyperin()

users.get('/', async () => ({ users: [] }))
users.get('/:id', async ({ request }) => ({ id: request.params.id }))
users.post('/', async ({ request }) => ({ created: request.body }))

// mount under /users
app.mount('/users', users)
```

---

## Full example

```typescript
import hyperin from 'hyperin'
import { join } from 'node:path'
import {
  cors,
  json,
  multipart,
  serveStatic,
  urlencoded
} from 'hyperin/middleware'

const app = hyperin()

// ── Middlewares ──────────────────────────────────────────────
app.use(cors({ origin: '*' }))
app.use(json())
app.use(urlencoded({ extended: true }))
app.use(
  multipart({
    dest: join(import.meta.dirname, 'uploads'),
    limits: { fileSize: 5 * 1024 * 1024 }
  })
)

// ── Logger ───────────────────────────────────────────────────
app.use(async ({ request, next }) => {
  const start = Date.now()
  await next()
  console.log(`${request.method} ${request.path} — ${Date.now() - start}ms`)
})

// ── Error handler ────────────────────────────────────────────
app.use(async ({ error, response }) => {
  const status = (error as any).statusCode ?? 500
  response.status(status).json({ error: error.message })
})

// ── Routes ───────────────────────────────────────────────────
app.get('/', async () => ({ message: 'Hello, World!' }))

app.get('/users/:id', async ({ request }) => ({
  id: request.params.id
}))

app
  .route('/items/:id')
  .get(async ({ request }) => ({ id: request.params.id }))
  .put(async ({ request }) => ({ updated: request.params.id }))
  .delete(async ({ request }) => ({ deleted: request.params.id }))

app.post('/upload', async ({ request }) => ({
  fields: request.body,
  files: request.files
}))

app.use('/static', serveStatic(join(import.meta.dirname, 'public')))

// ── Server ───────────────────────────────────────────────────
app.listen(3000, '0.0.0.0', () => {
  console.log('Listening on http://0.0.0.0:3000')
})
```

---

## TypeScript types

```typescript
import type {
  Handler,
  ErrorMiddleware,
  HandlerContext,
  ErrorContext,
  HandlerReturn,
  Request,
  Response,
  HttpMethod
} from 'hyperin'
```

---

## License

MIT
