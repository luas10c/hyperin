import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from '@jest/globals'
import request from 'supertest'

import hyperin from '#/instance'
import { json } from '#/middleware'
import { openapi, clearOpenAPIRegistry } from '#/openapi'

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

describe('openapi integration', () => {
  afterEach(() => {
    clearOpenAPIRegistry()
  })

  test('deriva validacao e documentacao do contrato da rota', async () => {
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
    const operation = documentResponse.body.paths['/users/:id'].post

    expect(documentResponse.status).toBe(200)
    expect(operation.summary).toBe('Create user')
    expect(operation.parameters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'id', in: 'path' }),
        expect.objectContaining({ name: 'invite', in: 'query' })
      ])
    )
    expect(operation.requestBody.content['application/json'].schema.$ref).toBe(
      '#/components/schemas/POSTUsersIdRequestBody'
    )
    expect(operation.responses['201'].description).toBe('User created')
  })

  test('expoe o documento em um path customizado', async () => {
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

  test('consome o arquivo gerado sem regenerar por request', async () => {
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

  test('retorna issues de validacao no formato errors', async () => {
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
})
