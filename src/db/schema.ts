import { pgTable, text, boolean, timestamp, pgEnum, uuid, integer } from 'drizzle-orm/pg-core'
import { relations } from 'drizzle-orm'

// Enums
export const notificationTypeEnum = pgEnum('notification_type', [
  'new_appointment',
  'payment_received',
  'reminder_sent',
])

export const appointmentStatusEnum = pgEnum('appointment_status', [
  'pending',
  'confirmed',
  'completed',
  'cancelled',
  'no_show',
  'awaiting_payment',
])

export const planStatusEnum = pgEnum('plan_status', [
  'active',
  'inactive',
  'cancelled',
  'past_due',
])

export const userRoleEnum = pgEnum('user_role', ['owner', 'staff'])

export const messageSenderEnum = pgEnum('message_sender', ['client', 'owner', 'bot'])

// Tables
export const businesses = pgTable('businesses', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  slug: text('slug').unique().notNull(),
  phone: text('phone'),
  address: text('address'),
  instagram: text('instagram'),
  website: text('website'),
  logoUrl: text('logo_url'),
  whatsappPhone: text('whatsapp_phone'),
  // Depósitos
  webDepositRequired: boolean('web_deposit_required').default(false).notNull(),
  botDepositRequired: boolean('bot_deposit_required').default(false).notNull(),
  depositPercent: integer('deposit_percent').default(0).notNull(),
  // MercadoPago OAuth (cuenta del negocio, para cobrar señas)
  mpAccessToken: text('mp_access_token'),
  mpRefreshToken: text('mp_refresh_token'),
  mpUserId: text('mp_user_id'),
  mpTokenExpiresAt: timestamp('mp_token_expires_at'),
  // Billing (suscripción a la plataforma)
  planId: text('plan_id'),                                          // 'basic' | 'pro'
  planStatus: planStatusEnum('plan_status').default('inactive').notNull(),
  subscriptionId: text('subscription_id'),                          // MP preapproval ID
  subscriptionExpiresAt: timestamp('subscription_expires_at'),
  // Trial
  trialEndsAt: timestamp('trial_ends_at'),
  // WhatsApp setup request
  whatsappRequestedAt: timestamp('whatsapp_requested_at'),
  whatsappBotActive: boolean('whatsapp_bot_active').default(false).notNull(),
  whatsappDeactivationRequestedAt: timestamp('whatsapp_deactivation_requested_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
})

export const businessHours = pgTable('business_hours', {
  id: uuid('id').primaryKey().defaultRandom(),
  businessId: uuid('business_id')
    .notNull()
    .references(() => businesses.id, { onDelete: 'cascade' }),
  dayOfWeek: integer('day_of_week').notNull(), // 0=Sunday … 6=Saturday
  open: boolean('open').default(true).notNull(),
  fromTime: text('from_time').notNull(), // HH:MM
  toTime: text('to_time').notNull(),     // HH:MM
})

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  businessId: uuid('business_id')
    .notNull()
    .references(() => businesses.id, { onDelete: 'cascade' }),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash'),
  name: text('name').notNull(),
  role: userRoleEnum('role').default('owner').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
})

