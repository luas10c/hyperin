import { describe, expect, test } from '@jest/globals'
import { request as sendHttpRequest } from 'node:http'
import type { Readable } from 'node:stream'
import request, { type Response } from 'supertest'

import { hyperin } from '#/instance'
import { multipart, type FileInfo } from '#/middleware/multipart'

type UploadedFile = {
  fieldname: string
  filename: string
  mimetype: string
  encoding: string
  size: number
  content: string
}

type UploadResponse = {
  body: Record<string, unknown>
  files: {
    avatar: UploadedFile
  }
}

type MultipartErrorResponse = {
  statusCode: number
  path: string
  message: string
}

describe('multipart middleware', () => {
  test('parses fields and files with onFile', async () => {
    const app = hyperin()

    app.use(
      multipart({
        onFile: async (stream: Readable, info: FileInfo) => {
          const chunks: Buffer[] = []

          for await (const chunk of stream) {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
          }

          return {
            ...info,
            content: Buffer.concat(chunks).toString('utf8')
          }
        }
      })
    )

    app.post('/upload', ({ request }) => ({
      body: request.body,
      files: request.files
    }))

    const response: Response = await request(app)
      .post('/upload')
      .field('title', 'hello')
      .attach('avatar', Buffer.from('abc'), {
        filename: 'a.txt',
        contentType: 'text/plain'
      })

    expect(response.status).toBe(200)
    expect(response.body as UploadResponse).toEqual({
      body: { title: 'hello' },
      files: {
        avatar: {
          fieldname: 'avatar',
          filename: 'a.txt',
          mimetype: 'text/plain',
          encoding: '7bit',
          size: 3,
          content: 'abc'
        }
      }
    })
  })

  test('returns 400 when boundary is missing', async () => {
    const app = hyperin()

    app.use(multipart())
    app.post(
      '/upload',
      ({ request }) => request.body as Record<string, unknown>
    )

    const response: Response = await request(app)
      .post('/upload')
      .set('Content-Type', 'multipart/form-data')
      .send('abc')

    expect(response.status).toBe(400)
    expect(response.body as MultipartErrorResponse).toEqual({
      statusCode: 400,
      error: 'Missing multipart boundary',
      method: 'POST'
    })
  })

  test('returns 413 when multipart body exceeds configured limit', async () => {
    const app = hyperin()

    app.use(multipart({ limits: { bodySize: 4 } }))
    app.post(
      '/upload',
      ({ request }) => request.body as Record<string, unknown>
    )

    const response: Response = await request(app)
      .post('/upload')
      .field('title', 'hello')

    expect(response.status).toBe(413)
    expect(response.body).toEqual({
      statusCode: 413,
      error: 'Payload Too Large',
      method: 'POST'
    })
  })

  test('falls through when content-type is not multipart/form-data', async () => {
    const app = hyperin()

    app.use(multipart())
    app.post('/upload', ({ request }) => ({ files: request.files }))

    const response: Response = await request(app)
      .post('/upload')
      .set('Content-Type', 'application/json')
      .send({ ok: true })

    expect(response.status).toBe(200)
    expect(response.body).toEqual({ files: {} })
  })

  test('returns 413 when uploaded file exceeds fileSize limit', async () => {
    const app = hyperin()

    app.use(multipart({ limits: { fileSize: 2 } }))
    app.post('/upload', ({ request }) => ({
      body: request.body,
      files: request.files
    }))

    const response: Response = await request(app)
      .post('/upload')
      .attach('avatar', Buffer.from('abc'), {
        filename: 'a.txt',
        contentType: 'text/plain'
      })

    expect(response.status).toBe(413)
    expect(response.body).toEqual({
      statusCode: 413,
      error: 'File "a.txt" exceeds size limit of 2 bytes',
      method: 'POST'
    })
  })

  test('exposes the incoming file stream before the whole upload finishes', async () => {
    const app = hyperin()
    let resolveFirstChunk: (() => void) | undefined
    const firstChunkSeen = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error('stream did not start in time')),
        500
      )

      resolveFirstChunk = () => {
        clearTimeout(timeout)
        resolve()
      }
    })

    app.use(
      multipart({
        onFile: async (stream: Readable, info: FileInfo) => {
          const chunks: Buffer[] = []
          let seen = false

          for await (const chunk of stream) {
            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
            chunks.push(buffer)

            if (!seen) {
              seen = true
              resolveFirstChunk?.()
            }
          }

          return {
            ...info,
            content: Buffer.concat(chunks).toString('utf8')
          }
        }
      })
    )

    app.post('/upload', ({ request }) => request.files)

    const server = app.listen(0)
    const address = server.address()
    const port = typeof address === 'object' && address ? address.port : 0
    const boundary = '----hyperin-stream-test'
    const partHeader =
      `--${boundary}\r\n` +
      'Content-Disposition: form-data; name="avatar"; filename="a.txt"\r\n' +
      'Content-Type: text/plain\r\n\r\n'
    const firstBodyChunk = 'a'.repeat(64)
    const lastBodyChunk = 'b'.repeat(32)
    const firstChunk = Buffer.from(partHeader + firstBodyChunk)
    const secondChunk = Buffer.from(`${lastBodyChunk}\r\n--${boundary}--\r\n`)

    try {
      const response = await new Promise<{ status: number; body: string }>(
        (resolve, reject) => {
          const req = sendHttpRequest(
            {
              method: 'POST',
              port,
              path: '/upload',
              headers: {
                'Content-Type': `multipart/form-data; boundary=${boundary}`,
                'Content-Length': String(firstChunk.length + secondChunk.length)
              }
            },
            (res) => {
              const chunks: Buffer[] = []
              res.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
              res.on('end', () =>
                resolve({
                  status: res.statusCode ?? 0,
                  body: Buffer.concat(chunks).toString('utf8')
                })
              )
            }
          )

          req.on('error', reject)
          req.write(firstChunk)
          firstChunkSeen
            .then(() => {
              req.write(secondChunk)
              req.end()
            })
            .catch(reject)
        }
      )

      expect(response.status).toBe(200)
      expect(JSON.parse(response.body)).toEqual({
        avatar: {
          fieldname: 'avatar',
          filename: 'a.txt',
          mimetype: 'text/plain',
          encoding: '7bit',
          size: 96,
          content: `${firstBodyChunk}${lastBodyChunk}`
        }
      })
      await expect(firstChunkSeen).resolves.toBeUndefined()
    } finally {
      await app.shutdown()
    }
  })
})
