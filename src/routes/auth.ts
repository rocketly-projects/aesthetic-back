import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { jwtVerify, createRemoteJWKSet } from 'jose'
import bcrypt from 'bcryptjs'
import { createDb } from '../lib/db'
import { signJwt } from '../lib/jwt'
import { zv } from '../lib/validator'
import { businesses, users } from '../db/schema'
import { createUniqueSlug } from '../lib/slug'
import type { Bindings } from '../index'

const authRoutes = new Hono<{ Bindings: Bindings }>()

const GOOGLE_JWKS = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'))

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  name: z.string().min(1).max(100),
  businessName: z.string().min(1).max(100),
})

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
})

const googleSchema = z.object({
  credential: z.string().min(1),
  businessName: z.string().min(1).max(100).optional(),
})

authRoutes.post('/register', zv(registerSchema), async (c) => {
  const { email, password, name, businessName } = c.req.valid('json')
  const db = createDb(c.env.DATABASE_URL)

  const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1)
  if (existing) {
    return c.json({ error: 'El email ya está registrado' }, 409)
  }

  const passwordHash = await bcrypt.hash(password, 12)

  const slug = await createUniqueSlug(db, businessName)

  const { business, user } = await db.transaction(async (tx) => {
    const trialEndsAt = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000)

    const [business] = await tx
      .insert(businesses)
      .values({ name: businessName, slug, trialEndsAt })
      .returning()

    const [user] = await tx
      .insert(users)
      .values({ businessId: business.id, email, passwordHash, name, role: 'owner' })
      .returning({
        id: users.id,
        businessId: users.businessId,
        email: users.email,
        name: users.name,
        role: users.role,
        createdAt: users.createdAt,
      })

    return { business, user }
  })

  const token = await signJwt(
    { businessId: business.id, userId: user.id, email: user.email, role: user.role },
    c.env
  )

  return c.json({ token, user, business }, 201)
})

authRoutes.post('/login', zv(loginSchema), async (c) => {
  const { email, password } = c.req.valid('json')
  const db = createDb(c.env.DATABASE_URL)

  const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1)

  if (!user || !user.passwordHash) {
    return c.json({ error: 'Email o contraseña incorrectos' }, 401)
  }

  const valid = await bcrypt.compare(password, user.passwordHash)
  if (!valid) {
    return c.json({ error: 'Email o contraseña incorrectos' }, 401)
  }

  const [business] = await db
    .select()
    .from(businesses)
    .where(eq(businesses.id, user.businessId))
    .limit(1)

  const token = await signJwt(
    { businessId: business.id, userId: user.id, email: user.email, role: user.role },
    c.env
  )

  const { passwordHash: _, ...safeUser } = user

  return c.json({ token, user: safeUser, business })
})

authRoutes.post('/google', zv(googleSchema), async (c) => {
  const { credential, businessName } = c.req.valid('json')
  const db = createDb(c.env.DATABASE_URL)

  let googleEmail: string
  let googleName: string

  try {
    const { payload } = await jwtVerify(credential, GOOGLE_JWKS, {
      audience: c.env.GOOGLE_CLIENT_ID,
      issuer: ['https://accounts.google.com', 'accounts.google.com'],
    })

    const email = payload['email']
    const name = payload['name']

    if (typeof email !== 'string' || typeof name !== 'string') {
      return c.json({ error: 'No se pudo verificar tu cuenta de Google' }, 401)
    }

    googleEmail = email
    googleName = name
  } catch (err: unknown) {
    // jose errors have a `code` field (ERR_JWT_EXPIRED, ERR_JWS_INVALID, etc.)
    if (err !== null && typeof err === 'object' && 'code' in err) {
      return c.json({ error: 'El acceso con Google expiró, intentá de nuevo' }, 401)
    }
    return c.json({ error: 'Error al verificar con Google, intentá de nuevo' }, 500)
  }

  const [existingUser] = await db
    .select()
    .from(users)
    .where(eq(users.email, googleEmail))
    .limit(1)

  if (existingUser) {
    // Case A: existing user — issue JWT
    const [business] = await db
      .select()
      .from(businesses)
      .where(eq(businesses.id, existingUser.businessId))
      .limit(1)

    const token = await signJwt(
      { businessId: business.id, userId: existingUser.id, email: existingUser.email, role: existingUser.role },
      c.env
    )

    const { passwordHash: _, ...safeUser } = existingUser
    return c.json({ token, user: safeUser, business }, 200)
  }

  if (!businessName) {
    // Case C: new user without businessName — ask frontend for onboarding
    return c.json({ needsOnboarding: true }, 200)
  }

  // Case B: new user + businessName — create business and owner
  const slug = await createUniqueSlug(db, businessName)

  const { business, user } = await db.transaction(async (tx) => {
    const trialEndsAt = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000)

    const [business] = await tx
      .insert(businesses)
      .values({ name: businessName, slug, trialEndsAt })
      .returning()

    const [user] = await tx
      .insert(users)
      .values({ businessId: business.id, email: googleEmail, passwordHash: null, name: googleName, role: 'owner' })
      .returning({
        id: users.id,
        businessId: users.businessId,
        email: users.email,
        name: users.name,
        role: users.role,
        createdAt: users.createdAt,
      })

    return { business, user }
  })

  const token = await signJwt(
    { businessId: business.id, userId: user.id, email: user.email, role: user.role },
    c.env
  )

  return c.json({ token, user, business }, 201)
})

export { authRoutes }
