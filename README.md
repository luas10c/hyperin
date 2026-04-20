[![Hyperin Logo](https://github.com/luas10c/hyperin/blob/main/hyperin.png?raw=true)](https://github.com/luas10c/hyperin)

Fast, modern, minimalist web framework for Node.js.

Hyperin is built for HTTP APIs and web services with a small surface area, strong defaults, and focus on performance.

## Installation

This is a Node.js module available through the npm registry.

```bash
npm install hyperin
```

## Features

- Fast radix-tree routing
- Middleware pipeline with `next()`
- Built-in helpers for JSON, cookies, compression, CORS, security, multipart, and static files
- Typed request/response primitives
- Express-like app settings API
- Works directly with Node.js HTTP server

## Quick Start

```ts
import hyperin from 'hyperin'
import { json } from 'hyperin/middleware'

const app = hyperin()

app.use(json())

app.get('/', () => {
  return {
    message: 'Hello World'
  }
})

app.post('/users', ({ request, response }) => {
  response.status(201)

  return {
    created: true,
    body: request.body
  }
})

app.listen(3000, () => {
  console.log('Server running at http://localhost:3000')
})
```

## Philosophy

Hyperin aims to provide small, robust HTTP tooling without forcing a heavy architecture.

It should feel familiar if you come from Express, while offering a modern core, built-in middleware, and a more focused API for high-performance Node.js services.

## Basic Usage

```ts
app.get('/health', () => 'ok')

app.get('/users/:id', ({ request }) => {
  return { id: request.params.id }
})

app.use('/api', async ({ next }) => {
  await next()
})

app.disable('x-powered-by')
```

## Built-In Middleware

```ts
import {
  compress,
  cookies,
  cors,
  json,
  logger,
  multipart,
  security,
  serveStatic,
  urlencoded
} from 'hyperin/middleware'
```

## Documentation

Full documentation is being prepared.

For now, the codebase and tests are the best reference for the public API.

## Contributing

```bash
npm install
npm test
npm run build
```

Issues and pull requests are welcome.

## License

[MIT](LICENSE)
