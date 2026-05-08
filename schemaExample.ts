import {
  pgTable,
  pgEnum,
  uuid,
  text,
  integer,
  boolean,
  date,
  time,
  timestamp,
  smallint,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";

// ── Enums ──────────────────────────────────────────────────────────────────

export const appointmentStatusEnum = pgEnum("appointment_status", [
  "pending",
  "confirmed",
  "completed",
  "cancelled",
]);

export const userRoleEnum = pgEnum("user_role", ["owner", "staff"]);

export const messageSenderEnum = pgEnum("message_sender", [
  "client",
  "owner",
  "bot",
]);

// ── businesses ─────────────────────────────────────────────────────────────

export const businesses = pgTable("businesses", {
  id:        uuid("id").primaryKey().defaultRandom(),
  name:      text("name").notNull(),
  phone:     text("phone"),
  address:   text("address"),
  instagram: text("instagram"),
  website:   text("website"),
  logoUrl:   text("logo_url"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// ── business_hours ─────────────────────────────────────────────────────────
// day_of_week: 0 = domingo … 6 = sábado (ISO: 1=lunes … 7=domingo, pero usamos JS convention)

export const businessHours = pgTable("business_hours", {
  id:          uuid("id").primaryKey().defaultRandom(),
  businessId:  uuid("business_id").notNull().references(() => businesses.id, { onDelete: "cascade" }),
  dayOfWeek:   smallint("day_of_week").notNull(), // 0=Sun, 1=Mon, ... 6=Sat
  open:        boolean("open").notNull().default(true),
  fromTime:    time("from_time").notNull().default("09:00"),
  toTime:      time("to_time").notNull().default("18:00"),
});

// ── users ──────────────────────────────────────────────────────────────────

export const users = pgTable("users", {
  id:         uuid("id").primaryKey().defaultRandom(),
  businessId: uuid("business_id").notNull().references(() => businesses.id, { onDelete: "cascade" }),
  email:      text("email").notNull().unique(),
  name:       text("name").notNull(),
  role:       userRoleEnum("role").notNull().default("owner"),
  createdAt:  timestamp("created_at").defaultNow().notNull(),
});

// ── clients ────────────────────────────────────────────────────────────────

export const clients = pgTable("clients", {
  id:          uuid("id").primaryKey().defaultRandom(),
  businessId:  uuid("business_id").notNull().references(() => businesses.id, { onDelete: "cascade" }),
  name:        text("name").notNull(),
  phone:       text("phone").notNull(),       // usado para matching con WhatsApp
  email:       text("email"),
  notes:       text("notes"),
  // Campos cacheados — se actualizan cuando un appointment cambia a "completed"
  visits:      integer("visits").notNull().default(0),
  totalSpent:  integer("total_spent").notNull().default(0), // ARS, sin decimales
  lastVisitAt: date("last_visit_at"),
  createdAt:   timestamp("created_at").defaultNow().notNull(),
  updatedAt:   timestamp("updated_at").defaultNow().notNull(),
});

// ── services ───────────────────────────────────────────────────────────────

export const services = pgTable("services", {
  id:         uuid("id").primaryKey().defaultRandom(),
  businessId: uuid("business_id").notNull().references(() => businesses.id, { onDelete: "cascade" }),
  name:       text("name").notNull(),
  category:   text("category").notNull(),
  duration:   integer("duration").notNull(),  // minutos
  price:      integer("price").notNull(),     // ARS, sin decimales
  color:      text("color").notNull().default("#9b8e7e"), // hex para UI
  visible:    boolean("visible").notNull().default(true),
  createdAt:  timestamp("created_at").defaultNow().notNull(),
  updatedAt:  timestamp("updated_at").defaultNow().notNull(),
});

// ── appointments ───────────────────────────────────────────────────────────
// precio y duración se desnormalizan al momento de reservar (snapshot)

export const appointments = pgTable("appointments", {
  id:           uuid("id").primaryKey().defaultRandom(),
  businessId:   uuid("business_id").notNull().references(() => businesses.id, { onDelete: "cascade" }),
  clientId:     uuid("client_id").notNull().references(() => clients.id),
  serviceId:    uuid("service_id").references(() => services.id, { onDelete: "set null" }),
  // Snapshot del servicio al momento de la reserva
  serviceName:  text("service_name").notNull(),
  duration:     integer("duration").notNull(),  // minutos
  price:        integer("price").notNull(),     // ARS
  // Fecha y hora por separado para facilitar queries de agenda por día
  date:         date("date").notNull(),         // YYYY-MM-DD
  time:         time("time").notNull(),         // HH:MM
  status:       appointmentStatusEnum("status").notNull().default("pending"),
  notes:        text("notes"),
  createdAt:    timestamp("created_at").defaultNow().notNull(),
  updatedAt:    timestamp("updated_at").defaultNow().notNull(),
});

// ── whatsapp_chats ─────────────────────────────────────────────────────────

export const whatsappChats = pgTable("whatsapp_chats", {
  id:            uuid("id").primaryKey().defaultRandom(),
  businessId:    uuid("business_id").notNull().references(() => businesses.id, { onDelete: "cascade" }),
  clientId:      uuid("client_id").references(() => clients.id, { onDelete: "set null" }), // nullable si el número no está registrado
  clientPhone:   text("client_phone").notNull(),
  clientName:    text("client_name"),
  unread:        integer("unread").notNull().default(0),
  isBot:         boolean("is_bot").notNull().default(true), // true = bot manejando, false = dueña tomó el control
  lastMessage:   text("last_message"),
  lastMessageAt: timestamp("last_message_at"),
  createdAt:     timestamp("created_at").defaultNow().notNull(),
});

// ── whatsapp_messages ──────────────────────────────────────────────────────

export const whatsappMessages = pgTable("whatsapp_messages", {
  id:       uuid("id").primaryKey().defaultRandom(),
  chatId:   uuid("chat_id").notNull().references(() => whatsappChats.id, { onDelete: "cascade" }),
  sender:   messageSenderEnum("sender").notNull(),
  text:     text("text").notNull(),
  sentAt:   timestamp("sent_at").defaultNow().notNull(),
});

// ── Relations ──────────────────────────────────────────────────────────────

export const businessesRelations = relations(businesses, ({ many }) => ({
  hours:        many(businessHours),
  users:        many(users),
  clients:      many(clients),
  services:     many(services),
  appointments: many(appointments),
  chats:        many(whatsappChats),
}));

export const businessHoursRelations = relations(businessHours, ({ one }) => ({
  business: one(businesses, { fields: [businessHours.businessId], references: [businesses.id] }),
}));

export const usersRelations = relations(users, ({ one }) => ({
  business: one(businesses, { fields: [users.businessId], references: [businesses.id] }),
}));

export const clientsRelations = relations(clients, ({ one, many }) => ({
  business:     one(businesses, { fields: [clients.businessId], references: [businesses.id] }),
  appointments: many(appointments),
  chats:        many(whatsappChats),
}));

export const servicesRelations = relations(services, ({ one, many }) => ({
  business:     one(businesses, { fields: [services.businessId], references: [businesses.id] }),
  appointments: many(appointments),
}));

export const appointmentsRelations = relations(appointments, ({ one }) => ({
  business: one(businesses,  { fields: [appointments.businessId], references: [businesses.id] }),
  client:   one(clients,     { fields: [appointments.clientId],   references: [clients.id]   }),
  service:  one(services,    { fields: [appointments.serviceId],  references: [services.id]  }),
}));

export const whatsappChatsRelations = relations(whatsappChats, ({ one, many }) => ({
  business: one(businesses, { fields: [whatsappChats.businessId], references: [businesses.id] }),
  client:   one(clients,    { fields: [whatsappChats.clientId],   references: [clients.id]   }),
  messages: many(whatsappMessages),
}));

export const whatsappMessagesRelations = relations(whatsappMessages, ({ one }) => ({
  chat: one(whatsappChats, { fields: [whatsappMessages.chatId], references: [whatsappChats.id] }),
}));
