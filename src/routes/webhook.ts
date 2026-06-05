import { Hono } from 'hono'
import type { Bindings, Variables } from '../index'

const webhookRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>()

// ─────────────────────────────────────────────────────────────────────────────
// GET /webhook/whatsapp — verificación inicial de Meta
// Meta hace un GET con hub.mode=subscribe&hub.verify_token=…&hub.challenge=…
// Si el token coincide con el nuestro, devolvemos el challenge en texto plano.
// ─────────────────────────────────────────────────────────────────────────────
webhookRoutes.get('/whatsapp', (c) => {
  const mode      = c.req.query('hub.mode')
  const token     = c.req.query('hub.verify_token')
  const challenge = c.req.query('hub.challenge')

  if (mode === 'subscribe' && token === c.env.META_WEBHOOK_VERIFY_TOKEN) {
    return c.text(challenge ?? '', 200)
  }
  return c.json({ error: 'Forbidden' }, 403)
})

// ─────────────────────────────────────────────────────────────────────────────
// POST /webhook/whatsapp — mensajes entrantes
// 1) Verifica firma HMAC-SHA256 con META_APP_SECRET
// 2) Extrae mensajes de texto del payload
// 3) Dedupe por waMessageId via KV (24h TTL)
// 4) Forwardea async a n8n y responde 200 en < 1s a Meta
// ─────────────────────────────────────────────────────────────────────────────
webhookRoutes.post('/whatsapp', async (c) => {
  const rawBody   = await c.req.text()
  const signature = c.req.header('x-hub-signature-256')

  if (!signature || !(await verifySignature(c.env.META_APP_SECRET, rawBody, signature))) {
    return c.json({ error: 'Invalid signature' }, 401)
  }

  let payload: WhatsAppWebhookPayload
  try {
    payload = JSON.parse(rawBody)
  } catch {
    return c.json({ error: 'Invalid JSON' }, 400)
  }

  const messages = extractTextMessages(payload)

  for (const msg of messages) {
    // Dedupe — Meta reintenta si no recibe 200 < 5s
    const seenKey = `wa:msg:${msg.waMessageId}`
    const seen = await c.env.RATE_LIMIT.get(seenKey)
    if (seen) continue
    c.executionCtx.waitUntil(
      c.env.RATE_LIMIT.put(seenKey, '1', { expirationTtl: 86400 })
    )

    // Forward async — Meta exige 200 OK rápido, el AI puede tardar 10s+
    c.executionCtx.waitUntil(
      fetch(c.env.N8N_WHATSAPP_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(msg),
      })
        .then((res) => {
          if (!res.ok) {
            console.error('[webhook/whatsapp] n8n responded', res.status, res.statusText)
          }
        })
        .catch((err) => {
          console.error('[webhook/whatsapp] n8n forward failed', err)
        })
    )
  }

  return c.json({ received: true })
})

// ─────────────────────────────────────────────────────────────────────────────
// Tipos del payload de Meta WhatsApp Cloud API
// Doc: https://developers.facebook.com/docs/whatsapp/cloud-api/webhooks/payload-examples
// ─────────────────────────────────────────────────────────────────────────────

type WhatsAppWebhookPayload = {
  entry?: Array<{
    changes?: Array<{
      value?: {
        metadata?: {
          phone_number_id?: string
          display_phone_number?: string
        }
        messages?: Array<{
          id?: string
          from?: string
          type?: string
          text?: { body?: string }
          timestamp?: string
        }>
        contacts?: Array<{
          profile?: { name?: string }
          wa_id?: string
        }>
      }
    }>
  }>
}

type N8nMessage = {
  from:          string
  fromName:      string | null
  message:       string
  businessPhone: string
  phoneNumberId: string
  waMessageId:   string
}

function extractTextMessages(payload: WhatsAppWebhookPayload): N8nMessage[] {
  const out: N8nMessage[] = []
  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const value = change.value
      if (!value?.messages) continue
      const phoneNumberId = value.metadata?.phone_number_id
      const displayPhone  = value.metadata?.display_phone_number
      if (!phoneNumberId || !displayPhone) continue

      for (const m of value.messages) {
        if (m.type !== 'text' || !m.text?.body || !m.from || !m.id) continue
        const contact = value.contacts?.find((c) => c.wa_id === m.from)
        out.push({
          from:          m.from,
          fromName:      contact?.profile?.name ?? null,
          message:       m.text.body,
          businessPhone: `+${displayPhone.replace(/^\+/, '')}`,
          phoneNumberId,
          waMessageId:   m.id,
        })
      }
    }
  }
  return out
}

// ─────────────────────────────────────────────────────────────────────────────
// HMAC-SHA256 verification (Web Crypto API — disponible en Workers)
// ─────────────────────────────────────────────────────────────────────────────

async function verifySignature(secret: string, body: string, signature: string): Promise<boolean> {
  const expected = await hmacSha256(secret, body)
  const provided = signature.replace(/^sha256=/, '')
  return timingSafeEqual(expected, provided)
}

async function hmacSha256(secret: string, data: string): Promise<string> {
  const enc = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(data))
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

export { webhookRoutes }
