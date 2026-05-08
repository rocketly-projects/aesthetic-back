import { Hono } from 'hono'
import { eq, and } from 'drizzle-orm'
import { z } from 'zod'
import { createDb } from '../lib/db'
import { services } from '../db/schema'
import { zv, zvQuery } from '../lib/validator'
import { requireJwt } from '../middleware/botAuth'
import type { Bindings, Variables } from '../index'

const serviceRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>()

const createServiceSchema = z.object({
  name: z.string().min(1).max(100),
  category: z.string().optional(),
  duration: z.number().int().min(1),
  price: z.number().int().min(0),
  color: z.string().optional(),
  visible: z.boolean().optional(),
})

const updateServiceSchema = createServiceSchema.partial()

const listQuerySchema = z.object({
  visible: z.enum(['true', 'false', 'all']).default('all'),
})

serviceRoutes.get('/', zvQuery(listQuerySchema), async (c) => {
  const db = createDb(c.env.DATABASE_URL)
  const businessId = c.get('businessId')
  const { visible } = c.req.valid('query')

  const visibilityFilter =
    visible === 'true'
      ? eq(services.visible, true)
      : visible === 'false'
        ? eq(services.visible, false)
        : undefined

  const rows = await db
    .select()
    .from(services)
    .where(and(eq(services.businessId, businessId), visibilityFilter))

  return c.json({ services: rows })
})

serviceRoutes.post('/', requireJwt, zv(createServiceSchema), async (c) => {
  const db = createDb(c.env.DATABASE_URL)
  const businessId = c.get('businessId')
  const data = c.req.valid('json')

  const [service] = await db.insert(services).values({ ...data, businessId }).returning()

  return c.json({ service }, 201)
})

serviceRoutes.get('/:id', requireJwt, async (c) => {
  const db = createDb(c.env.DATABASE_URL)
  const businessId = c.get('businessId')
  const id = c.req.param('id')

  const [service] = await db
    .select()
    .from(services)
    .where(and(eq(services.id, id), eq(services.businessId, businessId)))
    .limit(1)

  if (!service) return c.json({ error: 'Service not found' }, 404)

  return c.json({ service })
})

serviceRoutes.put('/:id', requireJwt, zv(updateServiceSchema), async (c) => {
  const db = createDb(c.env.DATABASE_URL)
  const businessId = c.get('businessId')
  const id = c.req.param('id')
  const data = c.req.valid('json')

  const [updated] = await db
    .update(services)
    .set({ ...data, updatedAt: new Date() })
    .where(and(eq(services.id, id), eq(services.businessId, businessId)))
    .returning()

  if (!updated) return c.json({ error: 'Service not found' }, 404)

  return c.json({ service: updated })
})

// Soft delete: set visible=false, never removes the record
serviceRoutes.delete('/:id', requireJwt, async (c) => {
  const db = createDb(c.env.DATABASE_URL)
  const businessId = c.get('businessId')
  const id = c.req.param('id')

  const [updated] = await db
    .update(services)
    .set({ visible: false, updatedAt: new Date() })
    .where(and(eq(services.id, id), eq(services.businessId, businessId)))
    .returning()

  if (!updated) return c.json({ error: 'Service not found' }, 404)

  return c.json({ service: updated })
})

export { serviceRoutes }
