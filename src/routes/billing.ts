import { Hono } from 'hono'
import { eq, and, lt } from 'drizzle-orm'
import { z } from 'zod'
import { createDb } from '../lib/db'
import { businesses, users, appointments } from '../db/schema'
import { zv } from '../lib/validator'
import { authMiddleware } from '../middleware/auth'
import type { Bindings, Variables } from '../index'

// ── MercadoPago OAuth helpers ─────────────────────────────────────────────────

const MP_TOKEN_URL = 'https://api.mercadopago.com/oauth/token'

interface MpTokenResponse {
  access_token: string
  refresh_token: string
  user_id: number
  expires_in: number  // seconds
}

export async function refreshMpToken(
  db: ReturnType<typeof createDb>,
  businessId: string,
  clientId: string,
  clientSecret: string
): Promise<string | null> {
  const [biz] = await db
    .select({ mpRefreshToken: businesses.mpRefreshToken, mpTokenExpiresAt: businesses.mpTokenExpiresAt })
    .from(businesses)
    .where(eq(businesses.id, businessId))
    .limit(1)

  if (!biz?.mpRefreshToken) return null

  // Si el token aún es válido (vence en más de 5 min), devolver sin refresh
  if (biz.mpTokenExpiresAt && biz.mpTokenExpiresAt.getTime() - Date.now() > 5 * 60 * 1000) {
    const [current] = await db
      .select({ mpAccessToken: businesses.mpAccessToken })
      .from(businesses)
      .where(eq(businesses.id, businessId))
      .limit(1)
    return current?.mpAccessToken ?? null
  }

  const res = await fetch(MP_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type:    'refresh_token',
      client_id:     clientId,
      client_secret: clientSecret,
      refresh_token: biz.mpRefreshToken,
    }),
  })

  if (!res.ok) return null

  const data = await res.json() as MpTokenResponse

  await db
    .update(businesses)
    .set({
      mpAccessToken: data.access_token,
      mpRefreshToken: data.refresh_token,
      mpUserId: String(data.user_id),
      mpTokenExpiresAt: new Date(Date.now() + data.expires_in * 1000),
      updatedAt: new Date(),
    })
    .where(eq(businesses.id, businessId))

  return data.access_token
}

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

  const mpRes = await fetch(`https://api.mercadopago.com/preapproval_plan/${plan.mpPlanId}`, {
    headers: { Authorization: `Bearer ${c.env.MP_ACCESS_TOKEN}` },
  })

  if (!mpRes.ok) {
    const err = await mpRes.json()
    console.error('MP plan fetch error:', err)
    return c.json({ error: 'Error al iniciar el proceso de pago', detail: err }, 502)
  }

  const mpPlan = await mpRes.json() as { id: string; init_point: string }

  await db
    .update(businesses)
    .set({ planId, updatedAt: new Date() })
    .where(eq(businesses.id, businessId))

  const backUrl = `${c.env.FRONTEND_URL}/billing/success`
  const checkoutUrl = `${mpPlan.init_point}&back_url=${encodeURIComponent(backUrl)}`

  return c.json({ checkoutUrl })
})

// ── POST /billing/confirm — llamado desde el front tras el checkout ────────────

