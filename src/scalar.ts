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

export type ScalarDocumentContent = string | null | Record<string, unknown>

export type ScalarPreferredSecurityScheme =
  | string
  | (string | string[])[]
  | null

export interface ScalarAuthenticationSecurityScheme {
  value?: string
  token?: string
  username?: string
  password?: string
  flows?: Record<string, unknown>
  [key: string]: unknown
}

export interface ScalarAuthenticationConfiguration {
  /**
   * Preferred OpenAPI security scheme name or AND/OR security scheme groups.
   */
  preferredSecurityScheme?: ScalarPreferredSecurityScheme

  /**
   * Values and overrides keyed by `components.securitySchemes` name.
   */
  securitySchemes?: Record<string, ScalarAuthenticationSecurityScheme>

  /**
   * Allows Scalar to show generic auth options not declared in the document.
   */
  createAnySecurityScheme?: boolean
}

export interface ScalarSource {
  default?: boolean
  url?: string
  content?: ScalarDocumentContent
  title?: string
  slug?: string
  spec?: {
    url?: string
    content?: ScalarDocumentContent
  }
  agent?: {
    key?: string
    disabled?: boolean
    hideAddApi?: boolean
  }
  [key: string]: unknown
}

export interface ScalarConfiguration {
  /**
   * Additional Scalar UI configuration passed directly to the client.
   */
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
  authentication?: ScalarAuthenticationConfiguration
  title?: string
  slug?: string
  content?: ScalarDocumentContent
  searchHotKey?: ScalarSearchHotKey
  defaultOpenFirstTag?: boolean
  defaultOpenAllTags?: boolean
  expandAllModelSections?: boolean
  expandAllResponses?: boolean
  orderSchemaPropertiesBy?: ScalarOrderSchemaPropertiesBy
  orderRequiredPropertiesFirst?: boolean
  sources?: ScalarSource[]
  [key: string]: unknown
}

export interface ScalarOptions {
  /**
   * URL path used to serve the Scalar documentation UI.
   * @default '/docs'
   */
  path?: string

  /**
   * OpenAPI document URL consumed by the Scalar UI.
   * @default '/openapi.json'
   */
  url?: string

  /**
   * OpenAPI document content passed inline to Scalar.
   */
  content?: ScalarDocumentContent

  /**
   * Scalar document title shortcut.
   */
  title?: string

  /**
   * Scalar document slug shortcut.
   */
  slug?: string

  /**
   * OpenAPI document sources consumed by Scalar. When provided, `url` is not
   * injected into the generated Scalar configuration.
   */
  sources?: ScalarSource[]

  /**
   * Authentication configuration passed to Scalar.
   */
  authentication?: ScalarAuthenticationConfiguration

  /**
   * Shortcut for `configuration.darkMode`.
   */
  darkMode?: boolean

  /**
   * Shortcut for `configuration.hideDarkModeToggle`.
   */
  hideDarkModeToggle?: boolean

  /**
   * Additional Scalar UI configuration merged into the generated page.
   */
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

function getDocumentInfo(
  content: ScalarDocumentContent | undefined
): { title?: string; description?: string } {
  if (!content || typeof content !== 'object' || Array.isArray(content)) return {}

  const info = content.info
  if (!info || typeof info !== 'object' || Array.isArray(info)) return {}
  const metadata = info as Record<string, unknown>

  return {
    ...(typeof metadata.title === 'string' && metadata.title !== ''
      ? { title: metadata.title }
      : {}),
    ...(typeof metadata.description === 'string' && metadata.description !== ''
      ? { description: metadata.description }
      : {})
  }
}

function getSourceContent(source: ScalarSource): ScalarDocumentContent | undefined {
  return source.content ?? source.spec?.content
}

function createSlug(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')

  return slug || 'openapi'
}

function getSourceSlug(source: ScalarSource, index: number): string {
  if (source.slug) return source.slug
  if (source.url) return getOpenAPISlug(source.url)
  if (source.spec?.url) return getOpenAPISlug(source.spec.url)
  if (source.title) return createSlug(source.title)

  const info = getDocumentInfo(getSourceContent(source))
  if (info.title) return createSlug(info.title)

  return `source-${index + 1}`
}

function normalizeSources(sources: ScalarSource[]): ScalarSource[] {
  const hasDefault = sources.some((source) => source.default === true)

  return sources.map((source, index) => {
    const normalized = { ...source }
    const info = getDocumentInfo(getSourceContent(source))

    normalized.slug ??= getSourceSlug(source, index)
    normalized.title ??= info.title ?? normalized.slug

    if (!hasDefault && index === 0) {
      normalized.default = true
    }

    return normalized
  })
}

function createScalarDocument(options?: ScalarOptions): string {
  const baseConfiguration = options?.configuration ?? {}
  const openapiUrl = options?.url ?? '/openapi.json'
  const content = options?.content ?? baseConfiguration.content
  const contentInfo = getDocumentInfo(content)
  const slug = options?.slug ?? baseConfiguration.slug ?? getOpenAPISlug(openapiUrl)
  const defaultTitle =
    options?.title ?? baseConfiguration.title ?? contentInfo.title ?? 'API Reference'
  const defaultDescription = contentInfo.description ?? ''
  const sources = options?.sources ?? baseConfiguration.sources
  const normalizedSources = sources ? normalizeSources(sources) : undefined
  const shouldFetchDocumentMetadata = !content && !normalizedSources
  const documentMetadataExpression = shouldFetchDocumentMetadata
    ? `fetch(${serializeScriptValue(openapiUrl)})
        .then((response) => response.ok ? response.json() : null)`
    : `Promise.resolve(${serializeScriptValue(content ?? null)})`
  const configuration = serializeScriptValue({
    ...baseConfiguration,
    ...(normalizedSources
      ? { sources: normalizedSources }
      : content !== undefined
        ? { content, slug }
        : { url: openapiUrl, slug }),
    ...(options?.title ? { title: options.title } : {}),
    ...(options?.authentication
      ? { authentication: options.authentication }
      : {}),
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

    <script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference@1.52.4" integrity="sha384-tPvZsWUisjPSa5t4cFmEhJq3K4mfQ7uXu1jPs+Nkke/8etOBqVXEdg4uOlb0RzSU" crossorigin="anonymous"></script>
    <script>
      ${documentMetadataExpression}
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
