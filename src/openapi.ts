import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, resolve } from 'node:path'

import type { Application, HttpMethod } from './instance'
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
  [key: string]: unknown
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
  content: Record<
    string,
    {
      schema: OpenAPISchema
      encoding?: Record<string, { contentType: string }>
    }
  >
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
  /**
   * Response description used in the generated OpenAPI operation.
   */
  description?: string

  /**
   * Content type associated with the wrapped response schema.
   */
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
  /**
   * URL path used to serve the generated OpenAPI JSON document.
   *
   * @default '/openapi.json'
   */
  path?: string

  /**
   * Output file path used to persist the generated OpenAPI JSON document.
   * If not defined, the document is kept in memory only.
   *
   * @default undefined
   */
  file?: string

  /**
   * Base document metadata merged into the generated OpenAPI document.
   */
  documentation?: {
    info?: {
      title?: string
      version?: string
      description?: string
    }
    servers?: Array<{ url: string; description?: string }>
  }

  /**
   * Optional schema mappers keyed by constructor name.
   * Useful for custom schema libraries or special-case JSON Schema output.
   */
  mapJsonSchema?: Record<string, (schema: unknown) => Record<string, unknown>>
}

type RequestSource = 'body' | 'params' | 'query'
type OperationFragment = Partial<OpenAPIOperation>
type OpenAPIConversionContext = {
  options?: OpenAPIOptions
  modelRegistry?: Map<string, OpenAPISchema>
}
type OperationMetadata =
  | OperationFragment
  | OpenAPIOperation
  | Promise<OperationFragment | OpenAPIOperation>
  | ((
      context?: OpenAPIConversionContext
    ) =>
      | OperationFragment
      | OpenAPIOperation
      | Promise<OperationFragment | OpenAPIOperation>)
type StandardSchemaLike = {
  '~standard'?: {
    version?: number
    vendor?: string
    validate?: (
      value: unknown,
      options?: unknown
    ) =>
      | { value?: unknown; issues?: readonly unknown[] }
      | Promise<{ value?: unknown; issues?: readonly unknown[] }>
    jsonSchema?: {
      input?: (options: { target: string }) => Record<string, unknown>
      output?: (options: { target: string }) => Record<string, unknown>
    }
  }
}
type SchemaDirection = 'input' | 'output'
type SchemaCapability = 'jsonSchema' | 'describe' | 'structural'
type StoredRoute = {
  path: string
  method: string
  operation?: OpenAPIOperation
  handlers?: Handler[]
}
type SchemaCapabilityAdapter = {
  name: string
  capability: SchemaCapability
  resolve: (
    schema: StandardSchemaLike,
    direction: SchemaDirection,
    context: OpenAPIConversionContext
  ) => OpenAPISchema | null
}
type OpenAPIPluginTarget = {
  use: Application['use']
}
type OpenAPIRegistryState = {
  options: OpenAPIOptions
  routeRegistry: Map<string, StoredRoute>
  modelRegistry: Map<string, OpenAPISchema>
  context: OpenAPIConversionContext
}
type OpenAPICoreLike = {
  getRoutesSnapshot(): [HttpMethod, string, Handler[]][]
  getMiddlewaresSnapshot(): Handler[]
  onRouteRegistered(
    observer: (method: HttpMethod, path: string, handlers: Handler[]) => void
  ): () => void
  onMiddlewareRegistered(observer: (middleware: Handler) => void): () => void
}

const hyperinCoreKey = Symbol.for('hyperin.core')

const operationMetadataKey = Symbol.for('hyperin.openapi.operation')
const fragmentMetadataKey = Symbol.for('hyperin.openapi.fragment')
const modelMetadataKey = Symbol.for('hyperin.openapi.models')
const multipartMiddlewareKey = Symbol.for('hyperin.multipart.middleware')
const multipartFieldsKey = Symbol.for('hyperin.multipart.fields')

function normalizePath(path: string | undefined, fallback: string): string {
  if (!path || path === '') return fallback
  return path.startsWith('/') ? path : `/${path}`
}

function isSchemaLikeValue(value: unknown): value is Record<string, unknown> {
  return (
    (typeof value === 'object' && value != null) || typeof value === 'function'
  )
}

