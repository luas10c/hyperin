import type { ParsedUrlQuery } from 'node:querystring'

import type {
  Request,
  RequestBody,
  RequestFiles,
  RequestParams,
  RequestQuery
} from './request'
import type { Response } from './response'

export type NextFunction = (error?: Error) => void | Promise<void>

export type HandlerReturn =
  | void
  | undefined
  | string
  | unknown[]
  | Record<string, unknown>
  | Promise<void | undefined | string | unknown[] | Record<string, unknown>>

export type HandlerContext<TRequest extends Request = Request> = {
  request: TRequest
  response: Response
  next: NextFunction
}

export type Middleware = (
  ctx: HandlerContext & { next: NextFunction }
) => void | Promise<void>

export type ErrorContext<TRequest extends Request = Request> =
  HandlerContext<TRequest> & {
    error: Error
    next: NextFunction
  }

export type RequestRefinement = {
  body?: unknown
  params?: Record<string, unknown>
  query?: Record<string, unknown>
  files?: Record<string, unknown>
}

export interface StandardSchemaV1Issue {
  readonly message: string
  readonly path?: readonly (PropertyKey | { readonly key: PropertyKey })[]
}

export interface StandardSchemaV1Options {
  readonly libraryOptions?: Record<string, unknown>
}

export interface StandardSchemaV1Types<TInput = unknown, TOutput = TInput> {
  readonly input: TInput
  readonly output: TOutput
}

export interface StandardSchemaV1Result<TOutput = unknown> {
  readonly value?: TOutput
  readonly issues?: readonly StandardSchemaV1Issue[]
}

export interface StandardSchemaV1<TInput = unknown, TOutput = TInput> {
  readonly '~standard': {
    readonly version?: 1
    readonly vendor?: string
    readonly validate: (
      value: unknown,
      options?: StandardSchemaV1Options | undefined
    ) =>
      | StandardSchemaV1Result<TOutput>
      | Promise<StandardSchemaV1Result<TOutput>>
    readonly types?: StandardSchemaV1Types<TInput, TOutput>
    readonly jsonSchema?: {
      readonly input?: (options: {
        target: string
        libraryOptions?: Record<string, unknown>
      }) => Record<string, unknown>
      readonly output?: (options: {
        target: string
        libraryOptions?: Record<string, unknown>
      }) => Record<string, unknown>
    }
  }
}

type AwaitedSchemaResult<TValue> =
  TValue extends PromiseLike<infer TResolved>
    ? AwaitedSchemaResult<TResolved>
    : TValue

type InferValidatedValue<TValue> =
  Extract<
    AwaitedSchemaResult<TValue>,
    { readonly value: unknown } | { value: unknown }
  > extends { readonly value: infer TOutput }
    ? TOutput
    : Extract<AwaitedSchemaResult<TValue>, { value: unknown }> extends {
          value: infer TOutput
        }
      ? TOutput
      : unknown

export type InferSchemaOutput<TSchema> = TSchema extends {
  readonly '~types'?: { readonly output: infer TOutput }
}
  ? TOutput
  : TSchema extends {
        readonly '~standard': {
          readonly types?: { readonly output: infer TOutput }
        }
      }
    ? TOutput
    : TSchema extends {
          readonly '~standard': {
            readonly validate: (...args: unknown[]) => infer TResult
          }
        }
      ? InferValidatedValue<TResult>
      : unknown

export interface RouteSchemaOptions {
  /**
   * Validation schema for `request.body`.
   */
  body?: unknown

  /**
   * Validation schema for route params extracted from the path.
   */
  params?: unknown

  /**
   * Validation schema for `request.query`.
   */
  query?: unknown

  /**
   * Short operation summary used in the generated OpenAPI document.
   */
  summary?: string

  /**
   * Detailed operation description used in the generated OpenAPI document.
   */
  description?: string

  /**
   * Explicit OpenAPI operation id.
   */
  operationId?: string

  /**
   * OpenAPI tags attached to the operation.
   */
  tags?: string[]

  /**
   * Marks the OpenAPI operation as deprecated.
   */
  deprecated?: boolean

  /**
   * Additional response schemas merged into the generated OpenAPI operation.
   */
  responses?: Record<string | number, unknown>
}

export interface TypedMiddleware<
  TRequest extends Request = Request,
  TRefinement extends RequestRefinement = Record<never, never>
> {
  (ctx: HandlerContext<TRequest>): HandlerReturn
  readonly __validate__?: TRefinement
}

export type Handler<TRequest extends Request = Request> =
  TypedMiddleware<TRequest>
