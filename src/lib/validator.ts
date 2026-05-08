import { zValidator } from '@hono/zod-validator'
import type { ZodSchema } from 'zod'

export function zv<T extends ZodSchema>(schema: T) {
  return zValidator('json', schema, (result, c) => {
    if (!result.success) {
      const fieldErrors = result.error.flatten().fieldErrors
      return c.json({ error: 'Validation failed', details: fieldErrors }, 422)
    }
  })
}

export function zvQuery<T extends ZodSchema>(schema: T) {
  return zValidator('query', schema, (result, c) => {
    if (!result.success) {
      const fieldErrors = result.error.flatten().fieldErrors
      return c.json({ error: 'Validation failed', details: fieldErrors }, 422)
    }
  })
}
