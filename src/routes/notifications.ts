import { Hono } from 'hono'
import { eq, and, desc, gte, count } from 'drizzle-orm'
import { createDb } from '../lib/db'
import { notifications } from '../db/schema'
import type { Bindings, Variables } from '../index'

const notificationRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>()

// 15 días en ms
const RETENTION_MS = 15 * 24 * 60 * 60 * 1000

// ── GET /notifications/unread-count ──────────────────────────────────────────

notificationRoutes.get('/unread-count', async (c) => {
  const db         = createDb(c.env.DATABASE_URL)
  const businessId = c.get('businessId')
  const since      = new Date(Date.now() - RETENTION_MS)

  const [row] = await db
    .select({ count: count() })
    .from(notifications)
    .where(
      and(
        eq(notifications.businessId, businessId),
        eq(notifications.read, false),
        gte(notifications.createdAt, since)
      )
    )

  return c.json({ count: row?.count ?? 0 })
})

// ── GET /notifications ────────────────────────────────────────────────────────
// Query params: unreadOnly=true|false (default false), limit=20

notificationRoutes.get('/', async (c) => {
  const db         = createDb(c.env.DATABASE_URL)
  const businessId = c.get('businessId')
  const since      = new Date(Date.now() - RETENTION_MS)
  const unreadOnly = c.req.query('unreadOnly') === 'true'
  const limit      = Math.min(parseInt(c.req.query('limit') ?? '20', 10), 50)

  const conditions = [
    eq(notifications.businessId, businessId),
    gte(notifications.createdAt, since),
    ...(unreadOnly ? [eq(notifications.read, false)] : []),
  ]

  const rows = await db
    .select()
    .from(notifications)
    .where(and(...conditions))
    .orderBy(desc(notifications.createdAt))
    .limit(limit)

  return c.json({ notifications: rows })
})

// ── PATCH /notifications/:id/read ─────────────────────────────────────────────

notificationRoutes.patch('/:id/read', async (c) => {
  const db         = createDb(c.env.DATABASE_URL)
  const businessId = c.get('businessId')
  const id         = c.req.param('id')

  await db
    .update(notifications)
    .set({ read: true })
    .where(and(eq(notifications.id, id), eq(notifications.businessId, businessId)))

  return c.json({ ok: true })
})

// ── PATCH /notifications/read-all ─────────────────────────────────────────────

notificationRoutes.patch('/read-all', async (c) => {
  const db         = createDb(c.env.DATABASE_URL)
  const businessId = c.get('businessId')

  await db
    .update(notifications)
    .set({ read: true })
    .where(and(eq(notifications.businessId, businessId), eq(notifications.read, false)))

  return c.json({ ok: true })
})

// ── DELETE /notifications/cleanup — para cron de n8n ─────────────────────────
// Protegido con X-API-Key igual que el endpoint de expire

notificationRoutes.delete('/cleanup', async (c) => {
  const apiKey = c.req.header('X-API-Key')
  if (apiKey !== c.env.BOT_API_KEY) return c.json({ error: 'Unauthorized' }, 401)

  const { sql } = await import('drizzle-orm')
  const db      = createDb(c.env.DATABASE_URL)
  const cutoff  = new Date(Date.now() - RETENTION_MS)

  const result = await db
    .delete(notifications)
    .where(sql`${notifications.createdAt} < ${cutoff}`)
    .returning({ id: notifications.id })

  return c.json({ deleted: result.length })
})

export { notificationRoutes }
