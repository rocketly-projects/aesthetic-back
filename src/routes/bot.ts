import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { createDb } from '../lib/db'
import { businesses } from '../db/schema'
import { zv } from '../lib/validator'
import { apiKeyAuth } from '../middleware/botAuth'
import type { Bindings, Variables } from '../index'

const botRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>()

const identifySchema = z.object({
  whatsappPhone: z.string().min(1),
})

botRoutes.post('/identify', apiKeyAuth, zv(identifySchema), async (c) => {
  const { whatsappPhone } = c.req.valid('json')
  const db = createDb(c.env.DATABASE_URL)

  const [business] = await db
    .select()
    .from(businesses)
    .where(eq(businesses.whatsappPhone, whatsappPhone))
    .limit(1)

  if (!business) {
    return c.json({ error: 'Business not found' }, 404)
  }

  return c.json({
    businessId: business.id,
    businessName: business.name,
    whatsappPhone: business.whatsappPhone,
  })
})

export { botRoutes }
