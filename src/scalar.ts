import type { Application } from './instance'

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
  /** @default openapi.json */
  url?: string
  title?: string
  darkMode?: boolean
  hideDarkModeToggle?: boolean
  configuration?: ScalarConfiguration
}

function normalizePath(path: string | undefined, fallback: string): string {
  if (!path || path === '') return fallback
  return path.startsWith('/') ? path : `/${path}`
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function serializeScriptValue(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
}

function createScalarDocument(options?: ScalarOptions): string {
  const title = escapeHtml(options?.title ?? 'API Reference')
  const configuration = serializeScriptValue({
    ...(options?.configuration ?? {}),
    url: options?.url ?? 'openapi.json',
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
    <title>${title}</title>
  </head>
  <body>
    <div id="app"></div>

    <script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference"></script>
    <script>
      Scalar.createApiReference('#app', ${configuration})
    </script>
  </body>
</html>
`
}

export function scalar<TApp extends Pick<Application, 'get'>>(
  app: TApp,
  options: ScalarOptions
): TApp {
  const path = normalizePath(options.path, '/docs')
  const html = createScalarDocument(options)

  app.get(path, ({ response }) => {
    response.html(html)
  })

  return app
}