function isStandardSchemaLike(schema: unknown): schema is StandardSchemaLike {
  return (
    isSchemaLikeValue(schema) &&
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
  schema: StandardSchemaLike,
  context: OpenAPIConversionContext
): Record<string, unknown> | null {
  const vendor = schema['~standard']?.vendor
  if (!vendor) return null

  const mapper = context.options?.mapJsonSchema?.[vendor]
  if (!mapper) return null

  try {
    return mapper(schema)
  } catch {
    return null
  }
}

function getStandardSchemaJsonSchema(
  schema: StandardSchemaLike,
  direction: SchemaDirection
): Record<string, unknown> | null {
  const converter = schema['~standard']?.jsonSchema
  const convert = converter?.[direction]
  if (typeof convert !== 'function') return null

  for (const target of ['draft-2020-12', 'draft-07', 'openapi-3.0'] as const) {
    try {
      return convert({ target })
    } catch {
      continue
    }
  }

  return null
}

function getSchemaMethodJsonSchema(
  schema: unknown,
  direction: SchemaDirection
): Record<string, unknown> | null {
  if (!isSchemaLikeValue(schema)) return null

  const candidate =
    direction === 'output' && typeof schema.toJSONSchema === 'function'
      ? schema.toJSONSchema
      : typeof schema.toJsonSchema === 'function'
        ? schema.toJsonSchema
        : typeof schema.toJSONSchema === 'function'
          ? schema.toJSONSchema
          : null

  if (typeof candidate !== 'function') return null

  for (const arg of [
    { target: 'draft-2020-12' },
    { target: 'draft-07' },
    { target: 'openapi-3.0' },
    undefined
  ] as const) {
    try {
      const jsonSchema =
        arg === undefined ? candidate.call(schema) : candidate.call(schema, arg)
      if (isObjectRecord(jsonSchema)) return jsonSchema
    } catch {
      continue
    }
  }

  return null
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

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value)
}

function inferOptionalityFromShape(schema: unknown): boolean {
  if (!isObjectRecord(schema)) return false

  if (schema.optional === true) return true
  if (isObjectRecord(schema.spec) && schema.spec.optional === true) return true

  switch (schema.type) {
    case 'optional':
    case 'exact_optional':
    case 'undefinedable':
    case 'nullish':
      return true
    case 'non_optional':
    case 'non_nullable':
    case 'non_nullish':
      return false
    default:
      return false
  }
}

function applyStructuralValidations(
  schema: OpenAPISchema,
  pipe: unknown
): OpenAPISchema {
  if (!Array.isArray(pipe)) return schema

  const normalized = { ...schema }

  for (const item of pipe) {
    if (!isObjectRecord(item) || item.kind !== 'validation') continue

    switch (item.type) {
      case 'email':
        normalized.format = 'email'
        break
      case 'url':
        normalized.format = 'uri'
        break
      case 'uuid':
        normalized.format = 'uuid'
        break
      case 'min_length':
        if (typeof item.requirement === 'number') {
          normalized.minLength = item.requirement
        }
        break
      case 'max_length':
        if (typeof item.requirement === 'number') {
          normalized.maxLength = item.requirement
        }
        break
      case 'regex':
        if (item.requirement instanceof RegExp) {
          normalized.pattern = item.requirement.source
        }
        break
      case 'min_value':
      case 'min_size':
        if (typeof item.requirement === 'number') {
          normalized.minimum = item.requirement
        }
        break
      case 'max_value':
      case 'max_size':
        if (typeof item.requirement === 'number') {
          normalized.maximum = item.requirement
        }
        break
    }
  }

  return normalized
}

function applyDescribedValidations(
  schema: OpenAPISchema,
  tests: unknown
): OpenAPISchema {
  if (!Array.isArray(tests)) return schema

  const normalized = { ...schema }

  for (const test of tests) {
    if (!isObjectRecord(test)) continue

    const params = isObjectRecord(test.params)
      ? test.params
      : isObjectRecord(test.args)
        ? test.args
        : undefined
    const name = typeof test.name === 'string' ? test.name : undefined

    switch (name) {
      case 'email':
        normalized.format = 'email'
        if (params?.regex instanceof RegExp) {
          normalized.pattern = params.regex.source
        }
        break
      case 'url':
        normalized.format = 'uri'
        if (params?.regex instanceof RegExp) {
          normalized.pattern = params.regex.source
        }
        break
      case 'uuid':
        normalized.format = 'uuid'
        if (params?.regex instanceof RegExp) {
          normalized.pattern = params.regex.source
        }
        break
      case 'integer':
        normalized.type = 'integer'
        break
      case 'min':
        if (typeof params?.min === 'number') {
          if (normalized.type === 'string') normalized.minLength = params.min
          else normalized.minimum = params.min
        }
        break
      case 'max':
        if (typeof params?.max === 'number') {
          if (normalized.type === 'string') normalized.maxLength = params.max
          else normalized.maximum = params.max
        }
        break
      case 'length':
        if (typeof params?.length === 'number') {
          if (normalized.type === 'string') {
            normalized.minLength = params.length
            normalized.maxLength = params.length
          }
        }
        break
      case 'matches':
        if (params?.regex instanceof RegExp) {
          normalized.pattern = params.regex.source
        }
        break
    }
  }

  return normalized
}