billingRoutes.post('/confirm', authMiddleware, async (c) => {
  const db = createDb(c.env.DATABASE_URL)
  const businessId = c.get('businessId')

  // preapproval_id is sent by the frontend after MP redirects back
  const body = await c.req.json<{ preapprovalId?: string }>().catch(() => ({ preapprovalId: undefined }))
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

  const planStatus: 'active' | 'inactive' | 'cancelled' | 'past_due' =
    sub.status === 'authorized'  ? 'active'
    : sub.status === 'paused'    ? 'past_due'
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

// ── POST /billing/deposit-webhook ────────────────────────────────────────────
// MP notifica aquí cuando un pago de seña cambia de estado

billingRoutes.post('/deposit-webhook', async (c) => {
  const body = await c.req.json<{ type: string; data: { id: string } }>().catch(() => null)
  if (!body || body.type !== 'payment') return c.json({ ok: true })

  const paymentId = body.data?.id
  if (!paymentId) return c.json({ ok: true })

  const db = createDb(c.env.DATABASE_URL)

  // businessId viene en el notification_url que armamos al crear la preferencia
  const businessId = c.req.query('businessId')

  // Obtener el access_token del negocio para leer el pago (es su pago, no de la plataforma)
  let mpToken = c.env.MP_ACCESS_TOKEN  // fallback: token de plataforma
  if (businessId) {
    const [biz] = await db
      .select({ mpAccessToken: businesses.mpAccessToken })
      .from(businesses)
      .where(eq(businesses.id, businessId))
      .limit(1)
    if (biz?.mpAccessToken) mpToken = biz.mpAccessToken
  }

  const mpRes = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
    headers: { Authorization: `Bearer ${mpToken}` },
  })

  if (!mpRes.ok) {
    console.error('[deposit-webhook] failed to fetch payment:', paymentId)
    return c.json({ ok: true })
  }

  const payment = await mpRes.json() as {
    id: number
    status: string
    external_reference: string
    collector_id: number
  }

  console.log('[deposit-webhook] payment status:', payment.status, 'ref:', payment.external_reference)

  const appointmentId = payment.external_reference
  if (!appointmentId) return c.json({ ok: true })

  const [appt] = await db
    .select()
    .from(appointments)
    .where(eq(appointments.id, appointmentId))
    .limit(1)

  if (!appt) return c.json({ ok: true })

  if (payment.status === 'approved') {
    await db
      .update(appointments)
      .set({
        status:      'confirmed',
        mpPaymentId: String(payment.id),
        updatedAt:   new Date(),
      })
      .where(eq(appointments.id, appointmentId))
  } else if (payment.status === 'cancelled' || payment.status === 'rejected') {
    await db
      .update(appointments)
      .set({ status: 'cancelled', updatedAt: new Date() })
      .where(eq(appointments.id, appointmentId))
  }

  return c.json({ ok: true })
})

// ── POST /billing/appointments/expire ────────────────────────────────────────
// Endpoint llamado por el cron de n8n cada 1h para cancelar turnos vencidos

billingRoutes.post('/appointments/expire', async (c) => {
  // Verificar bot API key para que no sea público
  const apiKey = c.req.header('X-API-Key')
  if (apiKey !== c.env.BOT_API_KEY) return c.json({ error: 'Unauthorized' }, 401)

  const db = createDb(c.env.DATABASE_URL)

  const expired = await db
    .update(appointments)
    .set({ status: 'cancelled', updatedAt: new Date() })
    .where(
      and(
        eq(appointments.status, 'awaiting_payment'),
        lt(appointments.paymentExpiresAt, new Date())
      )
    )
    .returning({ id: appointments.id })

  console.log(`[expire] cancelled ${expired.length} expired appointments`)

  return c.json({ cancelled: expired.length })
})

// ── PKCE helpers ─────────────────────────────────────────────────────────────

function base64url(buffer: Uint8Array): string {
  const base64 = btoa(String.fromCharCode(...buffer))
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
}

function generateCodeVerifier(): string {
  const array = new Uint8Array(32)
  crypto.getRandomValues(array)
  return base64url(array)
}

async function generateCodeChallenge(verifier: string): Promise<string> {
  const data = new TextEncoder().encode(verifier)
  const digest = await crypto.subtle.digest('SHA-256', data)
  return base64url(new Uint8Array(digest))
}

// state = base64url( JSON({ businessId, codeVerifier }) )
function encodeState(businessId: string, codeVerifier: string): string {
  const json = JSON.stringify({ b: businessId, v: codeVerifier })
  return btoa(json).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
}

