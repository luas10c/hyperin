import type { Application } from './instance'

function getOpenAPISlug(url: string): string {
  const pathname = url.split('?')[0]?.split('#')[0] ?? ''
  const segment = pathname.split('/').filter(Boolean).pop() ?? 'openapi.json'
  const [name] = segment.split('.')

  return name || 'openapi'
}

export type ScalarTheme =
  | 'default'
  | 'alternate'
  | 'moon'
  | 'purple'
  | 'solarized'
  | 'bluePlanet'
  | 'deepSpace'
  | 'saturn'
  | 'kepler'
  | 'elysiajs'
  | 'fastify'
  | 'mars'
  | 'laserwave'
  | 'none'

export type ScalarLayout = 'modern' | 'classic'

export type ScalarDeveloperToolsVisibility = 'never' | 'always' | 'localhost'

export type ScalarDocumentDownloadType =
  | 'none'
  | 'yaml'
  | 'json'
  | 'both'
  | 'direct'

export type ScalarOperationTitleSource = 'summary' | 'path'

export type ScalarSearchHotKey =
  | 'a'
  | 'b'
  | 'c'
  | 'd'
  | 'e'
  | 'f'
  | 'g'
  | 'h'
  | 'i'
  | 'j'
  | 'k'
  | 'l'
  | 'm'
  | 'n'
  | 'o'
  | 'p'
  | 'q'
  | 'r'
  | 's'
  | 't'
  | 'u'
  | 'v'
  | 'w'
  | 'x'
  | 'y'
  | 'z'

export type ScalarOrderSchemaPropertiesBy = 'alpha' | 'preserve'

export interface ScalarConfiguration {
  theme?: ScalarTheme
  layout?: ScalarLayout
  showSidebar?: boolean
  hideModels?: boolean
  hideSearch?: boolean
  showOperationId?: boolean
  darkMode?: boolean
  hideDarkModeToggle?: boolean
  documentDownloadType?: ScalarDocumentDownloadType
  operationTitleSource?: ScalarOperationTitleSource
  showDeveloperTools?: ScalarDeveloperToolsVisibility
  proxyUrl?: string
  baseServerURL?: string
  searchHotKey?: ScalarSearchHotKey
  defaultOpenFirstTag?: boolean
  defaultOpenAllTags?: boolean
  expandAllModelSections?: boolean
  expandAllResponses?: boolean
  orderSchemaPropertiesBy?: ScalarOrderSchemaPropertiesBy
  orderRequiredPropertiesFirst?: boolean
  [key: string]: unknown
}

export interface ScalarOptions {
  /** @default /docs */
  path?: string
  /** @default /openapi.json */
  url?: string
  darkMode?: boolean
  hideDarkModeToggle?: boolean
  configuration?: ScalarConfiguration
}

function normalizePath(path: string | undefined, fallback: string): string {
  if (!path || path === '') return fallback
  return path.startsWith('/') ? path : `/${path}`
}

function serializeScriptValue(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
}

function createScalarDocument(options?: ScalarOptions): string {
  const openapiUrl = options?.url ?? '/openapi.json'
  const slug = getOpenAPISlug(openapiUrl)
  const defaultTitle = 'API Reference'
  const defaultDescription = ''
  const configuration = serializeScriptValue({
    ...(options?.configuration ?? {}),
    url: openapiUrl,
    slug,
    ...(typeof options?.darkMode === 'boolean'
      ? { darkMode: options.darkMode }
      : {}),
    ...(typeof options?.hideDarkModeToggle === 'boolean'
      ? { hideDarkModeToggle: options.hideDarkModeToggle }
      : {})
  })

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="description" content="${defaultDescription}" />
    <title>${defaultTitle}</title>
  </head>
  <body>
    <div id="app"></div>

    <script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference"></script>
    <script>
      fetch(${serializeScriptValue(openapiUrl)})
        .then((response) => response.ok ? response.json() : null)
        .then((documentSpec) => {
          const descriptionElement = document.querySelector('meta[name="description"]')
          const title =
            typeof documentSpec?.info?.title === 'string' &&
            documentSpec.info.title !== ''
              ? documentSpec.info.title
              : ${serializeScriptValue(defaultTitle)}
          const description =
            typeof documentSpec?.info?.description === 'string' &&
            documentSpec.info.description !== ''
              ? documentSpec.info.description
              : ${serializeScriptValue(defaultDescription)}

          document.title = title

          if (descriptionElement) {
            descriptionElement.setAttribute('content', description)
          }

          Scalar.createApiReference('#app', ${configuration})
        })
        .catch(() => {
          const descriptionElement = document.querySelector('meta[name="description"]')

          document.title = ${serializeScriptValue(defaultTitle)}

          if (descriptionElement) {
            descriptionElement.setAttribute(
              'content',
              ${serializeScriptValue(defaultDescription)}
            )
          }

          Scalar.createApiReference('#app', ${configuration})
        })
    </script>
  </body>
</html>
`
}

export function scalar<TApp extends Pick<Application, 'get'>>(
  app: TApp,
  options?: ScalarOptions
): TApp {
  const path = normalizePath(options?.path, '/docs')
  const html = createScalarDocument(options)

  app.get(path, ({ response }) => {
    response.html(html)
  })

  return app
}
