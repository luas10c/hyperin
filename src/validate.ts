import type { Request } from './request'
import type { Response } from './response'

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

function isZodLike(s: any): s is MaybeZodLike {
  return s != null && typeof s.safeParse === 'function'
}

function createValidator(
  source: 'body' | 'params' | 'query',
  schema: SchemaInput
): Middleware {
  return async ({ request, response, next }) => {
    const data = (request as unknown as { [key: string]: unknown })[source]

    if (isZodLike(schema)) {
      const result = (schema as MaybeZodLike).safeParse(data)
      if (result.success) {
        const reqLike = request as unknown as { [key: string]: unknown }
        reqLike[source] = result.data
        return next()
      }
      const errorObj = (result as { error?: unknown }).error as unknown
      const hasFormat =
        typeof (errorObj as { format?: () => unknown }).format === 'function'
      const detailsValue = (errorObj as { message?: unknown }).message
      const err = hasFormat
        ? (errorObj as { format: () => unknown }).format()
        : {
            message: 'Validation error',
            details: detailsValue ?? errorObj
          }
      return void response.status(400).json({ error: err })
    }

    // Standards Schema validation via dynamic import
    try {
      const { default: Standards } = await import('standardschema')
      let ok = true
      let details: unknown = undefined
      if (typeof Standards?.validate === 'function') {
        const r = Standards.validate(schema as unknown, data)
        let resolved = true
        let localDetails: unknown = details
        if (r instanceof Promise) {
          const rr = await r
          if (typeof rr === 'boolean') {
            resolved = rr
          } else {
            const v = (rr as { valid?: boolean }).valid
            if (typeof v === 'boolean') resolved = v
            else resolved = true
            if ((rr as any).errors !== undefined)
              localDetails = (rr as any).errors
          }
        } else {
          if (typeof r === 'boolean') {
            resolved = r
          } else {
            const v = (r as { valid?: boolean }).valid
            if (typeof v === 'boolean') resolved = v
            else resolved = true
            if ((r as any).errors !== undefined)
              localDetails = (r as any).errors
          }
        }
        ok = resolved
        details = localDetails
      } else if (typeof Standards?.compile === 'function') {
        const validator = Standards.compile(schema as unknown)
        const r = validator(data) as unknown
        type StdCompileResult = { valid?: boolean; errors?: unknown }
        if (r instanceof Promise) {
          const rr = await r
          if (typeof rr === 'boolean') ok = rr
          else {
            const v = (rr as StdCompileResult).valid
            ok = typeof v === 'boolean' ? v : true
            if ((rr as StdCompileResult).errors !== undefined)
              details = (rr as StdCompileResult).errors
          }
        } else {
          if (typeof r === 'boolean') ok = r
          else {
            const v = (r as StdCompileResult).valid
            ok = typeof v === 'boolean' ? v : true
            if ((r as StdCompileResult).errors !== undefined)
              details = (r as StdCompileResult).errors
          }
        }
      } else {
        ok = true
      }
      if (ok) return next()
      return void response
        .status(400)
        .json({ error: 'Validation failed', details })
    } catch {
      // If Standards Schema library isn't available, skip strict validation but continue
      return next()
    }
  }
}

export const validate = {
  body: (schema: SchemaInput) => createValidator('body', schema),
  params: (schema: SchemaInput) => createValidator('params', schema),
  query: (schema: SchemaInput) => createValidator('query', schema)
}
