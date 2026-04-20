import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, resolve } from 'node:path'

import type { Application } from './instance'
import { RadixRouter } from './router'
import type { Handler } from './types'

export interface OpenAPISchema {
  $ref?: string
  type?: string | string[]
  format?: string
  minimum?: number
  maximum?: number
  minLength?: number
  maxLength?: number
  pattern?: string
  enum?: unknown[]
  items?: OpenAPISchema
  properties?: Record<string, OpenAPISchema>
  required?: string[]
  default?: unknown
}

export interface OpenAPIHeader {
  schema: OpenAPISchema
  description?: string
}

export interface OpenAPIResponse {
  description: string
  content?: Record<string, { schema: OpenAPISchema }>
  headers?: Record<string, OpenAPIHeader>
}

export interface OpenAPIParameter {
  name: string
  in: 'query' | 'path' | 'header' | 'cookie'
  required?: boolean
  schema: OpenAPISchema
  description?: string
}

export interface OpenAPIRequestBody {
  required?: boolean
  description?: string
  content: Record<string, { schema: OpenAPISchema }>
}

export interface OpenAPIOperation {
  summary?: string
  description?: string
  operationId?: string
  tags?: string[]
  parameters?: OpenAPIParameter[]
  requestBody?: OpenAPIRequestBody
  responses?: Record<string, OpenAPIResponse>
  deprecated?: boolean
}

export interface DescribeOperationResponse {
  description: string
  schema?: unknown
  contentType?: string
  content?: Record<string, { schema: unknown }>
  headers?: Record<string, unknown | { schema: unknown; description?: string }>
}

export interface DescribeOperationInput extends Omit<
  OpenAPIOperation,
  'responses'
> {
  detail?: Omit<OpenAPIOperation, 'responses'> & { hide?: boolean }
  response?: Record<string, DescribeOperationResponse>
  responses?: Record<string, DescribeOperationResponse>
}

export interface WithHeaderOptions {
  description?: string
  contentType?: string
}

export interface OpenAPIDocument {
  $schema: string
  openapi: '3.1.1'
  info: {
    title: string
    version: string
    description?: string
  }
  servers?: Array<{ url: string; description?: string }>
  paths: Record<string, Record<string, OpenAPIOperation>>
  components?: {
    schemas?: Record<string, OpenAPISchema>
  }
}

export interface OpenAPIOptions {
  path?: string
  file?: string
  documentation?: {
    info?: {
      title?: string
      version?: string
      description?: string
    }
    servers?: Array<{ url: string; description?: string }>
  }
  mapJsonSchema?: Record<string, (schema: unknown) => Record<string, unknown>>
}

type RequestSource = 'body' | 'params' | 'query'
type OperationFragment = Partial<OpenAPIOperation>
type OperationMetadata =
  | OperationFragment
  | OpenAPIOperation
  | Promise<OperationFragment | OpenAPIOperation>
type StandardSchemaLike = {
  '~standard'?: {
    vendor?: string
    validate?: (
      value: unknown,
      options?: unknown
    ) =>
      | { value?: unknown; issues?: readonly unknown[] }
      | Promise<{ value?: unknown; issues?: readonly unknown[] }>
    jsonSchema?: {
      input?: (options: { target: string }) => Record<string, unknown>
    }
  }
}
type StoredRoute = {
  path: string
  method: string
  operation?: OpenAPIOperation
  handlers?: Handler[]
}
type OpenAPIPluginTarget = {
  use: Application['use']
}

const routeRegistry = new Map<string, StoredRoute>()
const modelRegistry = new Map<string, OpenAPISchema>()
let currentOptions: OpenAPIOptions = {}

const operationMetadataKey = Symbol.for('hyperin.openapi.operation')
const fragmentMetadataKey = Symbol.for('hyperin.openapi.fragment')
const routerPatchedKey = Symbol.for('hyperin.openapi.router-patched')

function normalizePath(path: string | undefined, fallback: string): string {
  if (!path || path === '') return fallback
  return path.startsWith('/') ? path : `/${path}`
}

