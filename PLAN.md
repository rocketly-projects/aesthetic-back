# Plan: aesthetic-back — Schema completo + rutas de negocio

## Contexto

El proyecto base generó una arquitectura multi-tenant genérica con una tabla `tenants`. El dominio real de **aesthetic** tiene entidades específicas: `Business` + `User` separados, `Client`, `Service`, `Appointment`, `WhatsappChat` y `WhatsappMessage`. Este plan reemplaza el schema genérico con el del dominio, adapta el sistema de auth, y agrega todas las rutas necesarias.

---

## Paso 1 — Schema (src/db/schema.ts)

Reemplazar la tabla `tenants` + `planEnum` por el schema completo del dominio. Agregar `passwordHash` a `users`.

Tablas resultantes:
- `businesses` — datos del negocio (name, phone, address, instagram, website, logoUrl)
- `business_hours` — 7 filas por negocio (dayOfWeek 0-6, open, fromTime, toTime)
- `users` — owner/staff del negocio (**+ passwordHash** text notNull)
- `clients` — CRM con campos cacheados (visits, totalSpent, lastVisitAt)
- `services` — catálogo (name, category, duration, price, color, visible)
- `appointments` — turno con snapshot (serviceName, duration, price desnormalizados)
- `whatsapp_chats` — conversación por número de teléfono
- `whatsapp_messages` — mensajes individuales

Enums: `appointment_status`, `user_role`, `message_sender`

IDs: `uuid().defaultRandom()`

Relaciones Drizzle: incluir todas las `relations()`.

---

## Paso 2 — JWT (src/lib/jwt.ts)

Cambiar `JwtPayload`:
```ts
type JwtPayload = {
  businessId: string
  userId: string
  email: string
  role: 'owner' | 'staff'
}
```

Actualizar `verifyJwt` para validar los 4 campos.

---

## Paso 3 — Tipos globales (src/index.ts)

Cambiar `Variables`:
```ts
type Variables = {
  businessId: string
  userId: string
  email: string
  role: 'owner' | 'staff'
}
```

---

## Paso 4 — Middleware (src/middleware/auth.ts)

Actualizar para setear `businessId`, `userId`, `email`, `role` en el contexto.

---

## Paso 5 — Auth routes (src/routes/auth.ts)

**POST /auth/register**
- Body: `{ email, password, name, businessName }`
- Crea `Business` + `User` (role: owner, passwordHash) en transacción
- Retorna `{ token, user, business }` con 201

**POST /auth/login**
- Busca `user` por email, join con `business`
- Compara hash, error genérico si falla
- Retorna `{ token, user, business }`

---

## Paso 6 — Rutas de negocio

### src/routes/businesses.ts
- `GET /businesses/me` — perfil del negocio
- `PUT /businesses/me` — actualizar perfil
- `GET /businesses/me/hours` — horarios (7 filas ordenadas por dayOfWeek)
- `PUT /businesses/me/hours` — upsert bulk (array de 7 días)

### src/routes/clients.ts
- `GET /clients` — lista paginada (page, limit, search por nombre/teléfono)
- `POST /clients` — crear
- `GET /clients/:id` — perfil con stats cacheadas
- `PUT /clients/:id` — editar
- `DELETE /clients/:id` — hard delete

### src/routes/services.ts
- `GET /services` — lista (query `visible`: true|false|all)
- `POST /services` — crear
- `GET /services/:id` — detalle
- `PUT /services/:id` — editar
- `DELETE /services/:id` — **soft delete** (visible=false)

### src/routes/appointments.ts
- `GET /appointments` — lista paginada con filtros (status, date, clientId)
- `POST /appointments` — crear con snapshot del servicio
- `GET /appointments/:id` — detalle
- `PUT /appointments/:id` — editar (status, notes, date, time)
- `DELETE /appointments/:id` — cambia status a `cancelled`
- `GET /appointments/agenda/:date` — turnos del día + slots libres disponibles

**Lógica al cambiar status → `completed`:**
- `clients.visits += 1`
- `clients.totalSpent += appointment.price`
- `clients.lastVisitAt = appointment.date`

**Agenda + disponibilidad:**
- Slots de 30 min entre `fromTime` y `toTime` del `businessHours` del día
- Un slot está ocupado si algún appointment activo lo cubre
- Respuesta: `{ date, appointments: [...], availableSlots: ["09:00", "09:30", ...] }`

### src/routes/whatsapp.ts
- `GET /whatsapp/chats` — lista ordenada por `lastMessageAt` desc
- `POST /whatsapp/chats` — crear o recuperar chat por `clientPhone`
- `GET /whatsapp/chats/:id` — detalle
- `PATCH /whatsapp/chats/:id` — actualizar `isBot`, marcar leído (`unread=0`)
- `GET /whatsapp/chats/:id/messages` — mensajes paginados
- `POST /whatsapp/chats/:id/messages` — enviar mensaje, actualiza `lastMessage` + `lastMessageAt`

---

## Paso 7 — Registrar rutas en index.ts

```ts
api.route('/businesses', businessRoutes)
api.route('/clients', clientRoutes)
api.route('/services', serviceRoutes)
api.route('/appointments', appointmentRoutes)
api.route('/whatsapp', whatsappRoutes)
```

---

## Archivos a modificar/crear

| Archivo | Acción |
|---|---|
| `src/db/schema.ts` | Reescribir completo |
| `src/lib/jwt.ts` | Nuevo JwtPayload (4 campos) |
| `src/index.ts` | Nuevas Variables + registrar rutas |
| `src/middleware/auth.ts` | Setear businessId, userId, email, role |
| `src/routes/auth.ts` | Reescribir con Business+User en transacción |
| `src/routes/businesses.ts` | Crear |
| `src/routes/clients.ts` | Crear |
| `src/routes/services.ts` | Crear |
| `src/routes/appointments.ts` | Crear (incluye agenda + slots) |
| `src/routes/whatsapp.ts` | Crear |

---

## Verificación

```bash
npm run generate   # genera SQL de migración
npm run migrate    # aplica en Supabase
npm run dev        # servidor en localhost:8787

# Register
curl -X POST http://localhost:8787/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"owner@test.com","password":"12345678","name":"Ana García","businessName":"Studio Ana"}'

# Login
curl -X POST http://localhost:8787/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"owner@test.com","password":"12345678"}'

# Ruta protegida
curl http://localhost:8787/businesses/me \
  -H "Authorization: Bearer <token>"

# Agenda con disponibilidad
curl http://localhost:8787/appointments/agenda/2025-05-10 \
  -H "Authorization: Bearer <token>"
```
