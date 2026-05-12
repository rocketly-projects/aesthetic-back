import { createMiddleware } from 'hono/factory'
import { eq } from 'drizzle-orm'
import { verifyJwt } from '../lib/jwt'
import { createDb } from '../lib/db'
import { businesses } from '../db/schema'
import type { Bindings, Variables } from '../index'

type Env = { Bindings: Bindings; Variables: Variables }

// Validates only X-API-Key — for /bot/identify (no businessId yet)
export const apiKeyAuth = createMiddleware<Env>(async (c, next) => {
  const apiKey = c.req.header('X-API-Key')
  if (!apiKey || apiKey !== c.env.BOT_API_KEY) {
    return c.json({ error: 'Unauthorized' }, 401)
  }
  await next()
})

// Accepts JWT OR (X-API-Key + X-Business-Id)
export const dualAuth = createMiddleware<Env>(async (c, next) => {
  const authHeader = c.req.header('Authorization')

  if (authHeader?.startsWith('Bearer ')) {
    try {
      const payload = await verifyJwt(authHeader.slice(7), c.env)
      c.set('businessId', payload.businessId)
      c.set('userId', payload.userId)
      c.set('email', payload.email)
      c.set('role', payload.role)
      c.set('authSource', 'jwt')
      return await next()
    } catch {
      // fall through to bot auth
    }
  }

  const apiKey = c.req.header('X-API-Key')
  if (apiKey) {
    if (apiKey !== c.env.BOT_API_KEY) {
      return c.json({ error: 'Unauthorized' }, 401)
    }

    const businessIdHeader = c.req.header('X-Business-Id')
    if (!businessIdHeader) {
      return c.json({ error: 'Unauthorized' }, 401)
    }

    const db = createDb(c.env.DATABASE_URL)
    const [business] = await db
      .select()
      .from(businesses)
      .where(eq(businesses.id, businessIdHeader))
      .limit(1)

    if (!business) {
      return c.json({ error: 'Business not found' }, 404)
    }

    c.set('businessId', business.id)
    c.set('authSource', 'bot')
    return await next()
  }

  return c.json({ error: 'Unauthorized' }, 401)
})

// Add to routes that must reject bot auth
export const requireJwt = createMiddleware<Env>(async (c, next) => {
  if (c.get('authSource') !== 'jwt') {
    return c.json({ error: 'Unauthorized' }, 401)
  }
  await next()
})

// Blocks access if the business does not have an active plan
export const requireActivePlan = createMiddleware<Env>(async (c, next) => {
  const businessId = c.get('businessId')
  if (!businessId) return c.json({ error: 'Unauthorized' }, 401)

  const db = createDb(c.env.DATABASE_URL)
  const [business] = await db
    .select({ planStatus: businesses.planStatus })
    .from(businesses)
    .where(eq(businesses.id, businessId))
    .limit(1)

  if (!business || business.planStatus !== 'active') {
    return c.json({ error: 'Plan inactivo. Suscribite para continuar usando Aesthetic.' }, 403)
  }

  await next()
})
