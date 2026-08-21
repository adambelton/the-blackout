CREATE TABLE "tts_voices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"provider_voice_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"speed" real,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tts_voices_provider_voice_unique" UNIQUE("provider","provider_voice_id")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "tts_voices_default_unique" ON "tts_voices" USING btree ("is_default") WHERE is_default = true;