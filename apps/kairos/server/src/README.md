# apps/kairos/server/src — internal architecture

How the engine works inside: the four-stage pipeline, the runtime that hosts it, the data shapes that flow between stages, the module map, and the anti-patterns the design exists to prevent. For the engine *as a service* — the consumer contract, the lifecycle, how to run it — see [`../README.md`](../README.md). This file is the home of the (decomposed) Kairos architecture; the legacy [`docs/kairos-architecture.md`](../../../../docs/kairos-architecture.md) is being retired into the README tree and has drifted in places.

## The pipeline — four stages, one subtractive

```
receive sources (POST /broadcasts/:id/entries)
 → ingest + batch delta-boundaried window of entries, keyed by subject time (see vocabulary.md § Time)
 → enrich scoped, additive — services annotate
 → curate full-payload, subtractive — the curator selects
 → generate Sonnet writes prose on the curated selection (Haiku picks imagery in parallel)
 → emit narrative to the consumer over the feed WS
 ↘ curator feedback flows back to enrichment (per-annotation outcomes)
```

Only **one** stage drops entries: curation. Enrichment only *adds* annotations; the generator receives exactly what curation chose; nothing downstream re-filters. That single-authority shape is load-bearing — see Anti-patterns.

### Stage 1 — Ingest + batch → [`pipeline/`](pipeline/README.md) (`pipeline.ts`, `subject-time.ts`) + [`feed.ts`](#top-level-orchestration)

`POST …/entries` → `Feed.push` (dedup on `data.sourceId`, INSERT `feed_entries`, append to the in-memory cache, fire the in-process listener) → `CyclePipeline.onEntry`. Ambient sources (`narrative_voice`, `narrative_context`) are filtered out here — they're the brief, fetched via `getNarrativeContext()` as a lens, not subjects of enrichment. Everything else goes into the **waiting room**, keyed by subject ordinal — the `(phase, phaseSecond)` pair the consumer stamped, collapsed to one sortable number (`subject-time.ts::subjectOrdinal`.

A **cadence flush** (timer tick, default 45s) drains entries whose ordinal ≤ `(highest observed − DELAY)`, DELAY default 60s — the long tail of source-arrival latency, so a window is complete in subject-time terms before it ships. More-recent entries wait. Entries arriving *after* their window flushed (ordinal ≤ the last-flushed boundary) are **late-discarded with telemetry** (`getLateDiscardedCount()`). Null-ordinal entries (no phase — legacy, ambient, test fixtures) pass through any flush. A flush that lands while a prior flush is in flight queues one pending tick rather than racing — cadence becomes `max(interval, flushDuration)`. The output is a `FeedChunk` — an explicit, bounded, subject-time-coherent unit.

Two more flush kinds beyond cadence: **external** (`pipeline.flush({consumerPrompt})` from `POST …/narrative/generate`) drains the entire waiting room and tags the cycle `triggerReason: external`; **closing** — when an entry lands carrying a `closingExtensionSeconds` marker (the consumer stamps it on a phase boundary, e.g. the half-time whistle, optionally with a `closingPrompt`), the pipeline pins the next cycle's drain end at `triggerOrdinal + extensionSeconds`, dispatches it on a wall-clock timer (`delayMs + extensionSeconds×1000` from now, with a force-timer backstop), and holds the marker entry + any concurrent consumer-prompt cycle until the closing cycle has gone — so the closing beat and the reflective beat land in order. *(The architecture doc's "phase-boundary triggers" / `recognizePhaseTransition` description is stale — this consumer-stamped-marker mechanism replaced it; the consumer decides which entries qualify, not Kairos recognising phase names.)*

### Stage 2 — Enrichment → [`enrichment/`](enrichment/README.md)

All enrichment services run **in parallel** against the `FeedChunk`. Each is additive and scoped: it processes only entries tagged for it (the source's `enrichment_tags` — there's no "active/inactive source" concept; tagging is the routing), tracks a set of *subjects* (a player, a theme, an arc — each carrying three readings: `expressed` / `unexpressed` / `acknowledged`), hydrates subject state from the DB at startup and persists it after each cycle, and emits zero-or-more `EnrichmentAnnotation`s — one per subject whose reading materially shifted (the materiality test is per-service judgement, e.g. momentum's "direction changed OR intensity moved ≥2 levels"). A per-service cap (5/cycle) guards against one service dominating. At activation, services that opt in get a one-shot Haiku call against the brief alone to seed subject priors before any evidence arrives (`patterns_echoes` opts out — it's purely live-evidence-driven). Services never remove entries, decide priority, or judge what the passage is about.

