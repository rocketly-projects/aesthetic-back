# aesthetic-back — Contexto del Backend

## Stack

| Tecnología | Versión | Uso |
|---|---|---|
| Hono | ^4.7.7 | Framework HTTP |
| Cloudflare Workers | — | Runtime (wrangler dev/deploy) |
| Drizzle ORM | ^0.44.0 | ORM + migraciones |
| postgres.js | ^3.4.5 | Driver PostgreSQL |
| Zod | ^3.24.4 | Validación de esquemas |
| @hono/zod-validator | ^0.4.3 | Middleware de validación para Hono |
| bcryptjs | ^2.4.3 | Hash de contraseñas |
| jose | ^5.10.0 | JWT (sign/verify) |
| TypeScript | ^5.8.3 | — |

---

## Variables de entorno (Bindings / Cloudflare)

```ts
DATABASE_URL   // Cadena de conexión PostgreSQL
JWT_SECRET     // Secreto para firmar JWTs
FRONTEND_URL   // Origen permitido en CORS (+ localhost:3000 siempre)
GOOGLE_CLIENT_ID
BOT_API_KEY    // Clave para autenticación de bot
```

---

## Variables de contexto (Hono `c.get(...)`)

```ts
businessId  // uuid
userId      // uuid
email       // string
role        // 'owner' | 'staff'
authSource  // 'jwt' | 'bot'
```

---

## Estructura de archivos

```
src/
├── index.ts                  # Entry point, Bindings/Variables, error handler, rutas
├── db/
│   └── schema.ts             # Todas las tablas y relaciones Drizzle
├── lib/
│   ├── db.ts                 # createDb(url) — factory de conexión
│   ├── jwt.ts                # signJwt() / verifyJwt()
│   ├── validator.ts          # zv() (json) y zvQuery() (query params)
│   ├── slug.ts               # slugify() y createUniqueSlug(db, name)
│   └── date-ranges.ts        # Utilidades de rangos de fechas
├── middleware/
│   ├── auth.ts               # authMiddleware (JWT puro, no usado en rutas actuales)
│   └── botAuth.ts            # dualAuth, requireJwt, apiKeyAuth
└── routes/
    ├── auth.ts               # /auth/*
    ├── businesses.ts         # /businesses/*
    ├── clients.ts            # /clients/*
    ├── services.ts           # /services/*
    ├── appointments.ts       # /appointments/*
    ├── whatsapp.ts           # /whatsapp/*
    ├── bot.ts                # /bot/*
    └── public.ts             # /public/*
```

---

## Registro de rutas (`src/index.ts`)

```
/auth/*       -> authRoutes        (sin auth)
/bot/*        -> botRoutes         (sin auth de negocio, usa apiKeyAuth internamente)
/public/*     -> publicRoutes      (sin auth, CORS *)

/* (sub-router protegido por dualAuth):
  /businesses/*  -> businessRoutes
  /clients/*     -> clientRoutes
  /services/*    -> serviceRoutes
  /appointments/* -> appointmentRoutes
  /whatsapp/*    -> whatsappRoutes
```

---

## CORS

- Rutas generales: origen permitido = `FRONTEND_URL` + `http://localhost:3000`, con `credentials: true`.
- `/public/*`: `origin: '*'`, solo GET/POST/OPTIONS.

---

## Autenticación y middleware

### `dualAuth` (aplicado a todo el sub-router protegido)
Acepta **JWT** (`Authorization: Bearer <token>`) **O** bot key (`X-API-Key` + `X-Business-Id`).
- JWT: decodifica y pone `businessId`, `userId`, `email`, `role`, `authSource=jwt`.
- Bot key: valida `X-API-Key === BOT_API_KEY`, busca el negocio por `X-Business-Id`, pone `businessId`, `authSource=bot`.

### `requireJwt`
Middleware adicional en rutas que **no** deben aceptar bot auth. Rechaza si `authSource !== 'jwt'`.

