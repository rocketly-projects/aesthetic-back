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
    name: 'Plan Basico',
    price: 30000,
    mpPlanId: '1da6e1fd943142779b655e2eb8ea0aa5',
    features: ['Gestion de turnos', 'Agenda', 'Clientes', 'Servicios', 'Perfil publico'],
  },
  pro: {
    id: 'pro',
    name: 'Plan Pro',
    price: 40000,
    mpPlanId: '2966c3b9c83a4b87b07cc7731856a54b',
    features: ['Todo el Plan Basico', 'Bot de WhatsApp', 'Respuestas automaticas 24/7'],
  },
} as const

export type PlanId = keyof typeof PLANS

// ── GET /billing/plans ────────────────────────────────────────────────────────

billingRoutes.get('/plans', (c) => {
  return c.json({ plans: Object.values(PLANS) })
})

// ── GET /billing/status ───────────────────────────────────────────────────────

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

// ── POST /billing/subscribe ───────────────────────────────────────────────────

const subscribeSchema = z.object({
  planId: z.enum(['basic', 'pro']),
})

billingRoutes.post('/subscribe', authMiddleware, zv(subscribeSchema), async (c) => {
  const db = createDb(c.env.DATABASE_URL)
  const businessId = c.get('businessId')
  const { planId } = c.req.valid('json')

  const plan = PLANS[planId]

  // Fetch the plan template to get its init_point
  const mpRes = await fetch(`https://api.mercadopago.com/preapproval_plan/${plan.mpPlanId}`, {
    headers: { Authorization: `Bearer ${c.env.MP_ACCESS_TOKEN}` },
  })

  if (!mpRes.ok) {
    const err = await mpRes.json()
    console.error('MP plan fetch error:', err)
    return c.json({ error: 'Error al iniciar el proceso de pago', detail: err }, 502)
  }

  const mpPlan = await mpRes.json() as { id: string; init_point: string }

  // Save selected plan
  await db
    .update(businesses)
    .set({ planId, updatedAt: new Date() })
    .where(eq(businesses.id, businessId))

  // Append back_url and external_reference (businessId) to the checkout URL
  const backUrl = `${c.env.FRONTEND_URL}/billing/success`
  const checkoutUrl = `${mpPlan.init_point}&back_url=${encodeURIComponent(backUrl)}&external_reference=${businessId}`

  return c.json({ checkoutUrl })
})

// ── POST /billing/confirm — llamado desde el front tras el checkout ────────────

billingRoutes.post('/confirm', authMiddleware, async (c) => {
  const db = createDb(c.env.DATABASE_URL)
  const businessId = c.get('businessId')

  // preapproval_id is sent by the frontend after MP redirects back
  const body = await c.req.json<{ preapprovalId?: string }>().catch(() => ({}))
  const preapprovalId = body.preapprovalId

  if (!preapprovalId) return c.json({ confirmed: false })

  const mpRes = await fetch(
    `https://api.mercadopago.com/preapproval/${preapprovalId}`,
    { headers: { Authorization: `Bearer ${c.env.MP_ACCESS_TOKEN}` } }
  )

  if (!mpRes.ok) return c.json({ confirmed: false })

  const sub = await mpRes.json() as {
    id: string
    status: string
    next_payment_date?: string
  }

  console.log('[confirm] preapproval status:', sub.status)

  if (sub.status !== 'authorized') return c.json({ confirmed: false })

  await db
    .update(businesses)
    .set({
      planStatus: 'active',
      subscriptionId: sub.id,
      subscriptionExpiresAt: sub.next_payment_date ? new Date(sub.next_payment_date) : null,
      updatedAt: new Date(),
    })
    .where(eq(businesses.id, businessId))

  return c.json({ confirmed: true })
})

// ── POST /billing/webhook ─────────────────────────────────────────────────────

billingRoutes.post('/webhook', async (c) => {
  const body = await c.req.json<{
    type: string
    data: { id: string }
  }>()

  console.log('[webhook] received:', JSON.stringify(body))

  if (body.type !== 'subscription_preapproval') {
    console.log('[webhook] ignoring type:', body.type)
    return c.json({ ok: true })
  }

  const subscriptionId = body.data?.id
  if (!subscriptionId) return c.json({ ok: true })

  const mpRes = await fetch(`https://api.mercadopago.com/preapproval/${subscriptionId}`, {
    headers: { Authorization: `Bearer ${c.env.MP_ACCESS_TOKEN}` },
  })

  if (!mpRes.ok) return c.json({ ok: true })

  const sub = await mpRes.json() as {
    id: string
    status: string
    payer_email?: string
    external_reference?: string
    next_payment_date?: string
  }

  console.log('[webhook] sub status:', sub.status, 'external_reference:', sub.external_reference, 'payer_email:', sub.payer_email)

  const db = createDb(c.env.DATABASE_URL)

  const planStatus =
    sub.status === 'authorized' ? 'active'
    : sub.status === 'paused'   ? 'past_due'
    : sub.status === 'cancelled' ? 'cancelled'
    : 'inactive'

  // Prefer external_reference (businessId) for lookup; fall back to subscriptionId already stored
  if (sub.external_reference) {
    await db
      .update(businesses)
      .set({
        planStatus,
        subscriptionId: sub.id,
        subscriptionExpiresAt: sub.next_payment_date ? new Date(sub.next_payment_date) : null,
        updatedAt: new Date(),
      })
      .where(eq(businesses.id, sub.external_reference))
  } else {
    // Fallback: find business that already has this subscriptionId stored
    await db
      .update(businesses)
      .set({
        planStatus,
        subscriptionExpiresAt: sub.next_payment_date ? new Date(sub.next_payment_date) : null,
        updatedAt: new Date(),
      })
      .where(eq(businesses.subscriptionId, sub.id))
  }

  return c.json({ ok: true })
})

export { billingRoutes }