function isDescribedSchemaRecord(
  value: unknown
): value is Record<string, unknown> {
  return (
    isObjectRecord(value) &&
    typeof value.type === 'string' &&
    (Object.hasOwn(value, 'fields') ||
      Object.hasOwn(value, 'keys') ||
      Object.hasOwn(value, 'innerType') ||
      Object.hasOwn(value, 'tests') ||
      Object.hasOwn(value, 'rules') ||
      Object.hasOwn(value, 'optional') ||
      Object.hasOwn(value, 'nullable') ||
      Object.hasOwn(value, 'oneOf') ||
      Object.hasOwn(value, 'flags'))
  )
}

function describedSchemaToOpenAPI(description: unknown): OpenAPISchema | null {
  if (!isObjectRecord(description) || typeof description.type !== 'string') {
    return null
  }

  let openapiSchema: OpenAPISchema | null

  switch (description.type) {
    case 'object': {
      const entries = isObjectRecord(description.fields)
        ? description.fields
        : isObjectRecord(description.keys)
          ? description.keys
          : {}
      const properties = Object.fromEntries(
        Object.entries(entries).map(([key, value]) => [
          key,
          describedSchemaToOpenAPI(value) ?? {}
        ])
      )
      const required = Object.entries(entries)
        .filter(([, value]) => {
          if (!isObjectRecord(value)) return true
          if (value.optional === true) return false
          if (
            isObjectRecord(value.flags) &&
            value.flags.presence === 'required'
          ) {
            return true
          }
          return value.optional !== true
        })
        .map(([key]) => key)

      openapiSchema = {
        type: 'object',
        properties,
        ...(required.length > 0 ? { required } : {})
      }
      break
    }
    case 'array':
      openapiSchema = {
        type: 'array',
        items:
          describedSchemaToOpenAPI(
            description.innerType ??
              (Array.isArray(description.items)
                ? description.items[0]
                : undefined)
          ) ?? {}
      }
      break
    case 'tuple':
      openapiSchema = {
        type: 'array',
        prefixItems: Array.isArray(description.innerType)
          ? description.innerType
              .map((item) => describedSchemaToOpenAPI(item))
              .filter((item): item is OpenAPISchema => item != null)
          : []
      }
      break
    case 'string':
      openapiSchema = { type: 'string' }
      break
    case 'number':
      openapiSchema = { type: 'number' }
      break
    case 'boolean':
      openapiSchema = { type: 'boolean' }
      break
    case 'date':
      openapiSchema = { type: 'string', format: 'date-time' }
      break
    default:
      openapiSchema = null
  }

  if (!openapiSchema) return null

  if (Array.isArray(description.oneOf) && description.oneOf.length > 0) {
    openapiSchema.enum = [...description.oneOf]
  }

  if ('default' in description && description.default !== undefined) {
    openapiSchema.default = description.default
  }

  openapiSchema = applyDescribedValidations(openapiSchema, description.tests)
  openapiSchema = applyDescribedValidations(openapiSchema, description.rules)

  return withNullability(openapiSchema, description.nullable === true)
}

function getDescribedSchema(schema: unknown): Record<string, unknown> | null {
  if (!isSchemaLikeValue(schema) || typeof schema.describe !== 'function') {
    return null
  }

  try {
    const description = schema.describe()
    return isDescribedSchemaRecord(description) ? description : null
  } catch {
    return null
  }
}

