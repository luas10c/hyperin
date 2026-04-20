import { z } from 'zod'

import hyperin from '#/instance'

const app = hyperin()

app.post(
  '/users/:id',
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
  },
  {
    params: z.object({ id: z.coerce.number() }),
    query: z.object({ search: z.string().optional() }),
    body: z.object({ name: z.string(), age: z.number() }),
    responses: {
      201: {
        description: 'Created'
      }
    }
  }
)
