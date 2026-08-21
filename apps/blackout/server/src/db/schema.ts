import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  real,
  bigint,
  boolean,
  pgEnum,
  index,
  jsonb,
  unique,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import type { CanonicalState, RevealingCanonical } from "@blackout/shared";

// Broadcast lifecycle: draft → scheduled → live → complete → (archived).
// `archived` is an admin curation decision — the broadcast completed fine
// but is excluded from the public replays surface.
export const BROADCAST_STATUSES = ["draft", "scheduled", "live", "complete", "archived"] as const;
export const broadcastStatusEnum = pgEnum("broadcast_status", BROADCAST_STATUSES);

export const broadcasts = pgTable(
  "broadcasts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    homeTeam: text("home_team").notNull(),
    awayTeam: text("away_team").notNull(),
    competition: text("competition").notNull(),
    matchDate: timestamp("match_date", { withTimezone: true }).notNull(),
    status: broadcastStatusEnum("status").notNull().default("draft"),
    fixtureId: bigint("fixture_id", { mode: "number" }),
    // FK into `radio_sources`. Nullable so broadcasts can be created
    // before a stream is picked. RESTRICT prevents catalogue cleanup
    // from silently detaching an in-use source from a broadcast.
    radioSourceId: uuid("radio_source_id").references(() => radioSources.id, {
      onDelete: "restrict",
    }),
    // FK into `tts_voices`. Nullable — new broadcasts inherit the
    // catalogue default at create time; null until then. RESTRICT
    // prevents voice deletion while any broadcast references it.
    ttsVoiceId: uuid("tts_voice_id").references(() => ttsVoices.id, {
      onDelete: "restrict",
    }),
    // Pipeline-wide TTS kill switch. Null / false = audio synthesis
    // suppressed across all surfaces for this broadcast. True = audio is
    // on. Default-null so new broadcasts don't silently burn credits
    // during testing; a moderator flips it on when the broadcast is
    // ready for real narrator audio.
    ttsEnabled: boolean("tts_enabled"),
    moderatorId: uuid("moderator_id"),
    kairosBroadcastId: text("kairos_broadcast_id"),
    matchBrief: text("match_brief"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("broadcasts_match_date_idx").on(sql`${table.matchDate} DESC`),
    index("broadcasts_status_idx").on(table.status),
  ],
);

// Audio artefact for one Kairos narrative, read aloud on the broadcast
// feed. One row per narrative that goes through TTS. Synthesis happens
// server-side on narrative arrival from Kairos; the bytes land in the
// configured StorageProvider (R2 in prod, in-memory in dev) addressed by
// `audioKey`. Playback URLs are generated on demand — for R2, signed URLs
// with a short expiry — so we don't persist a URL that might be stale by
// the time a late joiner consumes it.
//
// `playbackStartedAt` is populated by the RoomConductor the moment this
// clip becomes the currently-playing one. Late joiners seek into the
// audio at `(serverNow - playbackStartedAt)` so every listener hears the
// same moment. Nullable until playback actually begins.
// Illustrations live per-narrative (one image per passage, per the
// 2026-04-23 design). Image bytes sit in the same storage provider as
// audio (R2 in prod, InMemory in dev), addressed by `image_key`.
// `narrativeId` is Kairos's generation id — same identifier the
// matchroom receives on the `illustration` cue, so the Blackout can
// re-resolve the stored image on rehydration / late join without a
// Kairos round-trip.
export const broadcastIllustrations = pgTable(
  "broadcast_illustrations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    broadcastId: uuid("broadcast_id")
      .notNull()
      .references(() => broadcasts.id, { onDelete: "cascade" }),
    // Present on runtime-generated rows (the narrative the image
    // accompanies). Null on pool rows — studio-prepared images aren't
    // tied to any one narrative; pool membership is authoritatively
    // tracked on the Kairos side via `content_pool_items`, which
    // stashes the illustrationId onto `consumer_metadata` so Kairos
    // can thread it back at selection time.
    narrativeId: text("narrative_id"),
    prompt: text("prompt").notNull(),
    imageKey: text("image_key").notNull(),
    contentType: text("content_type").notNull().default("image/webp"),
    model: text("model").notNull(),
    generatedAt: timestamp("generated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    generationMs: integer("generation_ms").notNull(),
  },
  (table) => [
    index("broadcast_illustrations_broadcast_idx").on(table.broadcastId),
    index("broadcast_illustrations_narrative_idx").on(
      table.broadcastId,
      table.narrativeId,
    ),
  ],
);

// Prompts the writer rejected during studio prep. Fed back into the
// LLM suggestion call as negative context so subsequent batches steer
// away from repeated themes. Accepted prompts are derivable from
// `broadcast_illustrations` (source='pool', acceptedAt is not null)
// so they don't need a separate ledger — only rejections need a home.
export const broadcastDiscardedPrompts = pgTable(
  "broadcast_discarded_prompts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    broadcastId: uuid("broadcast_id")
      .notNull()
      .references(() => broadcasts.id, { onDelete: "cascade" }),
    prompt: text("prompt").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("broadcast_discarded_prompts_broadcast_idx").on(table.broadcastId),
  ],
);

