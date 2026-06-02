import { Hono } from 'hono'
import { eq, and, asc, sql, getTableColumns } from 'drizzle-orm'
import { z } from 'zod'
import { createDb } from '../lib/db'
import { appointments, clients, services, businessHours, businesses } from '../db/schema'
import { zv, zvQuery } from '../lib/validator'
import { requireJwt } from '../middleware/botAuth'
import { createMpPreference } from '../lib/mp'
import { insertNotification } from '../lib/notifications'
import type { Bindings, Variables } from '../index'

const ALL_STATUSES = ['pending', 'confirmed', 'completed', 'cancelled', 'no_show', 'awaiting_payment'] as const

const appointmentRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>()

const createAppointmentSchema = z.object({
  clientId: z.string().uuid().optional(),
  serviceId: z.string().uuid(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD'),
  time: z.string().regex(/^\d{2}:\d{2}$/, 'time must be HH:MM'),
  notes: z.string().optional(),
})

const updateAppointmentSchema = z.object({
  status: z.enum(ALL_STATUSES).optional(),
  notes: z.string().optional(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  time: z.string().regex(/^\d{2}:\d{2}$/).optional(),
})

const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  status: z.enum(ALL_STATUSES).optional(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  clientId: z.string().uuid().optional(),
})

function timeToMinutes(t: string): number {
  const [h, m] = t.split(':').map(Number)
  return h * 60 + m
}

function minutesToTime(mins: number): string {
  return `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`
}

// IMPORTANT: registered before /:id to avoid "agenda" matching as an id
appointmentRoutes.get('/agenda/:date', async (c) => {
  const db = createDb(c.env.DATABASE_URL)
  const businessId = c.get('businessId')
  const date = c.req.param('date')

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return c.json({ error: 'Formato de fecha inválido, usá YYYY-MM-DD' }, 400)
  }

  // Use noon UTC to avoid date shifting across timezones
  const dayOfWeek = new Date(`${date}T12:00:00Z`).getUTCDay()

  const [dayHours] = await db
    .select()
    .from(businessHours)
    .where(
      and(eq(businessHours.businessId, businessId), eq(businessHours.dayOfWeek, dayOfWeek))
    )
    .limit(1)

  const dayAppointments = await db
    .select({
      ...getTableColumns(appointments),
      clientName: clients.name,
    })
    .from(appointments)
    .leftJoin(clients, eq(appointments.clientId, clients.id))
    .where(and(eq(appointments.businessId, businessId), eq(appointments.date, date)))
    .orderBy(asc(appointments.time))

  const activeAppointments = dayAppointments.filter((a) => a.status !== 'cancelled')

  let availableSlots: string[] = []

  if (dayHours?.open) {
    const start = timeToMinutes(dayHours.fromTime)
    const end = timeToMinutes(dayHours.toTime)

    // Build set of minutes blocked by active appointments
    const busyMinutes = new Set<number>()
    for (const appt of activeAppointments) {
      const apptStart = timeToMinutes(appt.time)
      const apptEnd = apptStart + appt.duration
      for (let m = apptStart; m < apptEnd; m += 30) {
        busyMinutes.add(m)
      }
    }

    // Generate 30-min slots within business hours and filter busy ones
    for (let m = start; m < end; m += 30) {
      if (!busyMinutes.has(m)) {
        availableSlots.push(minutesToTime(m))
      }
    }
  }

  return c.json({ date, appointments: dayAppointments, availableSlots })
})

appointmentRoutes.get('/', zvQuery(listQuerySchema), async (c) => {
  const db = createDb(c.env.DATABASE_URL)
  const businessId = c.get('businessId')
  const { page, limit, status, date, clientId } = c.req.valid('query')

  const offset = (page - 1) * limit

  const rows = await db
    .select({
      ...getTableColumns(appointments),
      clientName: clients.name,
    })
    .from(appointments)
    .leftJoin(clients, eq(appointments.clientId, clients.id))
    .where(
      and(
        eq(appointments.businessId, businessId),
        status ? eq(appointments.status, status) : undefined,
        date ? eq(appointments.date, date) : undefined,
        clientId ? eq(appointments.clientId, clientId) : undefined
      )
    )
    .orderBy(asc(appointments.date), asc(appointments.time))
    .limit(limit)
    .offset(offset)

  return c.json({ appointments: rows, page, limit })
})

