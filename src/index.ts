import instance from './instance'
import { cors } from './cors'
import { json, urlencoded } from './body'
import { multipart } from './multipart'
import { serveStatic } from './serve-static'

export * from './instance'
export * from './cors'
export * from './body'
export * from './multipart'
export * from './serve-static'

const hyperin = Object.assign(instance, {
  cors,
  json,
  urlencoded,
  multipart,
  static: serveStatic
})

export default hyperin
