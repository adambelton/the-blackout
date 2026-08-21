# Kairos — system architecture

> **⚠️ Being decomposed into the README tree (2026-05-11).** The canonical engine architecture now lives in [`apps/kairos/server/README.md`](../apps/kairos/server/README.md) (the engine as a service: consumer contract, lifecycle, runtime) + [`apps/kairos/server/src/README.md`](../apps/kairos/server/src/README.md) (the internal architecture: the four stages, the data shapes, the module map, the anti-patterns) + each `apps/kairos/server/src/<module>/README.md`. **Treat the READMEs as canonical; this document has drifted.** Known drift: §3 "Phase-boundary triggers" describes a `recognizePhaseTransition` / `schedulePhaseFlush` mechanism that doesn't exist — the real mechanism is the consumer-stamped `closingExtensionSeconds` marker in `apps/kairos/server/src/pipeline/pipeline.ts` (the consumer decides which entries qualify); the body's `enrichment/pipeline.ts` / `enrichment/subject-time.ts` / `enrichment/registry.ts` paths are stale — those moved to `src/pipeline/` (cycle pipeline + content-time) and `src/registry.ts` on 2026-05-11, and `EnrichmentPipeline` is now `CyclePipeline`; the lifecycle includes a vestigial `paused` status; migration-file references (`0006_…`) are stale numbers (the `drizzle/` history was squashed to `0000_fixed_synch.sql`). This file will be retired into a thin index once the Kairos vertical is verified.

A canonical mental model. Written 2026-04-24 after an audit uncovered that parts of the pipeline had drifted from the original design for lack of a holistic reference. Purpose: be the one-page mental map of the whole system, so the next time someone changes a stage they can see what else depends on its shape.

> **Chronos is the raw stream — events, commentary, research, moderator input. Time passing, things happening, sources flowing in. Kairos is what the engine produces — the meaningful moment extracted from the stream. The engine's job: transforming Chronos into Kairos.**

## The pipeline at a glance

A Mermaid diagram of the four-stage pipeline (ingest+batch → enrich → curate → generate) with the feedback loop and supporting state lives at [`kairos-architecture-diagram.md`](./kairos-architecture-diagram.md). Open it for the visual; the rest of this doc is the narrative.

## 1. System boundary

### What Kairos is

A domain-agnostic narrative orchestration engine. Given a stream of typed source entries and a brief that frames what matters, it produces prose that describes the meaningful moments in the stream, in order, at a consumer-appropriate cadence.

### What Kairos is not

- **Not a presentation layer.** TTS, illustrations as *assets*, matchroom UI, audio playback choreography — all consumer-side.
- **Not a source collector.** Sources arrive at Kairos over HTTP. It doesn't poll APIs, transcribe audio, or collect moderator input directly.
- **Not domain-aware.** No football types. No sport-specific logic. Domain shape lives in the event profile and service specs that ship with a broadcast.
- **Not stateful beyond a broadcast.** Every broadcast has its own durable state in Postgres; nothing carries across broadcasts except platform content (profiles, specs).

### Consumer contract

The consumer (for us: The Blackout) communicates with Kairos over HTTP + WebSocket. Dependency is one-way: the consumer knows about Kairos; Kairos doesn't know about its consumer. The seam is in `apps/blackout/server/src/lib/kairos.ts` on the consumer side.

## 2. The pipeline — four stages

```
receive sources
 → ingest + batch (delta-boundaried window of entries)
 → enrich (scoped, additive — services annotate)
 → curate (full-payload, subtractive — curator selects)
 → generate (LLM emits prose on the curated selection)
 → emit narrative (to consumer via WS)
```

One subtractive stage. Curation owns what's kept and what's dropped. The generator receives curated meaning states, not raw context.

### Stage 1 — Ingest + batch

