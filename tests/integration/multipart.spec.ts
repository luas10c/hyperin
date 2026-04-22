import { describe, expect, test } from '@jest/globals'
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
})
