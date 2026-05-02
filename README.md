<br>
<div align="center">
  <img src="https://github.com/luas10c/hyperin/blob/main/hyperin.png?raw=true" alt="Hyperin">
</div>
<p align="center">Fast, modern, minimalist web framework for Node.js.</p>
<div align="center">
  <a href="https://npm.im/hyperin"><img src="https://badgen.net/npm/v/hyperin"></a>
  <a href="https://npm.im/hyperin"><img src="https://badgen.net/npm/dm/hyperin"></a>
  <a href="https://npm.im/hyperin"><img src="https://img.shields.io/badge/ESLint-3A33D1?logo=eslint" alt="eslint"></a>
  <a href="https://npm.im/hyperin"><img src="https://img.shields.io/badge/Prettier-21323b?logo=prettier&logoColor=ffffff" alt="prettier"></a>
  <a href="https://npm.im/hyperin"><img src="https://img.shields.io/github/license/luas10c/hyperin" alt="github license"></a>
</div>
<br><br>
Hyperin is lightweight HTTP tooling for high-performance Node.js services, combining an Express-like feel with a modern, focused core.

## Installation

This is a Node.js module available through the npm registry.

```bash
npm install hyperin
```

## Features

- Fast radix-tree routing
- Middleware pipeline with `next()`
- Built-in JSON, cookies, compression, CORS, security, multipart, and static file helpers
- Typed request and response primitives
- Express-like settings API
- OpenAPI and Scalar support

## Quick Start

```ts
import hyperin from 'hyperin'
import { json } from 'hyperin/middleware'

const app = hyperin()

app.use(json())

app.get('/', () => ({ message: 'Hello World' }))

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

## Validation

Route methods accept multiple handlers. Pass the route options object as the last argument to add validation and documentation metadata.

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

## Logger

Use the built-in logger to emit structured events with custom levels, metadata, and async transports.

```ts

import { hyperin } from 'hyperin'
import { createLogger } from 'hyperin/logger'

const app = hyperin()

const logger = createLogger({
  kind: 'audit',
  level: 'info',
  transports: [
    async function ({ event }) {
      console.log(event)
    }
  ]
})

app.get('/', async function () {
  logger.trace('Get all the data.', { })

  return {
    message: 'Hello, World!'
  }
})

app.listen(7000, '0.0.0.0')
```

## OpenAPI

Generate an OpenAPI document from route schemas.

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

The document is available at `GET /openapi.json` by default.

## Scalar

Expose a Scalar UI for the generated OpenAPI document.

```ts
import { scalar } from 'hyperin/scalar'

scalar(app)

scalar(app, {
  path: '/docs',
  url: '/openapi.json',
  configuration: {
    theme: 'purple',
    layout: 'modern'
  }
})
```

## Documentation

Full documentation is being prepared. For now, the codebase and tests are the best reference for the public API.

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
