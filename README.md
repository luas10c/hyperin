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

## CORS

For public APIs, the default `cors()` configuration is usually fine.

When using cookies or other credentialed cross-origin requests, do not rely on a wildcard origin. Use an explicit allowlist instead.

```ts
import { cors } from 'hyperin/middleware'

app.use(
  cors({
    origin: ['https://app.example.com', 'https://admin.example.com'],
    credentials: true
  })
)
```

Avoid patterns like `cors({ origin: '*', credentials: true })` for private APIs.

## Validation

Route methods accept any number of handlers. When you need validation and documentation, pass the route options object as the last argument.

```ts
import hyperin from 'hyperin'
import { json } from 'hyperin/middleware'
import { z } from 'zod'

const app = hyperin()

app.use(json())

app.post(
  '/login',
  ({ request, response }) => {
    const { email, password } = request.body

    response.status(201)
    return { email, password }
  },
  {
    body: z.object({
      email: z.email(),
      password: z.string().min(6)
    })
  }
)
```

Hyperin also supports Standard Schema, allowing you to use your favorite validation library.

Supported Standard Schema libraries include:

- [Zod](https://zod.dev)
- [Yup](https://github.com/jquense/yup)
- [Valibot](https://valibot.dev)
- [ArkType](https://arktype.io)
- [Effect Schema](https://effect.website/docs/schema/introduction/)
- [Joi](https://joi.dev)
- and more

## OpenAPI

Hyperin can expose an OpenAPI document from the same route schemas.

```ts
import { openapi } from 'hyperin/openapi'

openapi(app, {
  documentation: {
    info: {
      title: 'My API',
      version: '1.0.0'
    }
  }
})
```

By default the document is available at `GET /openapi.json`.

When a Standard Schema implementation exposes JSON Schema, Hyperin uses it directly.
Otherwise, Hyperin falls back to a structural conversion based on the schema shape to keep the documentation working without depending on a specific library.

## Scalar

Hyperin can also expose a Scalar UI for the generated OpenAPI document.

```ts
import { scalar } from 'hyperin/scalar'

scalar(app)
// or
scalar(app, {
  path: '/docs', // default: /docs
  url: '/openapi.json', // default /openapi.json
  configuration: { // configuration is optional
    theme: 'purple',
    layout: 'modern'
  }
})
```

By default, Scalar uses `API Reference` as its title and updates the browser title from `openapi.info.title` when the document is loaded.

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

## Support

Enjoying this framework? Consider supporting the project.

<p>
  <a href="https://buymeacoffee.com/luas10c" target="_blank" rel="noopener noreferrer"><img src="https://github.com/luas10c/hyperin/blob/main/buymeacoffe.png?raw=true" alt="Buy me a coffee" width="180" /></a>
</p>

## License

[MIT](LICENSE)