### `apiKeyAuth`
Solo valida `X-API-Key`. Usado en `/bot/identify` (aún no tiene businessId).

### `authMiddleware` (`middleware/auth.ts`)
JWT puro. Actualmente no montado en ninguna ruta (reemplazado por `dualAuth`).

---

## Error handler global

| Condición | Respuesta |
|---|---|
| PG `23505` (unique violation) | 409 `Resource already exists` |
| PG `P0002` o mensaje "not found" | 404 `Resource not found` |
| `BusinessError` | status de la instancia (400/404/409/422) |
| Otros | 500 (mensaje real solo si `FRONTEND_URL` contiene "localhost") |

`BusinessError` se exporta desde `index.ts` y se usa en rutas para lanzar errores controlados.

---

## Schema de base de datos (`src/db/schema.ts`)

### Enums
- `appointment_status`: `pending`, `confirmed`, `completed`, `cancelled`, `no_show`
- `user_role`: `owner`, `staff`
- `message_sender`: `client`, `owner`, `bot`

### Tabla `businesses`
| Campo | Tipo | Notas |
|---|---|---|
| id | uuid PK | defaultRandom |
| name | text NOT NULL | |
| slug | text UNIQUE NOT NULL | |
| phone | text | |
| address | text | |
| instagram | text | |
| website | text | |
| logoUrl | text | |
| whatsappPhone | text | Para identificación bot |
| depositRequired | boolean NOT NULL | default false |
| depositPercent | integer NOT NULL | default 0 |
| createdAt / updatedAt | timestamp | defaultNow |

### Tabla `business_hours`
| Campo | Tipo | Notas |
|---|---|---|
| id | uuid PK | |
| businessId | uuid FK → businesses | cascade delete |
| dayOfWeek | integer | 0=Domingo … 6=Sábado |
| open | boolean NOT NULL | default true |
| fromTime | text | HH:MM |
| toTime | text | HH:MM |

### Tabla `users`
| Campo | Tipo | Notas |
|---|---|---|
| id | uuid PK | |
| businessId | uuid FK → businesses | cascade delete |
| email | text UNIQUE NOT NULL | |
| passwordHash | text | null si Google OAuth |
| name | text NOT NULL | |
| role | user_role | default 'owner' |
| createdAt | timestamp | |

### Tabla `clients`
| Campo | Tipo | Notas |
|---|---|---|
| id | uuid PK | |
| businessId | uuid FK → businesses | cascade delete |
| name | text NOT NULL | |
| phone | text | |
| email | text | |
| notes | text | |
| visits | integer NOT NULL | default 0, se incrementa al completar cita |
| totalSpent | integer NOT NULL | default 0, ídem |
| lastVisitAt | timestamp | |
| createdAt / updatedAt | timestamp | |

### Tabla `services`
| Campo | Tipo | Notas |
|---|---|---|
| id | uuid PK | |
| businessId | uuid FK → businesses | cascade delete |
| name | text NOT NULL | |
| category | text | |
| duration | integer NOT NULL | minutos |
| price | integer NOT NULL | centavos / entero |
| color | text | |
| visible | boolean NOT NULL | default true |
| createdAt / updatedAt | timestamp | |

> **Soft delete**: `DELETE /services/:id` pone `visible=false`, no elimina el registro.

### Tabla `appointments`
| Campo | Tipo | Notas |
|---|---|---|
| id | uuid PK | |
| businessId | uuid FK → businesses | cascade delete |
| clientId | uuid FK → clients | set null on delete |
| serviceId | uuid FK → services | set null on delete |
| serviceName | text NOT NULL | snapshot al momento de reserva |
| duration | integer NOT NULL | snapshot |
| price | integer NOT NULL | snapshot |
| date | text NOT NULL | YYYY-MM-DD |
| time | text NOT NULL | HH:MM |
| status | appointment_status | default 'pending' |
| notes | text | |
| createdAt / updatedAt | timestamp | |