function structuralSchemaToOpenAPI(schema: unknown): OpenAPISchema | null {
  if (!isSchemaLikeValue(schema)) return null

  if (
    !('type' in schema) &&
    (isObjectRecord(schema.props) || isObjectRecord(schema.propsInfo))
  ) {
    const propertiesSource = isObjectRecord(schema.props)
      ? schema.props
      : Object.fromEntries(
          Object.entries(schema.propsInfo as Record<string, unknown>).map(
            ([key, value]) => [
              key,
              isObjectRecord(value) && 'type' in value ? value.type : value
            ]
          )
        )
    const required = isObjectRecord(schema.propsInfo)
      ? Object.entries(schema.propsInfo)
          .filter(
            ([, value]) => !isObjectRecord(value) || value.optional !== true
          )
          .map(([key]) => key)
      : Object.keys(propertiesSource)

    return {
      type: 'object',
      properties: Object.fromEntries(
        Object.entries(propertiesSource).map(([key, value]) => [
          key,
          structuralSchemaToOpenAPI(value) ?? {}
        ])
      ),
      ...(required.length > 0 ? { required } : {})
    }
  }

  if (!('type' in schema) && typeof schema.basicType === 'string') {
    switch (schema.basicType) {
      case 'string':
        return { type: 'string' }
      case 'number':
        return { type: 'number' }
      case 'boolean':
        return { type: 'boolean' }
      default:
        return null
    }
  }

  if (
    isObjectRecord(schema.schema) &&
    typeof schema.schema.type === 'string' &&
    String(schema.schema.type).startsWith('__!quartet/')
  ) {
    return structuralSchemaToOpenAPI(schema.schema)
  }

  if (schema.type === 'lazy' && typeof schema.getter === 'function') {
    try {
      return structuralSchemaToOpenAPI(schema.getter())
    } catch {
      return null
    }
  }

  if (
    (schema.type === 'optional' ||
      schema.type === 'exact_optional' ||
      schema.type === 'undefinedable' ||
      schema.type === 'nullish') &&
    'wrapped' in schema
  ) {
    const wrapped = structuralSchemaToOpenAPI(schema.wrapped)
    if (!wrapped) return null

    return schema.type === 'nullish' ? withNullability(wrapped, true) : wrapped
  }

  if (
    (schema.type === 'nullable' ||
      schema.type === 'non_optional' ||
      schema.type === 'non_nullable' ||
      schema.type === 'non_nullish') &&
    'wrapped' in schema
  ) {
    const wrapped = structuralSchemaToOpenAPI(schema.wrapped)
    if (!wrapped) return null

    if (schema.type === 'nullable') return withNullability(wrapped, true)
    return wrapped
  }

  let openapiSchema: OpenAPISchema

  switch (schema.type) {
    case 'string':
      openapiSchema = { type: 'string' }
      break
    case 'number':
      openapiSchema = { type: 'number' }
      break
    case 'integer':
      openapiSchema = { type: 'integer' }
      break
    case 'boolean':
      openapiSchema = { type: 'boolean' }
      break
    case 'bigint':
      openapiSchema = { type: 'integer' }
      break
    case 'date':
      openapiSchema = { type: 'string', format: 'date-time' }
      break
    case 'array':
      openapiSchema = {
        type: 'array',
        items:
          structuralSchemaToOpenAPI(
            schema.item ??
              schema.innerType ??
              (Array.isArray(schema.schemas) ? schema.schemas[0] : undefined)
          ) ?? {}
      }
      break
    case 'object':
    case 'strict_object':
    case 'loose_object':
    case 'object_with_rest': {
      const entries = isObjectRecord(schema.entries)
        ? schema.entries
        : isObjectRecord(schema.fields)
          ? schema.fields
          : isObjectRecord(schema._object)
            ? schema._object
            : isObjectRecord(schema.props)
              ? schema.props
              : isObjectRecord(schema.propsSchemas)
                ? schema.propsSchemas
                : isObjectRecord(schema.to) &&
                    isObjectRecord(schema.to.properties)
                  ? schema.to.properties
                  : null
      if (!entries) return null

      const properties = Object.fromEntries(
        Object.entries(entries).map(([key, value]) => [
          key,
          structuralSchemaToOpenAPI(value) ?? {}
        ])
      )
      const required = Object.entries(entries)
        .filter(([, value]) => !inferOptionalityFromShape(value))
        .map(([key]) => key)

      openapiSchema = {
        type: 'object',
        properties,
        ...(required.length > 0 ? { required } : {})
      }
      break
    }
    case 'literal':
      openapiSchema = { enum: [schema.literal] }
      break
    case '__!quartet/Object!__': {
      const propsSchemas = isObjectRecord(schema.propsSchemas)
        ? schema.propsSchemas
        : null
      if (!propsSchemas) return null

      const properties = Object.fromEntries(
        Object.entries(propsSchemas).map(([key, value]) => [
          key,
          structuralSchemaToOpenAPI(value) ?? {}
        ])
      )

      openapiSchema = {
        type: 'object',
        properties,
        required: Object.keys(propsSchemas)
      }
      break
    }
    case '__!quartet/String!__':
      openapiSchema = { type: 'string' }
      break
    case '__!quartet/Number!__':
      openapiSchema = { type: 'number' }
      break
    case '__!quartet/Boolean!__':
      openapiSchema = { type: 'boolean' }
      break
    case '__!quartet/And!__': {
      const oneOf = Array.isArray(schema.schemas)
        ? schema.schemas
            .map((item) => structuralSchemaToOpenAPI(item))
            .filter((item): item is OpenAPISchema => item != null)
        : []
      openapiSchema = oneOf.length === 1 ? oneOf[0] : { allOf: oneOf }
      break
    }
    case '__!quartet/Test!__':
      openapiSchema = {}
      break
    case 'picklist':
      openapiSchema = Array.isArray(schema.options)
        ? { enum: [...schema.options] }
        : {}
      break
    case 'enum':
      openapiSchema = isObjectRecord(schema.enum)
        ? { enum: Object.values(schema.enum) }
        : {}
      break
    case 'union':
    case 'variant':
      openapiSchema = {
        oneOf: Array.isArray(schema.options)
          ? schema.options
              .map((option) => structuralSchemaToOpenAPI(option))
              .filter((option): option is OpenAPISchema => option != null)
          : []
      }
      break
    case 'tuple':
      openapiSchema = {
        type: 'array',
        prefixItems: Array.isArray(schema.items)
          ? schema.items
              .map((item) => structuralSchemaToOpenAPI(item))
              .filter((item): item is OpenAPISchema => item != null)
          : []
      }
      break
    default:
      return null
  }

  return applyStructuralValidations(openapiSchema, schema.pipe)
}

