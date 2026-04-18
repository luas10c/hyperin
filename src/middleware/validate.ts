import type { AnyRequest, Request } from '../request'
import type { Response } from '../response'
import type { TypedMiddleware } from '../types'

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
type JsonSchema = unknown
type SchemaInput = MaybeZodLike | JsonSchema
type RequestSource = 'body' | 'params' | 'query'
type RequestData = Pick<Request, RequestSource>
type StandardsValidationResult = boolean | { valid?: boolean; errors?: unknown }
type StandardsModule = {
  validate?: (
    schema: unknown,
    data: unknown
  ) => StandardsValidationResult | Promise<StandardsValidationResult>
  compile?: (
    schema: unknown
  ) => (
    data: unknown
  ) => StandardsValidationResult | Promise<StandardsValidationResult>
}
type ValidationOutcome =
  | { ok: true; data?: unknown }
  | { ok: false; details: unknown }

type InferSchema<TSchema> = TSchema extends {
  safeParse: (input: unknown) => infer TResult
}
  ? Extract<TResult, { success: true }> extends { data: infer TData }
    ? TData
    : unknown
  : unknown

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

let standardsModulePromise: Promise<StandardsModule | null> | null = null
const standardsValidatorCache = new Map<
  SchemaInput,
  Promise<ValidatorRunner | null>
>()

function isZodLike(s: unknown): s is MaybeZodLike {
  return (
    s != null && typeof (s as { safeParse?: unknown }).safeParse === 'function'
  )
}

function normalizeStandardsResult(
  result: StandardsValidationResult
): ValidationOutcome {
  if (typeof result === 'boolean') {
    return result ? { ok: true } : { ok: false, details: undefined }
  }

  return {
    ok: typeof result.valid === 'boolean' ? result.valid : true,
    ...(result.errors !== undefined ? { details: result.errors } : {})
  } as ValidationOutcome
}

function formatZodError(result: { error?: unknown }): unknown {
  const errorObj = result.error as
    | { format?: () => unknown; message?: unknown }
    | undefined

  if (typeof errorObj?.format === 'function') {
    return errorObj.format()
  }

  return {
    message: 'Validation error',
    details: errorObj?.message ?? result.error
  }
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

function getStandardsModule(): Promise<StandardsModule | null> {
  if (!standardsModulePromise) {
    standardsModulePromise = import('standardschema')
      .then((module) => module.default)
      .catch(() => null)
  }

  return standardsModulePromise
}

function getStandardsValidator(
  schema: SchemaInput
): Promise<ValidatorRunner | null> {
  const cached = standardsValidatorCache.get(schema)
  if (cached) return cached

  const pending = getStandardsModule().then(async (standards) => {
    if (!standards) return null

    if (typeof standards.validate === 'function') {
      return async (data: unknown): Promise<ValidationOutcome> =>
        normalizeStandardsResult(await standards.validate!(schema, data))
    }

    if (typeof standards.compile === 'function') {
      const compiled = standards.compile(schema)
      return async (data: unknown): Promise<ValidationOutcome> =>
        normalizeStandardsResult(await compiled(data))
    }

    return null
  })

  standardsValidatorCache.set(schema, pending)
  return pending
}

function createPreparedValidator(
  source: RequestSource,
  schema: SchemaInput
): PreparedValidator {
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

  const standardsValidatorPromise = getStandardsValidator(schema)

  return {
    source,
    kind: 'standard',
    run: async (data: unknown): Promise<ValidationOutcome> => {
      const validator = await standardsValidatorPromise
      if (!validator) return { ok: true }
      return validator(data)
    }
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
        const error =
          validator.kind === 'zod'
            ? outcome.details
            : { message: 'Validation failed', details: outcome.details }

        return void response.status(400).json({ error })
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
  return createValidationMiddleware([createPreparedValidator(source, schema)])
}

export const validate = {
  body: <TSchema extends SchemaInput, TBody = InferSchema<TSchema>>(
    schema: TSchema
  ) =>
    createValidator('body', schema) as TypedMiddleware<
      AnyRequest,
      ValidateBodyRefinement<TBody>
    >,
  params: <
    TSchema extends SchemaInput,
    TParams extends Record<string, unknown> =
      InferSchema<TSchema> extends Record<string, unknown>
        ? InferSchema<TSchema>
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
      InferSchema<TSchema> extends Record<string, unknown>
        ? InferSchema<TSchema>
        : Record<string, unknown>
  >(
    schema: TSchema
  ) =>
    createValidator('query', schema) as TypedMiddleware<
      AnyRequest,
      ValidateQueryRefinement<TQuery>
    >
}
