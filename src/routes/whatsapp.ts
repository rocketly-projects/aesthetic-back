import { Hono } from 'hono'
import { eq, and, desc } from 'drizzle-orm'
import { z } from 'zod'
import { createDb } from '../lib/db'
import { whatsappChats, whatsappMessages, clients } from '../db/schema'
import { zv, zvQuery } from '../lib/validator'
import { requireJwt } from '../middleware/botAuth'
import type { Bindings, Variables } from '../index'

const whatsappRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>()

const createChatSchema = z.object({
  clientPhone: z.string().min(1),
  clientName: z.string().optional().nullable(),
})

const updateChatSchema = z.object({
  isBot:      z.boolean().optional(),
  markRead:   z.boolean().optional(),
  clientName: z.string().min(1).optional().nullable(),
  clientId:   z.string().uuid().optional().nullable(),
})

const sendMessageSchema = z.object({
  content: z.string().min(1),
  sender: z.enum(['client', 'owner', 'bot']),
})

const messagesQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
})

whatsappRoutes.get('/chats', requireJwt, async (c) => {
  const db = createDb(c.env.DATABASE_URL)
  const businessId = c.get('businessId')

  const chats = await db
    .select()
    .from(whatsappChats)
    .where(eq(whatsappChats.businessId, businessId))
    .orderBy(desc(whatsappChats.lastMessageAt))

  return c.json({ chats })
})

whatsappRoutes.post('/chats', zv(createChatSchema), async (c) => {
  const db = createDb(c.env.DATABASE_URL)
  const businessId = c.get('businessId')
  const { clientPhone, clientName } = c.req.valid('json')

  // Helper: buscar cliente por teléfono
  const findClient = () =>
    db
      .select()
      .from(clients)
      .where(and(eq(clients.businessId, businessId), eq(clients.phone, clientPhone)))
      .limit(1)
      .then(([r]) => r ?? null)

  // Return existing chat if one already exists for this phone
  const [existing] = await db
    .select()
    .from(whatsappChats)
    .where(
      and(
        eq(whatsappChats.businessId, businessId),
        eq(whatsappChats.clientPhone, clientPhone)
      )
    )
    .limit(1)

  if (existing) {
    // Auto-linkear clientId si todavía no está vinculado
    if (!existing.clientId) {
      const matched = await findClient()
      if (matched) {
        const [updated] = await db
          .update(whatsappChats)
          .set({ clientId: matched.id, clientName: clientName ?? matched.name })
          .where(eq(whatsappChats.id, existing.id))
          .returning()
        return c.json({ chat: updated })
      }
    }
    return c.json({ chat: existing })
  }

  // Nuevo chat — intentar auto-linkear por teléfono
  const matched = await findClient()

  const [chat] = await db
    .insert(whatsappChats)
    .values({
      businessId,
      clientPhone,
      clientName: clientName ?? matched?.name ?? null,
      clientId:   matched?.id ?? null,
    })
    .returning()

  return c.json({ chat }, 201)
})

whatsappRoutes.get('/chats/:id', requireJwt, async (c) => {
  const db = createDb(c.env.DATABASE_URL)
  const businessId = c.get('businessId')
  const id = c.req.param('id')

  const [chat] = await db
    .select()
    .from(whatsappChats)
    .where(and(eq(whatsappChats.id, id), eq(whatsappChats.businessId, businessId)))
    .limit(1)

  if (!chat) return c.json({ error: 'Chat not found' }, 404)

  return c.json({ chat })
})

whatsappRoutes.patch('/chats/:id', zv(updateChatSchema), async (c) => {
  const db = createDb(c.env.DATABASE_URL)
  const businessId = c.get('businessId')
  const id = c.req.param('id')
  const { isBot, markRead, clientName, clientId } = c.req.valid('json')

  const updates = {
    ...(isBot      !== undefined ? { isBot }      : {}),
    ...(markRead               ? { unread: 0 }   : {}),
    ...(clientName != null     ? { clientName }  : {}),
    ...(clientId   != null     ? { clientId }    : {}),
  }

  // Drizzle no admite .set({}) vacío — si no hay nada que actualizar, devolver el chat existente
  if (Object.keys(updates).length === 0) {
    const [chat] = await db
      .select()
      .from(whatsappChats)
      .where(and(eq(whatsappChats.id, id), eq(whatsappChats.businessId, businessId)))
      .limit(1)
    if (!chat) return c.json({ error: 'Chat not found' }, 404)
    return c.json({ chat })
  }

  const [updated] = await db
    .update(whatsappChats)
    .set(updates)
    .where(and(eq(whatsappChats.id, id), eq(whatsappChats.businessId, businessId)))
    .returning()

  if (!updated) return c.json({ error: 'Chat not found' }, 404)

  return c.json({ chat: updated })
})

whatsappRoutes.get('/chats/:id/messages', requireJwt, zvQuery(messagesQuerySchema), async (c) => {
  const db = createDb(c.env.DATABASE_URL)
  const businessId = c.get('businessId')
  const id = c.req.param('id')
  const { page, limit } = c.req.valid('query')

  const [chat] = await db
    .select()
    .from(whatsappChats)
    .where(and(eq(whatsappChats.id, id), eq(whatsappChats.businessId, businessId)))
    .limit(1)

  if (!chat) return c.json({ error: 'Chat not found' }, 404)

  const offset = (page - 1) * limit

  const messages = await db
    .select()
    .from(whatsappMessages)
    .where(eq(whatsappMessages.chatId, id))
    .orderBy(desc(whatsappMessages.createdAt))
    .limit(limit)
    .offset(offset)

  return c.json({ messages, page, limit })
})

whatsappRoutes.post('/chats/:id/messages', zv(sendMessageSchema), async (c) => {
  const db = createDb(c.env.DATABASE_URL)
  const businessId = c.get('businessId')
  const id = c.req.param('id')
  const { content, sender } = c.req.valid('json')

  const [chat] = await db
    .select()
    .from(whatsappChats)
    .where(and(eq(whatsappChats.id, id), eq(whatsappChats.businessId, businessId)))
    .limit(1)

  if (!chat) return c.json({ error: 'Chat not found' }, 404)

  const now = new Date()

  const [message] = await db.transaction(async (tx) => {
    const [msg] = await tx
      .insert(whatsappMessages)
      .values({ chatId: id, businessId, sender, content })
      .returning()

    await tx
      .update(whatsappChats)
      .set({ lastMessage: content, lastMessageAt: now })
      .where(eq(whatsappChats.id, id))

    return [msg]
  })

  return c.json({ message }, 201)
})

export { whatsappRoutes }
