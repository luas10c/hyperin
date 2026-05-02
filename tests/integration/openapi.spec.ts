import { afterEach, describe, expect, test } from '@jest/globals'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import request from 'supertest'

import hyperin from '#/instance'
import { json, multipart } from '#/middleware'
import {
  apiKeyAuth,
  basicAuth,
  bearerAuth,
  clearOpenAPIRegistry,
  cookieAuth,
  model,
  oauth2Auth,
  openapi
} from '#/openapi'

function stringSchema() {
  return {
    '~standard': {
      validate(value: unknown) {
        return typeof value === 'string'
          ? { value }
          : { issues: [{ message: 'Expected string' }] }
      },
      jsonSchema: {
        input(options?: { target: string }) {
          void options
          return { type: 'string' }
        }
      }
    }
  }
}

function optionalStringSchema() {
  return {
    '~standard': {
      validate(value: unknown) {
        return value === undefined || typeof value === 'string'
          ? { value }
          : { issues: [{ message: 'Expected string' }] }
      },
      jsonSchema: {
        input(options?: { target: string }) {
          void options
          return { type: 'string' }
        }
      }
    }
  }
}

function numberSchema() {
  return {
    '~standard': {
      validate(value: unknown) {
        const parsed = Number(value)
        return Number.isFinite(parsed)
          ? { value: parsed }
          : { issues: [{ message: 'Expected number' }] }
      },
      jsonSchema: {
        input(options?: { target: string }) {
          void options
          return { type: 'number' }
        }
      }
    }
  }
}

function draft07OnlyObjectSchema(
  inputProperties: Record<string, Record<string, unknown>>,
  required: string[],
  outputProperties: Record<string, Record<string, unknown>> = inputProperties,
  outputRequired: string[] = required
) {
  return {
    '~standard': {
      version: 1 as const,
      vendor: 'test-draft07-only',
      validate(value: unknown) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
          return { issues: [{ message: 'Expected object' }] }
        }

        return { value }
      },
      jsonSchema: {
        input(options: { target: string }) {
          if (options.target !== 'draft-07') {
            throw new Error(`Unsupported target: ${options.target}`)
          }

          return {
            type: 'object',
            properties: inputProperties,
            required,
            additionalProperties: false
          }
        },
        output(options: { target: string }) {
          if (options.target !== 'draft-07') {
            throw new Error(`Unsupported target: ${options.target}`)
          }

          return {
            type: 'object',
            properties: outputProperties,
            required: outputRequired,
            additionalProperties: false
          }
        }
      }
    }
  }
}

type TestSchema =
  | ReturnType<typeof stringSchema>
  | ReturnType<typeof optionalStringSchema>
  | ReturnType<typeof numberSchema>

function objectSchema(
  properties: Record<string, TestSchema>,
  required: string[]
) {
  return {
    '~standard': {
      validate(value: unknown) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
          return { issues: [{ message: 'Expected object' }] }
        }

        const input = value as Record<string, unknown>
        const output: Record<string, unknown> = {}
        const issues: unknown[] = []

        for (const key of required) {
          if (!(key in input)) {
            issues.push({ message: `Missing ${key}` })
          }
        }

        for (const [key, schema] of Object.entries(properties)) {
          const result = schema['~standard'].validate(input[key])
          if (Array.isArray(result.issues)) {
            if (required.includes(key) || input[key] !== undefined) {
              issues.push(...result.issues)
            }
            continue
          }

          if (result.value !== undefined) {
            output[key] = result.value
          }
        }

        return issues.length > 0 ? { issues } : { value: output }
      },
      jsonSchema: {
        input(options?: { target: string }) {
          void options
          const jsonProperties = Object.fromEntries(
            Object.entries(properties).map(([key, schema]) => [
              key,
              schema['~standard'].jsonSchema.input({ target: 'draft-2020-12' })
            ])
          )

          return {
            type: 'object',
            properties: jsonProperties,
            required
          }
        }
      }
    }
  }
}

