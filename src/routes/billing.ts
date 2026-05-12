import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { createDb } from '../lib/db'
import { businesses } from '../db/schema'
import { zv } from '../lib/validator'
import { authMiddleware } from '../middleware/auth'
import type { Bindings, Variables } from '../index'

const billingRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>()

// ── Plan definitions ──────────────────────────────────────────────────────────

export const PLANS = {
  basic: {
    id: 'basic',
    name: 'Plan Básico',
    price: 30000,
    mpPlanId: '7a1d71983b844a6a8931bcbda5d9b028',
    features: ['Gestión de turnos', 'Agenda', 'Clientes', 'Servicios', 'Perfil público'],
  },
  pro: {
    id: 'pro',
    name: 'Plan Pro',
    price: 40000,
    mpPlanId: 'e87fcf98039748a1a2b37a8c07a06a76',
    features: ['Todo el Plan Básico', 'Bot de WhatsApp', 'Respuestas automáticas 24/7'],
  },
} as const

export type PlanId = keyof typeof PLANS

// ── GET /billing/plans — público, devuelve los planes disponibles ──────────────

billingRoutes.get('/plans', (c) => {
  return c.json({ plans: Object.values(PLANS) })
})

// ── GET /billing/status — estado del plan del negocio autenticado ─────────────

billingRoutes.get('/status', authMiddleware, async (c) => {
  const db = createDb(c.env.DATABASE_URL)
  const businessId = c.get('businessId')

  const [business] = await db
    .select({
      planId: businesses.planId,
      planStatus: businesses.planStatus,
      subscriptionId: businesses.subscriptionId,
      subscriptionExpiresAt: businesses.subscriptionExpiresAt,
    })
    .from(businesses)
    .where(eq(businesses.id, businessId))
    .limit(1)

  if (!business) return c.json({ error: 'Business not found' }, 404)

  const plan = business.planId ? PLANS[business.planId as PlanId] ?? null : null

  return c.json({
    planId: business.planId,
    planName: plan?.name ?? null,
    planStatus: business.planStatus,
    subscriptionId: business.subscriptionId,
    subscriptionExpiresAt: business.subscriptionExpiresAt,
  })
})

// ── POST /billing/subscribe — crea la suscripción en MP y devuelve el checkout ─

const subscribeSchema = z.object({
  planId: z.enum(['basic', 'pro']),
})

billingRoutes.post('/subscribe', authMiddleware, zv(subscribeSchema), async (c) => {
  const db = createDb(c.env.DATABASE_URL)
  const businessId = c.get('businessId')
  const { planId } = c.req.valid('json')

  const plan = PLANS[planId]

  // Fetch business info to use as payer data
  const [business] = await db
    .select({ name: businesses.name, id: businesses.id })
    .from(businesses)
    .where(eq(businesses.id, businessId))
    .limit(1)

  if (!business) return c.json({ error: 'Business not found' }, 404)

  // Create preapproval (subscription instance) in MP
  const mpRes = await fetch('https://api.mercadopago.com/preapproval', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${c.env.MP_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      preapproval_plan_id: plan.mpPlanId,
      reason: plan.name,
      external_reference: businessId,
      back_url: `${c.env.FRONTEND_URL}/billing/success`,
      status: 'pending',
    }),
  })

  if (!mpRes.ok) {
    const err = await mpRes.json()
    console.error('MP preapproval error:', err)
    return c.json({ error: 'Error al iniciar el proceso de pago', detail: err }, 502)
  }

  const mpData = await mpRes.json() as { id: string; init_point: string }

  // Save pending subscription data
  await db
    .update(businesses)
    .set({
      planId,
      subscriptionId: mpData.id,
      updatedAt: new Date(),
    })
    .where(eq(businesses.id, businessId))

  return c.json({
    subscriptionId: mpData.id,
    checkoutUrl: mpData.init_point,
  })
})

// ── POST /billing/webhook — recibe eventos de MP ──────────────────────────────

billingRoutes.post('/webhook', async (c) => {
  const body = await c.req.json<{
    type: string
    data: { id: string }
  }>()

  // Only handle subscription events
  if (body.type !== 'subscription_preapproval') {
    return c.json({ ok: true })
  }

  const subscriptionId = body.data?.id
  if (!subscriptionId) return c.json({ ok: true })

  // Fetch subscription details from MP
  const mpRes = await fetch(`https://api.mercadopago.com/preapproval/${subscriptionId}`, {
    headers: { Authorization: `Bearer ${c.env.MP_ACCESS_TOKEN}` },
  })

  if (!mpRes.ok) return c.json({ ok: true })

  const sub = await mpRes.json() as {
    id: string
    status: string
    external_reference: string
    next_payment_date?: string
  }

  const businessId = sub.external_reference
  if (!businessId) return c.json({ ok: true })

  const db = createDb(c.env.DATABASE_URL)

  // Map MP status → our planStatus
  const planStatus =
    sub.status === 'authorized' ? 'active'
    : sub.status === 'paused'   ? 'past_due'
    : sub.status === 'cancelled' ? 'cancelled'
    : 'inactive'

  await db
    .update(businesses)
    .set({
      planStatus,
      subscriptionExpiresAt: sub.next_payment_date ? new Date(sub.next_payment_date) : null,
      updatedAt: new Date(),
    })
    .where(eq(businesses.id, businessId))

  return c.json({ ok: true })
})

export { billingRoutes }