const schemaCapabilityAdapters: SchemaCapabilityAdapter[] = [
  {
    name: 'standard-json-schema',
    capability: 'jsonSchema',
    resolve(schema, direction) {
      const jsonSchema = getStandardSchemaJsonSchema(schema, direction)
      return jsonSchema ? jsonSchemaToOpenAPI(jsonSchema) : null
    }
  },
  {
    name: 'mapped-json-schema',
    capability: 'jsonSchema',
    resolve(schema, _direction, context) {
      const jsonSchema = getMappedJsonSchema(schema, context)
      return jsonSchema ? jsonSchemaToOpenAPI(jsonSchema) : null
    }
  },
  {
    name: 'describe-adapter',
    capability: 'describe',
    resolve(schema) {
      const description = getDescribedSchema(schema)
      return description ? describedSchemaToOpenAPI(description) : null
    }
  },
  {
    name: 'structural-adapter',
    capability: 'structural',
    resolve(schema) {
      return structuralSchemaToOpenAPI(schema)
    }
  },
  {
    name: 'schema-method-json-schema',
    capability: 'jsonSchema',
    resolve(schema, direction) {
      const jsonSchema = getSchemaMethodJsonSchema(schema, direction)
      return jsonSchema ? jsonSchemaToOpenAPI(jsonSchema) : null
    }
  }
]

export function schemaToOpenAPI(
  schema: unknown,
  direction: SchemaDirection = 'input',
  context: OpenAPIConversionContext = {}
): OpenAPISchema {
  if (typeof schema === 'string') {
    return context.modelRegistry?.has(schema)
      ? cloneSchema(context.modelRegistry.get(schema) as OpenAPISchema)
      : { type: 'string' }
  }

  if (!schema || (typeof schema !== 'object' && typeof schema !== 'function')) {
    return { type: 'object' }
  }

  if (isStandardSchemaLike(schema)) {
    for (const adapter of schemaCapabilityAdapters) {
      const openapiSchema = adapter.resolve(schema, direction, context)
      if (openapiSchema) return openapiSchema
    }

    return {}
  }

  return jsonSchemaToOpenAPI(schema as Record<string, unknown>)
}

function jsonSchemaToOpenAPI(schema: Record<string, unknown>): OpenAPISchema {
  const normalized: Record<string, unknown> = {}

  for (const [key, value] of Object.entries(schema)) {
    if (value === undefined) continue

    if (key === 'properties' || key === 'patternProperties') {
      normalized[key] = Object.fromEntries(
        Object.entries(value as Record<string, Record<string, unknown>>).map(
          ([propertyName, propertySchema]) => [
            propertyName,
            jsonSchemaToOpenAPI(propertySchema)
          ]
        )
      )
      continue
    }

    if (
      key === '$defs' ||
      key === 'definitions' ||
      key === 'dependentSchemas'
    ) {
      normalized[key] = Object.fromEntries(
        Object.entries(value as Record<string, Record<string, unknown>>).map(
          ([schemaName, nestedSchema]) => [
            schemaName,
            jsonSchemaToOpenAPI(nestedSchema)
          ]
        )
      )
      continue
    }

    if (
      key === 'items' ||
      key === 'not' ||
      key === 'contains' ||
      key === 'if' ||
      key === 'then' ||
      key === 'else' ||
      key === 'propertyNames' ||
      key === 'additionalProperties' ||
      key === 'unevaluatedProperties'
    ) {
      normalized[key] =
        value && typeof value === 'object' && !Array.isArray(value)
          ? jsonSchemaToOpenAPI(value as Record<string, unknown>)
          : value
      continue
    }

    if (
      key === 'allOf' ||
      key === 'anyOf' ||
      key === 'oneOf' ||
      key === 'prefixItems'
    ) {
      normalized[key] = Array.isArray(value)
        ? value.map((item) =>
            item && typeof item === 'object' && !Array.isArray(item)
              ? jsonSchemaToOpenAPI(item as Record<string, unknown>)
              : item
          )
        : value
      continue
    }

    normalized[key] = value
  }

  return withNullability(normalized as OpenAPISchema, schema.nullable === true)
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
  schema: unknown,
  context: OpenAPIConversionContext = {}
): Promise<OperationFragment> {
  const openapiSchema = schemaToOpenAPI(schema, 'input', context)

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
  input: unknown | { schema: unknown; description?: string },
  context: OpenAPIConversionContext
): OpenAPIHeader {
  if (input && typeof input === 'object' && 'schema' in input) {
    return {
      schema: schemaToOpenAPI(
        (input as { schema: unknown }).schema,
        'output',
        context
      ),
      ...(typeof (input as { description?: unknown }).description === 'string'
        ? { description: (input as { description?: string }).description }
        : {})
    }
  }

  return {
    schema: schemaToOpenAPI(input, 'output', context)
  }
}

