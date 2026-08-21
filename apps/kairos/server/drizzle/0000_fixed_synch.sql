CREATE TYPE "public"."broadcast_status" AS ENUM('pending', 'active', 'paused', 'complete');--> statement-breakpoint
CREATE TYPE "public"."service_type" AS ENUM('enrichment', 'curation');--> statement-breakpoint
CREATE TYPE "public"."source_type" AS ENUM('event', 'moderator', 'narrative_context', 'narrative_voice');--> statement-breakpoint
CREATE TYPE "public"."spec_status" AS ENUM('experimental', 'active', 'archived');--> statement-breakpoint
CREATE TYPE "public"."trigger_reason" AS ENUM('accumulation', 'external');--> statement-breakpoint
CREATE TABLE "broadcasts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_profile_name" text NOT NULL,
	"status" "broadcast_status" DEFAULT 'pending' NOT NULL,
	"spec_overrides" jsonb,
	"config" jsonb,
	"brief_thread_inventory" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "content_pool_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"broadcast_id" uuid NOT NULL,
	"prompt" text NOT NULL,
	"tags" jsonb DEFAULT '[]'::jsonb,
	"consumer_metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "enrichment_service_states" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"broadcast_id" uuid NOT NULL,
	"service_name" text NOT NULL,
	"spec_version" text NOT NULL,
	"expressed_state" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"unexpressed_state" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"acknowledged_state" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_surfaced_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "event_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"enrichment_services" jsonb NOT NULL,
	"curation_service_tiers" jsonb NOT NULL,
	CONSTRAINT "event_profiles_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "feed_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"broadcast_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"timestamp" timestamp with time zone DEFAULT now() NOT NULL,
	"data" jsonb NOT NULL,
	"enrichment_tags" jsonb DEFAULT '[]'::jsonb
);
--> statement-breakpoint
CREATE TABLE "generations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"broadcast_id" uuid NOT NULL,
	"triggered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"trigger_reason" "trigger_reason" NOT NULL,
	"context_package" jsonb NOT NULL,
	"output" text NOT NULL,
	"word_count" integer NOT NULL,
	"token_usage" jsonb,
	"duration_ms" integer,
	"covers" jsonb DEFAULT '[]'::jsonb
);
--> statement-breakpoint
CREATE TABLE "pipeline_cycles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"broadcast_id" uuid NOT NULL,
	"triggered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"trigger_reason" "trigger_reason" NOT NULL,
	"flush_trigger" text,
	"chunk_entries" jsonb NOT NULL,
	"annotations" jsonb NOT NULL,
	"curation" jsonb NOT NULL,
	"timing_ms" jsonb,
	"generation_id" uuid
);
--> statement-breakpoint
CREATE TABLE "service_specs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"service_name" text NOT NULL,
	"service_type" "service_type" NOT NULL,
	"event_profile_name" text NOT NULL,
	"version" text NOT NULL,
	"status" "spec_status" DEFAULT 'experimental' NOT NULL,
	"spec" jsonb NOT NULL,
	"notes" text,
	"activated_at" timestamp with time zone,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"broadcast_id" uuid NOT NULL,
	"name" text NOT NULL,
	"type" "source_type" NOT NULL,
	"canonical" boolean DEFAULT false NOT NULL,
	"enrichment_tags" jsonb DEFAULT '[]'::jsonb,
	"config" jsonb DEFAULT '{}'::jsonb
);
--> statement-breakpoint
ALTER TABLE "broadcasts" ADD CONSTRAINT "broadcasts_event_profile_name_event_profiles_name_fk" FOREIGN KEY ("event_profile_name") REFERENCES "public"."event_profiles"("name") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_pool_items" ADD CONSTRAINT "content_pool_items_broadcast_id_broadcasts_id_fk" FOREIGN KEY ("broadcast_id") REFERENCES "public"."broadcasts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enrichment_service_states" ADD CONSTRAINT "enrichment_service_states_broadcast_id_broadcasts_id_fk" FOREIGN KEY ("broadcast_id") REFERENCES "public"."broadcasts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feed_entries" ADD CONSTRAINT "feed_entries_broadcast_id_broadcasts_id_fk" FOREIGN KEY ("broadcast_id") REFERENCES "public"."broadcasts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feed_entries" ADD CONSTRAINT "feed_entries_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generations" ADD CONSTRAINT "generations_broadcast_id_broadcasts_id_fk" FOREIGN KEY ("broadcast_id") REFERENCES "public"."broadcasts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_cycles" ADD CONSTRAINT "pipeline_cycles_broadcast_id_broadcasts_id_fk" FOREIGN KEY ("broadcast_id") REFERENCES "public"."broadcasts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_cycles" ADD CONSTRAINT "pipeline_cycles_generation_id_generations_id_fk" FOREIGN KEY ("generation_id") REFERENCES "public"."generations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_specs" ADD CONSTRAINT "service_specs_event_profile_name_event_profiles_name_fk" FOREIGN KEY ("event_profile_name") REFERENCES "public"."event_profiles"("name") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sources" ADD CONSTRAINT "sources_broadcast_id_broadcasts_id_fk" FOREIGN KEY ("broadcast_id") REFERENCES "public"."broadcasts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "content_pool_items_broadcast_idx" ON "content_pool_items" USING btree ("broadcast_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_enrichment_broadcast_service" ON "enrichment_service_states" USING btree ("broadcast_id","service_name");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_spec_service_profile_version" ON "service_specs" USING btree ("service_name","event_profile_name","version");