export const broadcastNarrations = pgTable(
  "broadcast_narrations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    broadcastId: uuid("broadcast_id")
      .notNull()
      .references(() => broadcasts.id, { onDelete: "cascade" }),
    // Kairos's id for the narrative this audio represents. Globally unique
    // on the Kairos side but we scope the uniqueness constraint to
    // (broadcastId, narrativeId) for self-documentation and safety.
    narrativeId: text("narrative_id").notNull(),
    text: text("text").notNull(),
    wordCount: integer("word_count").notNull(),
    // Storage-provider-addressable key. For R2 this is the object key
    // (e.g. `broadcast_<id>/narration_<id>.mp3`); for in-memory it's the
    // map key under which the buffer is held.
    audioKey: text("audio_key").notNull(),
    durationMs: integer("duration_ms").notNull(),
    voiceId: text("voice_id").notNull(),
    provider: text("provider").notNull(),
    synthesizedAt: timestamp("synthesized_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    playbackStartedAt: timestamp("playback_started_at", { withTimezone: true }),
    // Kairos's batchEntryIds — the full list of feed entry ids that fed
    // this narration's context. Persisted (in addition to Kairos's own
    // copy) so the Blackout can reconstruct the reveal set at
    // bootstrap time without round-tripping to Kairos for every
    // narration.
    batchEntryIds: jsonb("batch_entry_ids").$type<string[]>().default([]).notNull(),
    // Kairos's covers — the entries the narrator EXPLICITLY references
    // in this passage's prose (subset of batchEntryIds). Used by
    // /broadcasts/:id to gate the matchroom reveal contract: a
    // canonical event card stays hidden only while a narration that
    // covers it is mid-flight. Once the narration finishes (or if no
    // currently-playing narration covers it), the event card is
    // visible. Earlier behaviour gated on batchEntryIds of finished
    // narrations — opt-in reveal — which left late-joiners with a
    // sparse matchroom (events visible only after they'd been
    // narrated). This column flips it to opt-out reveal: visible by
    // default, hidden only mid-cover.
    covers: jsonb("covers").$type<{ entryId: string; charOffset?: number }[]>().default([]).notNull(),
    // Per-passage canonical-state bundle for the matchroom reveal
    // architecture (Design A — `docs/matchroom-reveal-architecture-scoping.md`).
    // `revealedCanonical` is the visible state at this passage's
    // audio-start; `revealingCanonical` is the deltas this passage
    // reveals during its audio. Both NULL on rows written before the
    // bundle contract landed — consumers fall back to the legacy
    // reveal path (covers + batchEntryIds + server-derived score)
    // when either is null. Populated together by the conductor at
    // synthesis time; NULL/non-NULL is paired.
    revealedCanonical: jsonb("revealed_canonical").$type<CanonicalState | null>(),
    revealingCanonical: jsonb("revealing_canonical").$type<RevealingCanonical | null>(),
  },
  (table) => [
    index("broadcast_narrations_broadcast_idx").on(table.broadcastId),
    index("broadcast_narrations_narrative_idx").on(
      table.broadcastId,
      table.narrativeId,
    ),
  ],
);

// Catalogue of commentary streams. `stream_url` is the canonical playback URL
// the dropdown populates; `url_pattern` is a substring matcher for legacy /
// free-text URL paths that should resolve back to a catalogued source.
// Offsets are updated from live-match observations — see latency sampling in
// the moderator WS handler.
export const radioSources = pgTable("radio_sources", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  streamUrl: text("stream_url").notNull().unique(),
  urlPattern: text("url_pattern").notNull().unique(),
  defaultOffsetSeconds: integer("default_offset_seconds").notNull(),
  // When true, pipe the stream through ffmpeg before Deepgram. Needed for
  // MPEG-TS HLS segments containing HE-AAC (e.g. BBC syndication feeds) —
  // Deepgram's byte sniffer can't parse those directly. False keeps the
  // fast path for MP3 / AAC-LC streams Deepgram decodes natively.
  transcode: boolean("transcode").notNull().default(false),
  lastObservedOffsetSeconds: real("last_observed_offset_seconds"),
  lastObservedAt: timestamp("last_observed_at", { withTimezone: true }),
  observationCount: integer("observation_count").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// Legacy single-use launch notification list retained in the schema so
// existing local databases remain readable. The concept site no longer
// collects signups or sends launch notifications.
//
// `signupIp` is captured solely so that on a repeat submission the
// route can compare the incoming IP to the stored one — the
// "you're already on the list" UX message is only returned to the
// IP that originally registered, so the response can't be used to
// enumerate which addresses are on the list from anywhere else.
export const notifySignups = pgTable("notify_signups", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(),
  signupIp: text("signup_ip"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// Admin-curated catalogue of TTS voices available for selection in the
// moderator console. Admins add voices from the provider library (with
// optional display-name and speed overrides), writers pick from this
// list. The `isDefault` voice is stamped onto new broadcast rows when
// no voice has been explicitly chosen.
export const ttsVoices = pgTable(
  "tts_voices",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    provider: text("provider").notNull(),
    providerVoiceId: text("provider_voice_id").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    speed: real("speed"),
    isDefault: boolean("is_default").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("tts_voices_provider_voice_unique").on(table.provider, table.providerVoiceId),
    uniqueIndex("tts_voices_default_unique").on(table.isDefault).where(sql`is_default = true`),
  ],
);

// --- Auth ---
// Better Auth tables (users / sessions / accounts / verifications)
// live in `@blackout/auth` so the web (issuer) + the server (validator)
// can both instantiate the factory against the same Drizzle schema.
// They're re-exported here so drizzle-kit's standard `pnpm db:generate`
// flow picks them up via this single schema path — migration
// ownership lives with the server (the DB owner), matching the
// `@kairos/auth` setup on apps/kairos/server.
//
// Previously these tables were managed by apps/blackout/client's own
// drizzle config (a fossil from when the web app was first scaffolded
// with Better Auth via npx). That config + its drizzle/ directory
// are removed in the same PR as this re-export.
export {
  users,
  sessions,
  accounts,
  verifications,
  usersRelations,
  sessionsRelations,
  accountsRelations,
} from "@blackout/auth";
