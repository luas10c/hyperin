import riseway from './instance'
import { cors, json, urlencoded, multipart, serveStatic } from './middleware'

export * from './instance'
export * from './middleware'

const highen = Object.assign(riseway, {
  cors,
  json,
  urlencoded,
  multipart,
  static: serveStatic
})

export default highen
