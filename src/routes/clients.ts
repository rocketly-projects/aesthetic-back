import { Hono } from 'hono'
import { eq, and, or, ilike, desc } from 'drizzle-orm'
import { z } from 'zod'
import { createDb } from '../lib/db'
import { clients } from '../db/schema'
import { zv, zvQuery } from '../lib/validator'
import { requireJwt } from '../middleware/botAuth'
import type { Bindings, Variables } from '../index'

const clientRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>()

const createClientSchema = z.object({
  name: z.string().min(1).max(100),
  phone: z.string().optional(),
  email: z.string().email().optional(),
  notes: z.string().optional(),
})

const updateClientSchema = createClientSchema.partial()

const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().optional(),
})

clientRoutes.get('/', zvQuery(listQuerySchema), async (c) => {
  const db = createDb(c.env.DATABASE_URL)
  const businessId = c.get('businessId')
  const { page, limit, search } = c.req.valid('query')

  const offset = (page - 1) * limit

  const searchFilter = search
    ? or(ilike(clients.name, `%${search}%`), ilike(clients.phone, `%${search}%`))
    : undefined

  const rows = await db
    .select()
    .from(clients)
    .where(and(eq(clients.businessId, businessId), searchFilter))
    .orderBy(desc(clients.createdAt))
    .limit(limit)
    .offset(offset)

  return c.json({ clients: rows, page, limit })
})

clientRoutes.post('/', zv(createClientSchema), async (c) => {
  const db = createDb(c.env.DATABASE_URL)
  const businessId = c.get('businessId')
  const data = c.req.valid('json')

  const [client] = await db.insert(clients).values({ ...data, businessId }).returning()

  return c.json({ client }, 201)
})

clientRoutes.get('/:id', requireJwt, async (c) => {
  const db = createDb(c.env.DATABASE_URL)
  const businessId = c.get('businessId')
  const id = c.req.param('id')

  const [client] = await db
    .select()
    .from(clients)
    .where(and(eq(clients.id, id), eq(clients.businessId, businessId)))
    .limit(1)

  if (!client) return c.json({ error: 'Client not found' }, 404)

  return c.json({ client })
})

clientRoutes.put('/:id', requireJwt, zv(updateClientSchema), async (c) => {
  const db = createDb(c.env.DATABASE_URL)
  const businessId = c.get('businessId')
  const id = c.req.param('id')
  const data = c.req.valid('json')

  const [updated] = await db
    .update(clients)
    .set({ ...data, updatedAt: new Date() })
    .where(and(eq(clients.id, id), eq(clients.businessId, businessId)))
    .returning()

  if (!updated) return c.json({ error: 'Client not found' }, 404)

  return c.json({ client: updated })
})

clientRoutes.delete('/:id', requireJwt, async (c) => {
  const db = createDb(c.env.DATABASE_URL)
  const businessId = c.get('businessId')
  const id = c.req.param('id')

  const [deleted] = await db
    .delete(clients)
    .where(and(eq(clients.id, id), eq(clients.businessId, businessId)))
    .returning()

  if (!deleted) return c.json({ error: 'Client not found' }, 404)

  return c.json({ success: true })
})

export { clientRoutes }
