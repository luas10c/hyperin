import type { ParsedUrlQuery } from 'node:querystring'

import type {
  Request,
  RequestBody,
  RequestFiles,
  RequestParams,
  RequestQuery
} from './request'
import type {
  OpenAPICallback,
  OpenAPIExternalDocumentation,
  OpenAPIParameter,
  DescribeOperationRequestBody,
  OpenAPIResponses,
  DescribeOperationResponse,
  OpenAPISecurityRequirement,
  OpenAPIServer
} from './openapi'
import type { Response } from './response'

export type NextFunction = (error?: Error) => void | Promise<void>

export type HandlerReturn =
  | void
  | undefined
  | string
  | boolean
  | unknown[]
  | readonly unknown[]
  | Record<string, unknown>
  | Promise<
      | void
      | undefined
      | string
      | boolean
      | unknown[]
      | readonly unknown[]
      | Record<string, unknown>
    >

export type HandlerContext<
  TRequest extends Request = Request,
  TResponse extends object = Response
> = {
  request: TRequest
  response: TResponse
  next: NextFunction
}

export type Middleware = (
  ctx: HandlerContext & { next: NextFunction }
) => void | Promise<void>

export type ErrorContext<
  TRequest extends Request = Request,
  TResponse extends object = Response
> = HandlerContext<TRequest, TResponse> & {
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
   * Documentation schema for request headers.
   */
  headers?: unknown

  /**
   * Documentation schema for request cookies.
   */
  cookies?: unknown

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
   * Explicit OpenAPI parameters merged into the generated operation.
   */
  parameters?: OpenAPIParameter[]

  /**
   * Explicit OpenAPI request body merged into the generated operation.
   */
  requestBody?: DescribeOperationRequestBody

  /**
   * OpenAPI security requirements for the operation.
   */
  security?: OpenAPISecurityRequirement[]

  /**
   * OpenAPI servers for the operation.
   */
  servers?: OpenAPIServer[]

  /**
   * External documentation attached to the OpenAPI operation.
   */
  externalDocs?: OpenAPIExternalDocumentation

  /**
   * OpenAPI callbacks attached to the operation.
   */
  callbacks?: Record<string, OpenAPICallback>

  /**
   * Additional response schemas merged into the generated OpenAPI operation.
   */
  responses?: OpenAPIResponses<DescribeOperationResponse>
}

export interface TypedMiddleware<
  TRequest extends Request = Request,
  TRefinement extends RequestRefinement = Record<never, never>,
  TResponse extends object = Response
> {
  (ctx: HandlerContext<TRequest, TResponse>): HandlerReturn
  readonly __validate__?: TRefinement
}

export type Handler<TRequest extends Request = Request> =
  TypedMiddleware<TRequest>
export type ErrorMiddleware<
  TRequest extends Request = Request,
  TResponse extends object = Response
> = (
  ctx: ErrorContext<TRequest, TResponse>
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
  TMiddleware extends TypedMiddleware<TRequest, infer TRefinement, infer _TResponse>
    ? MergeRefinement<TRequest, TRefinement>
    : never

export type HandlerChain<
  TRequest extends Request,
  THandlers extends unknown[]
> = THandlers extends [infer TFirst, ...infer TRest]
  ? TFirst extends TypedMiddleware<
      TRequest,
      RequestRefinement,
      infer _TResponse
    >
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

type DeclaredResponseStatusCodes<
  TResponses extends RouteSchemaOptions['responses']
> = Extract<keyof NonNullable<TResponses>, number>

export type ResponseStatusCodes<TOptions extends RouteSchemaOptions> =
  [DeclaredResponseStatusCodes<TOptions['responses']>] extends [never]
    ? number
    : DeclaredResponseStatusCodes<TOptions['responses']>

type ResponseEntryForStatus<
  TResponses extends RouteSchemaOptions['responses'],
  TStatus extends number
> = NonNullable<TResponses> extends infer TDefinedResponses extends object
  ? TStatus extends keyof TDefinedResponses
    ? TDefinedResponses[TStatus]
    : `${TStatus}` extends keyof TDefinedResponses
      ? TDefinedResponses[`${TStatus}`]
      : never
  : never

type NormalizeResponseContent<TEntry> = TEntry extends { content: infer TContent }
  ? TContent extends string
    ? Record<TContent, { schema: unknown }>
    : TContent
  : TEntry extends { schema: infer TSchema; contentType: infer TContentType extends string }
    ? Record<TContentType, { schema: TSchema }>
    : TEntry extends { schema: infer TSchema }
      ? { 'application/json': { schema: TSchema } }
      : never

type ContentSchemaByPattern<
  TResponses extends RouteSchemaOptions['responses'],
  TStatus extends number,
  TPattern extends string
> = NormalizeResponseContent<
  ResponseEntryForStatus<TResponses, TStatus>
> extends infer TContent extends object
  ? {
      [TKey in keyof TContent]: TKey extends string
        ? TKey extends TPattern
          ? TContent[TKey] extends { schema: infer TSchema }
            ? InferSchemaOutput<TSchema>
            : never
          : never
        : never
    }[keyof TContent]
  : never

type JsonBodyForResponse<
  TResponses extends RouteSchemaOptions['responses'],
  TStatus extends number
> = TResponses extends undefined
  ? object
  : [ContentSchemaByPattern<TResponses, TStatus, `application/json${string}`>] extends [never]
    ? never
    : ContentSchemaByPattern<TResponses, TStatus, `application/json${string}`>

type TextBodyForResponse<
  TResponses extends RouteSchemaOptions['responses'],
  TStatus extends number
> = TResponses extends undefined
  ? string
  : [ContentSchemaByPattern<TResponses, TStatus, `text/plain${string}`>] extends [never]
    ? never
    : ContentSchemaByPattern<TResponses, TStatus, `text/plain${string}`>

export type TypedResponse<
  TResponses extends RouteSchemaOptions['responses'] = undefined,
  TStatusCode extends number = 200
> = Omit<Response, 'status' | 'json' | 'text'> & {
  status<TNextStatusCode extends ResponseStatusCodes<{ responses: TResponses }>>(
    statusCode: TNextStatusCode
  ): TypedResponse<TResponses, TNextStatusCode>
  json(body: JsonBodyForResponse<TResponses, TStatusCode>): TypedResponse<TResponses, TStatusCode>
  text(body: TextBodyForResponse<TResponses, TStatusCode>): TypedResponse<TResponses, TStatusCode>
}

export type ApplyRouteResponse<
  TOptions extends RouteSchemaOptions
> = TypedResponse<TOptions['responses']>

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
  /**
   * Maximum size in bytes for the header block of each multipart part.
   *
   * This applies before the terminating `\r\n\r\n` separator is found.
   */
  maxHeaderSize?: number
  /** Maximum size in bytes of a non-file field value. */
  maxFieldSize?: number
  /** Maximum number of non-file fields. */
  maxFields?: number
  /** Maximum number of multipart parts (fields + files). */
  maxParts?: number
  /** Maximum number of files across all file fields. */
  maxFiles?: number
}