**Owner:** `apps/kairos/server/src/pipeline/pipeline.ts` (waiting room + flush), `apps/kairos/server/src/pipeline/subject-time.ts` (ordinal helper.ts` (broadcast-wide entry log).

**What it does:**
- Accepts `POST /broadcasts/:id/entries` from the consumer.
- Filters ambient sources (`narrative_voice`, `narrative_context`) at ingest — they're reference material fetched via `getNarrativeContext()`, not subjects of enrichment.
- Appends entries to the broadcast's feed log (persisted, queryable across the broadcast).
- Routes entries into the **waiting room** — an in-memory holding buffer keyed by subject ordinal (the `(phase, phaseSecond)` pair the consumer stamped at push time, collapsed into a single sortable number). Single-dispatch: entries leave the waiting room when drained, never re-read from the DB.
- A cadence flush drains entries whose subject ordinal is ≤ `(highest observed - DELAY_seconds)`. The remaining entries — too recent to be confident no late siblings will arrive — sit in the waiting room until the next flush.
- Late arrivals (entries landing after their window's flush — i.e. with ordinal ≤ the last-flushed boundary) are **discarded with telemetry**, exposed via `pipeline.getLateDiscardedCount()`. The discarded counter is the operational signal for whether `delayMs` is right; ~0 means we can tighten, climbing means we need to either increase DELAY or fix the source's stamping.
- On flush, emits a `FeedChunk { broadcastId, entries, fromTimestamp, toTimestamp, narrativeContext }`. The batch is an explicit, bounded unit — and now subject-time-coherent.

**Why this shape:**
- **Subject-time-coherent windows.** Wall-clock-ordered batching mixed entries from 2-3 subject minutes into a single cycle whenever sources had heterogeneous arrival latency (Sportmonks ~30s, HLS+ASR ~30s after the radio offset estimate; the 2026-05-02 audit showed 18% of normal cycles spanned ≥2 subject minutes). The narrator was reasoning about "what's happening now" against an incoherent slice. Subject-time batching keys the dispatch on *when the underlying event happened in subject time* (the match minute being commentated on), not when it physically arrived. See `docs/vocabulary.md` § Time.
- **DELAY trades narrative lag for completeness.** Default 60s — covers the long tail of source arrival latency with margin. Configurable per-pipeline so live tests can tune once the late-discard counter has data. Lower bound ~30s (below this, legitimate late entries get dropped); upper bound ~90s (above this, audience hears the broadcast audibly behind the action).
- **Single dispatch** by design. Each entry passes through the waiting room exactly once. The previous prototype's "assembly stage" re-read the DB on each cycle and filtered downstream; that pattern's failure modes (curator seeing the same entries multiple times, generator re-narrating moments) are structurally precluded here.
- **Null-ordinal entries pass through any cadence.** Entries without phase information (legacy unstamped entries, ambient sources, test fixtures) have no subject-time anchor to defer against, so they drain on the next flush regardless of boundary.
- **Ambient filtering happens once, at the edge.** The brief is a *lens*, not a source of enrichment subjects — putting it in the buffer would fire every service over every name/team/theme in it (observed Burnley-City 2026-04-22 = 40 annotations from one entry).
- **The feed log is broadcast-wide** so voice / context / canonical-event scans still have a source of truth, without contaminating cycle-level logic.

**The consumer's stamping responsibility.** Subject-time batching is only as accurate as the `phase` + `phaseSecond` the consumer stamps at push time. The Blackout's broadcast-runner stamps every entry from its calibrated radio-offset estimate (continuously refined by `event-correlation.ts` matching distilled commentary against canonical Sportmonks events). Other consumers ship their own stamping path; the engine's contract is just "if you give me an ordinal, I'll batch on it." Entries without phase fall through harmlessly.

### Stage 2 — Enrichment

**Owner:** `apps/kairos/server/src/enrichment/pipeline.ts::runCycle`, services in `apps/kairos/server/src/enrichment/services/`.

**What it does:**
- Runs all enrichment services in parallel against the `FeedChunk`.
- Each service processes entries *tagged for it* via the source's `enrichment_tags`. A service ignores sources not tagged for it. There is no "active/inactive source" filter — tagging is the routing contract.
- Each service emits zero or more `EnrichmentAnnotation`s, each tied to a `subject` (a named thing the service tracks over time — a player, a theme, an arc). Services hydrate subject state from the DB on start and persist it after each cycle.
- Per-service annotation cap (default 5 per cycle) guards against a single service dominating a cycle.

**Brief initialisation pass.** At broadcast activation, before any cycle runs, every enrichment service that opts in receives a one-shot Haiku call against the brief alone — the `BRIEF_INITIALIZATION_GUIDANCE` per service tells the model what priors to lift through that domain's lens. Output hydrates `unexpressed` state via the existing `hydrateStates` API; the persistence loop writes seeded state to `enrichment_service_states` immediately so a conductor restart that predates cycle 1 still survives. Services without meaningful brief priors (e.g. `patterns-echoes`, which is purely live-evidence-driven) opt out and remain a no-op. ContextCurator's thread inventory persists alongside on the broadcasts row's `briefThreadInventory` column — same activation, same parallel `Promise.all`. The brief stops being a passive sticker and becomes a load-bearing commitment the engine has internalised before evidence arrives. Landed 2026-04-26.

**Services Kairos ships:**
- `character-arcs` — tracks per-subject narrative arcs over time.
- `character-relationships` — dyadic state between subjects.
- `momentum` — directional / intensity reading of action.
- `patterns-echoes` — recurring motifs (the only service that doesn't seed from the brief — its subjects only exist as joins between brief and live evidence).
- `tension-conflict` — adversarial tension.
- `themes` — recurring frames pulled from the brief.

Services are additive: they observe the chunk, they produce annotations. They do not remove entries, decide priority, or judge what the passage should be about.

**Why this shape:**
- **Additive + scoped** so parallel execution is safe. Services don't wait for each other. Order-independent.
- **Subject-centric state** because meaning compounds across cycles. A character arc is the accumulation of past readings, not a one-shot judgement.
- **Tag-driven routing** because one source might matter to several services and a service might care about several sources — the N×M relationship is explicit, not implicit.

### Stage 3 — Curation

**Owner:** `apps/kairos/server/src/curation/curator.ts`, services in `apps/kairos/server/src/curation/services/`.

**What it does:**
- Runs curation services in **tiers**: services within a tier execute concurrently against the same prior context (they don't read each other's writes — guarantee enforced by the seed's tier definition); tiers run sequentially because each tier reads what the previous tier wrote. The four tiers ship as `[[narrative_arc, narrative_gap, saturation_resolver, context_curator], [priority, pacing], [conflict_resolver], [broadcast_summary]]` (column `event_profiles.curation_service_tiers`, jsonb of `string[][]`). Within-tier results are merged via `mergeTierResults` — decisions union by service name, conflicts concat, `shouldGenerate` AND-of-bools (false wins), single-writer fields take any divergence.
- Decides the **pendulum mode** for the cycle (`action_led` / `context_led` / `enrichment_led`) via `decideMode` — this affects emphasis, not silence.
- Produces a `CuratedPayload { entries, annotations, context }` — the final selection the generator will see.
- Emits `CuratorFeedback` per annotation back to enrichment services (`IGNORED` / `ACKNOWLEDGED` / `DELIVERED_WITH_EMPHASIS` / `KILLED_WITH_REPLACEMENT`). Services update their subject state accordingly — a suppressed reading doesn't get re-echoed next cycle.

**Services Kairos ships (with tier membership):**

*Tier 1 — independent (parallel):*
- `narrative-arc` — commits arc phase (`opening` / `rising` / `climax` / `falling` / `resolution`) or holds.
- `narrative-gap` — flags subjects whose annotations have been ignored for too long.
- `saturation-resolver` — suppresses annotations whose subject has been surfaced too often.
- `context_curator` — single source of truth for narrative_context (brief) usage. Two responsibilities sharing one recency model: (1) **suppression** of `patterns_echoes` annotations whose brief fragments were already echoed in the recent window (legacy `context-resonance-resolver` job), (2) **surfacing** — at activation extracts a `NarrativeThread[]` inventory from the brief; per cycle, filters by recency and asks Haiku which threads are alive *right now* given the broadcast's prior summary + arc + cycle entries. Outputs a `relevantThreads` list the generator surfaces only when mode lands on `context_led`. Heuristic floor (~3 min freshness window) keeps the LLM ranker honest; threads anchored on brief fragments already cited by surviving `patterns_echoes` annotations this cycle are excluded (the £262m problem). Recency tracker updates only when the cycle actually narrates from the surfaced threads.

*Tier 2 — read tier 1 outputs (parallel):*
- `priority` — LLM-driven fact-level priority. Can remove entries.
- `pacing` — recommends word count and cadence based on consumer feedback signals.

*Tier 3:*
- `conflict_resolver` — resolves conflicts between annotations (two services disagreeing on a subject), with priority's emphasis decision in scope.

*Tier 4:*
- `broadcast_summary` — compiles summary state (canonical + narrative blocks) for the next cycle's prior context.

**Curation is the only authority on drops.** It owns:
- What entries reach the generator (`selectedEntries`).
- Priority within token budget — a final `reconcileBudget` pass evicts lowest-priority entries (canonical / batch-trigger entries are never evicted) until the selection fits the ceiling.
- Feedback that shapes the next cycle's enrichment state.

**Why this shape:**
- **Tiered + parallel-within-tier** because most services in a phase don't read each other's writes — running them sequentially was leaving wall-clock time on the table. The dependency graph is the seed's tier definition; the merge fold is what makes the parallelism safe. Replaced the original sequential for-loop 2026-04-26.
- **Subtractive** because enrichment is additive. The shape of meaning comes from what's *not* said as much as what is. A full-payload subtractive curator is how the system expresses restraint.
- **Authoritative drop decisions** because the generator should receive exactly what curation chose. Second-guessing curation downstream (e.g. by re-filtering on age or budget in a later stage) creates drift.

### Stage 4 — Generation

**Owner:** `apps/kairos/server/src/narrative/engine.ts`.

**What it does:**
- Receives the `CuratedPayload` from curation.
- Builds the generator prompt:
 - System prompt: `narrative_voice` (from the broadcast's voice source) + `narrative_context` (from the broadcast's context source) + cached domain guidance.
 - User prompt: top-of-prompt steering preamble for any moderator-typed directives (`collectModeratorDirectives` — surfaces moderator entries as live editorial steering, separate from chunk feed where curation could evict them); curated entries (annotated and timestamped, with parent/child grouping for entries that share a `parentSourceId` ↔ `canonicalSourceId` linkage — `match_action` event_texture rendered indented under its canonical Sportmonks event); the running summary; refrain budget status; target word count; cycle cadence. When mode is `context_led`, also includes `relevantThreads` from `context_curator` — ranked threads from the brief that the curator judges alive for this cycle.
- Calls Sonnet via the `deliver_narrative` tool.
- In parallel, Haiku runs imagery selection against the same curated context — produces `pool` / `generate` / `hold` decision before Sonnet finishes, so the consumer's image pipeline starts as soon as possible.
- Filters phantom covers (cites that don't match any curated entry) before persisting.
- Persists the `generation` row (`contextPackage`, prose, covers, token usage, imagery).
- Emits a `narrative` message to all subscribed WS clients: `{ id, text, covers, batchEntryIds, imagery, contentTime, … }`.
- Updates the running summary — canonical events regenerated from live canonical entries (templated, deterministic), narrative block updated by Haiku (constrained never to touch state).

**Why this shape:**
- **Sonnet for generation, Haiku for imagery + summary.** Different cost/quality profiles; imagery and summary are scoped enough to be cheap.
- **Covers with `charOffset`** so the consumer can fire per-entry UI reveals mid-audio, not just at clip end.
- **Running summary as two glued blocks** — canonical events are fact, narrative block is judgement. They don't mix. The templated canonical block is the antidote to Haiku dropping facts in compression (Burnley-City 2026-04-22 — Haaland goal evaporated from the summary at cycle 6).
- **Parallel imagery + narrative** because image generation is the slowest thing in the consumer pipeline; starting it early is worth a small increase in coupling.

## 3. Cycle triggers

A cycle begins when one of two trigger types fires:

| Trigger | When | Drain criterion | Purpose |
|---|---|---|---|
| `accumulation` | Wall-clock timer tick (default 45s). | Entries with content ordinal ≤ `(highest observed - DELAY_seconds)`. Null-ordinal entries pass through. | The steady-state case. Curation handles selection regardless of whether the drain produced entries. Empty cycles still produce passages — `context_curator` surfaces brief threads in quiet windows so the narrator has material. Bounded by a private `consecutiveEmptyCycles` counter (default 2) — too many consecutive empty cycles degrade into filler, so the engine stops generating into pure silence. |
| `external` | A consumer requests an off-schedule cycle. Carries an opaque `consumerPrompt`. | Drains the entire waiting room. The consumer asked for this cycle; treat it as authoritative. | Phase-boundary or interlude moments where the consumer wants a deliberate beat outside the regular cadence (halftime reflection, closing passage, courtroom recess, debate interlude). Bypasses the empty-cycle cap. Goes through the same enrich → curate → generate path as `accumulation` — curation is still the sole authority on selection. |

**Two-clock model.** The `flushIntervalMs` (45s default) is the *cadence* — how often we attempt a flush in wall-clock time. The `delayMs` (60s default) is the *boundary lag* — how far behind the highest observed content ordinal the drain criterion sits. They're independent knobs:
- Tighten cadence → more cycles per minute (smaller content windows per cycle when the source flow is dense).
- Tighten DELAY → less narrative lag but more late-discards if calibration drifts.
- Loosen cadence → fewer larger cycles (suits quieter moments).

Today both are static defaults; the design space allows future per-broadcast or even per-trigger tuning ("intense moments warrant shorter cycles") without changing the trigger enum.

**No off-cadence flushes for priority entries.** `canonical: true` entries (goals, cards, subs) carry priority through curation — auto-emphasised at entry, never evicted by `reconcileBudget`, and they pull the cycle to `action_led` mode — but they do *not* fire flushes off the cadence. A goal lands in the cycle whose drain window contains its content ordinal, where the surrounding seconds of build-up and immediate aftermath give the narrator enough material to render the moment well. (Earlier prototypes had an immediate-flush path on canonical entries; it produced undersized cycles around goals and destabilised pacing math without materially improving end-to-end latency, since Sportmonks' inherent ~30s delay dominates anyway.)

**Phase-boundary triggers.** Phase-transition entries (KICKOFF / HALFTIME / SECOND_HALF_KICKOFF / FULL_TIME on the `sporting_event` profile, or whatever the consumer stamps as a transition) trigger an early scheduled flush — `T_observed + delayMs (+15s_content for HALFTIME / FULL_TIME)` — so the closing-of-prior-phase cycle dispatches as a single coherent unit including the reactive moments around the whistle ("the whistle blows and Salah drops to his knees"). Cadence flushes during the wait window are deferred so one cycle covers the whole window. KICKOFF and SECOND_HALF_KICKOFF don't get the +15s extension — pre-kickoff content is warming-lifecycle, not reactive material that belongs with the prior phase. The recognizer is in `apps/kairos/server/src/enrichment/subject-time.ts::recognizePhaseTransition`; the scheduling lives in `pipeline.ts::schedulePhaseFlush`.

**Why the trigger enum stayed at two.** Earlier `improv` and `gap` values had no behavioural divergence from `accumulation` — both flowed through the same `runCycle` → `enrich` → `curate` → `driveGeneration` path; the curator's mode selection (`action_led` / `enrichment_led` / `context_led`) was driven by what the cycle contained, not by the trigger reason. `gap` was defined but never set anywhere. Collapsing them to `accumulation` + `external` simplifies reasoning: a cycle is either scheduled or consumer-requested. The empty-cycle cap moved to a private counter where it belongs (a stopping rule, not a cycle type). See `0006_trigger_reason_collapse.sql` for the migration.

**Why `consumerPrompt` is opaque.** Kairos must not learn about consumer-domain concepts. A football broadcast has halftime reflections; a courtroom broadcast has closing arguments; a debate broadcast has interlude passages between rounds. Encoding "halftime_reflection" / "closing_passage" in Kairos's enum would leak the football domain. Instead, the consumer writes the actual prompt prose on their side and passes it through `consumerPrompt`; Kairos splices it verbatim into the user message via `formatConsumerPrompt`. New consumer phase moments don't require a Kairos change.

**Silence is not a valid outcome.** The pendulum (K19) says every cycle produces *something* — either action-led (a new moment), context-led (a draw from the brief), or enrichment-led (a recurring subject's next beat). The three modes keep the broadcast breathing. Historically we had "hold" cycles that produced no audio; that pattern was retired.

## 4. Supporting systems

### Feed (`apps/kairos/server/src/feed.ts`)

The broadcast-wide entry log. Every ingested entry lives here. Queryable via `GET /broadcasts/:id/entries`. Used by:

- The enrichment pipeline's waiting room (entries arrive via `feed.subscribe` → `pipeline.onEntry`, sit in the in-memory waiting room until drained).
- Generation-time scans for `narrative_voice`, `narrative_context`, `canonicalEvents`, and `feedWindow` markers. These are *broadcast-level* reads, not per-cycle selections.
- Replay / matchroom bootstrap / post-restart hydration via `feed.hydrate()`. The DB is the source of truth for "what was ever pushed"; the waiting room is the source of truth for "what hasn't been dispatched yet."

`Feed.push` includes a write-layer dedup keyed on `data.sourceId` — defense in depth for consumers whose source-side dedup misfires across restarts. Returns the existing entry on collision rather than inserting a duplicate. Synthetic phase entries and ambient briefs (no `sourceId`) skip the dedup; the consumer's view layer is responsible for collapsing those.

### BroadcastStateTracker (`apps/kairos/server/src/curation/state-tracker.ts`)

Per-broadcast runtime state:
- Elapsed time since activation (for cadence decisions).
- Measured WPM estimate (closes the loop between Sonnet output length and how fast the consumer actually reads it via `POST /broadcasts/:id/feedback`).
- Prior generations (last N for refrain-budget checks + priorGenerations context).
- Running summary (carried forward across cycles).
- Pacing signals from the consumer (`slow_down` / `speed_up` / `on_track`).

### RecentCyclesBuffer (`apps/kairos/server/src/curation/recent-cycles.js`)

A small in-memory ring of recent curation contexts, passed to each cycle's curation stage. Some services use it for anti-repetition (saturation, context_curator's stale-echo suppression).

### Feedback loop

Per-annotation feedback per cycle: `CuratorFeedback { serviceName, subjectId, outcome, replacementReading? }`. Outcomes:
- `IGNORED` — curator didn't use this annotation.
- `ACKNOWLEDGED` — curator noted it but didn't emphasise.
- `DELIVERED_WITH_EMPHASIS` — curator surfaced it.
- `KILLED_WITH_REPLACEMENT` — curator replaced the reading (typically conflict resolution).

Services implement `confirmSurfaced(feedback)` and update subject state. Subjects that received no annotation this cycle receive no feedback — their state holds.

### Canonical events

A subset of feed entries flagged `sourceCanonical` on `event`-type sources (goals, cards, subs in a sporting context). Treated as ground truth — never dropped by curation, passed to the generator as a separate block alongside the running summary. The running summary's templated `Canonical state` block is regenerated from them every cycle.

### Refrains

Configurable repeated phrases the generator can reuse across cycles with per-phase budgets. Example: a "silence before the dam breaks" phrase that can appear twice in `rising` and zero times in `closing`. The engine scans prior generations to count current usage and passes a refrain-status summary to the generator each cycle.

### Invariants

Post-generation domain-agnostic checks fire when a generation exhibits a known-bad pattern:
- `phantom_covers` — cover ids that don't match any entry in the generator's context (hallucinated citations).
- `tool_call_failed` — the generator went off-tool (produced plain text instead of the `deliver_narrative` tool call).
- Consumer-side invariants on the Blackout side (goal referenced without GOAL event in covers, score phrase without goal, etc.) — these ship in `apps/blackout/server/src/conductor/invariants.ts` and operate on `batchEntryIds`.

Invariants log warnings + capture PostHog events. They don't block.

## 5. Features the system supports

| Feature | Where it lives | What it does |
|---|---|---|
| **Pendulum modes** | `curator.decideMode` | Every cycle produces output in one of three modes — action-led, context-led, or enrichment-led. Silence is not an outcome. |
| **Content-time batching** | `enrichment/pipeline.ts` (waiting room + drain), `enrichment/subject-time.ts` (ordinal helper) | Cadence cycles drain entries by content ordinal, not arrival time. DELAY (60s default) waits for late-arriving entries to land in their proper window before flushing. Late arrivals (post-flush) discard with telemetry. Single-dispatch — no DB resurrection. |
| **Priority-flush queuing** | `enrichment/pipeline.ts::dispatchFlush` | A tick arriving while a flush is in flight queues one pending tick rather than dropping or racing — cadence becomes `max(interval, flushDuration)`. |
| **Adaptive target word count** | `engine.ts::computeTargetWords` + `state-tracker.ts` | Measured WPM from consumer feedback drives the next cycle's target. A slower voice (Hume) naturally produces fewer words per cycle. |
| **Imagery selection (pool / generate / hold)** | `narrative/imagery.ts` | Haiku picks from the consumer's pre-prepared pool, generates a fresh prompt, or holds the previous image. Anti-reuse guidance built in. |
| **Covers with `charOffset`** | `narrative/generator.ts` → consumer | Each cover can carry a character offset into the prose. Consumer uses this to fire per-entry UI reveals mid-audio. |
| **`contentTime`** | `engine.ts` → consumer | The batch's earliest subject time, carried on the `narrative` cue as the cycle's **content-time anchor**. Consumer content clocks drive off this, not off specific event coverage. See `docs/vocabulary.md` § Time. |
| **Consumer pacing feedback** | `POST /broadcasts/:id/feedback` → `state-tracker.ts` → `pacing` curation service | Slow-down / speed-up signals from the consumer adjust target word count. |
| **Canonical events as ground truth** | `engine.ts::canonicalEvents` | Priority entries on event sources pass to the generator as a separate fact block. Never dropped by curation. Antidote to summary drift. |
| **Running summary (canonical + narrative)** | `engine.ts::assembleRunningSummary` | Two glued blocks: templated state (regenerates each cycle, can't drift) + Haiku-produced narrative arc note (constrained never to touch state). |
| **Refrains with phase budgets** | `engine.ts::formatRefrainStatus` | Recurring phrases with per-phase budgets; engine tracks usage across cycles and feeds status to the generator. |
| **Phase transitions** | Sources emit phase markers (`first_half` / `half_time` / `second_half` / etc.) on entries; `state-tracker.ts` observes them | Cycle-level phase + `phaseSecond` available to the generator; refrain budgets are per-phase. |
| **Post-cycle invariants framework** | `invariants.ts` | Warn-only domain-agnostic postcondition checks on each generation. |
| **Service specs with experimental/active/archived versions** | `apps/kairos/server/src/db/schema.ts` → `service_specs` table, `POST /specs/:service/:profile/:version/promote` | Services can have multiple spec versions live simultaneously. Promotion is atomic (archive old + activate new). |
| **Event profiles** | `apps/kairos/server/src/db/seed.ts`, `GET /profiles` | A domain container — ships with a default `sporting_event` profile. Determines which enrichment + curation services activate for a broadcast. |
| **Replay + export** | `apps/kairos/server/scripts/replay.ts`, `apps/kairos/server/scripts/export-broadcast.ts` | Replay captured feed through the engine with a canned LLM (cheap mechanics validation); export a broadcast's feed + generations + cycles to flat files under `data/broadcasts/<id>/` for analysis. |
| **Feed WebSocket for consumers** | `apps/kairos/server/src/ws/feed.ts` | Read-only stream. On connect: full sync of current entries. Then: `entry` / `narrative` (with covers + batchEntryIds) / `generation_skipped` / `cycle_complete` messages. **Heartbeat:** the consumer-side `kairos-heartbeat.ts` (in The Blackout) sends a ping every 15s and terminates on missed pong — needed because Kairos restarts under tsx-watch leave consumer sockets half-open, and TCP keepalive alone takes minutes. Server-side ping (Kairos pinging its subscribers) and a graceful-shutdown close-frame on SIGTERM are still owed — the symmetric design has both ends pinging; today it's lopsided. |

## 6. Token budget

Curation owns the token budget. `reconcileBudget` runs last in the curation chain: it evicts *lowest-priority* entries until the prompt fits under the generator's `maxContextTokens` ceiling, drops any annotations whose `informedBy` ids have all been evicted, and records its decision in `ctx.decisions.budget_reconciler`. Priority tiers: canonical (never evicted) → emphasised → annotated → plain; ties break newer-first.

The generator receives exactly `curated.entries`. The UI's reveal fallback rides on `batchEntryIds`, which carries the cycle's full pre-curation batch — so budget eviction never erases reveal signal.

## 7. Broadcast lifecycle

```
pending → active → complete
 ↑ ↑ ↑
 create activate complete
```

- **`pending`:** created via `POST /broadcasts`. Accepts only `narrative_voice` and `narrative_context` entries (pre-activation seeding). Required: at least one entry of each type with non-empty content. Runtime machinery is not yet started.
- **`active`:** transitioned via `PATCH /broadcasts/:id { status: "active" }`. Starts the `BroadcastRuntime` — feed hydration, enrichment pipeline, curator, narrative engine, WS fan-out. Accepts all entry types.
- **`complete`:** terminal. `PATCH /broadcasts/:id { status: "complete" }`. Stops runtime. Feed + generations remain queryable.

After a server restart, runtime is lazily rehydrated on first reference to an `active` broadcast.

## 8. Data shapes — the types that carry the pipeline

```
FeedEntry — one ingested source entry: { id, broadcastId, sourceId, sourceName,
 sourceType, timestamp, data, enrichmentTags, sourceCanonical }

FeedChunk — a cycle's batch: { broadcastId, entries, fromTimestamp, toTimestamp,
 narrativeContext }

