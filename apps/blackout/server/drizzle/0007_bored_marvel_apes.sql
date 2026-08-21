-- Clear legacy text voice IDs before the column is retyped as uuid.
-- Existing values are provider voice IDs (e.g. ElevenLabs string IDs),
-- not UUIDs, so they cannot be cast. Broadcasts will pick up the
-- catalogue default voice at next activation via resolveTtsVoice().
UPDATE "broadcasts" SET "tts_voice_id" = NULL WHERE "tts_voice_id" IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "broadcasts" DROP CONSTRAINT "broadcasts_radio_source_id_radio_sources_id_fk";
--> statement-breakpoint
ALTER TABLE "broadcasts" ALTER COLUMN "tts_voice_id" SET DATA TYPE uuid USING "tts_voice_id"::uuid;--> statement-breakpoint
ALTER TABLE "broadcasts" ADD CONSTRAINT "broadcasts_tts_voice_id_tts_voices_id_fk" FOREIGN KEY ("tts_voice_id") REFERENCES "public"."tts_voices"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "broadcasts" ADD CONSTRAINT "broadcasts_radio_source_id_radio_sources_id_fk" FOREIGN KEY ("radio_source_id") REFERENCES "public"."radio_sources"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "broadcasts" DROP COLUMN "author_voice_id";--> statement-breakpoint
ALTER TABLE "broadcasts" DROP COLUMN "tts_provider";