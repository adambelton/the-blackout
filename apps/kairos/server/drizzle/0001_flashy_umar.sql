ALTER TYPE "public"."service_type" ADD VALUE 'generation';--> statement-breakpoint
ALTER TYPE "public"."service_type" ADD VALUE 'imagery';--> statement-breakpoint
ALTER TABLE "event_profiles" ADD COLUMN "created_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "event_profiles" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "service_specs" ADD COLUMN "created_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "service_specs" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "sources" ADD COLUMN "created_at" timestamp with time zone DEFAULT now() NOT NULL;