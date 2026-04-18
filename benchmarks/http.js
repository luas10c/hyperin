import { performance } from 'node:perf_hooks'

import { z } from 'zod'

import hyperin from '../dist/index.js'
import { json, validate } from '../dist/middleware/index.js'

function listen(app) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const address = server.address()

      if (!address || typeof address === 'string') {
        reject(new Error('Could not resolve benchmark server address'))
        return
      }

      resolve({
        server,
        baseUrl: `http://127.0.0.1:${address.port}`
      })
    })
  })
}

async function runScenario(baseUrl, scenario) {
  const durationMs = scenario.durationMs ?? 3000
  const concurrency = scenario.concurrency ?? 64
  const deadline = performance.now() + durationMs
  let completed = 0
  let failed = 0

  async function worker() {
    while (performance.now() < deadline) {
      const response = await fetch(`${baseUrl}${scenario.path}`, {
        method: scenario.method ?? 'GET',
        headers: scenario.headers,
        body: scenario.body
      })

      if (response.status !== scenario.expectedStatus) {
        failed++
      }

      await response.arrayBuffer()
      completed++
    }
  }

  const startedAt = performance.now()
  await Promise.all(Array.from({ length: concurrency }, () => worker()))
  const elapsedMs = performance.now() - startedAt

  return {
    'scenario': scenario.name,
    concurrency,
    'requests': completed,
    failed,
    'req/s': Math.round((completed * 1000) / elapsedMs)
  }
}

const app = hyperin()

app.use(json())

app.get('/ping', () => 'ok')
app.get('/users/:id', ({ request }) => ({ id: request.params.id }))
app.get('/search', ({ request }) => ({ q: request.query.q ?? '' }))
app.post('/json', ({ request }) => request.body)
app.post(
  '/validated/:id',
  validate.params(z.object({ id: z.coerce.number() })),
  validate.query(z.object({ q: z.string().optional() })),
  validate.body(z.object({ name: z.string(), age: z.number() })),
  ({ request }) => ({
    id: request.params.id,
    q: request.query.q ?? null,
    name: request.body.name,
    age: request.body.age
  })
)

const { server, baseUrl } = await listen(app)

try {
  const rows = []

  rows.push(
    await runScenario(baseUrl, {
      name: 'static route',
      path: '/ping',
      expectedStatus: 200
    })
  )

  rows.push(
    await runScenario(baseUrl, {
      name: 'params route',
      path: '/users/42',
      expectedStatus: 200
    })
  )

  rows.push(
    await runScenario(baseUrl, {
      name: 'query route',
      path: '/search?q=hyperin',
      expectedStatus: 200
    })
  )

  rows.push(
    await runScenario(baseUrl, {
      name: 'json body',
      method: 'POST',
      path: '/json',
      expectedStatus: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hello: 'world', value: 1 })
    })
  )

  rows.push(
    await runScenario(baseUrl, {
      name: 'validated body',
      method: 'POST',
      path: '/validated/42?q=test',
      expectedStatus: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'luciano', age: 30 })
    })
  )

  rows.push(
    await runScenario(baseUrl, {
      name: 'not found',
      path: '/missing',
      expectedStatus: 404
    })
  )

  console.table(rows)
} finally {
  await new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error)
      else resolve()
    })
  })
}