function normalizeResponse(
  response: DescribeOperationResponse | OpenAPIResponse,
  context: OpenAPIConversionContext
): OpenAPIResponse {
  const normalizedContent = response.content
    ? Object.fromEntries(
        Object.entries(response.content).map(([contentType, entry]) => [
          contentType,
          { schema: schemaToOpenAPI(entry.schema, 'output', context) }
        ])
      )
    : undefined

  const normalizedHeaders = response.headers
    ? Object.fromEntries(
        Object.entries(response.headers).map(([name, header]) => [
          name,
          normalizeHeader(header, context)
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
          schema: schemaToOpenAPI(response.schema, 'output', context)
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
  operation: DescribeOperationInput | OpenAPIOperation,
  context: OpenAPIConversionContext
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
                normalizeResponse(responseItem, context)
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

function isMultipartMiddleware(handler: Handler): boolean {
  return (
    (handler as unknown as Record<symbol, unknown>)[multipartMiddlewareKey] ===
    true
  )
}

function getMultipartFields(handler: Handler): Record<string, unknown> | null {
  const fields = (handler as unknown as Record<symbol, unknown>)[
    multipartFieldsKey
  ]

  return fields && typeof fields === 'object' && !Array.isArray(fields)
    ? (fields as Record<string, unknown>)
    : null
}

function createMultipartFieldDescription(config: unknown): string | undefined {
  if (!config || typeof config !== 'object') return undefined

  const fieldConfig = config as {
    description?: unknown
    maxFileSize?: unknown
    maxFiles?: unknown
    mimeTypes?: unknown
  }
  const descriptionParts: string[] = []

  if (typeof fieldConfig.description === 'string') {
    descriptionParts.push(fieldConfig.description)
  }

  if (
    Array.isArray(fieldConfig.mimeTypes) &&
    fieldConfig.mimeTypes.length > 0
  ) {
    descriptionParts.push(
      `Accepted MIME types: ${fieldConfig.mimeTypes.join(', ')}.`
    )
  }

  if (typeof fieldConfig.maxFileSize === 'number') {
    descriptionParts.push(
      `Maximum file size: ${fieldConfig.maxFileSize} bytes.`
    )
  }

  if (typeof fieldConfig.maxFiles === 'number') {
    descriptionParts.push(`Maximum files: ${fieldConfig.maxFiles}.`)
  }

  return descriptionParts.length > 0 ? descriptionParts.join('\n\n') : undefined
}

function createMultipartFieldSchema(config: unknown): OpenAPISchema {
  const fieldDescription = createMultipartFieldDescription(config)
  const description = fieldDescription ? { description: fieldDescription } : {}

  if (
    config &&
    typeof config === 'object' &&
    (config as { kind?: unknown }).kind === 'array'
  ) {
    return {
      type: 'array',
      ...description,
      items: {
        type: 'string',
        format: 'binary'
      }
    }
  }

  return {
    type: 'string',
    ...description,
    format: 'binary'
  }
}

function getMultipartRequiredFields(
  fields: Record<string, unknown> | null
): string[] {
  if (!fields) return []

  return Object.entries(fields)
    .filter(([, config]) => {
      return !(
        config &&
        typeof config === 'object' &&
        (config as { required?: unknown }).required === false
      )
    })
    .map(([name]) => name)
}

function createMultipartEncoding(
  fields: Record<string, unknown> | null
): Record<string, { contentType: string }> | undefined {
  if (!fields) return undefined

  const encoding = Object.fromEntries(
    Object.entries(fields).flatMap(([name, config]) => {
      if (!config || typeof config !== 'object') return []

      const mimeTypes = (config as { mimeTypes?: unknown }).mimeTypes
      if (!Array.isArray(mimeTypes) || mimeTypes.length === 0) return []

      return [
        [
          name,
          {
            contentType: mimeTypes.join(', ')
          }
        ]
      ]
    })
  )

  return Object.keys(encoding).length > 0 ? encoding : undefined
}

function createMultipartFieldsSchema(
  fields: Record<string, unknown> | null
): OpenAPISchema | null {
  if (!fields) return null

  return {
    type: 'object',
    properties: Object.fromEntries(
      Object.entries(fields).map(([name, config]) => [
        name,
        createMultipartFieldSchema(config)
      ])
    ),
    required: getMultipartRequiredFields(fields)
  }
}

function mergeMultipartSchemaFields(
  schema: OpenAPISchema,
  fieldsSchema: OpenAPISchema | null
): OpenAPISchema {
  if (!fieldsSchema?.properties) return schema

  return {
    ...schema,
    type: schema.type ?? 'object',
    properties: {
      ...(schema.properties ?? {}),
      ...fieldsSchema.properties
    },
    required: [
      ...new Set([...(schema.required ?? []), ...(fieldsSchema.required ?? [])])
    ]
  }
}

function applyMultipartRequestBody(
  operation: OpenAPIOperation,
  fields: Record<string, unknown> | null
): OpenAPIOperation {
  const fieldsSchema = createMultipartFieldsSchema(fields)
  const encoding = createMultipartEncoding(fields)
  const requestBody = operation.requestBody
  const jsonContent = requestBody?.content['application/json']
  const multipartContent = requestBody?.content['multipart/form-data']

  if (!requestBody && fieldsSchema) {
    return {
      ...operation,
      requestBody: {
        content: {
          'multipart/form-data': {
            schema: fieldsSchema,
            ...(encoding ? { encoding } : {})
          }
        }
      }
    }
  }

  if (requestBody && multipartContent) {
    return {
      ...operation,
      requestBody: {
        ...requestBody,
        content: {
          ...requestBody.content,
          'multipart/form-data': {
            schema: mergeMultipartSchemaFields(
              multipartContent.schema,
              fieldsSchema
            ),
            ...(multipartContent.encoding || encoding
              ? {
                  encoding: {
                    ...(multipartContent.encoding ?? {}),
                    ...(encoding ?? {})
                  }
                }
              : {})
          }
        }
      }
    }
  }

  if (!requestBody || !jsonContent) {
    return operation
  }

  const content = { ...requestBody.content }
  delete content['application/json']

  return {
    ...operation,
    requestBody: {
      ...requestBody,
      content: {
        ...content,
        'multipart/form-data': {
          schema: mergeMultipartSchemaFields(jsonContent.schema, fieldsSchema),
          ...(encoding ? { encoding } : {})
        }
      }
    }
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
    (context?: OpenAPIConversionContext) =>
      normalizeOperation(operation, context ?? {})
  )
}

export function model(models: Record<string, unknown>): Handler {
  return setHandlerMetadata(
    async ({ next }) => next(),
    modelMetadataKey,
    models
  )
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
  state: OpenAPIRegistryState,
  method: string,
  path: string,
  operation: OpenAPIOperation
): void {
  const key = routeKey(method, path)
  const current = state.routeRegistry.get(key)

  state.routeRegistry.set(key, {
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
  handler: Handler,
  context: OpenAPIConversionContext
): Promise<OperationFragment> {
  const metadata = handler as unknown as Record<symbol, unknown>
  const operationValue = metadata[operationMetadataKey]
  const fragmentValue = metadata[fragmentMetadataKey]
  const operation = (await (typeof operationValue === 'function'
    ? operationValue(context)
    : operationValue)) as OpenAPIOperation | undefined
  const fragment = (await (typeof fragmentValue === 'function'
    ? fragmentValue(context)
    : fragmentValue)) as OperationFragment | undefined

  if (operation && fragment) {
    return mergeOperation(operation, fragment)
  }

  return operation ?? fragment ?? {}
}

function registerModelsFromHandler(
  state: OpenAPIRegistryState,
  handler: Handler
): void {
  const metadata = handler as unknown as Record<symbol, unknown>
  const models = metadata[modelMetadataKey] as
    | Record<string, unknown>
    | undefined
  if (!models) return

  for (const [name, schema] of Object.entries(models)) {
    state.modelRegistry.set(
      name,
      schemaToOpenAPI(schema, 'output', state.context)
    )
  }
}

function recordRouteFromHandlers(
  state: OpenAPIRegistryState,
  method: string,
  path: string,
  handlers: Handler[]
): void {
  const key = routeKey(method, path)
  const current = state.routeRegistry.get(key)

  state.routeRegistry.set(key, {
    method: method.toUpperCase(),
    path,
    operation: current?.operation,
    handlers
  })
}

async function resolveRouteOperation(
  route: StoredRoute,
  context: OpenAPIConversionContext
): Promise<OpenAPIOperation | undefined> {
  let operation = route.operation
  let usesMultipart = false
  let multipartFields: Record<string, unknown> | null = null

  for (const handler of route.handlers ?? []) {
    if (isMultipartMiddleware(handler)) {
      usesMultipart = true
      multipartFields = getMultipartFields(handler) ?? multipartFields
    }

    const fragment = await extractHandlerOperation(handler, context)
    if (Object.keys(fragment).length === 0) continue
    operation = mergeOperation(operation, fragment)
  }

  if (operation && usesMultipart) {
    operation = applyMultipartRequestBody(operation, multipartFields)
  }

  return operation
}

export async function getOpenAPIDocument(
  state: OpenAPIRegistryState = {
    options: {},
    routeRegistry: new Map<string, StoredRoute>(),
    modelRegistry: new Map<string, OpenAPISchema>(),
    context: {}
  }
): Promise<OpenAPIDocument> {
  const paths: OpenAPIDocument['paths'] = {}

  for (const route of state.routeRegistry.values()) {
    const operation = await resolveRouteOperation(route, state.context)
    if (!operation) continue

    const pathItem = (paths[route.path] ??= {})
    pathItem[route.method.toLowerCase()] = operation
  }

  return {
    $schema: 'https://spec.openapis.org/oas/3.1/schema-base/2025-09-15',
    openapi: '3.1.1',
    info: {
      title: state.options.documentation?.info?.title ?? 'API Reference',
      version: state.options.documentation?.info?.version ?? '1.0.0',
      ...(state.options.documentation?.info?.description
        ? { description: state.options.documentation.info.description }
        : {})
    },
    ...(state.options.documentation?.servers
      ? { servers: state.options.documentation.servers }
      : {}),
    paths
  }
}

export function clearOpenAPIRegistry(): void {
  // Kept for backward compatibility. OpenAPI state is now isolated per app.
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

function getOpenAPICore(app: OpenAPIPluginTarget): OpenAPICoreLike | null {
  const core = Reflect.get(app as object, hyperinCoreKey) as unknown

  if (!core || typeof core !== 'object') return null

  const candidate = core as Partial<OpenAPICoreLike>
  if (
    typeof candidate.getRoutesSnapshot !== 'function' ||
    typeof candidate.onRouteRegistered !== 'function' ||
    typeof candidate.getMiddlewaresSnapshot !== 'function' ||
    typeof candidate.onMiddlewareRegistered !== 'function'
  ) {
    return null
  }

  return candidate as OpenAPICoreLike
}

function createOpenAPIMiddleware(
  app: OpenAPIPluginTarget,
  options: OpenAPIOptions = {}
): Handler {
  const specPath = normalizePath(options.path, '/openapi.json')
  const filePath = options.file ? resolveOpenAPIFilePath(options.file) : null
  let persistedDocumentPromise: Promise<OpenAPIDocument> | null = null
  let cachedDocumentPromise: Promise<OpenAPIDocument> | null = null
  const state: OpenAPIRegistryState = {
    options,
    routeRegistry: new Map<string, StoredRoute>(),
    modelRegistry: new Map<string, OpenAPISchema>(),
    context: { options }
  }
  state.context.modelRegistry = state.modelRegistry
  const core = getOpenAPICore(app)
  const invalidateDocument = (): void => {
    cachedDocumentPromise = null
    persistedDocumentPromise = null
  }

  if (core) {
    for (const middleware of core.getMiddlewaresSnapshot()) {
      registerModelsFromHandler(state, middleware)
    }

    for (const [method, path, handlers] of core.getRoutesSnapshot()) {
      recordRouteFromHandlers(state, method, path, handlers)
    }

    core.onRouteRegistered((method, path, handlers) => {
      recordRouteFromHandlers(state, method, path, handlers)
      invalidateDocument()
    })

    core.onMiddlewareRegistered((middleware) => {
      registerModelsFromHandler(state, middleware)
      invalidateDocument()
    })
  }

  return async ({ request, response, next }) => {
    if (request.path === specPath) {
      const document = filePath
        ? await (persistedDocumentPromise ??= (async () => {
            if (await fileExists(filePath)) {
              return loadOpenAPIFile(filePath)
            }

            const document = await getOpenAPIDocument(state)
            await writeOpenAPIFile(filePath, document)
            return document
          })())
        : await (cachedDocumentPromise ??= getOpenAPIDocument(state))

      response.json(document)
      return
    }

    await next()

    const operation = request.locals.openapi as OpenAPIOperation | undefined
    if (!operation || !request.method) return

    recordOperation(state, request.method, request.path, operation)
    invalidateDocument()
  }
}

export function openapi<TApp extends OpenAPIPluginTarget>(
  app: TApp,
  options: OpenAPIOptions = {}
): TApp {
  ;(app.use as unknown as (handler: Handler) => unknown)(
    createOpenAPIMiddleware(app, options)
  )
  return app
}
