import instance from './instance'
import { cors } from './cors'
import { json, urlencoded } from './body'
import { validate } from './validate'
import { multipart } from './multipart'
import { serveStatic } from './serve-static'

export * from './instance'
export * from './cors'
export * from './body'
export * from './validate'
export * from './multipart'
export * from './serve-static'

const hyperin = Object.assign(instance, {
  cors,
  json,
  urlencoded,
  validate,
  multipart,
  static: serveStatic
})

export default hyperin
