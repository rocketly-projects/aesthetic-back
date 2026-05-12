CREATE TYPE "public"."plan_status" AS ENUM('active', 'inactive', 'cancelled', 'past_due');--> statement-breakpoint
ALTER TABLE "businesses" ADD COLUMN "plan_id" text;--> statement-breakpoint
ALTER TABLE "businesses" ADD COLUMN "plan_status" "plan_status" DEFAULT 'inactive' NOT NULL;--> statement-breakpoint
ALTER TABLE "businesses" ADD COLUMN "subscription_id" text;--> statement-breakpoint
ALTER TABLE "businesses" ADD COLUMN "subscription_expires_at" timestamp;
