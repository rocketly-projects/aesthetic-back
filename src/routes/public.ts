import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { eq, and, ne, asc, desc, ilike } from 'drizzle-orm'
import { z } from 'zod'
import { createDb } from '../lib/db'
import { businesses, businessHours, services, appointments, clients } from '../db/schema'
import { zv, zvQuery } from '../lib/validator'
import { createMpPreference } from '../lib/mp'
import { insertNotification } from '../lib/notifications'
import type { Bindings, Variables } from '../index'
import { BusinessError } from '../index'

const publicRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>()

// Allow all origins for the public booking widget
publicRoutes.use('*', cors({ origin: '*', allowMethods: ['GET', 'POST', 'OPTIONS'] }))

// ─── helpers ──────────────────────────────────────────────────────────────────

function timeToMinutes(t: string): number {
  const [h, m] = t.split(':').map(Number)
  return h * 60 + m
}

function minutesToTime(mins: number): string {
  return `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`
}

async function getBusinessBySlug(db: ReturnType<typeof createDb>, slug: string) {
  const [business] = await db
    .select()
    .from(businesses)
    .where(eq(businesses.slug, slug))
    .limit(1)
  return business ?? null
}

// ─── GET /public/businesses/search?q=xxx ──────────────────────────────────────

publicRoutes.get('/businesses/search', async (c) => {
  const q   = (c.req.query('q') ?? '').trim()
  const db  = createDb(c.env.DATABASE_URL)

  const cols = {
    name:    businesses.name,
    slug:    businesses.slug,
    address: businesses.address,
    logoUrl: businesses.logoUrl,
  }

  // Sin query → devolver los últimos 5 negocios registrados
  if (q.length < 2) {
    const rows = await db
      .select(cols)
      .from(businesses)
      .orderBy(asc(businesses.createdAt))
      .limit(5)
    return c.json({ businesses: rows })
  }

  // Con query → búsqueda por nombre (case-insensitive)
  const rows = await db
    .select(cols)
    .from(businesses)
    .where(ilike(businesses.name, `%${q}%`))
    .limit(8)

  return c.json({ businesses: rows })
})

// ─── GET /public/:slug ─────────────────────────────────────────────────────────

publicRoutes.get('/:slug', async (c) => {
  const db = createDb(c.env.DATABASE_URL)
  const slug = c.req.param('slug')

  const business = await getBusinessBySlug(db, slug)
  if (!business) return c.json({ error: 'Negocio no encontrado' }, 404)

  const hours = await db
    .select()
    .from(businessHours)
    .where(eq(businessHours.businessId, business.id))
    .orderBy(asc(businessHours.dayOfWeek))

  return c.json({
    business: {
      name: business.name,
      slug: business.slug,
      address: business.address,
      phone: business.phone,
      instagram: business.instagram,
      logoUrl: business.logoUrl,
      webDepositRequired: business.webDepositRequired,
      depositPercent: business.depositPercent,
    },
    hours: hours.map((h) => ({
      dayOfWeek: h.dayOfWeek,
      open: h.open,
      fromTime: h.fromTime,
      toTime: h.toTime,
    })),
  })
})

// ─── GET /public/:slug/services ───────────────────────────────────────────────

publicRoutes.get('/:slug/services', async (c) => {
  const db = createDb(c.env.DATABASE_URL)
  const slug = c.req.param('slug')

  const business = await getBusinessBySlug(db, slug)
  if (!business) return c.json({ error: 'Negocio no encontrado' }, 404)

  const rows = await db
    .select()
    .from(services)
    .where(and(eq(services.businessId, business.id), eq(services.visible, true)))
    .orderBy(asc(services.name))

  return c.json({
    services: rows.map((s) => ({
      id: s.id,
      name: s.name,
      duration: s.duration,
      price: s.price,
      color: s.color,
      category: s.category,
    })),
  })
})

// ─── GET /public/:slug/availability?date=YYYY-MM-DD&serviceId=xxx ─────────────

const availabilityQuerySchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD'),
  serviceId: z.string().uuid(),
})

