import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { createDb } from '../lib/db'
import { businesses, users } from '../db/schema'
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
  const email = c.get('email')
  const { planId } = c.req.valid('json')

  const plan = PLANS[planId]
  const backUrl = `${c.env.FRONTEND_URL}/billing/success`

  // Create a standalone preapproval (without preapproval_plan_id) so we can set
  // external_reference = businessId. This lets the webhook find the correct business.
  const mpRes = await fetch('https://api.mercadopago.com/preapproval', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${c.env.MP_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      reason: plan.name,
      external_reference: businessId,
      payer_email: email,
      back_url: backUrl,
      auto_recurring: {
        frequency: 1,
        frequency_type: 'months',
        transaction_amount: plan.price,
        currency_id: 'ARS',
      },
      status: 'pending',
    }),
  })

  if (!mpRes.ok) {
    const err = await mpRes.json()
    console.error('MP subscribe error:', err)
    return c.json({ error: 'Error al iniciar el proceso de pago', detail: err }, 502)
  }

  const mpPreapproval = await mpRes.json() as { id: string; init_point: string }
  console.log('[subscribe] preapproval created:', mpPreapproval.id)

  await db
    .update(businesses)
    .set({ planId, subscriptionId: mpPreapproval.id, updatedAt: new Date() })
    .where(eq(businesses.id, businessId))

  return c.json({ checkoutUrl: mpPreapproval.init_point })
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

  const updatePayload = {
    planStatus,
    subscriptionId: sub.id,
    subscriptionExpiresAt: sub.next_payment_date ? new Date(sub.next_payment_date) : null,
    updatedAt: new Date(),
  }

  // 1. Prefer external_reference (businessId) — set when user pays via our checkout
  if (sub.external_reference) {
    await db.update(businesses).set(updatePayload).where(eq(businesses.id, sub.external_reference))
    return c.json({ ok: true })
  }

  // 2. Fallback: match by subscriptionId already stored (set by /billing/confirm)
  const [existing] = await db
    .select({ id: businesses.id })
    .from(businesses)
    .where(eq(businesses.subscriptionId, sub.id))
    .limit(1)

  if (existing) {
    await db.update(businesses).set(updatePayload).where(eq(businesses.id, existing.id))
    return c.json({ ok: true })
  }

  // 3. Last resort: look up by payer_email (works in production where emails match)
  if (sub.payer_email) {
    const [user] = await db
      .select({ businessId: users.businessId })
      .from(users)
      .where(eq(users.email, sub.payer_email))
      .limit(1)

    if (user) {
      await db.update(businesses).set(updatePayload).where(eq(businesses.id, user.businessId))
    }
  }

  return c.json({ ok: true })
})

export { billingRoutes }
