import { pgTable, uuid, text, timestamp, jsonb, integer, boolean, pgEnum, uniqueIndex, index } from "drizzle-orm/pg-core";
import {
  SERVICE_TYPES,
  SPEC_STATUSES,
  BROADCAST_STATUSES,
  SOURCE_TYPES,
  TRIGGER_REASONS,
} from "./enums.js";

// --- Enums ---
// Values imported from ./enums.ts so TypeScript consts and Postgres
// enum columns stay in sync by construction.

export const serviceTypeEnum = pgEnum("service_type", SERVICE_TYPES);
export const specStatusEnum = pgEnum("spec_status", SPEC_STATUSES);
export const broadcastStatusEnum = pgEnum("broadcast_status", BROADCAST_STATUSES);
export const sourceTypeEnum = pgEnum("source_type", SOURCE_TYPES);
export const triggerReasonEnum = pgEnum("trigger_reason", TRIGGER_REASONS);

// --- Platform content ---

export const eventProfiles = pgTable("event_profiles", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull().unique(),
  description: text("description"),
  enrichmentServices: jsonb("enrichment_services").notNull().$type<string[]>(),
  // Curation services are grouped into tiers. Within a tier services run
  // concurrently (they don't read each other's writes); tiers run
  // sequentially (each tier's outputs feed the next). See
  // docs/kairos-architecture for the dependency graph.
  curationServiceTiers: jsonb("curation_service_tiers").notNull().$type<string[][]>(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const serviceSpecs = pgTable("service_specs", {
  id: uuid("id").primaryKey().defaultRandom(),
  serviceName: text("service_name").notNull(),
  serviceType: serviceTypeEnum("service_type").notNull(),
  eventProfileName: text("event_profile_name").notNull().references(() => eventProfiles.name),
  version: text("version").notNull(),
  status: specStatusEnum("status").notNull().default("experimental"),
  spec: jsonb("spec").notNull().$type<Record<string, unknown>>(),
  notes: text("notes"),
  activatedAt: timestamp("activated_at", { withTimezone: true }),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (table) => [
  uniqueIndex("uq_spec_service_profile_version").on(
    table.serviceName, table.eventProfileName, table.version,
  ),
]);

// --- Broadcast ---

export const broadcasts = pgTable("broadcasts", {
  id: uuid("id").primaryKey().defaultRandom(),
  eventProfileName: text("event_profile_name").notNull().references(() => eventProfiles.name),
  status: broadcastStatusEnum("status").notNull().default("pending"),
  specOverrides: jsonb("spec_overrides").$type<Record<string, { version: string }>>(),
  config: jsonb("config").$type<Record<string, unknown>>(),
  // ContextCurator's brief-derived thread inventory, populated by the
  // activation-time initialisation pass. Survives conductor restarts —
  // without it we'd re-run the extraction Haiku call on every respawn.
  // Schema is `Array<{threadId, label, anchors[], briefRationale}>`
  // matching NarrativeThread in src/curation/types.ts.
  briefThreadInventory: jsonb("brief_thread_inventory").$type<Array<{
    threadId: string;
    label: string;
    anchors: string[];
    briefRationale: string;
  }>>(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

// --- Sources ---

export const sources = pgTable("sources", {
  id: uuid("id").primaryKey().defaultRandom(),
  broadcastId: uuid("broadcast_id").notNull().references(() => broadcasts.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  type: sourceTypeEnum("type").notNull(),
  canonical: boolean("canonical").notNull().default(false),
  enrichmentTags: jsonb("enrichment_tags").$type<string[]>().default([]),
  config: jsonb("config").$type<Record<string, unknown>>().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// --- Feed entries ---

export const feedEntries = pgTable("feed_entries", {
  id: uuid("id").primaryKey().defaultRandom(),
  broadcastId: uuid("broadcast_id").notNull().references(() => broadcasts.id, { onDelete: "cascade" }),
  sourceId: uuid("source_id").notNull().references(() => sources.id, { onDelete: "cascade" }),
  timestamp: timestamp("timestamp", { withTimezone: true }).notNull().defaultNow(),
  data: jsonb("data").notNull().$type<Record<string, unknown>>(),
  enrichmentTags: jsonb("enrichment_tags").$type<string[]>().default([]),
});

// --- Generations ---

export const generations = pgTable("generations", {
  id: uuid("id").primaryKey().defaultRandom(),
  broadcastId: uuid("broadcast_id").notNull().references(() => broadcasts.id, { onDelete: "cascade" }),
  triggeredAt: timestamp("triggered_at", { withTimezone: true }).notNull().defaultNow(),
  triggerReason: triggerReasonEnum("trigger_reason").notNull(),
  contextPackage: jsonb("context_package").notNull().$type<Record<string, unknown>>(),
  output: text("output").notNull(),
  wordCount: integer("word_count").notNull(),
  tokenUsage: jsonb("token_usage").$type<{ inputTokens: number; outputTokens: number }>(),
  durationMs: integer("duration_ms"),
  covers: jsonb("covers").$type<Array<{ entryId: string; subjectTime?: string; charOffset?: number }>>().default([]),
});

// --- Pipeline cycles ---
// One row per flush — the unit the pipeline inspector paginates through.
// Captures the full enrichment/curation/generation picture for a single
// batch so it can be replayed visually without touching the live
// runtime state. Skipped generations (curator said no or context empty)
// still get a row with `generationId = null`.

export const pipelineCycles = pgTable("pipeline_cycles", {
  id: uuid("id").primaryKey().defaultRandom(),
  broadcastId: uuid("broadcast_id").notNull().references(() => broadcasts.id, { onDelete: "cascade" }),
  triggeredAt: timestamp("triggered_at", { withTimezone: true }).notNull().defaultNow(),
  triggerReason: triggerReasonEnum("trigger_reason").notNull(),
  // Sub-classification of the flush that produced this cycle.
  // `cadence` — scheduled wall-clock tick; `phase` — phase-boundary
  // trigger; `consumer_prompt` — external `flush({consumerPrompt})`.
  // Distinct from `triggerReason` (`accumulation` | `external`) so
  // the inspector can show admins which trigger fired without
  // widening the existing enum. Nullable for cycles persisted before
  // the column landed.
  flushTrigger: text("flush_trigger"),
  chunkEntries: jsonb("chunk_entries").notNull().$type<Array<Record<string, unknown>>>(),
  annotations: jsonb("annotations").notNull().$type<Array<Record<string, unknown>>>(),
  curation: jsonb("curation").notNull().$type<Record<string, unknown>>(),
  // Per-stage wall-clock breakdown captured at runtime — same shape
  // as the `cycle_timing` PostHog event. Excludes the persist itself
  // (timing is computed before the row is inserted). Nullable for
  // cycles persisted before the column landed.
  timingMs: jsonb("timing_ms").$type<{
    totalMs: number;
    enrichmentMs: number;
    curationServicesMs: number;
    handlerMs: number;
    perServiceEnrichmentMs: Record<string, number>;
    perServiceCurationMs: Record<string, number>;
  }>(),
  generationId: uuid("generation_id").references(() => generations.id, { onDelete: "set null" }),
});

// --- Enrichment service state ---

// --- Content pool ---
// Consumer-prepared tagged content items the imagery selector can pick
// from at runtime instead of emitting a fresh-generate decision.
// Domain-agnostic by construction: Kairos holds a prompt, a tag set,
// and an opaque `consumer_metadata` blob the consumer stashes whatever
// pointer it needs into (e.g. an illustration record id for a future
// lookup). Kairos never interprets consumer_metadata — it just threads
// it back through the selection result so the consumer can resolve
// bytes on its side.
//
// Scope note: "content pool" rather than "image pool" on purpose — the
// mechanism carries for audio clips, video loops, or any other
// pre-prepared content a consumer might want the engine to pick from.
export const contentPoolItems = pgTable(
  "content_pool_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    broadcastId: uuid("broadcast_id")
      .notNull()
      .references(() => broadcasts.id, { onDelete: "cascade" }),
    prompt: text("prompt").notNull(),
    tags: jsonb("tags").$type<string[]>().default([]),
    consumerMetadata: jsonb("consumer_metadata").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("content_pool_items_broadcast_idx").on(table.broadcastId),
  ],
);

export const enrichmentServiceStates = pgTable("enrichment_service_states", {
  id: uuid("id").primaryKey().defaultRandom(),
  broadcastId: uuid("broadcast_id").notNull().references(() => broadcasts.id, { onDelete: "cascade" }),
  serviceName: text("service_name").notNull(),
  specVersion: text("spec_version").notNull(),
  // Each column stores a SubjectStateMap — Record<subjectId, { label, reading }>.
  expressedState: jsonb("expressed_state").notNull().$type<Record<string, unknown>>().default({}),
  unexpressedState: jsonb("unexpressed_state").notNull().$type<Record<string, unknown>>().default({}),
  acknowledgedState: jsonb("acknowledged_state").notNull().$type<Record<string, unknown>>().default({}),
  lastSurfacedAt: timestamp("last_surfaced_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (table) => [
  uniqueIndex("uq_enrichment_broadcast_service").on(
    table.broadcastId, table.serviceName,
  ),
]);

// --- Auth (K6.3a) ---
// Better Auth tables (users / sessions / accounts / verifications)
// live in `@kairos/auth` so the admin app + the server can both
// instantiate the factory against the same Drizzle schema. They're
// re-exported here so drizzle-kit's standard `pnpm db:generate` flow
// picks them up via this single schema path — keeping migration
// ownership on `apps/kairos/server` (the DB owner), even though the
// table defs live in the shared package.
//
// See `packages/kairos/auth/README.md` and `docs/prompts-as-content-design.md`
// § *Auth — mirroring `@blackout/auth`* for the asymmetry: the admin
// app is the issuer (email/password sign-in; users seeded via
// `apps/kairos/client/scripts/create-user.ts`); the server is
// validator-only (`src/auth.ts`); both share the factory and these
// tables.
export {
  users,
  sessions,
  accounts,
  verifications,
  usersRelations,
  sessionsRelations,
  accountsRelations,
} from "@kairos/auth";