appointmentRoutes.post('/', zv(createAppointmentSchema), async (c) => {
  const db = createDb(c.env.DATABASE_URL)
  const businessId  = c.get('businessId')
  const authSource  = c.get('authSource')   // 'jwt' = owner, 'bot' = chatbot
  const { clientId, serviceId, date, time, notes } = c.req.valid('json')

  const [service] = await db
    .select()
    .from(services)
    .where(and(eq(services.id, serviceId), eq(services.businessId, businessId)))
    .limit(1)

  if (!service) return c.json({ error: 'Servicio no encontrado' }, 404)

  // El owner siempre confirma directamente; el bot respeta botDepositRequired
  let needsDeposit = false
  let mpAccessToken: string | null = null
  let depositPercent = 0
  let businessSlug = ''

  if (authSource === 'bot') {
    const [biz] = await db
      .select({ botDepositRequired: businesses.botDepositRequired, depositPercent: businesses.depositPercent, mpAccessToken: businesses.mpAccessToken, slug: businesses.slug })
      .from(businesses)
      .where(eq(businesses.id, businessId))
      .limit(1)

    if (biz?.botDepositRequired && biz.mpAccessToken) {
      needsDeposit   = true
      mpAccessToken  = biz.mpAccessToken
      depositPercent = biz.depositPercent
      businessSlug   = biz.slug
    }
  }

  const paymentExpiresAt = needsDeposit ? new Date(Date.now() + 30 * 60 * 1000) : null

  const [appointment] = await db
    .insert(appointments)
    .values({
      businessId,
      clientId,
      serviceId,
      serviceName: service.name,
      duration:    service.duration,
      price:       service.price,
      date,
      time,
      notes,
      status:          needsDeposit ? 'awaiting_payment' : 'confirmed',
      paymentExpiresAt,
    })
    .returning()

  // Notificación al dueño del negocio (no debe romper la reserva si falla)
  try {
    const clientName = clientId
      ? (await db.select({ name: clients.name }).from(clients).where(eq(clients.id, clientId)).limit(1))[0]?.name ?? 'Cliente'
      : 'Cliente'
    await insertNotification(
      db,
      businessId,
      'new_appointment',
      'Nuevo turno',
      `${clientName} reservó ${service.name} para el ${appointment.date} a las ${appointment.time}`,
      appointment.id
    )
  } catch (err) {
    console.error('[appointments/post] notification error:', err)
  }

  // Si requiere depósito, crear preferencia MP y actualizar el turno
  if (needsDeposit && mpAccessToken) {
    const depositAmount = Math.round((service.price * depositPercent) / 100)
    try {
      const backendUrl = new URL(c.req.url).origin
      const { preferenceId, initPoint, depositAmount: mpDepositAmount } = await createMpPreference({
        businessId,
        businessSlug:  businessSlug,
        appointmentId: appointment.id,
        serviceName:   service.name,
        price:         service.price,
        depositPercent,
        mpAccessToken,
        frontendUrl:   c.env.FRONTEND_URL,
        backendUrl,
      })

      await db
        .update(appointments)
        .set({ mpPreferenceId: preferenceId, updatedAt: new Date() })
        .where(eq(appointments.id, appointment.id))

      return c.json({
        appointment: { ...appointment, status: 'awaiting_payment' as const },
        deposit: { required: true, percent: depositPercent, amount: mpDepositAmount, initPoint, expiresAt: paymentExpiresAt },
      }, 201)
    } catch (err) {
      // Si MP falla, devolvemos el turno como awaiting_payment sin link de pago
      // El bot debe informarle al cliente que intente de nuevo
      console.error('[appointments/post] MP preference error:', err)
      return c.json({
        appointment: { ...appointment, status: 'awaiting_payment' as const },
        deposit: { required: true, percent: depositPercent, amount: depositAmount, initPoint: null, expiresAt: paymentExpiresAt },
        mpError: true,
      }, 201)
    }
  }

  return c.json({
    appointment,
    deposit: { required: false, percent: 0, amount: 0, initPoint: null, expiresAt: null },
  }, 201)
})

appointmentRoutes.get('/:id', requireJwt, async (c) => {
  const db = createDb(c.env.DATABASE_URL)
  const businessId = c.get('businessId')
  const id = c.req.param('id')

  const [appointment] = await db
    .select({
      ...getTableColumns(appointments),
      clientName: clients.name,
    })
    .from(appointments)
    .leftJoin(clients, eq(appointments.clientId, clients.id))
    .where(and(eq(appointments.id, id), eq(appointments.businessId, businessId)))
    .limit(1)

  if (!appointment) return c.json({ error: 'Turno no encontrado' }, 404)

  return c.json({ appointment })
})

appointmentRoutes.put('/:id', requireJwt, zv(updateAppointmentSchema), async (c) => {
  const db = createDb(c.env.DATABASE_URL)
  const businessId = c.get('businessId')
  const id = c.req.param('id')
  const data = c.req.valid('json')

  const [existing] = await db
    .select()
    .from(appointments)
    .where(and(eq(appointments.id, id), eq(appointments.businessId, businessId)))
    .limit(1)

  if (!existing) return c.json({ error: 'Turno no encontrado' }, 404)

  const [updated] = await db.transaction(async (tx) => {
    const [appt] = await tx
      .update(appointments)
      .set({ ...data, updatedAt: new Date() })
      .where(and(eq(appointments.id, id), eq(appointments.businessId, businessId)))
      .returning()

    // When newly marked completed, update cached client stats
    if (data.status === 'completed' && existing.status !== 'completed' && existing.clientId) {
      await tx
        .update(clients)
        .set({
          visits: sql`${clients.visits} + 1`,
          totalSpent: sql`${clients.totalSpent} + ${existing.price}`,
          lastVisitAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(clients.id, existing.clientId))
    }

    return [appt]
  })

  return c.json({ appointment: updated })
})

// Soft delete: sets status to cancelled
appointmentRoutes.delete('/:id', async (c) => {
  const db = createDb(c.env.DATABASE_URL)
  const businessId = c.get('businessId')
  const id = c.req.param('id')

  const [updated] = await db
    .update(appointments)
    .set({ status: 'cancelled', updatedAt: new Date() })
    .where(and(eq(appointments.id, id), eq(appointments.businessId, businessId)))
    .returning()

  if (!updated) return c.json({ error: 'Turno no encontrado' }, 404)

  return c.json({ appointment: updated })
})

export { appointmentRoutes }
