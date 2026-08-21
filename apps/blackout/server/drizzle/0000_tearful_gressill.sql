CREATE TYPE "public"."broadcast_status" AS ENUM('draft', 'scheduled', 'live', 'complete');--> statement-breakpoint
CREATE TABLE "broadcast_discarded_prompts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"broadcast_id" uuid NOT NULL,
	"prompt" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "broadcast_illustrations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"broadcast_id" uuid NOT NULL,
	"narrative_id" text,
	"prompt" text NOT NULL,
	"image_key" text NOT NULL,
	"content_type" text DEFAULT 'image/webp' NOT NULL,
	"model" text NOT NULL,
	"generated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"generation_ms" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "broadcast_narrations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"broadcast_id" uuid NOT NULL,
	"narrative_id" text NOT NULL,
	"text" text NOT NULL,
	"word_count" integer NOT NULL,
	"audio_key" text NOT NULL,
	"duration_ms" integer NOT NULL,
	"voice_id" text NOT NULL,
	"provider" text NOT NULL,
	"synthesized_at" timestamp with time zone DEFAULT now() NOT NULL,
	"playback_started_at" timestamp with time zone,
	"batch_entry_ids" jsonb DEFAULT '[]'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "broadcasts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"home_team" text NOT NULL,
	"away_team" text NOT NULL,
	"competition" text NOT NULL,
	"match_date" timestamp with time zone NOT NULL,
	"status" "broadcast_status" DEFAULT 'draft' NOT NULL,
	"fixture_id" bigint,
	"radio_source_id" uuid,
	"author_voice_id" text,
	"tts_voice_id" text,
	"tts_provider" text,
	"tts_enabled" boolean,
	"moderator_id" uuid,
	"kairos_broadcast_id" text,
	"match_brief" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "radio_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"stream_url" text NOT NULL,
	"url_pattern" text NOT NULL,
	"default_offset_seconds" integer NOT NULL,
	"transcode" boolean DEFAULT false NOT NULL,
	"last_observed_offset_seconds" real,
	"last_observed_at" timestamp with time zone,
	"observation_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "radio_sources_stream_url_unique" UNIQUE("stream_url"),
	CONSTRAINT "radio_sources_url_pattern_unique" UNIQUE("url_pattern")
);
--> statement-breakpoint
ALTER TABLE "broadcast_discarded_prompts" ADD CONSTRAINT "broadcast_discarded_prompts_broadcast_id_broadcasts_id_fk" FOREIGN KEY ("broadcast_id") REFERENCES "public"."broadcasts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "broadcast_illustrations" ADD CONSTRAINT "broadcast_illustrations_broadcast_id_broadcasts_id_fk" FOREIGN KEY ("broadcast_id") REFERENCES "public"."broadcasts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "broadcast_narrations" ADD CONSTRAINT "broadcast_narrations_broadcast_id_broadcasts_id_fk" FOREIGN KEY ("broadcast_id") REFERENCES "public"."broadcasts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "broadcasts" ADD CONSTRAINT "broadcasts_radio_source_id_radio_sources_id_fk" FOREIGN KEY ("radio_source_id") REFERENCES "public"."radio_sources"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "broadcast_discarded_prompts_broadcast_idx" ON "broadcast_discarded_prompts" USING btree ("broadcast_id");--> statement-breakpoint
CREATE INDEX "broadcast_illustrations_broadcast_idx" ON "broadcast_illustrations" USING btree ("broadcast_id");--> statement-breakpoint
CREATE INDEX "broadcast_illustrations_narrative_idx" ON "broadcast_illustrations" USING btree ("broadcast_id","narrative_id");--> statement-breakpoint
CREATE INDEX "broadcast_narrations_broadcast_idx" ON "broadcast_narrations" USING btree ("broadcast_id");--> statement-breakpoint
CREATE INDEX "broadcast_narrations_narrative_idx" ON "broadcast_narrations" USING btree ("broadcast_id","narrative_id");--> statement-breakpoint
CREATE INDEX "broadcasts_match_date_idx" ON "broadcasts" USING btree ("match_date" DESC);--> statement-breakpoint
CREATE INDEX "broadcasts_status_idx" ON "broadcasts" USING btree ("status");