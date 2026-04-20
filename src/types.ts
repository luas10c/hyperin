import type { ParsedUrlQuery } from 'node:querystring'

import type { AnyRequest, Request } from './request'
import type { Response } from './response'

export type NextFunction = () => void | Promise<void>

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

export type ErrorContext<TRequest extends Request = Request> =
  HandlerContext<TRequest> & {
    error: Error
    next: NextFunction
  }

export type RequestRefinement = {
  body?: unknown
  params?: Record<string, unknown>
  query?: Record<string, unknown>
}

export interface StandardSchemaV1Types<TInput = unknown, TOutput = TInput> {
  readonly input: TInput
  readonly output: TOutput
}

export interface StandardSchemaV1Result<TOutput = unknown> {
  readonly value?: TOutput
  readonly issues?: readonly unknown[]
}

export interface StandardSchemaV1<TInput = unknown, TOutput = TInput> {
  readonly '~standard': {
    readonly version?: 1
    readonly vendor?: string
    readonly validate: (
      value: unknown,
      options?: unknown
    ) =>
      | StandardSchemaV1Result<TOutput>
      | Promise<StandardSchemaV1Result<TOutput>>
    readonly types?: StandardSchemaV1Types<TInput, TOutput>
    readonly jsonSchema?: {
      readonly input?: (options: { target: string }) => Record<string, unknown>
    }
  }
}

type InferZodLikeSchema<TSchema> = TSchema extends {
  safeParse: (input: unknown) => infer TResult
}
  ? Extract<TResult, { success: true }> extends { data: infer TData }
    ? TData
    : unknown
  : never

export type InferSchemaOutput<TSchema> =
  TSchema extends StandardSchemaV1<unknown, infer TOutput>
    ? TOutput
    : InferZodLikeSchema<TSchema> extends never
      ? unknown
      : InferZodLikeSchema<TSchema>

export interface RouteSchemaOptions {
  body?: unknown
  params?: unknown
  query?: unknown
  summary?: string
  description?: string
  operationId?: string
  tags?: string[]
  deprecated?: boolean
  responses?: Record<string | number, unknown>
}

export type TypedMiddleware<
  TRequest extends Request = Request,
  TRefinement extends RequestRefinement = Record<never, never>
> = ((ctx: HandlerContext<TRequest>) => HandlerReturn) & {
  readonly __validate__?: TRefinement
}

export type Handler<TRequest extends Request = Request> =
  TypedMiddleware<TRequest>
export type AnyMiddleware = TypedMiddleware<AnyRequest, RequestRefinement>
export type ErrorMiddleware<TRequest extends Request = Request> = (
  ctx: ErrorContext<TRequest>
) => void | Promise<void>

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
    : TRequest['query']
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
    : TRequest['query']
>