> **Soft delete**: `DELETE /appointments/:id` pone `status='cancelled'`.

### Tabla `whatsapp_chats`
| Campo | Tipo | Notas |
|---|---|---|
| id | uuid PK | |
| businessId | uuid FK → businesses | cascade delete |
| clientPhone | text NOT NULL | |
| clientName | text | |
| isBot | boolean NOT NULL | default true |
| unread | integer NOT NULL | default 0 |
| lastMessage | text | |
| lastMessageAt | timestamp | |
| createdAt | timestamp | |

### Tabla `whatsapp_messages`
| Campo | Tipo | Notas |
|---|---|---|
| id | uuid PK | |
| chatId | uuid FK → whatsapp_chats | cascade delete |
| businessId | uuid FK → businesses | cascade delete |
| sender | message_sender NOT NULL | client/owner/bot |
| content | text NOT NULL | |
| createdAt | timestamp | |

---

## Endpoints por módulo

### `POST /auth/register`
Crea negocio + usuario owner en una transacción. Genera slug único. Devuelve `{ token, user, business }`.

**Body:** `{ email, password (min 8), name, businessName }`

### `POST /auth/login`
Verifica credenciales con bcrypt. Devuelve `{ token, user, business }`.

**Body:** `{ email, password }`

### `POST /auth/google`
Verifica Google ID token con JWKS. Tres casos:
- Usuario existente → JWT
- Usuario nuevo sin `businessName` → `{ needsOnboarding: true }`
- Usuario nuevo con `businessName` → crea negocio + usuario, devuelve JWT

**Body:** `{ credential, businessName? }`

---

### `GET /businesses/me` *(requireJwt)*
Devuelve el negocio del usuario autenticado.

### `PUT /businesses/me` *(requireJwt)*
Actualiza datos del negocio. El slug se normaliza con `slugify()`.

**Body (parcial):** `{ name?, slug?, phone?, address?, instagram?, website?, logoUrl?, depositRequired?, depositPercent? }`

### `GET /businesses/me/hours` *(dualAuth)*
Devuelve las 7 filas de horario ordenadas por `dayOfWeek`.

### `PUT /businesses/me/hours` *(requireJwt)*
Reemplaza los 7 días de horario en una transacción (delete + insert).

**Body:** array de 7 objetos `{ dayOfWeek (0-6), open, fromTime (HH:MM), toTime (HH:MM) }`

---

### `GET /clients` *(dualAuth)*
Lista paginada. Soporta búsqueda por nombre o teléfono.

**Query:** `page?, limit?, search?`

### `POST /clients` *(dualAuth)*
Crea cliente.

**Body:** `{ name, phone?, email?, notes? }`

### `GET /clients/:id` *(requireJwt)*
### `PUT /clients/:id` *(requireJwt)*
### `DELETE /clients/:id` *(requireJwt)* — elimina físicamente

---

### `GET /services` *(dualAuth)*
Lista servicios. Query `visible=true|false|all` (default `all`).

### `POST /services` *(requireJwt)*
**Body:** `{ name, category?, duration (min), price (int), color?, visible? }`

### `GET /services/:id` *(requireJwt)*
### `PUT /services/:id` *(requireJwt)*
### `DELETE /services/:id` *(requireJwt)* — soft delete (`visible=false`)

---

### `GET /appointments/agenda/:date` *(dualAuth)*
Devuelve citas del día + slots libres de 30 min dentro del horario del negocio.

**Respuesta:** `{ date, appointments[], availableSlots[] }`

### `GET /appointments` *(requireJwt)*
Lista paginada con filtros.

**Query:** `page?, limit?, status?, date?, clientId?`

### `POST /appointments` *(dualAuth)*
Crea cita. Hace snapshot de nombre/duración/precio del servicio.

**Body:** `{ clientId?, serviceId, date, time, notes? }`

