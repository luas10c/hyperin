import type { AnyRequest, Request } from './request'
import type { Response } from './response'
import type {
  InferSchemaOutput,
  StandardSchemaV1,
  StandardSchemaV1Result,
  TypedMiddleware
} from './types'
import {
  attachOpenAPIFragmentMetadata,
  createOpenAPIOperationFragment
} from './openapi'

type NextFunction = () => void | Promise<void>
type Middleware = (ctx: {
  request: Request
  response: Response
  next: NextFunction
}) => void | Promise<void>

type MaybeZodLike = {
  safeParse: (input: unknown) => {
    success: boolean
    data?: unknown
    error?: unknown
  }
}
type SchemaInput = StandardSchemaV1 | MaybeZodLike | unknown
type RequestSource = 'body' | 'params' | 'query'
type RequestData = Pick<Request, RequestSource>
type ValidationOutcome =
  | { ok: true; data?: unknown }
  | { ok: false; details: unknown }

type ValidateBodyRefinement<TBody> = { body: TBody }
type ValidateParamsRefinement<TParams extends Record<string, unknown>> = {
  params: TParams
}
type ValidateQueryRefinement<TQuery extends Record<string, unknown>> = {
  query: TQuery
}

type ValidatorRunner = (data: unknown) => Promise<ValidationOutcome>
type PreparedValidator = {
  source: RequestSource
  kind: 'zod' | 'standard'
  run: ValidatorRunner
}

function isZodLike(s: unknown): s is MaybeZodLike {
  return (
    s != null && typeof (s as { safeParse?: unknown }).safeParse === 'function'
  )
}

function isStandardSchemaLike(schema: unknown): schema is StandardSchemaV1 {
  return (
    schema != null &&
    typeof schema === 'object' &&
    typeof (schema as StandardSchemaV1)['~standard']?.validate === 'function'
  )
}

function formatZodError(result: { error?: unknown }): unknown {
  const errorObj = result.error as
    | { format?: () => unknown; message?: unknown; issues?: unknown }
    | undefined

  if (Array.isArray(errorObj?.issues)) {
    return errorObj.issues
  }

  if (typeof errorObj?.format === 'function') {
    return errorObj.format()
  }

  return [{ message: errorObj?.message ?? result.error }]
}

function getRequestValue(request: RequestData, source: RequestSource): unknown {
  return request[source]
}

function setRequestValue(
  request: RequestData,
  source: RequestSource,
  value: unknown
): void {
  request[source] = value as never
}

function normalizeStandardResult(
  result: StandardSchemaV1Result
): ValidationOutcome {
  if (Array.isArray(result.issues)) {
    return { ok: false, details: result.issues }
  }

  return {
    ok: true,
    ...(result.value !== undefined ? { data: result.value } : {})
  }
}

function normalizeValidationErrors(details: unknown): unknown[] {
  if (Array.isArray(details)) return details
  if (details === undefined) return []
  return [details]
}

function createPreparedValidator(
  source: RequestSource,
  schema: SchemaInput
): PreparedValidator {
  if (isStandardSchemaLike(schema)) {
    return {
      source,
      kind: 'standard',
      run: async (data: unknown): Promise<ValidationOutcome> =>
        normalizeStandardResult(await schema['~standard'].validate(data))
    }
  }

  if (isZodLike(schema)) {
    return {
      source,
      kind: 'zod',
      run: async (data: unknown): Promise<ValidationOutcome> => {
        const result = schema.safeParse(data)
        if (result.success) {
          return { ok: true, data: result.data }
        }

        return { ok: false, details: formatZodError(result) }
      }
    }
  }

  return {
    source,
    kind: 'standard',
    run: async (): Promise<ValidationOutcome> => ({ ok: true })
  }
}

function createValidationMiddleware(
  validators: PreparedValidator[]
): Middleware {
  return async ({ request, response, next }) => {
    const requestData = request as unknown as RequestData

    for (const validator of validators) {
      const outcome = await validator.run(
        getRequestValue(requestData, validator.source)
      )

      if (!outcome.ok) {
        return void response.status(422).json({
          errors: normalizeValidationErrors(outcome.details)
        })
      }

      if ('data' in outcome) {
        setRequestValue(requestData, validator.source, outcome.data)
      }
    }

    return next()
  }
}

function createValidator(
  source: RequestSource,
  schema: SchemaInput
): Middleware {
  const middleware = createValidationMiddleware([
    createPreparedValidator(source, schema)
  ])

  return attachOpenAPIFragmentMetadata(
    middleware as unknown as TypedMiddleware,
    createOpenAPIOperationFragment(source, schema)
  ) as unknown as Middleware
}

export const validate = {
  body: <TSchema extends SchemaInput, TBody = InferSchemaOutput<TSchema>>(
    schema: TSchema
  ) =>
    createValidator('body', schema) as TypedMiddleware<
      AnyRequest,
      ValidateBodyRefinement<TBody>
    >,
  params: <
    TSchema extends SchemaInput,
    TParams extends Record<string, unknown> =
      InferSchemaOutput<TSchema> extends Record<string, unknown>
        ? InferSchemaOutput<TSchema>
        : Record<string, unknown>
  >(
    schema: TSchema
  ) =>
    createValidator('params', schema) as TypedMiddleware<
      AnyRequest,
      ValidateParamsRefinement<TParams>
    >,
  query: <
    TSchema extends SchemaInput,
    TQuery extends Record<string, unknown> =
      InferSchemaOutput<TSchema> extends Record<string, unknown>
        ? InferSchemaOutput<TSchema>
        : Record<string, unknown>
  >(
    schema: TSchema
  ) =>
    createValidator('query', schema) as TypedMiddleware<
      AnyRequest,
      ValidateQueryRefinement<TQuery>
    >
}