function isStandardSchemaLike(schema: unknown): schema is StandardSchemaLike {
  return (
    schema != null &&
    typeof schema === 'object' &&
    typeof (schema as StandardSchemaLike)['~standard'] === 'object'
  )
}

async function acceptsUndefined(schema: unknown): Promise<boolean> {
  if (!isStandardSchemaLike(schema)) return false

  const validate = schema['~standard']?.validate
  if (typeof validate !== 'function') return false

  const result = await validate(undefined)
  if (!result || typeof result !== 'object') return false
  return !Array.isArray((result as { issues?: unknown }).issues)
}

function getMappedJsonSchema(
  schema: StandardSchemaLike
): Record<string, unknown> | null {
  const vendor = schema['~standard']?.vendor
  if (!vendor) return null

  const mapper = currentOptions.mapJsonSchema?.[vendor]
  if (!mapper) return null

  try {
    return mapper(schema)
  } catch {
    return null
  }
}

function getStandardSchemaJsonSchema(
  schema: StandardSchemaLike
): Record<string, unknown> | null {
  const converter = schema['~standard']?.jsonSchema
  if (!converter?.input) return null

  try {
    return converter.input({ target: 'draft-2020-12' })
  } catch {
    try {
      return converter.input({ target: 'openapi-3.0' })
    } catch {
      return null
    }
  }
}

function withNullability(
  schema: OpenAPISchema,
  nullable: boolean
): OpenAPISchema {
  if (!nullable) return schema
  if (!schema.type) return { ...schema, type: ['null'] }
  if (Array.isArray(schema.type)) {
    return schema.type.includes('null')
      ? schema
      : { ...schema, type: [...schema.type, 'null'] }
  }

  return schema.type === 'null'
    ? schema
    : { ...schema, type: [schema.type, 'null'] }
}

export function schemaToOpenAPI(schema: unknown): OpenAPISchema {
  if (typeof schema === 'string') {
    return modelRegistry.has(schema)
      ? cloneSchema(modelRegistry.get(schema) as OpenAPISchema)
      : { type: 'string' }
  }

  if (!schema || typeof schema !== 'object') {
    return { type: 'object' }
  }

  if (isStandardSchemaLike(schema)) {
    const standardJsonSchema = getStandardSchemaJsonSchema(schema)
    if (standardJsonSchema) return jsonSchemaToOpenAPI(standardJsonSchema)

    const mappedJsonSchema = getMappedJsonSchema(schema)
    if (mappedJsonSchema) return jsonSchemaToOpenAPI(mappedJsonSchema)
  }

  return jsonSchemaToOpenAPI(schema as Record<string, unknown>)
}

function jsonSchemaToOpenAPI(schema: Record<string, unknown>): OpenAPISchema {
  if (schema.type === 'object') {
    const rawProperties = schema.properties as
      | Record<string, Record<string, unknown>>
      | undefined
    const properties: Record<string, OpenAPISchema> = {}

    for (const [key, value] of Object.entries(rawProperties ?? {})) {
      properties[key] = jsonSchemaToOpenAPI(value)
    }

    return {
      type: 'object',
      properties,
      ...(Array.isArray(schema.required)
        ? { required: schema.required as string[] }
        : {})
    }
  }

  if (schema.type === 'array') {
    return {
      type: 'array',
      items: schema.items
        ? jsonSchemaToOpenAPI(schema.items as Record<string, unknown>)
        : { type: 'object' }
    }
  }

  return withNullability(
    {
      ...(typeof schema.$ref === 'string' ? { $ref: schema.$ref } : {}),
      ...(typeof schema.type === 'string' || Array.isArray(schema.type)
        ? { type: schema.type as string | string[] }
        : {}),
      ...(typeof schema.format === 'string' ? { format: schema.format } : {}),
      ...(typeof schema.minimum === 'number'
        ? { minimum: schema.minimum }
        : {}),
      ...(typeof schema.maximum === 'number'
        ? { maximum: schema.maximum }
        : {}),
      ...(typeof schema.minLength === 'number'
        ? { minLength: schema.minLength }
        : {}),
      ...(typeof schema.maxLength === 'number'
        ? { maxLength: schema.maxLength }
        : {}),
      ...(typeof schema.pattern === 'string'
        ? { pattern: schema.pattern }
        : {}),
      ...(Array.isArray(schema.enum) ? { enum: schema.enum } : {}),
      ...(schema.default !== undefined ? { default: schema.default } : {})
    },
    schema.nullable === true
  )
}

