# pipeline/ — the cycle pipeline (ingest + batch + per-cycle orchestration)

Stage 1 of the engine *and* the per-cycle conductor for all four stages. This module takes entries off the feed listener, holds them in a subject-time-keyed waiting room, decides when a slice is complete, and drives the whole `enrich → curate → generate` loop for each cycle — emitting a `pipeline_cycles` row, the `cycle_complete` WS signal, and the per-cycle telemetry. It does not own the enrichment *services* (those are [`../enrichment/`](../enrichment/README.md)) or the curation *services* (those are [`../curation/`](../curation/README.md)) — it owns the *batching* and the *orchestration*. See [`docs/vocabulary.md`](../../../../../docs/vocabulary.md) § Time.

*(Moved here from `enrichment/pipeline.ts` + `enrichment/subject-time.ts` on 2026-05-11 — it was never an "enrichment" concern; it's the cycle conductor.)*

For where this sits in the four-stage picture, the data shapes, and the anti-patterns, see [`../README.md`](../README.md). This README goes one level deeper.

## How it fits

```
 feed.subscribe ──▶ CyclePipeline.onEntry(entry)
 (broadcast.ts wires │ ambient (narrative_voice / narrative_context)? — drop (the brief is a lens, not a subject)
 feed's listener) │ subjectOrdinal(data.phase, data.phaseSecond) ── subject-time.ts
 │ ordinal ≤ lastFlushedOrdinal? — late-discard with telemetry (getLateDiscardedCount())
 │ carries closingExtensionSeconds? — arm a pending closing cycle (markPendingClosing)
 ▼ else → push { ordinal, entry } into the WAITING ROOM
 ┌─ start(): setInterval(flushIntervalMs ≈ 45s) → dispatchTick ──────────────────────────────────────────────┐
 │ flush in flight? → queue ONE pending tick (cadence = max(interval, flushDuration), never 2×) │
 │ closing pending + ripe? → dispatchClosingCycle (drain up to the PINNED boundary) │
 │ closing pending + natural-boundary would cross the trigger but wall-clock target not yet? → skip │
 │ else → dispatchCadenceFlush │
 └────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
 flush({consumerPrompt}) (external — from POST …/narrative/generate) → drainAll() the waiting room, triggerReason=external
 │
 ▼
 runCycle(entries, triggerReason, flushTrigger, consumerPrompt?, drainBoundaryOrdinal?):
 build FeedChunk (+ narrativeContext from getNarrativeContext())
 → registry.getEnrichmentServices().map(s => s.process(chunk)) [PARALLEL — stage duration = max(service durations)]
 → cap 5 annotations / service → EnrichedPayload
 → curator.curate(enriched, triggerReason, consumerPrompt) ── ../curation/ (runs the 4 tiers; its onCurated handler,
 wired in broadcast.ts, drives narrative.driveGeneration
 and then curator.sendFeedback back into the enrichment
 services)
 → persistCycle(pipeline_cycles row: chunkEntries, annotations, curation snapshot, timingMs, generationId)
 → onCyclePersisted(cycleId) → "cycle_complete" WS to subscribers
 → recentCycles.add({ cycleId, triggeredAt, annotations, prose })
 → registry.persistEnrichmentStates() → upsert enrichment_service_states
 → captureEvent("cycle_timing")
 empty cycles still run the full path (the curator surfaces brief threads in quiet windows) but consecutiveEmptyCycles
 caps consecutive empties at maxConsecutiveEmptyCycles (default 2) so the engine doesn't burn tokens narrating into silence.
```

The pipeline is the **owner of the per-cycle loop** — it holds a `Curator` and calls `curate()`; the curator's `onCurated` handler (injected by `broadcast.ts`) is what reaches into `narrative/`. So the dependency line is `pipeline → curator → (handler) → narrative`, with `pipeline → registry` for the enrichment services. The `feed_entries` DB write is for replay/hydration only — **never read back for cycle batching**; the waiting room is the single source of truth for "what hasn't been dispatched yet."

## What it does

### `pipeline.ts` — `CyclePipeline`

- **`onEntry(entry)`** — drop ambient sources; compute the **subject ordinal** via `subject-time.ts`; late-discard if the entry's window already shipped; otherwise push to the waiting room; arm a pending closing cycle if the entry carries a `closingExtensionSeconds` marker.
- **The flush machinery** — a wall-clock timer (`flushIntervalMs`, default 45,000 — widened from 30s after Brighton-Chelsea 2026-04-21). `dispatchTick`: queue one pending tick if a flush is in flight (cadence = `max(interval, flushDuration)`, never 2× — the 90s-cadence fix from Burnley-City 2026-04-22); dispatch the closing cycle if pending and ripe; skip if a closing is pending and the natural drain would cross its trigger but the wall-clock target hasn't arrived; otherwise dispatch a **cadence flush** — drain entries with ordinal ≤ `(highest observed − delayMs/1000)` (default DELAY 60,000ms). `lastFlushedOrdinal` advances to the drained boundary.
- **Three flush kinds** — *cadence* (the steady state); *external* (`flush({consumerPrompt})` from `POST …/narrative/generate` — drains the entire waiting room, `triggerReason: external`, `flushTrigger: consumer_prompt`); *closing* (when a `closingExtensionSeconds` marker landed — `markPendingClosing` pins the next cycle's drain end at `triggerOrdinal + extensionSeconds`, dispatches it on a wall-clock timer with a force-timer backstop, holds the marker entry + any concurrent consumer-prompt cycle until the closing has gone — so the closing beat and the reflective beat land in order; `flushTrigger: closing`, `triggerReason: accumulation`).
- **`runCycle(...)`** — the per-cycle orchestration (the flow above): build the `FeedChunk`, run the enrichment services in parallel via the registry, cap, assemble the `EnrichedPayload`, hand to `curator.curate(...)`, persist the `pipeline_cycles` row, fire `onCyclePersisted`, append to the recent-cycles buffer, persist enrichment states, emit `cycle_timing`. Plus the exported `defaultPersistCycle` (the production persister — tests inject a noop/spy), `PipelineCycleRecord` / `CycleTimingMs` / `FlushTrigger` / `PipelineRegistry` (the narrow surface the pipeline needs from a registry) / `CyclePipelineOptions`, `DEFAULT_FLUSH_INTERVAL_MS` / `DEFAULT_DELAY_MS` / `DEFAULT_MAX_CONSECUTIVE_EMPTY_CYCLES`.
- **`waitForIdle()`** — resolve when every in-flight flush has settled (`stop()` clears the timer but can't abort a flush mid-run; teardown paths call this before closing the DB pool, or a late LLM call lands on a closed connection).

### `subject-time.ts` — the subject-time ordinal

`PHASE_ORDINAL_STRIDE` (1,000,000 between phases) + `PHASE_BASE` (the phase→base map — *currently hardcodes football phase names; domain leak, tracked in [`docs/kairos-domain-leak-open-items.md`](../../../../docs/kairos-domain-leak-open-items.md)*); `subjectOrdinal(phase, phaseSecond)`; `subjectOrdinalForEntry(entry)`; `readClosingExtension(entry)` / `readClosingPrompt(entry)` (the closing-cycle markers the consumer stamps on a phase boundary). Used by the pipeline (the drain key + the closing readers) and by `narrative/` (`subjectOrdinalForEntry` for the `drainBoundaryOrdinal` filter on canonical events; `subjectOrdinal` for the prompt's subject-time sort).

## Contract

### Provided
- **To the runtime (`broadcast.ts`):** `new CyclePipeline(broadcastId, registry, curator?, options)`, `pipeline.start()` / `stop()` / `onEntry(entry)` / `flush({consumerPrompt?})` / `getFlushIntervalMs()` / `getSnapshots()` / `getLateDiscardedCount()` / `waitForIdle()`. `CyclePipelineOptions` = `{ flushIntervalMs?, delayMs?, maxConsecutiveEmptyCycles?, onCyclePersisted?(cycleId), persistCycle?(row), getNarrativeContext?(), recentCycles? }`.
- **The waiting-room guarantee:** every entry is dispatched exactly once; subject-time-coherent windows; late arrivals discard, never retro-fit into a shipped window. The DB write to `feed_entries` is for replay/hydration only.
- **`subject-time.ts`'s ordinal helpers** (`subjectOrdinal` / `subjectOrdinalForEntry` / `readClosingExtension` / `readClosingPrompt`) — used by the pipeline and by `narrative/` (a sanctioned cross-module use of a pipeline-level utility).
- **The `PipelineRegistry` narrow interface** — `getEnrichmentServices()` / `persistEnrichmentStates()` / `getSnapshots()`; `ServiceRegistry` (in [`../registry.ts`](../README.md)) satisfies it, and tests can supply a minimal double.

### Depended on
- **From `feed.ts`:** `FeedEntry`; the single-listener model (one runtime, one listener); `getAll()` (the in-memory cache, for `getNarrativeContext()`).
- **From the consumer (via `data` on entries):** `phase` + `phaseSecond` (the subject ordinal — entries without them fall through harmlessly, but then batching isn't subject-time-coherent for those); `closingExtensionSeconds` + `closingPrompt` (closing cycles).
- **From [`../registry.ts`](../README.md):** `getEnrichmentServices()`, `persistEnrichmentStates()`, `getSnapshots()` (the `PipelineRegistry` surface).
- **From [`../curation/`](../curation/README.md):** `Curator` (held; `curate(enriched, triggerReason, consumerPrompt?)` runs the tiers and — via its injected `onCurated` handler — drives generation + feedback); `RecentCyclesBuffer`; `CuratedPayload` (type, for the cycle snapshot).
- **From [`../enrichment/`](../enrichment/README.md):** the `EnrichmentService` interface + `FeedChunk` / `EnrichmentAnnotation` / `EnrichedPayload` / `ServiceSnapshot` types.
- **From `../db/`:** `feed_entries` / `pipeline_cycles` / `enrichment_service_states` (dynamic import for the cycle persist); `TriggerReason`. **From `../narrative/`:** `NarrativeOutput` (type). **From `../telemetry.js`:** `captureEvent`.

## Anti-patterns

(See [`../README.md`](../README.md) for the engine-wide list — the ones owned here:)
- **No DB resurrection for cycle batching** — entries pass through the in-memory waiting room exactly once; the `feed_entries` write is for replay/hydration only.
- **No wall-clock-keyed batching** — windows are keyed on the subject ordinal, not broadcast wall-clock arrival time.
- **No off-cadence flushes for priority entries** — `canonical: true` gets auto-emphasis / never-evicted / pulls the cycle to `action_led` *in curation*, but does not fire a flush (the closing-cycle mechanism is the one exception, and it still respects the subject-time DELAY).
- **No silent cycles** — empty cycles still run the full path; the pendulum (in curation) ensures every cycle produces something; the empty-cap is a stopping rule, not a cycle type.

## Open work

- **`subject-time.ts::PHASE_BASE` hardcodes football phase names** — `pre_match`, `first_half`, `halftime`, `second_half`, `full_time`, etc. A phase→ordinal map is a domain concept in engine code; should be per-profile metadata. Tracked: [`docs/kairos-domain-leak-open-items.md`](../../../../docs/kairos-domain-leak-open-items.md). Out of scope until a second consumer onboards.
- **The architecture doc's "phase-boundary triggers" section is stale** — it describes a `recognizePhaseTransition` / `schedulePhaseFlush` mechanism that doesn't exist; the real mechanism is the consumer-stamped `closingExtensionSeconds` marker in this module. The legacy `docs/kairos-architecture.md` carries a redirect header noting this.

## See also

- [`../README.md`](../README.md) — the four-stage pipeline, the data shapes, the anti-patterns, the module map.
- [`../registry.ts`](../README.md) — `ServiceRegistry` (this module's `PipelineRegistry` is the narrow view of it).
- [`../enrichment/README.md`](../enrichment/README.md) — Stage 2 (the enrichment services this module runs in parallel).
- [`../curation/README.md`](../curation/README.md) — Stage 3 (the `Curator` this module holds and calls); [`../narrative/README.md`](../narrative/README.md) — Stage 4 (reached via the curator's `onCurated` handler).
