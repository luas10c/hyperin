import { z } from 'zod'

import hyperin from '#/index'
import { validate } from '#/middleware'

const app = hyperin()

app.get('/posts/:slug', ({ request }) => {
  const slug: string = request.params.slug

  return { slug }
})

app.post(
  '/users/:id',
  validate.params(z.object({ id: z.coerce.number() })),
  validate.query(z.object({ search: z.string().optional() })),
  validate.body(z.object({ name: z.string(), age: z.number() })),
  ({ request }) => {
    const id: number = request.params.id
    const search: string | undefined = request.query.search
    const name: string = request.body.name
    const age: number = request.body.age

    // @ts-expect-error validated params are no longer strings
    const invalidId: string = request.params.id

    // @ts-expect-error unknown properties should not exist
    const missingEmail: string = request.body.email

    return { id, search, name, age, invalidId, missingEmail }
  }
)
