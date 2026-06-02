import { createMiddleware } from 'hono/factory'
import { verifyJwt } from '../lib/jwt'
import type { Bindings, Variables } from '../index'

export const authMiddleware = createMiddleware<{ Bindings: Bindings; Variables: Variables }>(
  async (c, next) => {
    const authHeader = c.req.header('Authorization')

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return c.json({ error: 'No autorizado' }, 401)
    }

    const token = authHeader.slice(7)

    try {
      const payload = await verifyJwt(token, c.env)
      c.set('businessId', payload.businessId)
      c.set('userId', payload.userId)
      c.set('email', payload.email)
      c.set('role', payload.role)
      await next()
    } catch {
      return c.json({ error: 'No autorizado' }, 401)
    }
  }
)
