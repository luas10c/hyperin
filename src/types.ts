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