### `GET /appointments/:id` *(requireJwt)*
### `PUT /appointments/:id` *(requireJwt)*
Actualiza estado/notas/fecha/hora. Si pasa a `completed`, incrementa `visits`, `totalSpent` y `lastVisitAt` del cliente (dentro de una transacción).

**Body (parcial):** `{ status?, notes?, date?, time? }`

### `DELETE /appointments/:id` *(dualAuth)* — soft delete (`status='cancelled'`)

---

### `GET /whatsapp/chats` *(requireJwt)*
Lista chats ordenados por `lastMessageAt` desc.

### `POST /whatsapp/chats` *(dualAuth)*
Find-or-create chat por `clientPhone`.

**Body:** `{ clientPhone, clientName? }`

### `GET /whatsapp/chats/:id` *(requireJwt)*
### `PATCH /whatsapp/chats/:id` *(requireJwt)*
**Body:** `{ isBot?, markRead? }`

### `GET /whatsapp/chats/:id/messages` *(requireJwt)*
Paginado, ordenado desc (más recientes primero).

**Query:** `page?, limit? (max 100)`

### `POST /whatsapp/chats/:id/messages` *(dualAuth)*
Guarda mensaje y actualiza `lastMessage` / `lastMessageAt` del chat en transacción.

**Body:** `{ content, sender: 'client'|'owner'|'bot' }`

---

### `POST /bot/identify` *(apiKeyAuth)*
Busca un negocio por su `whatsappPhone`.

**Header:** `X-API-Key`
**Body:** `{ whatsappPhone }`
**Respuesta:** `{ businessId, businessName, whatsappPhone }`

---

### `GET /public/:slug`
Info pública del negocio + horarios.

**Respuesta:** `{ business: { name, slug, address, phone, instagram, logoUrl, depositRequired, depositPercent }, hours[] }`

### `GET /public/:slug/services`
Servicios visibles del negocio, ordenados por nombre.

### `GET /public/:slug/availability?date=YYYY-MM-DD&serviceId=uuid`
Slots disponibles de 30 min para un servicio en una fecha. Excluye citas no canceladas. Genera slots desde apertura hasta `cierre - duración_servicio`.

### `POST /public/:slug/appointments`
Reserva pública (widget de booking). Dentro de una transacción:
1. Re-verifica disponibilidad del slot (evita race conditions).
2. Find-or-create cliente por teléfono.
3. Crea cita con `status='pending'`.

**Body:** `{ serviceId, date, time, clientName, clientPhone, clientEmail? }`
**Respuesta:** `{ appointment: { id, date, time, serviceName, price, status }, deposit: { required, percent, amount } }`

---

## Lógica de disponibilidad

- Slots de **30 minutos** fijos.
- Un slot `[m, m+duración)` se bloquea si intersecta con cualquier cita activa (no cancelada) `[apptStart, apptStart+apptDuration)`.
- Condición de solapamiento: `m < apptEnd && slotEnd > apptStart`.
- El día de la semana se calcula con `new Date(\`\${date}T12:00:00Z\`).getUTCDay()` para evitar shifts de timezone.

---

## Scripts

```bash
npm run dev       # wrangler dev
npm run deploy    # wrangler deploy
npm run generate  # drizzle-kit generate (crea migración)
npm run migrate   # drizzle-kit migrate (aplica migración)
npm run studio    # drizzle-kit studio (UI de base de datos)
```

---

## Notas importantes

- El campo `slug` en `businesses` es `NOT NULL UNIQUE`. Al migrar desde datos existentes hay que popular slugs manualmente antes de correr la migración.
- Los precios y montos se manejan como **enteros** (sin decimales).
- `authMiddleware` en `middleware/auth.ts` existe pero **no está montado** en ninguna ruta; todo pasa por `dualAuth`.
- `date-ranges.ts` existe pero no está importado en ninguna ruta actualmente.
