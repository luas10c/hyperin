import { describe, expect, test } from '@jest/globals'
import request from 'supertest'

import hyperin from '#/instance'
import { openapi } from '#/openapi'
import { scalar } from '#/scalar'

describe('scalar integration', () => {
  test('expoe a ui do scalar em uma rota customizada', async () => {
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
})
