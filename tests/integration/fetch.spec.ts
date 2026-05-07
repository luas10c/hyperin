import { describe, expect, test } from '@jest/globals'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { gunzipSync } from 'node:zlib'

import { hyperin } from '#/instance'
import { compress, json, serveStatic } from '#/middleware'

function getSetCookieHeaders(response: globalThis.Response): string[] {
  const headers = response.headers as Headers & {
    getSetCookie?: () => string[]
  }

  if (typeof headers.getSetCookie === 'function') {
    return headers.getSetCookie()
  }

  const header = response.headers.get('set-cookie')
  return header ? header.split(', ') : []
}

describe('fetch adapter integration', () => {
  test('preserves multiple Set-Cookie headers', async () => {
    const app = hyperin()

    app.get('/cookies', ({ response }) => {
      response.cookie('session', 'abc')
      response.cookie('theme', 'dark')
      return response.status(201).send()
    })

    const response = await app.fetch(new Request('https://example.com/cookies'))

    expect(response.status).toBe(201)
    expect(getSetCookieHeaders(response)).toEqual([
      'session=abc; Path=/',
      'theme=dark; Path=/'
    ])
  })

  test('omits response bodies for HEAD and 204 responses', async () => {
    const app = hyperin()

    app.head('/head', () => 'should-not-be-sent')
    app.get('/empty', ({ response }) => response.status(204).text('ignored'))

    const headResponse = await app.fetch(new Request('https://example.com/head', { method: 'HEAD' }))
    const emptyResponse = await app.fetch(new Request('https://example.com/empty'))

    expect(headResponse.status).toBe(200)
    await expect(headResponse.text()).resolves.toBe('')
    expect(emptyResponse.status).toBe(204)
    await expect(emptyResponse.text()).resolves.toBe('')
  })

  test('supports aborted request bodies and keeps fetch handler healthy', async () => {
    const app = hyperin()
    const abortController = new AbortController()
    const encoder = new TextEncoder()

    app.use(json())
    app.post('/users', ({ request }) => request.body as Record<string, unknown>)
    app.get('/health', () => ({ ok: true }))

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('{"name":"Ada"'))
      }
    })

    const abortedResponsePromise = app.fetch(
      new Request('https://example.com/users', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: stream,
        duplex: 'half',
        signal: abortController.signal
      })
    )

    abortController.abort()

    const abortedResponse = await abortedResponsePromise
    const healthResponse = await app.fetch(new Request('https://example.com/health'))

    expect(abortedResponse.status).toBe(400)
    await expect(abortedResponse.json()).resolves.toEqual({
      error: 'Request aborted',
      type: undefined
    })
    await expect(healthResponse.json()).resolves.toEqual({ ok: true })
  })

  test('streams binary response chunks through app.fetch', async () => {
    const app = hyperin()
    const payload = Buffer.from('hello world')

    app.get('/stream', ({ response }) => {
      response.type('application/octet-stream')
      response.write(payload.subarray(0, 5))
      response.end(payload.subarray(5))
    })

    const response = await app.fetch(new Request('https://example.com/stream'))

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('application/octet-stream')
    expect(Buffer.from(await response.arrayBuffer())).toEqual(payload)
  })

  test('works with compress middleware through app.fetch', async () => {
    const app = hyperin()

    app.use(compress({ encodings: ['gzip'], threshold: 1 }))
    app.get('/payload', () => 'a'.repeat(256))

    const response = await app.fetch(
      new Request('https://example.com/payload', {
        headers: { 'accept-encoding': 'gzip' }
      })
    )

    expect(response.status).toBe(200)
    expect(response.headers.get('content-encoding')).toBe('gzip')
    expect(gunzipSync(Buffer.from(await response.arrayBuffer())).toString('utf8')).toBe(
      'a'.repeat(256)
    )
  })

  test('works with serveStatic and conditional requests through app.fetch', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hyperin-fetch-static-'))
    await writeFile(join(dir, 'hello.txt'), 'fetch-static')

    const app = hyperin()
    app.use('/public', serveStatic(resolve(dir), { etag: true }))

    const first = await app.fetch(new Request('https://example.com/public/hello.txt'))
    const etag = first.headers.get('etag')
    const second = await app.fetch(
      new Request('https://example.com/public/hello.txt', {
        headers: { 'if-none-match': etag ?? '' }
      })
    )

    expect(first.status).toBe(200)
    await expect(first.text()).resolves.toBe('fetch-static')
    expect(etag).toBeTruthy()
    expect(second.status).toBe(304)
    await expect(second.text()).resolves.toBe('')
  })
})
