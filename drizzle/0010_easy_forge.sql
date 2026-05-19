ALTER TYPE "public"."appointment_status" ADD VALUE 'awaiting_payment';--> statement-breakpoint
ALTER TABLE "appointments" ADD COLUMN "mp_preference_id" text;--> statement-breakpoint
ALTER TABLE "appointments" ADD COLUMN "mp_payment_id" text;--> statement-breakpoint
ALTER TABLE "appointments" ADD COLUMN "payment_expires_at" timestamp;--> statement-breakpoint
ALTER TABLE "businesses" ADD COLUMN "web_deposit_required" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "businesses" ADD COLUMN "bot_deposit_required" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "businesses" ADD COLUMN "mp_access_token" text;--> statement-breakpoint
ALTER TABLE "businesses" ADD COLUMN "mp_refresh_token" text;--> statement-breakpoint
ALTER TABLE "businesses" ADD COLUMN "mp_user_id" text;--> statement-breakpoint
ALTER TABLE "businesses" ADD COLUMN "mp_token_expires_at" timestamp;--> statement-breakpoint
ALTER TABLE "businesses" DROP COLUMN "deposit_required";