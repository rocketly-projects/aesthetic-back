import { Hono } from 'hono'
import { eq, asc } from 'drizzle-orm'
import { z } from 'zod'
import { createDb } from '../lib/db'
import { businesses, businessHours } from '../db/schema'
import { zv } from '../lib/validator'
import { requireJwt } from '../middleware/botAuth'
import type { Bindings, Variables } from '../index'

const businessRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>()

const updateBusinessSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  phone: z.string().optional(),
  address: z.string().optional(),
  instagram: z.string().optional(),
  website: z.string().optional(),
  logoUrl: z.string().optional(),
})

const updateHoursSchema = z
  .array(
    z.object({
      dayOfWeek: z.number().int().min(0).max(6),
      open: z.boolean(),
      fromTime: z.string().regex(/^\d{2}:\d{2}$/, 'fromTime must be HH:MM'),
      toTime: z.string().regex(/^\d{2}:\d{2}$/, 'toTime must be HH:MM'),
    })
  )
  .length(7)

businessRoutes.get('/me', requireJwt, async (c) => {
  const db = createDb(c.env.DATABASE_URL)
  const businessId = c.get('businessId')

  const [business] = await db
    .select()
    .from(businesses)
    .where(eq(businesses.id, businessId))
    .limit(1)

  if (!business) return c.json({ error: 'Business not found' }, 404)

  return c.json({ business })
})

businessRoutes.put('/me', requireJwt, zv(updateBusinessSchema), async (c) => {
  const db = createDb(c.env.DATABASE_URL)
  const businessId = c.get('businessId')
  const data = c.req.valid('json')

  const [updated] = await db
    .update(businesses)
    .set({ ...data, updatedAt: new Date() })
    .where(eq(businesses.id, businessId))
    .returning()

  return c.json({ business: updated })
})

businessRoutes.get('/me/hours', async (c) => {
  const db = createDb(c.env.DATABASE_URL)
  const businessId = c.get('businessId')

  const hours = await db
    .select()
    .from(businessHours)
    .where(eq(businessHours.businessId, businessId))
    .orderBy(asc(businessHours.dayOfWeek))

  return c.json({ hours })
})

businessRoutes.put('/me/hours', requireJwt, zv(updateHoursSchema), async (c) => {
  const db = createDb(c.env.DATABASE_URL)
  const businessId = c.get('businessId')
  const days = c.req.valid('json')

  await db.transaction(async (tx) => {
    await tx.delete(businessHours).where(eq(businessHours.businessId, businessId))
    await tx.insert(businessHours).values(days.map((d) => ({ ...d, businessId })))
  })

  const hours = await db
    .select()
    .from(businessHours)
    .where(eq(businessHours.businessId, businessId))
    .orderBy(asc(businessHours.dayOfWeek))

  return c.json({ hours })
})

export { businessRoutes }