function buildParameters(
  source: Extract<RequestSource, 'params' | 'query'>,
  schema: OpenAPISchema
): OpenAPIParameter[] {
  const properties = schema.properties ?? {}
  const requiredSet = new Set(schema.required ?? [])

  return Object.entries(properties).map(([name, propertySchema]) => ({
    name,
    in: source === 'params' ? 'path' : 'query',
    required: source === 'params' ? true : requiredSet.has(name),
    schema: propertySchema
  }))
}

export async function createOpenAPIOperationFragment(
  source: RequestSource,
  schema: unknown
): Promise<OperationFragment> {
  const openapiSchema = schemaToOpenAPI(schema)

  if (source === 'body') {
    return {
      requestBody: {
        required: !(await acceptsUndefined(schema)),
        content: {
          'application/json': {
            schema: openapiSchema
          }
        }
      }
    }
  }

  return {
    parameters: buildParameters(source, openapiSchema)
  }
}

function mergeUniqueParameters(
  base: OpenAPIParameter[] = [],
  extra: OpenAPIParameter[] = []
): OpenAPIParameter[] {
  const merged = new Map<string, OpenAPIParameter>()

  for (const parameter of [...base, ...extra]) {
    merged.set(`${parameter.in}:${parameter.name}`, parameter)
  }

  return [...merged.values()]
}

function mergeUniqueTags(base: string[] = [], extra: string[] = []): string[] {
  return [...new Set([...base, ...extra])]
}

function normalizeHeader(
  input: unknown | { schema: unknown; description?: string }
): OpenAPIHeader {
  if (input && typeof input === 'object' && 'schema' in input) {
    return {
      schema: schemaToOpenAPI((input as { schema: unknown }).schema),
      ...(typeof (input as { description?: unknown }).description === 'string'
        ? { description: (input as { description?: string }).description }
        : {})
    }
  }

  return {
    schema: schemaToOpenAPI(input)
  }
}

function normalizeResponse(
  response: DescribeOperationResponse | OpenAPIResponse
): OpenAPIResponse {
  const normalizedContent = response.content
    ? Object.fromEntries(
        Object.entries(response.content).map(([contentType, entry]) => [
          contentType,
          { schema: schemaToOpenAPI(entry.schema) }
        ])
      )
    : undefined

  const normalizedHeaders = response.headers
    ? Object.fromEntries(
        Object.entries(response.headers).map(([name, header]) => [
          name,
          normalizeHeader(header)
        ])
      )
    : undefined

  if ('schema' in response && response.schema !== undefined) {
    const contentType = response.contentType ?? 'application/json'

    return {
      description: response.description,
      ...(normalizedHeaders ? { headers: normalizedHeaders } : {}),
      content: {
        ...(normalizedContent ?? {}),
        [contentType]: {
          schema: schemaToOpenAPI(response.schema)
        }
      }
    }
  }

  return {
    description: response.description,
    ...(normalizedContent ? { content: normalizedContent } : {}),
    ...(normalizedHeaders ? { headers: normalizedHeaders } : {})
  }
}

function normalizeOperation(
  operation: DescribeOperationInput | OpenAPIOperation
): OpenAPIOperation {
  const rawDetail = 'detail' in operation ? operation.detail : undefined
  const response = 'response' in operation ? operation.response : undefined
  const base = { ...operation } as Record<string, unknown>
  const detail = rawDetail
    ? (() => {
        const value = { ...rawDetail } as Record<string, unknown>
        delete value.hide
        return value as Omit<OpenAPIOperation, 'responses'>
      })()
    : undefined

  delete base.detail
  delete base.response

  return {
    ...(detail ?? {}),
    ...(base as OpenAPIOperation),
    ...(operation.responses || response
      ? {
          responses: Object.fromEntries(
            Object.entries(operation.responses ?? response ?? {}).map(
              ([status, responseItem]) => [
                status,
                normalizeResponse(responseItem)
              ]
            )
          )
        }
      : {})
  }
}

