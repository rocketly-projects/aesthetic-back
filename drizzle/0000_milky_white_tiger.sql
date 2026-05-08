CREATE TYPE "public"."plan" AS ENUM('BASIC', 'PRO', 'ENTERPRISE');--> statement-breakpoint
CREATE TABLE "tenants" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"nombre" text NOT NULL,
	"slug" text NOT NULL,
	"plan" "plan" DEFAULT 'BASIC' NOT NULL,
	"activo" boolean DEFAULT true NOT NULL,
	"creado_en" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "tenants_email_unique" UNIQUE("email"),
	CONSTRAINT "tenants_slug_unique" UNIQUE("slug")
);