function decodeState(state: string): { businessId: string; codeVerifier: string } | null {
  try {
    const padded = state.replace(/-/g, '+').replace(/_/g, '/') + '=='.slice((state.length * 6) % 8 === 0 ? 0 : (8 - (state.length * 6) % 8) / 2)
    const json = atob(padded)
    const { b, v } = JSON.parse(json)
    if (!b || !v) return null
    return { businessId: b, codeVerifier: v }
  } catch {
    return null
  }
}

// ── GET /billing/mp/connect ───────────────────────────────────────────────────
// Devuelve la URL de autorización de MP para que el frontend redirija

billingRoutes.get('/mp/connect', authMiddleware, async (c) => {
  const businessId  = c.get('businessId')
  const backendBase = new URL(c.req.url).origin

  const codeVerifier  = generateCodeVerifier()
  const codeChallenge = await generateCodeChallenge(codeVerifier)

  const params = new URLSearchParams({
    client_id:             c.env.MP_CLIENT_ID,
    response_type:         'code',
    redirect_uri:          `${backendBase}/billing/mp/callback`,
    code_challenge:        codeChallenge,
    code_challenge_method: 'S256',
    state:                 encodeState(businessId, codeVerifier),
  })

  return c.json({
    redirectUrl: `https://auth.mercadopago.com.ar/authorization?${params.toString()}`,
  })
})

// ── GET /billing/mp/callback ──────────────────────────────────────────────────
// MP redirige aquí tras la autorización del owner

billingRoutes.get('/mp/callback', async (c) => {
  const code      = c.req.query('code')
  const rawState  = c.req.query('state')
  const error     = c.req.query('error')

  const frontendUrl = c.env.FRONTEND_URL

  if (error || !code || !rawState) {
    return c.redirect(`${frontendUrl}/negocio?mp=error`)
  }

  const decoded = decodeState(rawState)
  if (!decoded) {
    console.error('[mp/callback] invalid state:', rawState)
    return c.redirect(`${frontendUrl}/negocio?mp=error`)
  }

  const { businessId, codeVerifier } = decoded

  // Intercambiar código por tokens (MP requiere client_secret + code_verifier)
  const backendBase = new URL(c.req.url).origin
  const tokenParams = new URLSearchParams({
    grant_type:    'authorization_code',
    client_id:     c.env.MP_CLIENT_ID,
    client_secret: c.env.MP_CLIENT_SECRET,
    code,
    redirect_uri:  `${backendBase}/billing/mp/callback`,
    code_verifier: codeVerifier,
  })

  const res = await fetch(MP_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: tokenParams.toString(),
  })

  if (!res.ok) {
    console.error('[mp/callback] token exchange failed:', await res.text())
    return c.redirect(`${frontendUrl}/negocio?mp=error`)
  }

  const data = await res.json() as MpTokenResponse

  const db = createDb(c.env.DATABASE_URL)

  await db
    .update(businesses)
    .set({
      mpAccessToken:    data.access_token,
      mpRefreshToken:   data.refresh_token,
      mpUserId:         String(data.user_id),
      mpTokenExpiresAt: new Date(Date.now() + data.expires_in * 1000),
      updatedAt:        new Date(),
    })
    .where(eq(businesses.id, businessId))

  return c.redirect(`${frontendUrl}/negocio?mp=connected`)
})

// ── DELETE /billing/mp/disconnect ─────────────────────────────────────────────

billingRoutes.delete('/mp/disconnect', authMiddleware, async (c) => {
  const db         = createDb(c.env.DATABASE_URL)
  const businessId = c.get('businessId')

  await db
    .update(businesses)
    .set({
      mpAccessToken:    null,
      mpRefreshToken:   null,
      mpUserId:         null,
      mpTokenExpiresAt: null,
      updatedAt:        new Date(),
    })
    .where(eq(businesses.id, businessId))

  return c.json({ ok: true })
})

export { billingRoutes }
