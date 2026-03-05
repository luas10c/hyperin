import { beforeEach, afterEach, describe, it, expect } from '@jest/globals'
import { Readable } from 'node:stream'
import { parseLimit, readBody, parseMultipart } from '#/util'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IncomingMessage } from 'node:http'

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

function makeStream(body: string | Buffer): Readable {
  const readable = new Readable({ read() {} })
  readable.push(body)
  readable.push(null)
  return readable
}

function buildMultipartBody(
  boundary: string,
  parts: {
    name: string
    filename?: string
    contentType?: string
    data: string | Buffer
  }[]
): Buffer {
  const chunks: Buffer[] = []
  for (const part of parts) {
    chunks.push(Buffer.from(`--${boundary}\r\n`))
    let disp = `Content-Disposition: form-data; name="${part.name}"`
    if (part.filename) disp += `; filename="${part.filename}"`
    chunks.push(Buffer.from(disp + '\r\n'))
    if (part.contentType) {
      chunks.push(Buffer.from(`Content-Type: ${part.contentType}\r\n`))
    }
    chunks.push(Buffer.from('\r\n'))
    chunks.push(Buffer.isBuffer(part.data) ? part.data : Buffer.from(part.data))
    chunks.push(Buffer.from('\r\n'))
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`))
  return Buffer.concat(chunks)
}

// ─────────────────────────────────────────────────────────────
// parseLimit
// ─────────────────────────────────────────────────────────────

describe('parseLimit', () => {
  it('parses bytes (no unit)', () => {
    expect(parseLimit('500')).toBe(500)
  })

  it('parses kilobytes', () => {
    expect(parseLimit('1kb')).toBe(1024)
    expect(parseLimit('100kb')).toBe(100 * 1024)
  })

  it('parses megabytes', () => {
    expect(parseLimit('1mb')).toBe(1024 ** 2)
    expect(parseLimit('2mb')).toBe(2 * 1024 ** 2)
  })

  it('parses gigabytes', () => {
    expect(parseLimit('1gb')).toBe(1024 ** 3)
  })

  it('is case-insensitive', () => {
    expect(parseLimit('1KB')).toBe(1024)
    expect(parseLimit('1MB')).toBe(1024 ** 2)
  })

  it('parses decimal values', () => {
    expect(parseLimit('1.5mb')).toBe(Math.floor(1.5 * 1024 ** 2))
  })

  it('returns 1mb as fallback for invalid input', () => {
    expect(parseLimit('invalid')).toBe(1024 * 1024)
  })
})

// ─────────────────────────────────────────────────────────────
// readBody
// ─────────────────────────────────────────────────────────────

describe('readBody', () => {
  it('reads entire stream into a Buffer', async () => {
    const stream = makeStream('hello world')
    const buf = await readBody(stream, 1024)
    expect(buf.toString()).toBe('hello world')
  })

  it('throws 413 when body exceeds limit', async () => {
    const stream = makeStream(Buffer.alloc(200, 'x'))
    await expect(readBody(stream, 100)).rejects.toMatchObject({
      message: 'Payload Too Large',
      status: 413
    })
  })

  it('returns empty Buffer for empty stream', async () => {
    const stream = makeStream('')
    const buf = await readBody(stream, 1024)
    expect(buf.length).toBe(0)
  })

  it('reads exactly at the limit without throwing', async () => {
    const stream = makeStream(Buffer.alloc(100, 'a'))
    const buf = await readBody(stream, 100)
    expect(buf.length).toBe(100)
  })
})

// ─────────────────────────────────────────────────────────────
// parseMultipart
// ─────────────────────────────────────────────────────────────

describe('parseMultipart', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'highen-test-'))
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('parses a single text field', async () => {
    const boundary = 'testboundary'
    const body = buildMultipartBody(boundary, [
      { name: 'username', data: 'john' }
    ])
    const stream = makeStream(body) as unknown as IncomingMessage
    const { fields, files } = await parseMultipart(stream, boundary, tmpDir, {})
    expect(fields.username).toBe('john')
    expect(Object.keys(files)).toHaveLength(0)
  })

  it('parses multiple text fields', async () => {
    const boundary = 'bound'
    const body = buildMultipartBody(boundary, [
      { name: 'first', data: 'Alice' },
      { name: 'last', data: 'Smith' }
    ])
    const stream = makeStream(body) as unknown as IncomingMessage
    const { fields } = await parseMultipart(stream, boundary, tmpDir, {})
    expect(fields.first).toBe('Alice')
    expect(fields.last).toBe('Smith')
  })

  it('parses a file upload', async () => {
    const boundary = 'fileboundary'
    const fileContent = 'file content here'
    const body = buildMultipartBody(boundary, [
      {
        name: 'avatar',
        filename: 'photo.png',
        contentType: 'image/png',
        data: fileContent
      }
    ])
    const stream = makeStream(body) as unknown as IncomingMessage
    const { files } = await parseMultipart(stream, boundary, tmpDir, {})
    expect(files.avatar).toBeDefined()
    expect(files.avatar.filename).toBe('photo.png')
    expect(files.avatar.mimetype).toBe('image/png')
    expect(files.avatar.size).toBe(Buffer.byteLength(fileContent))
  })

  it('parses mixed fields and files', async () => {
    const boundary = 'mixedboundary'
    const body = buildMultipartBody(boundary, [
      { name: 'title', data: 'My Upload' },
      {
        name: 'file',
        filename: 'doc.txt',
        contentType: 'text/plain',
        data: 'hello'
      }
    ])
    const stream = makeStream(body) as unknown as IncomingMessage
    const { fields, files } = await parseMultipart(stream, boundary, tmpDir, {})
    expect(fields.title).toBe('My Upload')
    expect(files.file.filename).toBe('doc.txt')
  })

  it('throws when files limit is exceeded', async () => {
    const boundary = 'limitboundary'
    const body = buildMultipartBody(boundary, [
      { name: 'f1', filename: 'a.txt', data: 'a' },
      { name: 'f2', filename: 'b.txt', data: 'b' }
    ])
    const stream = makeStream(body) as unknown as IncomingMessage
    await expect(
      parseMultipart(stream, boundary, tmpDir, { files: 1 })
    ).rejects.toThrow('Too many files')
  })

  it('throws when fields limit is exceeded', async () => {
    const boundary = 'fieldlimitboundary'
    const body = buildMultipartBody(boundary, [
      { name: 'a', data: '1' },
      { name: 'b', data: '2' }
    ])
    const stream = makeStream(body) as unknown as IncomingMessage
    await expect(
      parseMultipart(stream, boundary, tmpDir, { fields: 1 })
    ).rejects.toThrow('Too many fields')
  })

  it('handles 6 consecutive requests without corruption', async () => {
    const boundary = 'consecutive'
    for (let i = 0; i < 6; i++) {
      const body = buildMultipartBody(boundary, [
        { name: 'iter', data: String(i) }
      ])
      const stream = makeStream(body) as unknown as IncomingMessage
      const { fields } = await parseMultipart(stream, boundary, tmpDir, {})
      expect(fields.iter).toBe(String(i))
    }
  })

  it('handles binary file data correctly', async () => {
    const boundary = 'binboundary'
    const binaryData = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a
    ]) // PNG header
    const body = buildMultipartBody(boundary, [
      {
        name: 'img',
        filename: 'image.png',
        contentType: 'image/png',
        data: binaryData
      }
    ])
    const stream = makeStream(body) as unknown as IncomingMessage
    const { files } = await parseMultipart(stream, boundary, tmpDir, {})
    expect(files.img.size).toBe(binaryData.length)
  })
})
