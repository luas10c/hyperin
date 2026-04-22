export function parseRawUrl(rawUrl: string): {
  path: string
  rawQuery: string | null
} {
  if (!rawUrl) {
    return { path: '/', rawQuery: null }
  }

  let pathStart = 0

  if (rawUrl.startsWith('http://') || rawUrl.startsWith('https://')) {
    const authorityStart = rawUrl.indexOf('//')
    const firstSlash = rawUrl.indexOf('/', authorityStart + 2)

    if (firstSlash === -1) {
      return { path: '/', rawQuery: null }
    }

    pathStart = firstSlash
  }

  let pathEnd = rawUrl.length
  const queryStart = rawUrl.indexOf('?', pathStart)
  if (queryStart !== -1 && queryStart < pathEnd) pathEnd = queryStart

  const hashStart = rawUrl.indexOf('#', pathStart)
  if (hashStart !== -1 && hashStart < pathEnd) pathEnd = hashStart

  const rawPath = rawUrl.slice(pathStart, pathEnd)
  const path = rawPath
    ? rawPath.charCodeAt(0) === 47
      ? rawPath
      : `/${rawPath}`
    : '/'

  if (queryStart === -1) {
    return { path, rawQuery: null }
  }

  const queryEnd =
    hashStart !== -1 && hashStart > queryStart ? hashStart : rawUrl.length

  return {
    path,
    rawQuery: rawUrl.slice(queryStart + 1, queryEnd)
  }
}
