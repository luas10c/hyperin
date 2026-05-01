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

async function sendRawMultipart(
  app: ReturnType<typeof hyperin>,
  options: {
    body: Buffer | string
    boundary: string
    path?: string
    contentType?: string
  }
): Promise<{ status: number; body: string }> {
  const server = app.listen(0)
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  const body = Buffer.isBuffer(options.body)
    ? options.body
    : Buffer.from(options.body)

  try {
    return await new Promise((resolve, reject) => {
      const req = sendHttpRequest(
        {
          method: 'POST',
          port,
          path: options.path ?? '/upload',
          headers: {
            'Content-Type':
              options.contentType ??
              `multipart/form-data; boundary=${options.boundary}`,
            'Content-Length': String(body.length)
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
      req.end(body)
    })
  } finally {
    await app.shutdown()
  }
}

describe('multipart middleware', () => {
  test('parses fields and files with onFile', async () => {
    const app = hyperin()

    app.use(
      multipart({
        onFile: async ({
          stream,
          info
        }: {
          stream: Readable
          info: FileInfo
        }) => {
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

    app.use(multipart({ limits: { totalSize: 4 } }))
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

  test('returns 413 when a single file field exceeds its maxFileSize limit', async () => {
    const app = hyperin()

    app.use(
      multipart({
        fields: {
          avatar: {
            kind: 'single',
            maxFileSize: 2
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
      .attach('avatar', Buffer.from('abc'), {
        filename: 'a.txt',
        contentType: 'text/plain'
      })

    expect(response.status).toBe(413)
    expect(response.body).toEqual({
      statusCode: 413,
      error: 'Field "avatar" exceeds maxFileSize limit of 2 bytes',
      method: 'POST'
    })
  })

  test('returns maxFileSize errors before the multipart request finishes', async () => {
    const app = hyperin()

    app.use(
      multipart({
        fields: {
          avatar: {
            kind: 'single',
            maxFileSize: 2
          }
        }
      })
    )
    app.post('/upload', ({ request }) => request.files)

    const server = app.listen(0)
    const address = server.address()
    const port = typeof address === 'object' && address ? address.port : 0
    const boundary = 'early-limit-boundary'
    const bodyStart =
      `--${boundary}\r\n` +
      'Content-Disposition: form-data; name="avatar"; filename="a.txt"\r\n' +
      'Content-Type: text/plain\r\n\r\n' +
      'a'.repeat(64)

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
                'Content-Length': String(1024)
              }
            },
            (res) => {
              const chunks: Buffer[] = []
              res.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
              res.on('end', () => {
                req.destroy()
                resolve({
                  status: res.statusCode ?? 0,
                  body: Buffer.concat(chunks).toString('utf8')
                })
              })
            }
          )

          req.on('error', (error: NodeJS.ErrnoException) => {
            if (error.code !== 'ECONNRESET') reject(error)
          })
          req.write(bodyStart)
        }
      )

      expect(response.status).toBe(413)
      expect(JSON.parse(response.body)).toEqual({
        statusCode: 413,
        error: 'Field "avatar" exceeds maxFileSize limit of 2 bytes',
        method: 'POST'
      })
    } finally {
      await app.shutdown()
    }
  })

  test('returns 400 when a required file field is missing', async () => {
    const app = hyperin()

    app.use(
      multipart({
        fields: {
          avatar: {
            kind: 'single'
          }
        }
      })
    )
    app.post('/upload', ({ request }) => request.files)

    const response: Response = await request(app)
      .post('/upload')
      .field('title', 'hello')

    expect(response.status).toBe(400)
    expect(response.body).toEqual({
      statusCode: 400,
      error: 'Missing required multipart file field "avatar"',
      method: 'POST'
    })
  })

  test('allows missing file fields when required is false', async () => {
    const app = hyperin()

    app.use(
      multipart({
        fields: {
          avatar: {
            kind: 'single',
            required: false
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

    expect(response.status).toBe(200)
    expect(response.body).toEqual({
      body: { title: 'hello' },
      files: {}
    })
  })

  test('returns 413 when an array file exceeds its maxFileSize limit', async () => {
    const app = hyperin()

    app.use(
      multipart({
        fields: {
          gallery: {
            kind: 'array',
            maxFiles: 2,
            maxFileSize: 2
          }
        }
      })
    )
    app.post('/upload', ({ request }) => request.files)

    const response: Response = await request(app)
      .post('/upload')
      .attach('gallery', Buffer.from('abc'), {
        filename: 'a.txt',
        contentType: 'text/plain'
      })

    expect(response.status).toBe(413)
    expect(response.body).toEqual({
      statusCode: 413,
      error: 'Field "gallery" exceeds maxFileSize limit of 2 bytes',
      method: 'POST'
    })
  })

  test('accepts unlimited array files and sizes when limits are omitted', async () => {
    const app = hyperin()

    app.use(
      multipart({
        fields: {
          gallery: {
            kind: 'array'
          }
        },
        onFile: async ({ stream, info }) => {
          stream.resume()
          return info
        }
      })
    )
    app.post('/upload', ({ request }) => request.files)

    const response: Response = await request(app)
      .post('/upload')
      .attach('gallery', Buffer.from('abc'), {
        filename: 'a.txt',
        contentType: 'text/plain'
      })
      .attach('gallery', Buffer.from('defg'), {
        filename: 'b.txt',
        contentType: 'text/plain'
      })

    expect(response.status).toBe(200)
    expect(response.body.gallery).toEqual([
      expect.objectContaining({ filename: 'a.txt', size: 3 }),
      expect.objectContaining({ filename: 'b.txt', size: 4 })
    ])
  })

  test('processes single and array file fields without reusing streams', async () => {
    const app = hyperin()

    app.use(
      multipart({
        fields: {
          avatar: {
            kind: 'single'
          },
          photos: {
            kind: 'array'
          }
        },
        onFile: async ({ stream, info }) => {
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
    app.post('/upload', ({ request }) => request.files)

    const response: Response = await request(app)
      .post('/upload')
      .attach('avatar', Buffer.from('avatar'), {
        filename: 'avatar.jpg',
        contentType: 'image/jpeg'
      })
      .attach('photos', Buffer.from('photo-1'), {
        filename: 'photo-1.jpg',
        contentType: 'image/jpeg'
      })
      .attach('photos', Buffer.from('photo-2'), {
        filename: 'photo-2.jpg',
        contentType: 'image/jpeg'
      })

    expect(response.status).toBe(200)
    expect(response.body).toEqual({
      avatar: expect.objectContaining({
        fieldname: 'avatar',
        filename: 'avatar.jpg',
        content: 'avatar'
      }),
      photos: [
        expect.objectContaining({
          fieldname: 'photos',
          filename: 'photo-1.jpg',
          content: 'photo-1'
        }),
        expect.objectContaining({
          fieldname: 'photos',
          filename: 'photo-2.jpg',
          content: 'photo-2'
        })
      ]
    })
  })

  test('rejects file fields with unsupported MIME types', async () => {
    const app = hyperin()

    app.use(
      multipart({
        fields: {
          avatar: {
            kind: 'single',
            mimeTypes: ['image/png', 'image/jpeg']
          }
        }
      })
    )
    app.post('/upload', ({ request }) => request.files)

    const response: Response = await request(app)
      .post('/upload')
      .attach('avatar', Buffer.from('abc'), {
        filename: 'a.txt',
        contentType: 'text/plain'
      })

    expect(response.status).toBe(415)
    expect(response.body).toEqual({
      statusCode: 415,
      error:
        'Field "avatar" only accepts files with MIME types: image/png, image/jpeg. Received: text/plain',
      method: 'POST'
    })
  })

  test('accepts generic octet-stream uploads when filename extension matches mimeTypes', async () => {
    const app = hyperin()

    app.use(
      multipart({
        fields: {
          avatar: {
            kind: 'single',
            mimeTypes: ['image/png', 'image/jpg', 'image/jpeg']
          }
        },
        onFile: async ({ stream, info }) => {
          stream.resume()
          return info
        }
      })
    )
    app.post('/upload', ({ request }) => request.files)

    const response: Response = await request(app)
      .post('/upload')
      .attach('avatar', Buffer.from('abc'), {
        filename: '292553415_442224927910336_3444365576393536002_n.jpg',
        contentType: 'application/octet-stream'
      })

    expect(response.status).toBe(200)
    expect(response.body.avatar).toEqual(
      expect.objectContaining({
        filename: '292553415_442224927910336_3444365576393536002_n.jpg',
        mimetype: 'image/jpeg'
      })
    )
  })

  test('accepts multipart content type lists sent from OpenAPI encoding', async () => {
    const app = hyperin()

    app.use(
      multipart({
        fields: {
          avatar: {
            kind: 'single',
            mimeTypes: ['image/png', 'image/jpg', 'image/jpeg']
          }
        },
        onFile: async ({ stream, info }) => {
          stream.resume()
          return info
        }
      })
    )
    app.post('/upload', ({ request }) => request.files)

    const response: Response = await request(app)
      .post('/upload')
      .attach('avatar', Buffer.from('abc'), {
        filename: 'avatar.jpg',
        contentType: 'image/png, image/jpg, image/jpeg'
      })

    expect(response.status).toBe(200)
    expect(response.body.avatar).toEqual(
      expect.objectContaining({
        filename: 'avatar.jpg',
        mimetype: 'image/jpeg'
      })
    )
  })

  test('accepts any file type when mimeTypes is omitted', async () => {
    const app = hyperin()

    app.use(
      multipart({
        fields: {
          avatar: {
            kind: 'single'
          }
        },
        onFile: async ({ stream, info }) => {
          stream.resume()
          return info
        }
      })
    )
    app.post('/upload', ({ request }) => request.files)

    const response: Response = await request(app)
      .post('/upload')
      .attach('avatar', Buffer.from('abc'), {
        filename: 'a.txt',
        contentType: 'text/plain'
      })

    expect(response.status).toBe(200)
    expect(response.body).toEqual({
      avatar: {
        fieldname: 'avatar',
        filename: 'a.txt',
        mimetype: 'text/plain',
        encoding: '7bit',
        size: 3
      }
    })
  })

  test('returns an error when onFile rejects without hanging the upload', async () => {
    const app = hyperin()

    app.use(
      multipart({
        onFile: async () => {
          throw new Error('upload failed')
        }
      })
    )
    app.post('/upload', ({ request }) => request.files)

    const response: Response = await request(app)
      .post('/upload')
      .attach('avatar', Buffer.from('abc'), {
        filename: 'a.txt',
        contentType: 'text/plain'
      })

    expect(response.status).toBe(400)
    expect(response.body).toEqual({
      statusCode: 400,
      error: 'upload failed',
      method: 'POST'
    })
  })

  test('rejects malformed multipart payload variants', async () => {
    const cases = [
      {
        name: 'invalid opening boundary',
        body: 'oops\r\nContent-Disposition: form-data; name="a"\r\n\r\n1',
        expectedError: 'Malformed multipart body'
      },
      {
        name: 'missing final boundary',
        body:
          '--test-boundary\r\n' +
          'Content-Disposition: form-data; name="a"\r\n\r\n' +
          '1',
        expectedError: 'Unexpected end of multipart body'
      },
      {
        name: 'invalid boundary separator',
        body:
          '--test-boundary\r\n' +
          'Content-Disposition: form-data; name="a"\r\n\r\n' +
          '1\r\n' +
          '--test-boundaryxx',
        expectedError: 'Malformed multipart body'
      },
      {
        name: 'malformed part header line',
        body:
          '--test-boundary\r\n' +
          'Content-Disposition form-data; name="a"\r\n\r\n' +
          '1\r\n' +
          '--test-boundary--\r\n',
        expectedError: 'Malformed multipart headers'
      }
    ]

    for (const testCase of cases) {
      const app = hyperin()
      app.use(multipart())
      app.post(
        '/upload',
        ({ request }) => request.body as Record<string, unknown>
      )

      const response = await sendRawMultipart(app, {
        boundary: 'test-boundary',
        body: testCase.body
      })

      expect(response.status).toBe(400)
      expect(JSON.parse(response.body)).toEqual({
        statusCode: 400,
        error: testCase.expectedError,
        method: 'POST'
      })
    }
  })

  test('rejects duplicate headers within a multipart part', async () => {
    const app = hyperin()
    app.use(multipart())
    app.post(
      '/upload',
      ({ request }) => request.body as Record<string, unknown>
    )

    const response = await sendRawMultipart(app, {
      boundary: 'dup-boundary',
      body:
        '--dup-boundary\r\n' +
        'Content-Disposition: form-data; name="a"\r\n' +
        'Content-Disposition: form-data; name="b"\r\n\r\n' +
        '1\r\n' +
        '--dup-boundary--\r\n'
    })

    expect(response.status).toBe(400)
    expect(JSON.parse(response.body)).toEqual({
      statusCode: 400,
      error: 'Duplicate multipart header: content-disposition',
      method: 'POST'
    })
  })

  test('rejects array file fields with too many uploaded files', async () => {
    const app = hyperin()

    app.use(
      multipart({
        fields: {
          gallery: {
            kind: 'array',
            maxFiles: 10,
            maxFileSize: 1024
          }
        }
      })
    )
    app.post('/upload', ({ request }) => request.files)

    let req = request(app).post('/upload')
    for (let i = 0; i < 11; i++) {
      req = req.attach('gallery', Buffer.from(String(i)), {
        filename: `${i}.txt`,
        contentType: 'text/plain'
      })
    }

    const response: Response = await req

    expect(response.status).toBe(413)
    expect(response.body).toEqual({
      statusCode: 413,
      error: 'Field "gallery" exceeds maxFiles limit of 10',
      method: 'POST'
    })
  })

  test('rejects unexpected multipart file fields when allowlist is configured', async () => {
    const app = hyperin()

    app.use(
      multipart({
        fields: {
          avatar: {
            kind: 'single',
            maxFileSize: 1024
          }
        }
      })
    )
    app.post('/upload', ({ request }) => request.files)

    const response: Response = await request(app)
      .post('/upload')
      .attach('unexpected', Buffer.from('abc'), {
        filename: 'a.txt',
        contentType: 'text/plain'
      })

    expect(response.status).toBe(400)
    expect(response.body).toEqual({
      statusCode: 400,
      error: 'Unexpected multipart file field "unexpected"',
      method: 'POST'
    })
  })

  test('supports array file fields and accumulates request.files[fieldname]', async () => {
    const app = hyperin()

    app.use(
      multipart({
        fields: {
          gallery: {
            kind: 'array',
            maxFiles: 2,
            maxFileSize: 16
          }
        },
        onFile: async ({
          stream,
          info
        }: {
          stream: Readable
          info: FileInfo
        }) => {
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
    app.post('/upload', ({ request }) => request.files)

    const response: Response = await request(app)
      .post('/upload')
      .attach('gallery', Buffer.from('ab'), {
        filename: '1.txt',
        contentType: 'text/plain'
      })
      .attach('gallery', Buffer.from('cd'), {
        filename: '2.txt',
        contentType: 'text/plain'
      })

    expect(response.status).toBe(200)
    expect(response.body).toEqual({
      gallery: [
        {
          fieldname: 'gallery',
          filename: '1.txt',
          mimetype: 'text/plain',
          encoding: '7bit',
          size: 2,
          content: 'ab'
        },
        {
          fieldname: 'gallery',
          filename: '2.txt',
          mimetype: 'text/plain',
          encoding: '7bit',
          size: 2,
          content: 'cd'
        }
      ]
    })
  })

  test('respects stream.highWaterMark for onFile streams', async () => {
    const app = hyperin()
    let writableHighWaterMark = 0

    app.use(
      multipart({
        stream: {
          highWaterMark: 1024
        },
        onFile: async ({ stream }) => {
          const readableStream = stream as Readable & {
            readableHighWaterMark?: number
          }
          writableHighWaterMark = readableStream.readableHighWaterMark ?? 0
          stream.resume()
        }
      })
    )
    app.post('/upload', ({ response }) => response.send('ok'))

    const response: Response = await request(app)
      .post('/upload')
      .attach('avatar', Buffer.from('abc'), {
        filename: 'a.txt',
        contentType: 'text/plain'
      })

    expect(response.status).toBe(200)
    expect(writableHighWaterMark).toBe(1024)
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
        onFile: async ({
          stream,
          info
        }: {
          stream: Readable
          info: FileInfo
        }) => {
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

  test('accepts a long quoted boundary and chunked body splits', async () => {
    const app = hyperin()
    const boundary = `hyperin-${'x'.repeat(180)}`
    const body =
      `--${boundary}\r\n` +
      'Content-Disposition: form-data; name="title"\r\n\r\n' +
      'hello\r\n' +
      `--${boundary}--\r\n`

    app.use(multipart())
    app.post(
      '/upload',
      ({ request }) => request.body as Record<string, unknown>
    )

    const server = app.listen(0)
    const address = server.address()
    const port = typeof address === 'object' && address ? address.port : 0
    const chunks = [body.slice(0, 17), body.slice(17, 121), body.slice(121)]

    try {
      const response = await new Promise<{ status: number; body: string }>(
        (resolve, reject) => {
          const req = sendHttpRequest(
            {
              method: 'POST',
              port,
              path: '/upload',
              headers: {
                'Content-Type': `multipart/form-data; boundary="${boundary}"`
              }
            },
            (res) => {
              const buffers: Buffer[] = []
              res.on('data', (chunk) => buffers.push(Buffer.from(chunk)))
              res.on('end', () =>
                resolve({
                  status: res.statusCode ?? 0,
                  body: Buffer.concat(buffers).toString('utf8')
                })
              )
            }
          )

          req.on('error', reject)
          for (const chunk of chunks) req.write(chunk)
          req.end()
        }
      )

      expect(response.status).toBe(200)
      expect(JSON.parse(response.body)).toEqual({ title: 'hello' })
    } finally {
      await app.shutdown()
    }
  })

  test('ignores unsafe multipart field names', async () => {
    const app = hyperin()

    app.use(multipart())
    app.post('/upload', ({ request }) => ({
      body: request.body,
      files: request.files
    }))

    const response: Response = await request(app)
      .post('/upload')
      .field('title', 'hello')
      .field('__proto__', 'polluted')
      .attach('constructor', Buffer.from('abc'), {
        filename: 'a.txt',
        contentType: 'text/plain'
      })

    expect(response.status).toBe(200)
    expect(response.body).toEqual({
      body: { title: 'hello' },
      files: {}
    })
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })

  test('aborted multipart uploads release streams and keep the server healthy', async () => {
    const app = hyperin()
    let streamClosed = false

    app.use(
      multipart({
        onFile: async ({ stream }: { stream: Readable }) => {
          await new Promise<void>((resolve) => {
            stream.on('close', () => {
              streamClosed = true
              resolve()
            })
            stream.resume()
          })
        }
      })
    )
    app.post('/upload', ({ request }) => request.files)
    app.get('/health', () => ({ ok: true }))

    const server = app.listen(0)
    const address = server.address()
    const port = typeof address === 'object' && address ? address.port : 0
    const boundary = '----hyperin-abort-test'
    const partialBody = Buffer.from(
      `--${boundary}\r\n` +
        'Content-Disposition: form-data; name="avatar"; filename="a.txt"\r\n' +
        'Content-Type: text/plain\r\n\r\n' +
        'partial-upload'
    )

    try {
      await new Promise<void>((resolve, reject) => {
        const req = sendHttpRequest({
          method: 'POST',
          port,
          path: '/upload',
          headers: {
            'Content-Type': `multipart/form-data; boundary=${boundary}`,
            'Content-Length': String(partialBody.length + 128)
          }
        })

        req.on('error', () => resolve())
        req.on('response', () => {
          reject(new Error('upload should have been aborted by the client'))
        })
        req.write(partialBody)
        setTimeout(() => req.destroy(), 10)
      })

      await new Promise((resolve) => setTimeout(resolve, 50))

      expect(streamClosed).toBe(true)

      const health = await request(app).get('/health')
      expect(health.status).toBe(200)
      expect(health.body).toEqual({ ok: true })
    } finally {
      await app.shutdown()
    }
  })
})