function mergeResponses(
  current: OpenAPIOperation['responses'] = {},
  extra: OpenAPIOperation['responses'] = {}
): OpenAPIOperation['responses'] {
  const merged: NonNullable<OpenAPIOperation['responses']> = { ...current }

  for (const [status, response] of Object.entries(extra)) {
    const existing = merged[status]

    merged[status] = existing
      ? {
          description: response.description || existing.description,
          ...(existing.content || response.content
            ? {
                content: {
                  ...(existing.content ?? {}),
                  ...(response.content ?? {})
                }
              }
            : {}),
          ...(existing.headers || response.headers
            ? {
                headers: {
                  ...(existing.headers ?? {}),
                  ...(response.headers ?? {})
                }
              }
            : {})
        }
      : response
  }

  return merged
}

function mergeOperation(
  current: OpenAPIOperation | undefined,
  fragment: OperationFragment
): OpenAPIOperation {
  return {
    ...(current ?? {}),
    ...fragment,
    ...(current?.tags || fragment.tags
      ? { tags: mergeUniqueTags(current?.tags, fragment.tags) }
      : {}),
    ...(current?.parameters || fragment.parameters
      ? {
          parameters: mergeUniqueParameters(
            current?.parameters,
            fragment.parameters
          )
        }
      : {}),
    ...(current?.responses || fragment.responses
      ? { responses: mergeResponses(current?.responses, fragment.responses) }
      : {}),
    ...(fragment.requestBody
      ? { requestBody: fragment.requestBody }
      : current?.requestBody
        ? { requestBody: current.requestBody }
        : {})
  }
}

function setHandlerMetadata<T>(
  handler: T,
  key: symbol,
  value: OperationMetadata
): T {
  ;(handler as Record<symbol, unknown>)[key] = value
  return handler
}

export function attachOpenAPIFragmentMetadata<T extends Handler>(
  handler: T,
  fragment: OperationMetadata
): T {
  return setHandlerMetadata(handler, fragmentMetadataKey, fragment)
}

export function describeOperation(operation: DescribeOperationInput): Handler {
  return setHandlerMetadata(
    async ({ next }) => next(),
    operationMetadataKey,
    normalizeOperation(operation)
  )
}

export function model(models: Record<string, unknown>): Handler {
  for (const [name, schema] of Object.entries(models)) {
    modelRegistry.set(name, schemaToOpenAPI(schema))
  }

  return async ({ next }) => next()
}

export function withHeader(
  schema: unknown,
  headers: Record<string, unknown | { schema: unknown; description?: string }>,
  options: WithHeaderOptions = {}
): DescribeOperationResponse {
  return {
    description: options.description ?? 'Successful response',
    schema,
    ...(options.contentType ? { contentType: options.contentType } : {}),
    headers
  }
}

function routeKey(method: string, path: string): string {
  return `${method.toUpperCase()} ${path}`
}

function recordOperation(
  method: string,
  path: string,
  operation: OpenAPIOperation
): void {
  const key = routeKey(method, path)
  const current = routeRegistry.get(key)

  routeRegistry.set(key, {
    method: method.toUpperCase(),
    path,
    operation: mergeOperation(current?.operation, operation),
    handlers: current?.handlers
  })
}

function cloneSchema(schema: OpenAPISchema): OpenAPISchema {
  return JSON.parse(JSON.stringify(schema)) as OpenAPISchema
}

async function extractHandlerOperation(
  handler: Handler
): Promise<OperationFragment> {
  const metadata = handler as unknown as Record<symbol, unknown>
  const operation = (await metadata[operationMetadataKey]) as
    | OpenAPIOperation
    | undefined
  const fragment = (await metadata[fragmentMetadataKey]) as
    | OperationFragment
    | undefined

  if (operation && fragment) {
    return mergeOperation(operation, fragment)
  }

  return operation ?? fragment ?? {}
}