EnrichmentAnnotation — one subject reading from one service: { serviceName, subjectId,
 reading, informedBy, ... }

EnrichedPayload — after enrichment: { broadcastId, entries, annotations }

CurationContext — mutable state threaded through curation services: { selectedEntries,
 selectedAnnotations, decisions, conflicts, mode, pacing, ... }

CuratedPayload — after curation: { broadcastId, entries, annotations,
 originalAnnotations, context, triggerReason, generatedAt }

NarrativeOutput — one generation + its metadata: { id, text, covers, batchEntryIds,
 imagery, contentTime, wordCount, usage, … }

CuratorFeedback — per-annotation signal back to enrichment: { serviceName, subjectId,
 outcome, replacementReading? }
```

## 9. Anti-patterns — things the design explicitly avoids

These are the failure modes that show up when the system is built without a holistic view. Anything below appearing in the code is drift.

- **No off-cadence flushes for priority entries.** Priority is a curation signal, not a timing signal. `canonical: true` entries get auto-emphasis, never-evicted status, and pull the cycle to `action_led` mode — but they do not fire flushes off the cadence. Off-cadence flushes produce undersized cycles around the priority entry and destabilise pacing math. (Phase-boundary flushes are an exception in the planned design — they fire one early flush keyed on phase transition, with the same DELAY guarantee.)
- **No DB resurrection for cycle batching.** Entries pass through the in-memory waiting room exactly once. The previous prototype's "assembly stage" re-read `feed_entries` on each cycle and filtered downstream; that produced ghost re-narrations, double-counted emphasis, and curator confusion about what was new. The DB write to `feed_entries` is for replay / matchroom bootstrap / post-restart hydration only — never for cycle batching.
- **No wall-clock-keyed batching.** Wall-clock buffers mixed entries from 2-3 subject minutes into a single cycle whenever sources had heterogeneous arrival latency. Subject-time batching is the structural fix; reverting to wall-clock keying re-introduces window incoherence.
- **No "assembly" stage between curation and generation.** Curation is the only stage that drops entries from the generator's view.
- **No oldest-first token-budget eviction.** Budget pressure resolves via priority, which curation owns.
- **No feed-wide scan for per-cycle selection.** The feed is the broadcast-wide log; cycles operate on the waiting room's drain.
- **No "inactive source" gate.** Source inclusion is defined by attachment to the broadcast (+ enrichment tags for service routing). A separate active/inactive flag without a lifecycle produces silent bugs and no benefit.
- **No silent cycles as a valid outcome.** The pendulum modes exist so every cycle produces something. Silence was a 2026-04 regression that has been explicitly designed out.
- **No second authority on drops.** If enrichment wants to suppress content, it produces fewer annotations. If ingest wants to suppress, it filters at `onEntry`. Nowhere else.
- **No feed context passed directly to the generator.** Whatever the generator sees, it sees via `curated.entries` (and the broadcast-level state reads for voice/context/canonical events).
- **No domain knowledge in the engine.** Football concepts, Sportmonks types, radio specifics — all live in service specs, event profiles, and consumer-side source adapters. The engine stays generic.
- **No cross-broadcast state.** Each broadcast is its own runtime + DB state. Platform content (profiles, specs) is the only thing that spans broadcasts.

## 10. Extension model

New domains are added by defining:
1. An **event profile** — the container, e.g. `sporting_event` or `political_event`. Lists which enrichment + curation service types activate.
2. **Service specs per profile** — domain-specific guidance for each service type. E.g. the `sporting_event` spec for `character-arcs` tells the service what arcs look like in sport. The service *type* is universal; the *spec* is domain-specific.
3. **Source types + their enrichment tags** — configured at broadcast creation. Declares which services receive which sources' entries.

New services are added by:
1. Implementing the `EnrichmentService` or `CurationService` interface.
2. Registering it in `registry.ts`.
3. Shipping at least one experimental spec per event profile that uses the service.

Spec versioning lets us iterate a service's domain guidance without affecting active broadcasts. A new spec lands as `experimental`; promotion to `active` atomically archives the previous one.

## 11. API surface — summary

**REST (consumer → Kairos):**
- `POST /broadcasts` — create pending broadcast with sources.
- `PATCH /broadcasts/:id` — status transitions, config updates.
- `POST /broadcasts/:id/entries` — push feed entries.
- `POST /broadcasts/:id/feedback` — pacing signals.
- `POST /broadcasts/:id/narrative/generate` — request an off-schedule cycle. Body `{ consumerPrompt: string }` is required (non-empty). Routes through `pipeline.flush({consumerPrompt})` → enrich → curate → generate, with the opaque preamble spliced into the LLM user message. The body-less curator-bypass path (`engine.generateNow()`) was retired 2026-04-26 — it produced the post-FT regression passage during the FA Cup SF by mining the entire match feed without curation. Returns 400 without a `consumerPrompt`.
- `GET /broadcasts/:id/*` — entries, cycles, generations, services for inspection.

**REST (platform content):**
- `GET /profiles`, `GET /profiles/:name` — event profiles.
- `GET /specs`, `GET /specs/:service/:profile` — service specs.
- `POST /specs/:service/:profile/:version/promote` — version lifecycle.

**WebSocket (consumer read-only):**
- `ws://…/broadcasts/:id/feed` — entry + narrative + cycle stream.

## 12. Runtime boundaries

The `BroadcastRuntime` (in `apps/kairos/server/src/broadcast.ts`) bundles per-broadcast machinery: the feed, enrichment pipeline, curator, narrative engine, state tracker, recent-cycles buffer, WS subscribers. One runtime per active broadcast; created at activation, destroyed at completion.

Multiple concurrent runtimes are supported but uncommon (at present we run one active broadcast at a time). Each runtime owns its own DB connections, LLM client, and subscribers; shared-state bugs across broadcasts are architecturally impossible.

---

## Reading guide

- Working on the pipeline: `apps/kairos/server/src/pipeline/` — start with `pipeline.ts` (waiting room + drain), then `subject-time.ts` (subject-ordinal helper that keys the drain.
- Working on enrichment: `apps/kairos/server/src/enrichment/` — start with `base-service.ts` (service skeleton subclasses build on), then any service file.
- Working on curation: `apps/kairos/server/src/curation/` — start with `curator.ts`, then a service that interests you.
- Working on generation: `apps/kairos/server/src/narrative/` — start with `engine.ts`. Per-entry shaping helpers (subject-minute derivation, `toAssembled`, `earliestSubjectMinute`, monotonic clamp on the content minute) live in `helpers.ts`.
- Working on domain packs: [`prompts-as-content-design.md`](prompts-as-content-design.md) covers the spec design model; `db/seed.ts` contains the default `sporting_event` pack.
- Working on the consumer side: `apps/blackout/server/src/lib/kairos.ts` is the HTTP/WS client. Everything else is consumer-domain.
