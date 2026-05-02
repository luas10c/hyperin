import { describe, expect, test } from '@jest/globals'
import request from 'supertest'

import hyperin from '#/instance'
import { openapi } from '#/openapi'
import { scalar } from '#/scalar'

describe('Scalar integration', () => {
  test('exposes the scalar UI on a custom route', async () => {
    const app = hyperin()

    openapi(app, {
      documentation: {
        info: {
          title: 'Framework API',
          description: 'Framework HTTP API reference',
          version: '1.0.0'
        }
      }
    })

    scalar(app, {
      path: '/docs',
      url: '/openapi.json',
      configuration: {
        theme: 'purple',
        proxyUrl: 'https://proxy.scalar.test',
        layout: 'modern'
      }
    })

    const response = await request(app).get('/docs')

    expect(response.status).toBe(200)
    expect(response.headers['content-type']).toContain('text/html')
    expect(response.text).toContain(
      'https://cdn.jsdelivr.net/npm/@scalar/api-reference'
    )
    expect(response.text).toContain("Scalar.createApiReference('#app', {")
    expect(response.text).toContain('fetch("/openapi.json")')
    expect(response.text).toContain('<meta name="description" content="" />')
    expect(response.text).toContain('<title>API Reference</title>')
    expect(response.text).toContain('"url":"/openapi.json"')
    expect(response.text).toContain('"slug":"openapi"')
    expect(response.text).toContain('"theme":"purple"')
    expect(response.text).toContain('"proxyUrl":"https://proxy.scalar.test"')
    expect(response.text).toContain('"layout":"modern"')
    expect(response.text).toContain('document.title = title')
    expect(response.text).toContain(
      `descriptionElement.setAttribute('content', description)`
    )
  })

  test('passes multiple sources without injecting a default url', async () => {
    const app = hyperin()

    scalar(app, {
      path: '/reference',
      sources: [
        {
          title: 'Public API',
          slug: 'public',
          url: '/openapi.json'
        },
        {
          title: 'Admin API',
          slug: 'admin',
          url: '/admin/openapi.json'
        }
      ],
      configuration: {
        theme: 'purple'
      }
    })

    const response = await request(app).get('/reference')

    expect(response.status).toBe(200)
    expect(response.text).toContain('"sources":[{"title":"Public API"')
    expect(response.text).toContain('"slug":"admin"')
    expect(response.text).toContain('"url":"/admin/openapi.json"')
    expect(response.text).not.toContain(
      '"url":"/openapi.json","slug":"openapi"'
    )
    expect(response.text).not.toContain('fetch("/openapi.json")')
    expect(response.text).toContain('"theme":"purple"')
  })

  test('passes inline content to Scalar without fetching a spec url', async () => {
    const app = hyperin()

    scalar(app, {
      path: '/inline-docs',
      content: {
        openapi: '3.1.1',
        info: {
          title: 'Inline API',
          description: 'Inline API description',
          version: '1.0.0'
        },
        paths: {}
      }
    })

    const response = await request(app).get('/inline-docs')

    expect(response.status).toBe(200)
    expect(response.text).toContain('"content":{"openapi":"3.1.1"')
    expect(response.text).toContain('"slug":"openapi"')
    expect(response.text).toContain('<title>Inline API</title>')
    expect(response.text).toContain(
      '<meta name="description" content="Inline API description" />'
    )
    expect(response.text).toContain('Promise.resolve({"openapi":"3.1.1"')
    expect(response.text).not.toContain('fetch("/openapi.json")')
  })

  test('normalizes configuration sources with default title and slug', async () => {
    const app = hyperin()

    scalar(app, {
      path: '/multi-docs',
      configuration: {
        sources: [
          {
            url: '/public/openapi.json'
          },
          {
            content: {
              openapi: '3.1.1',
              info: {
                title: 'Admin API',
                version: '1.0.0'
              },
              paths: {}
            }
          }
        ]
      }
    })

    const response = await request(app).get('/multi-docs')

    expect(response.status).toBe(200)
    expect(response.text).toContain(
      '"sources":[{"url":"/public/openapi.json","slug":"openapi","title":"openapi","default":true}'
    )
    expect(response.text).toContain('"slug":"admin-api"')
    expect(response.text).toContain('"title":"Admin API"')
    expect(response.text).not.toContain('fetch("/openapi.json")')
  })

  test('passes authentication configuration to Scalar', async () => {
    const app = hyperin()

    scalar(app, {
      path: '/docs',
      authentication: {
        preferredSecurityScheme: 'bearerAuth',
        securitySchemes: {
          bearerAuth: {
            token: 'test-token'
          },
          apiKeyAuth: {
            value: 'test-api-key'
          }
        },
        createAnySecurityScheme: true
      }
    })

    const response = await request(app).get('/docs')

    expect(response.status).toBe(200)
    expect(response.text).toContain('"authentication":{')
    expect(response.text).toContain('"preferredSecurityScheme":"bearerAuth"')
    expect(response.text).toContain('"token":"test-token"')
    expect(response.text).toContain('"value":"test-api-key"')
    expect(response.text).toContain('"createAnySecurityScheme":true')
  })
})