Six services ship: `momentum`, `tension_conflict`, `patterns_echoes`, `themes`, `character_arcs`, `character_relationships`. → [`enrichment/services/README.md`](enrichment/services/README.md).

### Stage 3 — Curation → [`curation/`](curation/README.md)

The only stage that drops entries. Curation services run in **tiers** — within a tier, concurrently against the same prior context (they don't read each other's writes — the seed's tier definition guarantees disjoint single-writer fields, and `mergeTierResults` folds the parallel outputs back); between tiers, sequentially (each tier reads the previous tier's writes). Four tiers ship:

```
T1 (parallel): narrative_arc · narrative_gap · saturation_resolver · context_curator
T2 (parallel): priority · pacing (read T1: arcPhase, urgentSubjects)
T3: conflict_resolver (reads T2: priority's emphasis)
T4: broadcast_summary (synthesises everything)
```

After the tiers: `applyRemovals` (union every service's `entriesRemoved`, drop canonical ids from the removal set silently, filter `selectedEntries` + dependent annotations — the canonical-never-evict guard lives here, once, so a service can't bypass it), then `reconcileBudget` (evict lowest-priority entries until the selection fits `maxContextTokens` — priority tiers: canonical never-evicted → emphasised → annotated → plain; ties newest-first), then `decideMode` (the pendulum: any emphasis ⇒ `action_led`; else `forceContextLed` set by saturation ⇒ `context_led`; else no annotations ⇒ `context_led`; else `enrichment_led` — silence is never an outcome). The output is a `CuratedPayload`. The curator also emits per-annotation `CuratorFeedback` back to enrichment services (`IGNORED` / `ACKNOWLEDGED` / `DELIVERED_WITH_EMPHASIS` / `KILLED_WITH_REPLACEMENT`), which advance/lock/revert subject state — a suppressed reading doesn't get re-echoed next cycle.

Eight services ship: `narrative_arc`, `narrative_gap`, `saturation_resolver`, `context_curator`, `priority`, `pacing`, `conflict_resolver`, `broadcast_summary`. → [`curation/services/README.md`](curation/services/README.md).

### Stage 4 — Generation → [`narrative/`](narrative/README.md)

`NarrativeEngine.driveGeneration(curated)` → `run(...)`: builds the `GenerationContext` from `curated.entries` (no parallel feed scan — curation is the authority); pulls the previous passage + running summary + flush boundary from the last `generations` row; collects `narrative_voice` / `narrative_context` / moderator directives from the feed cache; computes the target word count (curated pacing has authority, else the engine's `wpm × cycleMs × utilization`); formats refrain-budget status. Then **in parallel**: `generate(...)` calls Sonnet via the `deliver_narrative` tool (system prompt = voice + context + task instructions, cached; user message = moderator directives + canonical-events block + running summary + previous passage + refrain status + mode + relevant threads (if `context_led`) + target words + consumer prompt + the curated entries, parent/child-grouped, sorted by content ordinal), while `selectImagery(...)` runs a Haiku call over the content pool → `pool` / `generate` / `hold` and fires an early `imagery_decision` WS message. After both: filter phantom covers (cited ids not in the curated set), compute `batchEntryIds` (everything the cycle observed, superset of covers) + `contentTime` (earliest match-clock marker, monotonic-clamped), refresh the running summary (templated `Canonical state` block regenerated from canonical entries + the previous cycle's `Narrative arc` block, glued — see [`narrative/summary.ts`](narrative/README.md)), INSERT the `generations` row, emit the `narrative` WS message, run `checkGenerationInvariants`, fire telemetry, kick a background Haiku call to refresh the narrative block. On rate limit: emit `generation_skipped`, persist nothing.

## Cycle triggers

