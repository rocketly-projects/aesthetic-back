import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { authRoutes } from './routes/auth'
import { businessRoutes } from './routes/businesses'
import { clientRoutes } from './routes/clients'
import { serviceRoutes } from './routes/services'
import { appointmentRoutes } from './routes/appointments'
import { whatsappRoutes } from './routes/whatsapp'
import { botRoutes } from './routes/bot'
import { authMiddleware } from './middleware/auth'
import { dualAuth } from './middleware/botAuth'

export type Bindings = {
  DATABASE_URL: string
  JWT_SECRET: string
  FRONTEND_URL: string
  GOOGLE_CLIENT_ID: string
  BOT_API_KEY: string
}

export type Variables = {
  businessId: string
  userId: string
  email: string
  role: 'owner' | 'staff'
  authSource: 'jwt' | 'bot'
}

const app = new Hono<{ Bindings: Bindings; Variables: Variables }>()

app.use(
  '*',
  cors({
    origin: (origin, c) => {
      const allowed = [c.env.FRONTEND_URL, 'http://localhost:3000'].filter(Boolean)
      return allowed.includes(origin) ? origin : null
    },
    allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization'],
    credentials: true,
  })
)

// Rutas públicas
app.route('/auth', authRoutes)
app.route('/bot', botRoutes)

// Sub-router protegido (JWT o bot key según la ruta)
const api = new Hono<{ Bindings: Bindings; Variables: Variables }>()
api.use('*', dualAuth)
api.route('/businesses', businessRoutes)
api.route('/clients', clientRoutes)
api.route('/services', serviceRoutes)
api.route('/appointments', appointmentRoutes)
api.route('/whatsapp', whatsappRoutes)
app.route('/', api)

app.notFound((c) => c.json({ error: 'Not found' }, 404))

app.onError((err, c) => {
  const isDev = c.env.FRONTEND_URL?.includes('localhost')

  // Postgres error codes
  const pgCode = (err as { code?: string }).code

  if (pgCode === '23505') {
    return c.json({ error: 'Resource already exists' }, 409)
  }

  if (pgCode === 'P0002' || (err.message && err.message.includes('not found'))) {
    return c.json({ error: 'Resource not found' }, 404)
  }

  // BusinessError
  if (err instanceof BusinessError) {
    return c.json({ error: err.message }, err.status)
  }

  const message = isDev ? err.message : 'Internal server error'
  return c.json({ error: message }, 500)
})

export class BusinessError extends Error {
  constructor(
    message: string,
    public status: 400 | 404 | 409 | 422 = 400
  ) {
    super(message)
    this.name = 'BusinessError'
  }
}

export default app