export const clients = pgTable('clients', {
  id: uuid('id').primaryKey().defaultRandom(),
  businessId: uuid('business_id')
    .notNull()
    .references(() => businesses.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  phone: text('phone'),
  email: text('email'),
  notes: text('notes'),
  visits: integer('visits').default(0).notNull(),
  totalSpent: integer('total_spent').default(0).notNull(),
  lastVisitAt: timestamp('last_visit_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
})

export const services = pgTable('services', {
  id: uuid('id').primaryKey().defaultRandom(),
  businessId: uuid('business_id')
    .notNull()
    .references(() => businesses.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  category: text('category'),
  duration: integer('duration').notNull(), // minutes
  price: integer('price').notNull(),
  color: text('color'),
  visible: boolean('visible').default(true).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
})

export const appointments = pgTable('appointments', {
  id: uuid('id').primaryKey().defaultRandom(),
  businessId: uuid('business_id')
    .notNull()
    .references(() => businesses.id, { onDelete: 'cascade' }),
  clientId: uuid('client_id').references(() => clients.id, { onDelete: 'set null' }),
  serviceId: uuid('service_id').references(() => services.id, { onDelete: 'set null' }),
  // Snapshot at booking time
  serviceName: text('service_name').notNull(),
  duration: integer('duration').notNull(),
  price: integer('price').notNull(),
  // Scheduling
  date: text('date').notNull(), // YYYY-MM-DD
  time: text('time').notNull(), // HH:MM
  status: appointmentStatusEnum('status').default('pending').notNull(),
  notes: text('notes'),
  // MercadoPago (depósito/seña)
  mpPreferenceId: text('mp_preference_id'),
  mpPaymentId: text('mp_payment_id'),
  paymentExpiresAt: timestamp('payment_expires_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
})

export const whatsappChats = pgTable('whatsapp_chats', {
  id: uuid('id').primaryKey().defaultRandom(),
  businessId: uuid('business_id')
    .notNull()
    .references(() => businesses.id, { onDelete: 'cascade' }),
  clientId: uuid('client_id').references(() => clients.id, { onDelete: 'set null' }),
  clientPhone: text('client_phone').notNull(),
  clientName: text('client_name'),
  isBot: boolean('is_bot').default(true).notNull(),
  unread: integer('unread').default(0).notNull(),
  lastMessage: text('last_message'),
  lastMessageAt: timestamp('last_message_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
})

export const whatsappMessages = pgTable('whatsapp_messages', {
  id: uuid('id').primaryKey().defaultRandom(),
  chatId: uuid('chat_id')
    .notNull()
    .references(() => whatsappChats.id, { onDelete: 'cascade' }),
  businessId: uuid('business_id')
    .notNull()
    .references(() => businesses.id, { onDelete: 'cascade' }),
  sender: messageSenderEnum('sender').notNull(),
  content: text('content').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
})

export const notifications = pgTable('notifications', {
  id:         uuid('id').primaryKey().defaultRandom(),
  businessId: uuid('business_id').notNull().references(() => businesses.id, { onDelete: 'cascade' }),
  type:       notificationTypeEnum('type').notNull(),
  title:      text('title').notNull(),
  body:       text('body').notNull(),
  entityId:   uuid('entity_id'),
  read:       boolean('read').default(false).notNull(),
  createdAt:  timestamp('created_at').defaultNow().notNull(),
})

// Relations

export const businessesRelations = relations(businesses, ({ many }) => ({
  businessHours:  many(businessHours),
  users:          many(users),
  clients:        many(clients),
  services:       many(services),
  appointments:   many(appointments),
  whatsappChats:  many(whatsappChats),
  notifications:  many(notifications),
}))

export const notificationsRelations = relations(notifications, ({ one }) => ({
  business: one(businesses, { fields: [notifications.businessId], references: [businesses.id] }),
}))

export const businessHoursRelations = relations(businessHours, ({ one }) => ({
  business: one(businesses, {
    fields: [businessHours.businessId],
    references: [businesses.id],
  }),
}))

export const usersRelations = relations(users, ({ one }) => ({
  business: one(businesses, { fields: [users.businessId], references: [businesses.id] }),
}))

export const clientsRelations = relations(clients, ({ one, many }) => ({
  business: one(businesses, { fields: [clients.businessId], references: [businesses.id] }),
  appointments: many(appointments),
}))

export const servicesRelations = relations(services, ({ one, many }) => ({
  business: one(businesses, { fields: [services.businessId], references: [businesses.id] }),
  appointments: many(appointments),
}))

export const appointmentsRelations = relations(appointments, ({ one }) => ({
  business: one(businesses, { fields: [appointments.businessId], references: [businesses.id] }),
  client: one(clients, { fields: [appointments.clientId], references: [clients.id] }),
  service: one(services, { fields: [appointments.serviceId], references: [services.id] }),
}))

export const whatsappChatsRelations = relations(whatsappChats, ({ one, many }) => ({
  business: one(businesses, { fields: [whatsappChats.businessId], references: [businesses.id] }),
  client:   one(clients,    { fields: [whatsappChats.clientId],   references: [clients.id] }),
  messages: many(whatsappMessages),
}))

export const whatsappMessagesRelations = relations(whatsappMessages, ({ one }) => ({
  chat: one(whatsappChats, { fields: [whatsappMessages.chatId], references: [whatsappChats.id] }),
  business: one(businesses, {
    fields: [whatsappMessages.businessId],
    references: [businesses.id],
  }),
}))