Two values in the `trigger_reason` enum — `accumulation` (scheduled cadence tick; the buffer may be empty — empty cycles still produce a passage via `context_curator`'s brief threads, bounded by a `consecutiveEmptyCycles` cap so the engine doesn't generate into pure silence forever) and `external` (a consumer-requested off-schedule cycle, carrying an opaque `consumerPrompt`; bypasses the empty-cap; same enrich → curate → generate path). The `pipeline_cycles` row also carries a `flush_trigger` sub-classification (`cadence` / `closing` / `consumer_prompt`) so the inspector can show which kind fired without widening the enum. Earlier `improv` / `gap` trigger values were collapsed into `accumulation` (2026-04-26) — they had no behavioural divergence; the empty-cycle cap is a stopping rule, not a cycle type. Canonical entries (goals, cards, subs) carry priority *through curation* — auto-emphasised, never evicted, pull the cycle to `action_led` — but do **not** fire off-cadence flushes (priority is a curation signal, not a timing signal; an immediate-flush path produced undersized cycles and destabilised pacing, and Sportmonks' ~30s inherent delay dominates latency anyway).

## The data shapes that carry the pipeline

```
FeedEntry one ingested source entry: { id, broadcastId, sourceId, sourceName,
 (src/types.ts) sourceType, sourceCanonical, timestamp, data, enrichmentTags }

FeedChunk a cycle's batch: { broadcastId, entries, fromTimestamp, toTimestamp,
 (enrichment/types) narrativeContext }

EnrichmentAnnotation one subject reading from one service: { serviceName, subjectId,
 (enrichment/types) subjectLabel, meaning: { expressed, unexpressed, acknowledged, basis },
 informedBy: string[] }

EnrichedPayload after enrichment: { broadcastId, entries, annotations, fromTimestamp,
 (enrichment/types) toTimestamp, narrativeContext, drainBoundaryOrdinal? }

CurationContext mutable state threaded through curation tiers: { selectedEntries,
 (curation/types) selectedAnnotations, decisions, conflicts, forceContextLed?, mode,
 triggerReason, pacing, maxContextTokens, summary?, elapsedMs,
 estimatedWpm, cycleIntervalMs, serviceLastSurfacedAt, recentCycles,
 arcPhase?, urgentSubjects?, relevantThreads? }

CuratedPayload after curation: { broadcastId, entries, annotations, originalAnnotations,
 (curation/types) context, triggerReason, consumerPrompt?, drainBoundaryOrdinal?, generatedAt }

CuratorFeedback per-annotation signal back to enrichment: { serviceName, subjectId,
 (enrichment/types) outcome, replacementReading? }

GenerationContext what the generator's prompt renders: { entries: AssembledEntry[],
 (narrative/types) currentSubjectMinute, currentSubjectPhase?, currentSubjectPhaseSecond? }

NarrativeOutput one generation + its metadata: { id, broadcastId, text, generatedAt,
 (narrative/types) feedWindow, usage, covers: NarrativeCover[], batchEntryIds, contentTime,
 imagery: NarrativeImagery }
```

## Module map

### `src/` top-level — orchestration & cross-cutting
- **`server.ts`** — process entry. `@hono/node-server` + a raw `ws` `WebSocketServer` (`noServer: true`) that gates upgrades with the same bearer-token check as HTTP, then hands the socket to `ws/feed.ts`. SIGTERM flushes telemetry + closes the DB pool.
- **`app.ts`** — the Hono app: CORS, path-prefix middleware for the two auth surfaces (consumer = `apiKeyAuth` on `/broadcasts/*`; admin = `sessionContext` + `requireSession` on `/profiles/*` + `/specs/*`), public `/health`. Path-prefix declaration is the only shape that actually works here — siblings mounted at the same root (`app.route("/", consumerApp)` + `app.route("/", adminApp)`) make the first sub-app's wildcard middleware fire on every request, blocking real admin-app traffic from ever reaching `sessionContext`. The comment in `app.ts` explains the failure mode.
- **`api-key-middleware.ts`** — bearer-token gate against `KAIROS_API_KEYS` (constant-time; fail-closed; `/health` exempt). The consumer surface's gate.
- **`auth.ts`** — Better Auth instance for the admin surface; validator-only (sign-ins happen on the admin app via email/password). Builds a separate `postgres-js` Drizzle client over the same `DATABASE_URL` so auth queries don't share the engine's connection pool. Imports the schema from [`@kairos/auth`](../../../../packages/kairos/auth/README.md).
- **`session-middleware.ts`** — Hono middleware for the admin surface: `sessionContext` attaches `user` + `session` from the cookie (or null) plus an `INTERNAL_API_SECRET` header bypass for tests/ops scripts; `requireSession` 401s when no user is present. No role check — Kairos has one user type, being on the manually-seeded user list IS the security boundary.
- **`env.ts`** — loads `../.env` into `process.env` if not already set (no-op when the platform injected the env).
- **`types.ts`** — the engine-level shared types: `Source`, `SourceEntry`, `FeedEntry`, `SourceType`.
- **`feed.ts`** — `Feed`: the broadcast-wide entry log. DB-backed + an in-memory cache (the runtime's lifetime) + a single in-process listener. `push` (dedup + INSERT + cache + listener), `hydrate` (load all rows on runtime start), `getAll`, `query` (filtered DB read for the entries endpoint).
- **`broadcast.ts`** — `BroadcastRuntime` lifecycle: `buildRuntime` wires feed + registry + pipeline + curator + narrative engine + state tracker + recent-cycles buffer + subscribers and runs the brief-init pass; `ensureRuntime` / `startRuntime` (serialised per broadcast) / `stopRuntime` / `stopAllRuntimes`; `transitionStatus` (the lifecycle FSM + the activation gate). Holds the `runtimes` map.
- **`broadcast-health.ts`** — pure flow-health arithmetic for the inspector (`computeBroadcastHealth`, `computeCycleDrift`). The route handler does the I/O; this module decides the maths. (Holds the football-flavoured `LIVE_PHASES` set — see Open work in `../README.md`.)
- **`registry.ts`** — `ServiceRegistry`: at activation, reads the event profile, resolves a spec per service (override → `active` → `experimental`), constructs each enrichment service (`enrichmentFactories`) and each curation service (`curationFactories`), hydrates enrichment subject state from `enrichment_service_states`, builds the curation tiers from `event_profiles.curation_service_tiers`. Exposes `getEnrichmentServices()` / `getCurationServices()` / `getCurationServiceTiers()` / `getSnapshots()`, `persistEnrichmentStates()`, `getLastSurfacedAtMap()` / `touchSurfacedAt(serviceName)`. It wires *all* stages' services — a pipeline-level component, hence top-level (moved here from `enrichment/registry.ts` on 2026-05-11). The pipeline holds the narrow `PipelineRegistry` view of it; the curator + state tracker hold the full thing.
- **`invariants.ts`** — domain-agnostic post-generation postconditions (`phantom_covers`, `tool_call_failed`) → `telemetry.ts`. Warn-only, never blocks.
- **`telemetry.ts`** — PostHog wrapper (`captureInvariant`, `captureEvent`, `flushTelemetry`). Mirrors the Blackout's telemetry shape so one dashboard can pivot on `service`. No-op when `POSTHOG_KEY` is unset.

### `db/` → [`db/README.md`](db/README.md)
Postgres + Drizzle. `schema.ts` (tables: `event_profiles`, `service_specs`, `broadcasts`, `sources`, `feed_entries`, `generations`, `pipeline_cycles`, `enrichment_service_states`, `content_pool_items`) + `enums.ts` (the single source of truth for pgEnum values + their TS unions) + `client.ts` (the one postgres connection) + `content-pool.ts` (the *content-pool* repository, distinct from `client.ts`'s postgres connection pool) + `broadcasts.ts` (broadcast/source/spec repo + the `resolveSpecsForProfile` precedence logic) + `migrate.ts` (the programmatic migrator) + `check.ts` (the post-migrate drift detector) + `reset.ts` (local-only drop+migrate+seed SOP) + `seed.ts` (the `sporting_event` profile + placeholder specs).

### `pipeline/` → [`pipeline/README.md`](pipeline/README.md)
Stage 1 + the per-cycle conductor for all four stages. `pipeline.ts` (`CyclePipeline` — the waiting room + the cadence/closing/external flush machinery + `runCycle`, the per-cycle orchestration; plus `defaultPersistCycle`, `PipelineRegistry`, `CyclePipelineOptions`, the defaults), `subject-time.ts` (`subjectOrdinal` / `subjectOrdinalForEntry` — the `(phase, phaseSecond)` → sortable-ordinal helper, the pipeline's batching key, also used by `narrative/`; `readClosingExtension` / `readClosingPrompt` — the consumer-stamped closing-cycle markers; `PHASE_BASE` — football-phase hardcoding, tracked as a domain leak).

### `enrichment/` → [`enrichment/README.md`](enrichment/README.md)
Stage 2 — the enrichment services + their machinery. `base-service.ts` (`BaseEnrichmentService` — the three-state subject-tracking base class every enrichment service extends), `llm-enrichment.ts` (Haiku call assembly for the per-cycle + brief-init paths), `types.ts` (the enrichment-side type surface — `EnrichmentService`, `FeedChunk`, `EnrichmentAnnotation`, `EnrichedPayload`, `CuratorFeedback`, …), `services/` (the six enrichment services). (The cycle pipeline + the registry used to live here; lifted out 2026-05-11 — see `pipeline/` and `registry.ts`.)

### `curation/` → [`curation/README.md`](curation/README.md)
Stage 3. `curator.ts` (the `Curator` — runs the tiers, `mergeTierResults`, `applyRemovals`, `reconcileBudget`, `decideMode`, `sendFeedback`), `llm-curation.ts` (Haiku call assembly for curation + the `withDecision` helper), `recent-cycles.ts` (`RecentCyclesBuffer` — a 30-cycle in-memory ring of annotations + prose, for the cross-cycle judgement services), `state-tracker.ts` (`BroadcastStateTracker` — elapsed time, the WPM EMA, generation history, pacing signals, the running summary), `types.ts` (the curation-side type surface), `services/` (the eight curation services).

### `narrative/` → [`narrative/README.md`](narrative/README.md)
Stage 4. `engine.ts` (the `NarrativeEngine` lifecycle + `run` + `filterPhantomCovers`), `generator.ts` / `imagery.ts` / `summary.ts` (the three LLM surfaces — each loads its `*.baseline.md` at module init, merges with the resolved spec content from `registry.getGenerationSpec()` / `getImagerySpec()` / `getSummarySpec()` via the section-header assembler, K6.2), `*.baseline.md` (profile-agnostic prose for each surface — the in-code half of the prompts-as-content split), `spec-types.ts` (`GenerationSpecContent` / `ImagerySpecContent` / `SummarySpecContent` + `assembleSectionedPrompt`), `helpers.ts` (per-entry accessors + `toAssembled` + `deriveCurrentSubjectMinute` + `computeBatchEntries` + `clampMonotonicMinute`), `anchors.ts` (`extractAnchors` — `{{ref:...}}` → `charOffset` in the stripped prose), `refrain.ts` (`formatRefrainStatus` — refrain-budget tracking across prior generations), `types.ts` (the generation-side type surface).

### `eval/` → [`eval/README.md`](eval/README.md)
Cross-cutting support for the "eval criteria as spec content" model — not a pipeline stage. `spec-eval.ts` owns the `## Eval` section header names + the strict `prose-must-not-match: /regex/flags` hard-invariant grammar; `isEvalHeader` lets the three prompt assemblers (enrichment / curation / narrative) skip eval sections so they never leak into a prompt, and `extractEvalCriteria` + `checkProseInvariants` let the `manual/*-eval/` runners execute them.

### `llm/` → [`llm/README.md`](llm/README.md)
The provider-neutral LLM contract. `types.ts` (`LLMClient`, `LLMRequest`/`LLMResponse`, `SystemSegment`, tool shapes, `LLMRateLimitError`), `anthropic.ts` (the Anthropic SDK implementation — translates the neutral shape, threads `cache_control` markers, maps 429s to `LLMRateLimitError`), `defaults.ts` (model + token defaults: Sonnet for generation, Haiku for everything else), `stub.ts` (the scripted test double), `index.ts` (barrel).

### `routes/` → [`routes/README.md`](routes/README.md)
The Hono HTTP surface — one module per resource: `broadcasts.ts` (broadcasts CRUD + sources + entries + cycles + health + services + feedback), `narrative.ts` (off-schedule `generate` + generations reads), `content-pool.ts` (content-pool CRUD), `profiles.ts` (event-profile reads), `specs.ts` (spec list + promote), `health.ts`.

### `ws/` → [`ws/README.md`](ws/README.md)
`feed.ts` — `handleFeedSubscription`: register the socket on the runtime, send the `sync` batch, stream subsequent messages. Read-only.

## Anti-patterns — drift sentinels

These are the failure modes the design exists to prevent. Anything below appearing in the code is a regression — fix the code, don't accommodate it.

- **No second authority on drops.** Curation is the only stage that removes entries from the generator's view. If enrichment wants to suppress, it produces fewer annotations; if ingest wants to suppress, it filters at `onEntry`. Nowhere else. (The retired "assembly stage" re-filtered on age/budget after curation — ghost re-narrations, double-counted emphasis, curator confusion.)
- **No DB resurrection for cycle batching.** Entries pass through the in-memory waiting room exactly once. The `feed_entries` write is for replay / matchroom bootstrap / post-restart hydration *only* — never for cycle batching.
- **No wall-clock-keyed batching.** Windows are keyed on subject time (the `(phase, phaseSecond)` ordinal), not broadcast wall-clock arrival time. Wall-clock keying mixes 2–3 subject minutes into one cycle whenever sources have heterogeneous latency.
- **No off-cadence flushes for priority entries.** `canonical: true` gets auto-emphasis, never-evicted status, and pulls the cycle to `action_led` — but does not fire a flush. (The closing-cycle mechanism is the one exception, and it still respects the subject-time DELAY guarantee.)
- **No oldest-first token-budget eviction.** Budget pressure resolves via priority, which curation owns (`reconcileBudget`).
- **No feed-wide scan for per-cycle selection.** The feed is the broadcast-wide log; cycles operate on the waiting room's drain. (The generator does read broadcast-level state — voice, context, canonical events — but those are explicitly *not* per-cycle selections.)
- **No "inactive source" gate.** Source inclusion = attachment to the broadcast (+ `enrichment_tags` for service routing). A separate active/inactive flag without a lifecycle is a silent-bug factory.
- **No silent cycles.** The pendulum (`action_led` / `enrichment_led` / `context_led`) exists so every cycle produces something. Silence is a phase-driven concern *upstream* of curation; once curation runs, it always produces.
- **No feed context passed directly to the generator.** Whatever the generator sees as cycle material, it sees via `curated.entries`.
- **No domain knowledge in the engine.** Football concepts, Sportmonks types, radio specifics — service specs, event profiles, consumer source adapters. (`PHASE_BASE` / `LIVE_PHASES` violate this today — tracked tech-debt.)
- **No cross-broadcast state.** Each broadcast is its own runtime + DB state. Only platform content (profiles, specs) spans broadcasts.

## Open work

Engine-wide structural backlog + arch-doc drift live in [`../README.md`](../README.md) § Open work (the `context_curator` informal protocol, the `PHASE_BASE` domain leak, the stale doc-strings, the `kairos-architecture.md` drift). Resolved since the last audit: prompts-as-content's load-bearing lift (K6.2 + K6.3) — narrative/enrichment/curation now read `*.baseline.md` + the resolved spec content. The registry-placement inversion and the cycle-pipeline misplacement were resolved 2026-05-11 — the registry is now `registry.ts`, the cycle pipeline `pipeline/`. Stage-internal WIP lives in each stage's README.

## See also

- [`../README.md`](../README.md) — Kairos as a service: the consumer contract, lifecycle, runtime, dev/deploy, the engine-wide Open-work backlog.
- [`pipeline/README.md`](pipeline/README.md) (Stage 1 + the per-cycle conductor), [`enrichment/README.md`](enrichment/README.md) (Stage 2), [`curation/README.md`](curation/README.md) (Stage 3), [`narrative/README.md`](narrative/README.md) (Stage 4) — the four stage modules; `registry.ts` (wires the services) is in the module map above under `src/` top-level.
- [`db/README.md`](db/README.md), [`llm/README.md`](llm/README.md), [`routes/README.md`](routes/README.md), [`ws/README.md`](ws/README.md) — the supporting modules.
- [`docs/kairos-architecture.md`](../../../../docs/kairos-architecture.md) — the legacy canonical doc; superseded by this file + the stage READMEs; drifted in places (see `../README.md` § Open work).