publicRoutes.get('/:slug/availability', zvQuery(availabilityQuerySchema), async (c) => {
  const db = createDb(c.env.DATABASE_URL)
  const slug = c.req.param('slug')
  const { date, serviceId } = c.req.valid('query')

  const business = await getBusinessBySlug(db, slug)
  if (!business) return c.json({ error: 'Negocio no encontrado' }, 404)

  const [service] = await db
    .select()
    .from(services)
    .where(and(eq(services.id, serviceId), eq(services.businessId, business.id), eq(services.visible, true)))
    .limit(1)

  if (!service) return c.json({ error: 'Servicio no encontrado' }, 404)

  // Day of week (0=Sunday … 6=Saturday) — use noon UTC to avoid tz shifting
  const dayOfWeek = new Date(`${date}T12:00:00Z`).getUTCDay()

  const [dayHours] = await db
    .select()
    .from(businessHours)
    .where(and(eq(businessHours.businessId, business.id), eq(businessHours.dayOfWeek, dayOfWeek)))
    .limit(1)

  if (!dayHours?.open) return c.json({ slots: [] })

  const activeAppointments = await db
    .select({ time: appointments.time, duration: appointments.duration })
    .from(appointments)
    .where(
      and(
        eq(appointments.businessId, business.id),
        eq(appointments.date, date),
        ne(appointments.status, 'cancelled')
      )
    )

  const start = timeToMinutes(dayHours.fromTime)
  const end = timeToMinutes(dayHours.toTime)
  const serviceDuration = service.duration

  const slots: string[] = []
  for (let m = start; m + serviceDuration <= end; m += 30) {
    const slotEnd = m + serviceDuration
    const overlaps = activeAppointments.some((appt) => {
      const apptStart = timeToMinutes(appt.time)
      const apptEnd = apptStart + appt.duration
      return m < apptEnd && slotEnd > apptStart
    })
    if (!overlaps) slots.push(minutesToTime(m))
  }

  return c.json({ slots })
})

// ─── POST /public/:slug/appointments ─────────────────────────────────────────