export type ErrorMiddleware<TRequest extends Request = Request> = (
  ctx: ErrorContext<TRequest>
) => void | Promise<void>
export type ErrorHandler<TRequest extends Request = Request> =
  ErrorMiddleware<TRequest>
export type AnyHandler = TypedMiddleware<
  Request<RequestBody, RequestParams, RequestQuery, RequestFiles>,
  RequestRefinement
>
export type AnyErrorHandler = ErrorHandler<
  Request<RequestBody, RequestParams, RequestQuery, RequestFiles>
>
export type AnyMiddleware = AnyHandler | AnyErrorHandler

type MergeRefinement<
  TRequest extends Request,
  TRefinement extends RequestRefinement
> = Request<
  TRefinement extends { body: infer TBody } ? TBody : TRequest['body'],
  TRefinement extends { params: infer TParams extends Record<string, unknown> }
    ? TParams
    : TRequest['params'],
  TRefinement extends { query: infer TQuery extends Record<string, unknown> }
    ? TQuery
    : TRequest['query'],
  TRefinement extends { files: infer TFiles extends Record<string, unknown> }
    ? TFiles
    : TRequest['files']
>

export type ApplyMiddleware<TRequest extends Request, TMiddleware> =
  TMiddleware extends TypedMiddleware<TRequest, infer TRefinement>
    ? MergeRefinement<TRequest, TRefinement>
    : never

export type HandlerChain<
  TRequest extends Request,
  THandlers extends unknown[]
> = THandlers extends [infer TFirst, ...infer TRest]
  ? TFirst extends TypedMiddleware<TRequest, RequestRefinement>
    ? [TFirst, ...HandlerChain<ApplyMiddleware<TRequest, TFirst>, TRest>]
    : never
  : []

type NonEmptyHandlerChain<
  TRequest extends Request,
  THandlers extends unknown[]
> =
  HandlerChain<TRequest, THandlers> extends infer TChain extends unknown[]
    ? TChain extends []
      ? never
      : TChain
    : never

type ParamName<TSegment extends string> =
  TSegment extends `${infer TName}/${string}`
    ? ParamName<TName>
    : TSegment extends `${infer TName}?`
      ? TName
      : TSegment extends `${infer TName}*`
        ? TName
        : TSegment

type RouteParamKeys<TPath extends string> =
  TPath extends `${string}:${infer TParam}/${infer TRest}`
    ? ParamName<TParam> | RouteParamKeys<`/${TRest}`>
    : TPath extends `${string}:${infer TParam}`
      ? ParamName<TParam>
      : never

export type RouteParams<TPath extends string> = [
  RouteParamKeys<TPath>
] extends [never]
  ? Record<string, string>
  : Record<RouteParamKeys<TPath>, string>

export type RouteRequest<TPath extends string> = Request<
  Request['body'],
  RouteParams<TPath>,
  ParsedUrlQuery
>

export type ApplyRouteOptions<
  TRequest extends Request,
  TOptions extends RouteSchemaOptions
> = Request<
  TOptions extends { body: infer TBody }
    ? unknown extends InferSchemaOutput<TBody>
      ? TRequest['body']
      : InferSchemaOutput<TBody>
    : TRequest['body'],
  TOptions extends { params: infer TParams }
    ? InferSchemaOutput<TParams> extends Record<string, unknown>
      ? InferSchemaOutput<TParams>
      : TRequest['params']
    : TRequest['params'],
  TOptions extends { query: infer TQuery }
    ? InferSchemaOutput<TQuery> extends Record<string, unknown>
      ? InferSchemaOutput<TQuery>
      : TRequest['query']
    : TRequest['query'],
  TRequest['files']
>

export type RouteHandlerArgs<
  TPath extends string,
  THandlers extends unknown[]
> = NonEmptyHandlerChain<RouteRequest<TPath>, THandlers>

export type RouteHandlerArgsWithOptions<
  TPath extends string,
  TOptions extends RouteSchemaOptions,
  THandlers extends unknown[]
> = [
  ...NonEmptyHandlerChain<
    ApplyRouteOptions<RouteRequest<TPath>, TOptions>,
    THandlers
  >,
  TOptions & RouteSchemaOptions
]

export type RouteMethodArgsWithOptions<
  TPath extends string,
  TArgs extends [Handler, ...unknown[], RouteSchemaOptions]
> = TArgs extends [...infer THandlers, infer TOptions]
  ? TOptions extends RouteSchemaOptions
    ? THandlers extends [unknown, ...unknown[]]
      ? RouteHandlerArgsWithOptions<TPath, TOptions, THandlers>
      : never
    : never
  : never

export type MultipartLimits = {
  /**
   * Maximum total multipart payload size in bytes.
   */
  totalSize?: number
}