function recordRouteFromHandlers(
  method: string,
  path: string,
  handlers: Handler[]
): void {
  const key = routeKey(method, path)
  const current = routeRegistry.get(key)

  routeRegistry.set(key, {
    method: method.toUpperCase(),
    path,
    operation: current?.operation,
    handlers
  })
}

function patchRouter(): void {
  if ((globalThis as Record<symbol, unknown>)[routerPatchedKey]) return

  const originalAdd = RadixRouter.prototype.add
  RadixRouter.prototype.add = function patchedAdd(method, path, handlers) {
    recordRouteFromHandlers(method, path, handlers)
    originalAdd.call(this, method, path, handlers)
  }
  ;(globalThis as Record<symbol, unknown>)[routerPatchedKey] = true
}

patchRouter()

async function resolveRouteOperation(
  route: StoredRoute
): Promise<OpenAPIOperation | undefined> {
  let operation = route.operation

  for (const handler of route.handlers ?? []) {
    const fragment = await extractHandlerOperation(handler)
    if (Object.keys(fragment).length === 0) continue
    operation = mergeOperation(operation, fragment)
  }

  return operation
}

export async function getOpenAPIDocument(): Promise<OpenAPIDocument> {
  const paths: OpenAPIDocument['paths'] = {}

  for (const route of routeRegistry.values()) {
    const operation = await resolveRouteOperation(route)
    if (!operation) continue

    const pathItem = (paths[route.path] ??= {})
    pathItem[route.method.toLowerCase()] = operation
  }

  return {
    $schema: 'https://spec.openapis.org/oas/3.1/schema-base/2025-09-15',
    openapi: '3.1.1',
    info: {
      title: currentOptions.documentation?.info?.title ?? 'API',
      version: currentOptions.documentation?.info?.version ?? '1.0.0',
      ...(currentOptions.documentation?.info?.description
        ? { description: currentOptions.documentation.info.description }
        : {})
    },
    ...(currentOptions.documentation?.servers
      ? { servers: currentOptions.documentation.servers }
      : {}),
    paths
  }
}

export function clearOpenAPIRegistry(): void {
  routeRegistry.clear()
  modelRegistry.clear()
}

async function writeOpenAPIFile(
  file: string,
  document: OpenAPIDocument
): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, `${JSON.stringify(document, null, 2)}\n`, 'utf8')
}

function resolveOpenAPIFilePath(file: string): string {
  if (isAbsolute(file)) return file

  const entrypoint = process.argv[1]
  const baseDir = entrypoint ? dirname(resolve(entrypoint)) : process.cwd()
  return resolve(baseDir, file)
}

async function fileExists(file: string): Promise<boolean> {
  try {
    await access(file)
    return true
  } catch {
    return false
  }
}

async function loadOpenAPIFile(file: string): Promise<OpenAPIDocument> {
  return JSON.parse(await readFile(file, 'utf8')) as OpenAPIDocument
}

async function loadOrCreateOpenAPIFile(file: string): Promise<OpenAPIDocument> {
  if (await fileExists(file)) {
    return loadOpenAPIFile(file)
  }

  const document = await getOpenAPIDocument()
  await writeOpenAPIFile(file, document)
  return document
}

function createOpenAPIMiddleware(options: OpenAPIOptions = {}): Handler {
  currentOptions = options
  const specPath = normalizePath(options.path, '/openapi.json')
  const filePath = options.file ? resolveOpenAPIFilePath(options.file) : null
  let persistedDocumentPromise: Promise<OpenAPIDocument> | null = null

  return async ({ request, response, next }) => {
    if (request.path === specPath) {
      const document = filePath
        ? await (persistedDocumentPromise ??= loadOrCreateOpenAPIFile(filePath))
        : await getOpenAPIDocument()

      response.json(document)
      return
    }

    await next()

    const operation = request.locals.openapi as OpenAPIOperation | undefined
    if (!operation || !request.method) return

    recordOperation(request.method, request.path, operation)
  }
}

export function openapi<TApp extends OpenAPIPluginTarget>(
  app: TApp,
  options: OpenAPIOptions = {}
): TApp {
  ;(app.use as unknown as (handler: Handler) => unknown)(
    createOpenAPIMiddleware(options)
  )
  return app
}
