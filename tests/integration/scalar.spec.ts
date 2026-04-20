import { describe, expect, test } from '@jest/globals'
import request from 'supertest'

import hyperin from '#/instance'
import { scalar } from '#/scalar'

describe('scalar integration', () => {
  test('expoe a ui do scalar em uma rota customizada', async () => {
    const app = hyperin()

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
    expect(response.text).toContain('"url":"/openapi.json"')
    expect(response.text).toContain('"theme":"purple"')
    expect(response.text).toContain('"proxyUrl":"https://proxy.scalar.test"')
    expect(response.text).toContain('"layout":"modern"')
  })
})