describe('OpenAPI integration', () => {
  afterEach(() => {
    clearOpenAPIRegistry()
  })

  test('derives route contract validation and documentation', async () => {
    const app = hyperin()
    const createUserBody = objectSchema(
      {
        email: stringSchema(),
        password: stringSchema()
      },
      ['email', 'password']
    )
    const createUserQuery = objectSchema({ invite: optionalStringSchema() }, [])
    const createUserParams = objectSchema({ id: numberSchema() as never }, [
      'id'
    ])
    const createUserResponse = objectSchema({ email: stringSchema() }, [
      'email'
    ])

    app.use(json())

    app.post(
      '/users/:id',
      ({ request, response }) => {
        response.status(201)
        return {
          id: request.params.id,
          invite: request.query.invite,
          email: request.body.email
        }
      },
      {
        summary: 'Create user',
        params: createUserParams,
        query: createUserQuery,
        body: createUserBody,
        responses: {
          201: {
            description: 'User created',
            content: {
              'application/json': {
                schema: createUserResponse
              }
            }
          }
        }
      }
    )

    openapi(app)

    const routeResponse = await request(app)
      .post('/users/12?invite=yes')
      .send({ email: 'john@example.com', password: 'secret123' })

    expect(routeResponse.status).toBe(201)
    expect(routeResponse.body).toEqual({
      id: 12,
      invite: 'yes',
      email: 'john@example.com'
    })

    const documentResponse = await request(app).get('/openapi.json')
    const operation = documentResponse.body.paths['/users/{id}'].post

    expect(documentResponse.status).toBe(200)
    expect(documentResponse.body.paths['/users/:id']).toBeUndefined()
    expect(operation.summary).toBe('Create user')
    expect(operation.parameters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'id', in: 'path' }),
        expect.objectContaining({ name: 'invite', in: 'query' })
      ])
    )
    expect(operation.requestBody.content['application/json'].schema).toEqual({
      type: 'object',
      properties: {
        email: { type: 'string' },
        password: { type: 'string' }
      },
      required: ['email', 'password']
    })
    expect(operation.responses['201'].description).toBe('User created')
  })

  test('exposes the document at a custom path', async () => {
    const app = hyperin()

    app.get('/health', () => ({ ok: true }))

    openapi(app, {
      path: '/docs/openapi.json',
      documentation: {
        info: {
          title: 'API',
          version: '1.0.0'
        }
      }
    })

    const customPathResponse = await request(app).get('/docs/openapi.json')
    const defaultPathResponse = await request(app).get('/openapi.json')

    expect(customPathResponse.status).toBe(200)
    expect(customPathResponse.body.$schema).toBe(
      'https://spec.openapis.org/oas/3.1/schema-base/2025-09-15'
    )
    expect(customPathResponse.body.openapi).toBe('3.1.1')
    expect(customPathResponse.body.info).toEqual({
      title: 'API',
      version: '1.0.0'
    })
    expect(defaultPathResponse.status).toBe(404)
  })

  test('consumes the generated file without regenerating on request', async () => {
    const app = hyperin()
    const directory = await mkdtemp(join(tmpdir(), 'hyperin-openapi-'))
    const file = join(directory, 'openapi.json')
    const persistedDocument = {
      $schema: 'https://spec.openapis.org/oas/3.1/schema-base/2025-09-15',
      openapi: '3.1.1',
      info: {
        title: 'Persisted API',
        version: '1.0.0'
      },
      paths: {
        '/persisted': {
          get: {
            responses: {
              200: {
                description: 'ok'
              }
            }
          }
        }
      }
    }

    await writeFile(
      file,
      `${JSON.stringify(persistedDocument, null, 2)}\n`,
      'utf8'
    )

    app.get('/runtime', () => ({ ok: true }))

    openapi(app, {
      path: '/docs/openapi.json',
      file,
      documentation: {
        info: {
          title: 'Runtime API',
          version: '2.0.0'
        }
      }
    })

    const firstResponse = await request(app).get('/docs/openapi.json')
    const secondResponse = await request(app).get('/docs/openapi.json')
    const fileContent = JSON.parse(await readFile(file, 'utf8')) as Record<
      string,
      unknown
    >

    expect(firstResponse.status).toBe(200)
    expect(firstResponse.body).toEqual(persistedDocument)
    expect(secondResponse.body).toEqual(persistedDocument)
    expect(fileContent).toEqual(persistedDocument)

    await rm(directory, { recursive: true, force: true })
  })

  test('writes the generated document to file on first request when no file exists', async () => {
    const app = hyperin()
    const directory = await mkdtemp(join(tmpdir(), 'hyperin-openapi-'))
    const file = join(directory, 'openapi.json')

    app.get('/runtime', () => ({ ok: true }))

    openapi(app, {
      file,
      documentation: {
        info: {
          title: 'Runtime API',
          version: '2.0.0'
        }
      }
    })

    try {
      const response = await request(app).get('/openapi.json')
      const fileContent = JSON.parse(await readFile(file, 'utf8')) as Record<
        string,
        unknown
      >

      expect(response.status).toBe(200)
      expect(fileContent).toEqual(response.body)
      expect(response.body.info).toEqual({
        title: 'Runtime API',
        version: '2.0.0'
      })
      expect(response.body.paths).toEqual(expect.any(Object))
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('returns validation issues in the errors format', async () => {
    const app = hyperin()

    app.use(json())

    app.post('/', () => ({ ok: true }), {
      body: {
        '~standard': {
          validate(value: unknown) {
            if (!value || typeof value !== 'object' || Array.isArray(value)) {
              return { issues: [{ message: 'Expected object' }] }
            }

            const input = value as Record<string, unknown>
            if (typeof input.password !== 'string') {
              return {
                issues: [
                  {
                    expected: 'string',
                    code: 'invalid_type',
                    path: ['password'],
                    message: 'Invalid input: expected string, received null'
                  }
                ]
              }
            }

            return { value: input }
          },
          jsonSchema: {
            input() {
              return {
                type: 'object',
                properties: {
                  password: { type: 'string' }
                },
                required: ['password']
              }
            }
          }
        }
      },
      responses: {
        201: {
          description: 'Created'
        }
      }
    })

    const response = await request(app).post('/').send({ password: null })

    expect(response.status).toBe(422)
    expect(response.body).toEqual({
      errors: [
        {
          expected: 'string',
          code: 'invalid_type',
          path: ['password'],
          message: 'Invalid input: expected string, received null'
        }
      ]
    })
  })

  test('documents standard schema with draft-07 fallback and outputs for responses', async () => {
    const app = hyperin()
    const createUserBody = draft07OnlyObjectSchema(
      {
        email: { type: 'string', format: 'email' },
        password: { type: 'string', minLength: 8 }
      },
      ['email', 'password']
    )
    const createUserResponse = draft07OnlyObjectSchema(
      {
        ignored: { type: 'boolean' }
      },
      [],
      {
        id: { type: 'number' },
        email: { type: 'string', format: 'email' }
      },
      ['id', 'email']
    )

    app.use(json())

    app.post(
      '/register',
      ({ response }) => {
        response.status(201)
        return { id: 1, email: 'john@example.com' }
      },
      {
        body: createUserBody,
        responses: {
          201: {
            description: 'Created',
            content: {
              'application/json': {
                schema: createUserResponse
              }
            }
          }
        }
      }
    )

    openapi(app)

    const documentResponse = await request(app).get('/openapi.json')
    const operation = documentResponse.body.paths['/register'].post

    expect(documentResponse.status).toBe(200)
    expect(operation.requestBody.content['application/json'].schema).toEqual({
      type: 'object',
      properties: {
        email: { type: 'string', format: 'email' },
        password: { type: 'string', minLength: 8 }
      },
      required: ['email', 'password'],
      additionalProperties: false
    })
    expect(
      operation.responses['201'].content['application/json'].schema
    ).toEqual({
      type: 'object',
      properties: {
        id: { type: 'number' },
        email: { type: 'string', format: 'email' }
      },
      required: ['id', 'email'],
      additionalProperties: false
    })
  })

  test('documents multipart route bodies as multipart/form-data', async () => {
    const app = hyperin()
    const createUserBody = objectSchema(
      {
        email: stringSchema(),
        password: stringSchema()
      },
      ['email', 'password']
    )

    app.post(
      '/register',
      multipart({
        fields: {
          avatar: {
            kind: 'single',
            description: 'User avatar image',
            mimeTypes: ['image/png', 'image/jpeg']
          },
          gallery: {
            kind: 'array',
            description: 'Optional gallery images',
            required: false
          }
        }
      }),
      () => ({ ok: true }),
      {
        body: createUserBody
      }
    )

    openapi(app)

    const documentResponse = await request(app).get('/openapi.json')
    const operation = documentResponse.body.paths['/register'].post

    expect(documentResponse.status).toBe(200)
    expect(operation.requestBody.content['application/json']).toBeUndefined()
    expect(operation.requestBody.content['multipart/form-data'].schema).toEqual(
      {
        type: 'object',
        properties: {
          email: { type: 'string' },
          password: { type: 'string' },
          avatar: {
            type: 'string',
            description:
              'User avatar image\n\nAccepted MIME types: image/png, image/jpeg.',
            format: 'binary'
          },
          gallery: {
            type: 'array',
            description: 'Optional gallery images',
            items: { type: 'string', format: 'binary' }
          }
        },
        required: ['email', 'password', 'avatar']
      }
    )
    expect(
      operation.requestBody.content['multipart/form-data'].encoding
    ).toEqual({
      email: {
        contentType: 'text/plain'
      },
      password: {
        contentType: 'text/plain'
      },
      avatar: {
        contentType: 'image/png, image/jpeg'
      }
    })
  })

  test('uses mapJsonSchema for vendors without native Standard JSON Schema', async () => {
    const app = hyperin()
    const createUserBody = {
      '~standard': {
        version: 1 as const,
        vendor: 'custom-vendor',
        validate(value: unknown) {
          if (!value || typeof value !== 'object' || Array.isArray(value)) {
            return { issues: [{ message: 'Expected object' }] }
          }

          return { value }
        }
      }
    }

    app.post('/', () => ({ ok: true }), {
      body: createUserBody
    })

    openapi(app, {
      mapJsonSchema: {
        'custom-vendor': () => ({
          type: 'object',
          properties: {
            email: { type: 'string', format: 'email' },
            password: { type: 'string', minLength: 8 }
          },
          required: ['email', 'password']
        })
      }
    })

    const documentResponse = await request(app).get('/openapi.json')
    const operation = documentResponse.body.paths['/'].post

    expect(documentResponse.status).toBe(200)
    expect(operation.requestBody.content['application/json'].schema).toEqual({
      type: 'object',
      properties: {
        email: { type: 'string', format: 'email' },
        password: { type: 'string', minLength: 8 }
      },
      required: ['email', 'password']
    })
  })

  test('isolates route registry and options per app', async () => {
    const appA = hyperin()
    const appB = hyperin()

    appA.get('/a', () => ({ ok: 'a' }), {
      responses: {
        200: {
          description: 'ok'
        }
      }
    })
    appB.get('/b', () => ({ ok: 'b' }), {
      responses: {
        200: {
          description: 'ok'
        }
      }
    })

    openapi(appA, {
      documentation: {
        info: {
          title: 'App A',
          version: '1.0.0'
        }
      }
    })
    openapi(appB, {
      path: '/docs/openapi.json',
      documentation: {
        info: {
          title: 'App B',
          version: '2.0.0'
        }
      }
    })

    const responseA = await request(appA).get('/openapi.json')
    const responseB = await request(appB).get('/docs/openapi.json')

    expect(responseA.status).toBe(200)
    expect(responseA.body.info).toEqual({ title: 'App A', version: '1.0.0' })
    expect(responseA.body.paths['/a']).toBeDefined()
    expect(responseA.body.paths['/b']).toBeUndefined()

    expect(responseB.status).toBe(200)
    expect(responseB.body.info).toEqual({ title: 'App B', version: '2.0.0' })
    expect(responseB.body.paths['/b']).toBeDefined()
    expect(responseB.body.paths['/a']).toBeUndefined()
  })

  test('isolates mapJsonSchema during concurrent document generation', async () => {
    const appA = hyperin()
    const appB = hyperin()
    const schema = {
      '~standard': {
        version: 1 as const,
        vendor: 'custom-vendor',
        validate(value: unknown) {
          if (!value || typeof value !== 'object' || Array.isArray(value)) {
            return { issues: [{ message: 'Expected object' }] }
          }

          return { value }
        }
      }
    }

    appA.post('/', () => ({ ok: true }), { body: schema })
    appB.post('/', () => ({ ok: true }), { body: schema })

    openapi(appA, {
      mapJsonSchema: {
        'custom-vendor': () =>
          ({
            type: 'object',
            properties: { email: { type: 'string' } },
            required: ['email']
          }) as Record<string, unknown>
      }
    })
    openapi(appB, {
      path: '/docs/openapi.json',
      mapJsonSchema: {
        'custom-vendor': () =>
          ({
            type: 'object',
            properties: { age: { type: 'number' } },
            required: ['age']
          }) as Record<string, unknown>
      }
    })

    const [responseA, responseB] = await Promise.all([
      request(appA).get('/openapi.json'),
      request(appB).get('/docs/openapi.json')
    ])

    expect(
      responseA.body.paths['/'].post.requestBody.content['application/json']
        .schema
    ).toEqual({
      type: 'object',
      properties: { email: { type: 'string' } },
      required: ['email']
    })
    expect(
      responseB.body.paths['/'].post.requestBody.content['application/json']
        .schema
    ).toEqual({
      type: 'object',
      properties: { age: { type: 'number' } },
      required: ['age']
    })
  })

  test('isolates named models per app', async () => {
    const appA = hyperin()
    const appB = hyperin()

    appA.use(
      model({
        User: {
          type: 'object',
          properties: { email: { type: 'string' } },
          required: ['email']
        }
      })
    )
    appB.use(
      model({
        User: {
          type: 'object',
          properties: { age: { type: 'number' } },
          required: ['age']
        }
      })
    )

    appA.get('/users', () => ({ ok: true }), {
      responses: {
        200: {
          description: 'ok',
          schema: 'User'
        }
      }
    })
    appB.get('/users', () => ({ ok: true }), {
      responses: {
        200: {
          description: 'ok',
          schema: 'User'
        }
      }
    })

    openapi(appA)
    openapi(appB, { path: '/docs/openapi.json' })

    const [responseA, responseB] = await Promise.all([
      request(appA).get('/openapi.json'),
      request(appB).get('/docs/openapi.json')
    ])

    expect(
      responseA.body.paths['/users'].get.responses['200'].content[
        'application/json'
      ].schema
    ).toEqual({
      type: 'object',
      properties: { email: { type: 'string' } },
      required: ['email']
    })
    expect(
      responseB.body.paths['/users'].get.responses['200'].content[
        'application/json'
      ].schema
    ).toEqual({
      type: 'object',
      properties: { age: { type: 'number' } },
      required: ['age']
    })
    expect(responseA.body.components).toBeUndefined()
    expect(responseB.body.components).toBeUndefined()
  })

  test('emits reusable schemas and references named models when components are enabled', async () => {
    const app = hyperin()

    app.use(
      model({
        User: {
          type: 'object',
          properties: { email: { type: 'string' } },
          required: ['email']
        }
      })
    )

    app.get('/users/:id', () => ({ ok: true }), {
      params: objectSchema({ id: stringSchema() }, ['id']),
      responses: {
        200: {
          description: 'ok',
          schema: 'User'
        }
      }
    })

    openapi(app, { components: true })

    const response = await request(app).get('/openapi.json')
    const operation = response.body.paths['/users/{id}'].get

    expect(response.status).toBe(200)
    expect(response.body.paths['/users/:id']).toBeUndefined()
    expect(response.body.components.schemas.User).toEqual({
      type: 'object',
      properties: { email: { type: 'string' } },
      required: ['email']
    })
    expect(
      operation.responses['200'].content['application/json'].schema
    ).toEqual({
      $ref: '#/components/schemas/User'
    })
    expect(operation.parameters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'id', in: 'path', required: true })
      ])
    )
  })

  test('extracts inline operation schemas into components when components are enabled', async () => {
    const app = hyperin()

    app.post('/users', () => ({ ok: true }), {
      body: objectSchema({ email: stringSchema() }, ['email']),
      responses: {
        201: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: { id: { type: 'number' } },
                required: ['id']
              }
            }
          }
        }
      }
    })

    openapi(app, { components: true })

    const response = await request(app).get('/openapi.json')
    const operation = response.body.paths['/users'].post

    expect(response.status).toBe(200)
    expect(
      response.body.components.schemas.PostUsersRequestBodyApplicationJson
    ).toEqual({
      type: 'object',
      properties: { email: { type: 'string' } },
      required: ['email']
    })
    expect(
      response.body.components.schemas.PostUsersResponse201ApplicationJson
    ).toEqual({
      type: 'object',
      properties: { id: { type: 'number' } },
      required: ['id']
    })
    expect(operation.requestBody.content['application/json'].schema).toEqual({
      $ref: '#/components/schemas/PostUsersRequestBodyApplicationJson'
    })
    expect(
      operation.responses['201'].content['application/json'].schema
    ).toEqual({
      $ref: '#/components/schemas/PostUsersResponse201ApplicationJson'
    })
  })

  test('documents path parameters from route path when no params schema is provided', async () => {
    const app = hyperin()

    app.get('/users/:id/posts/:postId', () => ({ ok: true }), {
      responses: {
        200: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: { ok: { type: 'boolean' } }
              }
            }
          }
        }
      }
    })

    openapi(app)

    const response = await request(app).get('/openapi.json')
    const operation = response.body.paths['/users/{id}/posts/{postId}'].get

    expect(response.status).toBe(200)
    expect(operation.parameters).toEqual([
      {
        name: 'id',
        in: 'path',
        required: true,
        schema: { type: 'string' }
      },
      {
        name: 'postId',
        in: 'path',
        required: true,
        schema: { type: 'string' }
      }
    ])
  })

  test('generates stable operation ids when omitted', async () => {
    const app = hyperin()

    app.get('/users/:id/posts', () => ({ ok: true }), {
      responses: {
        200: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: { ok: { type: 'boolean' } }
              }
            }
          }
        }
      }
    })
    app.post('/users/:id/posts', () => ({ ok: true }), {
      operationId: 'createUserPost',
      responses: {
        201: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: { ok: { type: 'boolean' } }
              }
            }
          }
        }
      }
    })

    openapi(app)

    const response = await request(app).get('/openapi.json')

    expect(response.status).toBe(200)
    expect(response.body.paths['/users/{id}/posts'].get.operationId).toBe(
      'getUsersByIdPosts'
    )
    expect(response.body.paths['/users/{id}/posts'].post.operationId).toBe(
      'createUserPost'
    )
  })

  test('emits top-level webhooks with operation defaults', async () => {
    const app = hyperin()

    app.get('/users/:id', () => ({ ok: true }), {
      responses: {
        200: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: { ok: { type: 'boolean' } }
              }
            }
          }
        }
      }
    })

    openapi(app, {
      documentation: {
        security: [{ bearerAuth: [] }],
        webhooks: {
          userCreated: {
            post: {
              requestBody: {
                content: {
                  'application/json': {
                    schema: {
                      type: 'object',
                      properties: { id: { type: 'string' } },
                      required: ['id']
                    }
                  }
                }
              },
              responses: {
                200: {
                  description: 'Webhook received'
                }
              }
            }
          }
        }
      }
    })

    const response = await request(app).get('/openapi.json')

    expect(response.status).toBe(200)
    expect(response.body.webhooks.userCreated.post.operationId).toBe(
      'postUserCreated'
    )
    expect(response.body.webhooks.userCreated.post.security).toEqual([
      { bearerAuth: [] }
    ])
    expect(response.body.webhooks.userCreated.post.responses['200']).toEqual({
      description: 'Webhook received'
    })
  })

  test('emits top-level tags from documentation options', async () => {
    const app = hyperin()

    app.get('/users', () => ({ ok: true }), {
      tags: ['Users']
    })

    openapi(app, {
      documentation: {
        tags: [
          {
            name: 'Users',
            description: 'User management endpoints'
          }
        ]
      }
    })

    const response = await request(app).get('/openapi.json')

    expect(response.status).toBe(200)
    expect(response.body.tags).toEqual([
      {
        name: 'Users',
        description: 'User management endpoints'
      }
    ])
  })

  test('emits documented security schemes and operation security', async () => {
    const app = hyperin()

    app.get('/users', () => ({ ok: true }), {
      security: [{ bearerAuth: [] }],
      responses: {
        200: {
          description: 'ok'
        }
      }
    })

    openapi(app, {
      documentation: {
        security: [{ apiKeyAuth: [] }],
        externalDocs: {
          description: 'Authentication guide',
          url: 'https://example.com/auth'
        },
        components: {
          securitySchemes: {
            bearerAuth: bearerAuth({ bearerFormat: 'JWT' }),
            basicAuth: basicAuth(),
            apiKeyAuth: apiKeyAuth(),
            cookieAuth: cookieAuth('session'),
            oauth2Auth: oauth2Auth({
              authorizationCode: {
                authorizationUrl: 'https://example.com/oauth/authorize',
                tokenUrl: 'https://example.com/oauth/token',
                scopes: {
                  read: 'Read access'
                }
              }
            })
          }
        }
      }
    })

    const response = await request(app).get('/openapi.json')

    expect(response.status).toBe(200)
    expect(response.body.security).toEqual([{ apiKeyAuth: [] }])
    expect(response.body.externalDocs).toEqual({
      description: 'Authentication guide',
      url: 'https://example.com/auth'
    })
    expect(response.body.components.securitySchemes).toEqual({
      bearerAuth: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT'
      },
      apiKeyAuth: {
        type: 'apiKey',
        name: 'x-api-key',
        in: 'header'
      },
      basicAuth: {
        type: 'http',
        scheme: 'basic'
      },
      cookieAuth: {
        type: 'apiKey',
        name: 'session',
        in: 'cookie'
      },
      oauth2Auth: {
        type: 'oauth2',
        flows: {
          authorizationCode: {
            authorizationUrl: 'https://example.com/oauth/authorize',
            tokenUrl: 'https://example.com/oauth/token',
            scopes: {
              read: 'Read access'
            }
          }
        }
      }
    })
    expect(response.body.paths['/users'].get.security).toEqual([
      { bearerAuth: [] }
    ])
  })

  test('shares global security with operations unless overridden', async () => {
    const app = hyperin()

    app.get('/private', () => ({ ok: true }), {
      responses: {
        200: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: { ok: { type: 'boolean' } }
              }
            }
          }
        }
      }
    })
    app.get('/public', () => ({ ok: true }), {
      security: [],
      responses: {
        200: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: { ok: { type: 'boolean' } }
              }
            }
          }
        }
      }
    })

    openapi(app, {
      documentation: {
        components: {
          securitySchemes: {
            bearerAuth: {
              type: 'http',
              scheme: 'bearer'
            }
          }
        },
        security: [{ bearerAuth: [] }]
      }
    })

    const response = await request(app).get('/openapi.json')

    expect(response.status).toBe(200)
    expect(response.body.security).toEqual([{ bearerAuth: [] }])
    expect(response.body.paths['/private'].get.security).toEqual([
      { bearerAuth: [] }
    ])
    expect(response.body.paths['/public'].get.security).toEqual([])
  })

  test('documents route headers and cookies as parameters', async () => {
    const app = hyperin()

    app.get('/profile', () => ({ ok: true }), {
      headers: {
        type: 'object',
        properties: {
          'x-request-id': { type: 'string' },
          'accept-language': { type: 'string' }
        },
        required: ['x-request-id']
      },
      cookies: {
        type: 'object',
        properties: {
          locale: { type: 'string' },
          session: { type: 'string' }
        },
        required: ['session']
      },
      responses: {
        200: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: { ok: { type: 'boolean' } }
              }
            }
          }
        }
      }
    })

    openapi(app)

    const response = await request(app).get('/openapi.json')
    const operation = response.body.paths['/profile'].get

    expect(response.status).toBe(200)
    expect(operation.parameters).toEqual(
      expect.arrayContaining([
        {
          name: 'x-request-id',
          in: 'header',
          required: true,
          schema: { type: 'string' }
        },
        {
          name: 'accept-language',
          in: 'header',
          required: false,
          schema: { type: 'string' }
        },
        {
          name: 'locale',
          in: 'cookie',
          required: false,
          schema: { type: 'string' }
        },
        {
          name: 'session',
          in: 'cookie',
          required: true,
          schema: { type: 'string' }
        }
      ])
    )
  })

  test('emits documented reusable components', async () => {
    const app = hyperin()

    app.get('/users/:id', () => ({ ok: true }), {
      callbacks: {
        userUpdated: {
          '{$request.body#/callbackUrl}': {
            post: {
              responses: {
                200: {
                  description: 'Callback accepted'
                }
              }
            }
          }
        }
      },
      responses: {
        200: {
          description: 'ok'
        }
      }
    })

    openapi(app, {
      documentation: {
        components: {
          responses: {
            NotFound: {
              description: 'Not found'
            }
          },
          parameters: {
            UserId: {
              name: 'id',
              in: 'path',
              required: true,
              schema: { type: 'string' }
            }
          },
          examples: {
            UserExample: {
              value: { id: '1' }
            }
          },
          requestBodies: {
            UserInput: {
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: { email: { type: 'string' } }
                  }
                }
              }
            }
          },
          headers: {
            TraceId: {
              schema: { type: 'string' },
              description: 'Trace id'
            }
          },
          links: {
            GetUserById: {
              operationId: 'getUsersById',
              parameters: { id: '$response.body#/id' }
            }
          },
          callbacks: {
            UserUpdated: {
              '{$request.body#/callbackUrl}': {
                post: {
                  responses: {
                    200: {
                      description: 'Callback accepted'
                    }
                  }
                }
              }
            }
          },
          pathItems: {
            UserPath: {
              get: {
                responses: {
                  200: {
                    description: 'ok'
                  }
                }
              }
            }
          }
        }
      }
    })

    const response = await request(app).get('/openapi.json')

    expect(response.status).toBe(200)
    expect(response.body.components.responses.NotFound.description).toBe(
      'Not found'
    )
    expect(response.body.components.parameters.UserId.in).toBe('path')
    expect(response.body.components.examples.UserExample.value).toEqual({
      id: '1'
    })
    expect(
      response.body.components.requestBodies.UserInput.content[
        'application/json'
      ].schema.properties.email
    ).toEqual({ type: 'string' })
    expect(response.body.components.headers.TraceId.description).toBe(
      'Trace id'
    )
    expect(response.body.components.links.GetUserById.operationId).toBe(
      'getUsersById'
    )
    expect(
      response.body.components.callbacks.UserUpdated[
        '{$request.body#/callbackUrl}'
      ].post.responses['200'].description
    ).toBe('Callback accepted')
    expect(
      response.body.components.pathItems.UserPath.get.responses['200']
        .description
    ).toBe('ok')
    expect(
      response.body.paths['/users/{id}'].get.callbacks.userUpdated[
        '{$request.body#/callbackUrl}'
      ].post.responses['200'].description
    ).toBe('Callback accepted')
  })

  test('preserves media type examples and encoding metadata', async () => {
    const app = hyperin()

    app.post('/users', () => ({ ok: true }), {
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: { email: { type: 'string' } },
              required: ['email']
            },
            example: { email: 'john@example.com' },
            examples: {
              default: {
                summary: 'Default user',
                value: { email: 'john@example.com' }
              }
            }
          },
          'multipart/form-data': {
            schema: {
              type: 'object',
              properties: { avatar: { type: 'string', format: 'binary' } }
            },
            encoding: {
              avatar: {
                contentType: 'image/png',
                style: 'form',
                explode: true,
                allowReserved: false
              }
            }
          }
        }
      },
      responses: {
        201: {
          description: 'Created',
          content: {
            'application/json': {
              'schema': {
                type: 'object',
                properties: { id: { type: 'number' } },
                required: ['id']
              },
              'example': { id: 1 },
              'examples': {
                created: {
                  summary: 'Created user',
                  value: { id: 1 }
                }
              },
              'x-example-id': 'created-user'
            }
          },
          links: {
            GetUserById: {
              operationId: 'getUser',
              parameters: { id: '$response.body#/id' }
            }
          }
        }
      }
    })

    openapi(app)

    const response = await request(app).get('/openapi.json')
    const operation = response.body.paths['/users'].post

    expect(response.status).toBe(200)
    expect(operation.requestBody.content['application/json'].example).toEqual({
      email: 'john@example.com'
    })
    expect(
      operation.requestBody.content['application/json'].examples.default
    ).toEqual({
      summary: 'Default user',
      value: { email: 'john@example.com' }
    })
    expect(
      operation.requestBody.content['multipart/form-data'].encoding.avatar
    ).toEqual({
      contentType: 'image/png',
      style: 'form',
      explode: true,
      allowReserved: false
    })
    expect(
      operation.responses['201'].content['application/json'].example
    ).toEqual({ id: 1 })
    expect(
      operation.responses['201'].content['application/json'].examples.created
    ).toEqual({
      summary: 'Created user',
      value: { id: 1 }
    })
    expect(
      operation.responses['201'].content['application/json']['x-example-id']
    ).toBe('created-user')
    expect(operation.responses['201'].links.GetUserById).toEqual({
      operationId: 'getUser',
      parameters: { id: '$response.body#/id' }
    })
  })

  test('normalizes any response status alias to default', async () => {
    const app = hyperin()

    app.get('/users', () => ({ ok: true }), {
      responses: {
        any: {
          description: 'Any response'
        }
      }
    })

    openapi(app)

    const response = await request(app).get('/openapi.json')

    expect(response.status).toBe(200)
    expect(response.body.paths['/users'].get.responses.default).toEqual({
      description: 'Any response'
    })
    expect(response.body.paths['/users'].get.responses.any).toBeUndefined()
  })
})
