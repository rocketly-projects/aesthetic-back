# Aesthetic Back — API Reference

## Base URL

```
http://localhost:8787
```

---

## Autenticación

Las rutas protegidas requieren un header:

```
Authorization: Bearer <token>
```

El token se obtiene en `/auth/register` o `/auth/login`. Expira en **7 días**.

El JWT contiene: `businessId`, `userId`, `email`, `role` (`owner` | `staff`).

---

## Auth (público)

### POST /auth/register
Crea un negocio y su usuario owner en una transacción.

**Body:**
```json
{
  "email": "owner@test.com",
  "password": "12345678",
  "name": "Ana García",
  "businessName": "Studio Ana"
}
```

**Response 201:**
```json
{
  "token": "eyJ...",
  "user": {
    "id": "uuid",
    "businessId": "uuid",
    "email": "owner@test.com",
    "name": "Ana García",
    "role": "owner",
    "createdAt": "2025-05-06T..."
  },
  "business": {
    "id": "uuid",
    "name": "Studio Ana",
    "phone": null,
    "address": null,
    "instagram": null,
    "website": null,
    "logoUrl": null,
    "createdAt": "...",
    "updatedAt": "..."
  }
}
```

---

### POST /auth/login

**Body:**
```json
{
  "email": "owner@test.com",
  "password": "12345678"
}
```

**Response 200:** igual que register (sin 201).

---

## Businesses 🔒

### GET /businesses/me
Retorna el perfil del negocio del usuario autenticado.

**Response:**
```json
{
  "business": { "id", "name", "phone", "address", "instagram", "website", "logoUrl", "createdAt", "updatedAt" }
}
```

---

### PUT /businesses/me
Actualiza el perfil del negocio. Todos los campos son opcionales.

**Body:**
```json
{
  "name": "Nuevo nombre",
  "phone": "+54911...",
  "address": "Av. Corrientes 1234",
  "instagram": "@studio_ana",
  "website": "https://studioana.com",
  "logoUrl": "https://..."
}
```

---

### GET /businesses/me/hours
Retorna los 7 horarios del negocio ordenados por `dayOfWeek` (0=domingo, 6=sábado).

**Response:**
```json
{
  "hours": [
    { "id": "uuid", "businessId": "uuid", "dayOfWeek": 0, "open": false, "fromTime": "09:00", "toTime": "18:00" },
    { "id": "uuid", "businessId": "uuid", "dayOfWeek": 1, "open": true,  "fromTime": "09:00", "toTime": "18:00" },
    ...
  ]
}
```

---

### PUT /businesses/me/hours
Upsert bulk de los 7 días. **Siempre enviar los 7.**

**Body:**
```json
[
  { "dayOfWeek": 0, "open": false, "fromTime": "09:00", "toTime": "18:00" },
  { "dayOfWeek": 1, "open": true,  "fromTime": "09:00", "toTime": "18:00" },
  { "dayOfWeek": 2, "open": true,  "fromTime": "09:00", "toTime": "18:00" },
  { "dayOfWeek": 3, "open": true,  "fromTime": "09:00", "toTime": "18:00" },
  { "dayOfWeek": 4, "open": true,  "fromTime": "09:00", "toTime": "18:00" },
  { "dayOfWeek": 5, "open": true,  "fromTime": "09:00", "toTime": "13:00" },
  { "dayOfWeek": 6, "open": false, "fromTime": "09:00", "toTime": "13:00" }
]
```

---

## Clients 🔒

### GET /clients
Lista paginada de clientes.

**Query params:**
| Param | Tipo | Default | Descripción |
|---|---|---|---|
| `page` | number | 1 | Página |
| `limit` | number | 20 | Máx 100 |
| `search` | string | — | Filtra por nombre o teléfono |

**Response:**
```json
{
  "clients": [
    {
      "id": "uuid", "businessId": "uuid", "name": "María López",
      "phone": "+54911...", "email": "maria@mail.com", "notes": "...",
      "visits": 3, "totalSpent": 15000, "lastVisitAt": "...",
      "createdAt": "...", "updatedAt": "..."
    }
  ],
  "page": 1,
  "limit": 20
}
```

---

### POST /clients

**Body:**
```json
{
  "name": "María López",
  "phone": "+54911...",
  "email": "maria@mail.com",
  "notes": "Alérgica al keratex"
}
```

**Response 201:** `{ "client": { ... } }`

---

### GET /clients/:id
Perfil completo con stats cacheadas (`visits`, `totalSpent`, `lastVisitAt`).

---

### PUT /clients/:id
Editar. Todos los campos opcionales.

---

### DELETE /clients/:id
Hard delete. Elimina también sus turnos (cascade).

**Response:** `{ "success": true }`

---

## Services 🔒

### GET /services

**Query params:**
| Param | Valores | Default | Descripción |
|---|---|---|---|
| `visible` | `true` \| `false` \| `all` | `all` | Filtrar por visibilidad |

**Response:** `{ "services": [ ... ] }`

Cada service:
```json
{
  "id": "uuid", "businessId": "uuid", "name": "Corte y color",
  "category": "Cabello", "duration": 90, "price": 8000,
  "color": "#FF6B6B", "visible": true, "createdAt": "...", "updatedAt": "..."
}
```

> `duration` en minutos. `price` en la moneda local (entero).

---

### POST /services

**Body:**
```json
{
  "name": "Corte y color",
  "category": "Cabello",
  "duration": 90,
  "price": 8000,
  "color": "#FF6B6B",
  "visible": true
}
```

