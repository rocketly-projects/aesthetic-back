import { Hono } from 'hono'
import { eq, asc } from 'drizzle-orm'
import { z } from 'zod'
import { createDb } from '../lib/db'
import { businesses, businessHours } from '../db/schema'
import { zv } from '../lib/validator'
import { slugify } from '../lib/slug'
import { requireJwt } from '../middleware/botAuth'
import { insertNotification } from '../lib/notifications'
import { sendWhatsappRequestEmail, sendWhatsappDeactivationEmail } from '../lib/email'
import type { Bindings, Variables } from '../index'

const businessRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>()

const updateBusinessSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  slug: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[a-z0-9]+$/, 'slug must be lowercase alphanumeric only')
    .optional(),
  phone:            z.string().optional(),
  address:          z.string().optional(),
  instagram:        z.string().optional(),
  website:          z.string().optional(),
  logoUrl:          z.string().optional(),
  whatsappPhone:    z.string().optional().nullable(),
  webDepositRequired: z.boolean().optional(),
  botDepositRequired: z.boolean().optional(),
  depositPercent:   z.number().int().min(0).max(100).optional(),
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
  const { slug: rawSlug, ...data } = c.req.valid('json')

  // Normalize the slug if provided
  const slug = rawSlug ? slugify(rawSlug) : undefined

  const [updated] = await db
    .update(businesses)
    .set({ ...data, ...(slug ? { slug } : {}), updatedAt: new Date() })
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

const whatsappRequestSchema = z.object({
  type:         z.enum(['new', 'existing']),
  phone:        z.string().regex(/^\+\d{7,15}$/).optional(),
  contactName:  z.string().min(1).max(100),
  contactPhone: z.string().min(1).max(100),
  notes:        z.string().max(500).optional(),
}).refine(
  (d) => d.type === 'new' || (d.type === 'existing' && !!d.phone),
  { message: 'phone is required for existing number requests', path: ['phone'] }
)

businessRoutes.post('/me/whatsapp-request', requireJwt, zv(whatsappRequestSchema), async (c) => {
  const db         = createDb(c.env.DATABASE_URL)
  const businessId = c.get('businessId')
  const data       = c.req.valid('json')

  const [business] = await db
    .select({ name: businesses.name, planId: businesses.planId, whatsappRequestedAt: businesses.whatsappRequestedAt })
    .from(businesses)
    .where(eq(businesses.id, businessId))
    .limit(1)

  if (!business) return c.json({ error: 'Business not found' }, 404)

  // Marcar la solicitud en la DB
  await db
    .update(businesses)
    .set({ whatsappRequestedAt: new Date(), updatedAt: new Date() })
    .where(eq(businesses.id, businessId))

  // Notificación in-app para el dueño del negocio
  try {
    await insertNotification(
      db,
      businessId,
      'new_appointment', // reutilizamos el tipo genérico por ahora
      'Solicitud de WhatsApp recibida',
      'Tu solicitud fue enviada. Te contactamos en las próximas 48 hs para activar tu número.',
      undefined
    )
  } catch (err) {
    console.error('[whatsapp-request] notification error:', err)
  }

  // Email a Agustín — no debe romper el flujo si falla
  try {
    await sendWhatsappRequestEmail(
      {
        businessId,
        businessName: business.name,
        planId:       business.planId,
        type:         data.type,
        phone:        data.phone,
        contactName:  data.contactName,
        contactPhone: data.contactPhone,
        notes:        data.notes,
      },
      c.env.RESEND_API_KEY
    )
  } catch (err) {
    console.error('[whatsapp-request] email error:', err)
  }

  return c.json({ ok: true })
})

const whatsappDeactivationSchema = z.object({
  contactName:  z.string().min(1).max(100),
  contactPhone: z.string().min(1).max(100),
  notes:        z.string().max(500).optional(),
})

businessRoutes.post('/me/whatsapp-deactivation-request', requireJwt, zv(whatsappDeactivationSchema), async (c) => {
  const db         = createDb(c.env.DATABASE_URL)
  const businessId = c.get('businessId')
  const data       = c.req.valid('json')

  const [business] = await db
    .select({ name: businesses.name, whatsappPhone: businesses.whatsappPhone })
    .from(businesses)
    .where(eq(businesses.id, businessId))
    .limit(1)

  if (!business) return c.json({ error: 'Business not found' }, 404)

  // Email a Agustín — no debe romper el flujo si falla
  try {
    await sendWhatsappDeactivationEmail(
      {
        businessId,
        businessName:  business.name,
        whatsappPhone: business.whatsappPhone,
        contactName:   data.contactName,
        contactPhone:  data.contactPhone,
        notes:         data.notes,
      },
      c.env.RESEND_API_KEY
    )
  } catch (err) {
    console.error('[whatsapp-deactivation-request] email error:', err)
  }

  return c.json({ ok: true })
})

export { businessRoutes }
