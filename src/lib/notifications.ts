import { createDb } from './db'
import { notifications } from '../db/schema'

export type NotificationType = 'new_appointment' | 'payment_received' | 'reminder_sent'

export async function insertNotification(
  db: ReturnType<typeof createDb>,
  businessId: string,
  type: NotificationType,
  title: string,
  body: string,
  entityId?: string
): Promise<void> {
  await db.insert(notifications).values({ businessId, type, title, body, entityId: entityId ?? null })
}