**Response 201:** `{ "service": { ... } }`

---

### GET /services/:id

### PUT /services/:id
Editar. Todos los campos opcionales.

### DELETE /services/:id
**Soft delete** — pone `visible: false`. No elimina el registro (para mantener historial de turnos).

**Response:** `{ "service": { ..., "visible": false } }`

---

## Appointments 🔒

### GET /appointments

**Query params:**
| Param | Tipo | Descripción |
|---|---|---|
| `page` | number | Default 1 |
| `limit` | number | Default 20, máx 100 |
| `status` | string | `pending` \| `confirmed` \| `completed` \| `cancelled` \| `no_show` |
| `date` | string | YYYY-MM-DD |
| `clientId` | uuid | |

**Response:** `{ "appointments": [ ... ], "page": 1, "limit": 20 }`

Cada appointment:
```json
{
  "id": "uuid", "businessId": "uuid", "clientId": "uuid", "serviceId": "uuid",
  "serviceName": "Corte y color", "duration": 90, "price": 8000,
  "date": "2025-05-10", "time": "10:00",
  "status": "pending", "notes": "...",
  "createdAt": "...", "updatedAt": "..."
}
```

> `serviceName`, `duration` y `price` son **snapshot** del servicio al momento de reservar.

---

### POST /appointments

**Body:**
```json
{
  "serviceId": "uuid",
  "clientId": "uuid",
  "date": "2025-05-10",
  "time": "10:00",
  "notes": "Primera visita"
}
```

> `clientId` es opcional. El backend toma el snapshot del servicio automáticamente.

**Response 201:** `{ "appointment": { ... } }`

---

### GET /appointments/:id

### PUT /appointments/:id
Editar status, notas, fecha u hora.

**Body (todos opcionales):**
```json
{
  "status": "confirmed",
  "notes": "Confirmado por WhatsApp",
  "date": "2025-05-10",
  "time": "11:00"
}
```

> **Efecto secundario:** cuando `status` cambia a `completed`, el backend actualiza automáticamente en el cliente:
> - `visits += 1`
> - `totalSpent += appointment.price`
> - `lastVisitAt = appointment.date`

**Status válidos:** `pending` | `confirmed` | `completed` | `cancelled` | `no_show`

---

### DELETE /appointments/:id
Soft delete — cambia `status` a `cancelled`.

---

### GET /appointments/agenda/:date
Disponibilidad del día. `date` en formato `YYYY-MM-DD`.

**Response:**
```json
{
  "date": "2025-05-10",
  "appointments": [
    { "id": "uuid", "time": "10:00", "duration": 60, "status": "confirmed", "serviceName": "...", ... }
  ],
  "availableSlots": ["09:00", "09:30", "11:00", "11:30", "12:00"]
}
```

> Los slots son de 30 min dentro del horario del negocio ese día. Un slot está libre si ningún turno activo lo cubre. Si el negocio está cerrado ese día, `availableSlots` es `[]`.

---

## WhatsApp 🔒

### GET /whatsapp/chats
Lista de chats ordenada por `lastMessageAt` desc (más reciente primero).

**Response:**
```json
{
  "chats": [
    {
      "id": "uuid", "businessId": "uuid", "clientPhone": "+54911...",
      "clientName": "María", "isBot": true, "unread": 2,
      "lastMessage": "Hola, quería reservar turno",
      "lastMessageAt": "...", "createdAt": "..."
    }
  ]
}
```

---

### POST /whatsapp/chats
Crea o recupera un chat por `clientPhone` (idempotente).

**Body:**
```json
{
  "clientPhone": "+5491155443322",
  "clientName": "María"
}
```

**Response:** `{ "chat": { ... } }` — 201 si creado, 200 si ya existía.

---

### GET /whatsapp/chats/:id

### PATCH /whatsapp/chats/:id
Actualizar `isBot` o marcar como leído.

**Body (todos opcionales):**
```json
{
  "isBot": false,
  "markRead": true
}
```

> `markRead: true` pone `unread = 0`.

---

### GET /whatsapp/chats/:id/messages
Mensajes paginados, más recientes primero.

**Query params:** `page` (default 1), `limit` (default 50, máx 100)

**Response:**
```json
{
  "messages": [
    { "id": "uuid", "chatId": "uuid", "businessId": "uuid", "sender": "client", "content": "Hola!", "createdAt": "..." }
  ],
  "page": 1,
  "limit": 50
}
```

> `sender`: `client` | `owner` | `bot`

---

### POST /whatsapp/chats/:id/messages
Enviar un mensaje. Actualiza `lastMessage` y `lastMessageAt` en el chat.

**Body:**
```json
{
  "content": "Hola! ¿En qué te puedo ayudar?",
  "sender": "owner"
}
```

**Response 201:** `{ "message": { ... } }`

---

## Errores comunes

| Status | Descripción |
|---|---|
| `400` | Validación fallida |
| `401` | Sin token o token inválido/expirado |
| `404` | Recurso no encontrado |
| `409` | Recurso ya existe (ej: email duplicado) |
| `422` | Body con campos inválidos (detalle en `details`) |
| `500` | Error interno |

**Formato de error:**
```json
{ "error": "Mensaje descriptivo" }
```

**Formato de error de validación (422):**
```json
{
  "error": "Validation failed",
  "details": { "email": ["Invalid email"] }
}
```