const createPublicAppointmentSchema = z.object({
  serviceId: z.string().uuid(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD'),
  time: z.string().regex(/^\d{2}:\d{2}$/, 'time must be HH:MM'),
  clientName: z.string().min(1).max(100),
  clientPhone: z.string().min(1).max(30),
  clientEmail: z.string().email().optional(),
})

publicRoutes.post('/:slug/appointments', zv(createPublicAppointmentSchema), async (c) => {
  const db = createDb(c.env.DATABASE_URL)
  const slug = c.req.param('slug')
  const { serviceId, date, time, clientName, clientPhone, clientEmail } = c.req.valid('json')

  const business = await getBusinessBySlug(db, slug)
  if (!business) return c.json({ error: 'Negocio no encontrado' }, 404)

  const [service] = await db
    .select()
    .from(services)
    .where(and(eq(services.id, serviceId), eq(services.businessId, business.id), eq(services.visible, true)))
    .limit(1)

  if (!service) return c.json({ error: 'Servicio no encontrado' }, 404)

  const appointment = await db.transaction(async (tx) => {
    // Race condition check: re-verify slot availability inside the transaction
    const activeAppointments = await tx
      .select({ time: appointments.time, duration: appointments.duration })
      .from(appointments)
      .where(
        and(
          eq(appointments.businessId, business.id),
          eq(appointments.date, date),
          ne(appointments.status, 'cancelled')
        )
      )

    const slotStart = timeToMinutes(time)
    const slotEnd = slotStart + service.duration

    const overlaps = activeAppointments.some((appt) => {
      const apptStart = timeToMinutes(appt.time)
      const apptEnd = apptStart + appt.duration
      return slotStart < apptEnd && slotEnd > apptStart
    })

    if (overlaps) throw new BusinessError('El horario ya no está disponible', 409)

    // Find or create client by phone within this business
    let [client] = await tx
      .select()
      .from(clients)
      .where(and(eq(clients.businessId, business.id), eq(clients.phone, clientPhone)))
      .limit(1)

    if (!client) {
      ;[client] = await tx
        .insert(clients)
        .values({
          businessId: business.id,
          name: clientName,
          phone: clientPhone,
          email: clientEmail,
        })
        .returning()
    }

    const needsDeposit = business.webDepositRequired && !!business.mpAccessToken
    const paymentExpiresAt = needsDeposit ? new Date(Date.now() + 30 * 60 * 1000) : null

    const [appt] = await tx
      .insert(appointments)
      .values({
        businessId: business.id,
        clientId: client.id,
        serviceId: service.id,
        serviceName: service.name,
        duration: service.duration,
        price: service.price,
        date,
        time,
        status: needsDeposit ? 'awaiting_payment' : 'confirmed',
        paymentExpiresAt,
      })
      .returning()

    return appt
  })

  // Notificación al dueño del negocio
  await insertNotification(
    db,
    business.id,
    'new_appointment',
    'Nuevo turno',
    `${clientName} reservó ${service.name} para el ${appointment.date} a las ${appointment.time}`,
    appointment.id
  )

  // Si requiere depósito y MP está conectado, crear preferencia de pago
  if (business.webDepositRequired && business.mpAccessToken) {
    try {
      const backendUrl = new URL(c.req.url).origin
      const { preferenceId, initPoint, sandboxInitPoint, depositAmount } = await createMpPreference({
        businessId:    business.id,
        businessSlug:  business.slug,
        appointmentId: appointment.id,
        serviceName:   appointment.serviceName,
        price:         appointment.price,
        depositPercent: business.depositPercent,
        mpAccessToken: business.mpAccessToken,
        frontendUrl:   c.env.FRONTEND_URL,
        backendUrl,
      })

      // Guardar preferenceId en el turno
      await db
        .update(appointments)
        .set({ mpPreferenceId: preferenceId, updatedAt: new Date() })
        .where(eq(appointments.id, appointment.id))

      return c.json(
        {
          appointment: {
            id:          appointment.id,
            date:        appointment.date,
            time:        appointment.time,
            serviceName: appointment.serviceName,
            price:       appointment.price,
            status:      appointment.status,
          },
          deposit: {
            required:      true,
            percent:       business.depositPercent,
            amount:        depositAmount,
            initPoint,
            expiresAt:     appointment.paymentExpiresAt,
          },
        },
        201
      )
    } catch (err) {
      // Si MP falla, confirmar el turno de todas formas (no bloquear la reserva)
      console.error('[public/appointments] MP preference error:', err)
      await db
        .update(appointments)
        .set({ status: 'confirmed', paymentExpiresAt: null, updatedAt: new Date() })
        .where(eq(appointments.id, appointment.id))
    }
  }

  return c.json(
    {
      appointment: {
        id:          appointment.id,
        date:        appointment.date,
        time:        appointment.time,
        serviceName: appointment.serviceName,
        price:       appointment.price,
        status:      'confirmed',
      },
      deposit: {
        required: false,
        percent:  business.depositPercent,
        amount:   0,
        initPoint: null,
      },
    },
    201
  )
})

// ─── GET /public/appointment/:id — resumen público para el comprobante ────────

publicRoutes.get('/appointment/:id', async (c) => {
  const db = createDb(c.env.DATABASE_URL)
  const id = c.req.param('id')

  const [row] = await db
    .select({
      id:             appointments.id,
      serviceName:    appointments.serviceName,
      date:           appointments.date,
      time:           appointments.time,
      price:          appointments.price,
      status:         appointments.status,
      depositPercent: businesses.depositPercent,
      businessName:   businesses.name,
      businessSlug:   businesses.slug,
    })
    .from(appointments)
    .innerJoin(businesses, eq(appointments.businessId, businesses.id))
    .where(eq(appointments.id, id))
    .limit(1)

  if (!row) return c.json({ error: 'Turno no encontrado' }, 404)

  const depositAmount = Math.round((row.price * row.depositPercent) / 100)

  return c.json({
    id:           row.id,
    serviceName:  row.serviceName,
    date:         row.date,
    time:         row.time,
    status:       row.status,
    depositAmount,
    businessName: row.businessName,
    businessSlug: row.businessSlug,
  })
})

export { publicRoutes }
