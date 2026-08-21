# curation/ — the subtractive stage

Stage 3. The **only** stage that drops entries from the generator's view. Enrichment is additive (services *annotate*); curation is subtractive (the curator *selects*). The shape of meaning comes from what's *not* said as much as what is — a full-payload subtractive curator is how the engine expresses restraint. The generator receives exactly `curated.entries`; nothing downstream re-filters; if you find a second authority on drops anywhere, that's drift.

For where this sits, the data shapes, and the anti-patterns, see [`../README.md`](../README.md). This README goes one level deeper.

## What it does

### `curator.ts` — the `Curator`

`curate(enriched, triggerReason, consumerPrompt?)`:

1. **Build the initial `CurationContext`** — `selectedEntries` = all of `enriched.entries`; `selectedAnnotations` = all of `enriched.annotations`; `decisions` = `buildBaselineDecisions(...)` (a `canonical_emphasis` decision auto-emphasising every `sourceCanonical` entry — the consumer's source-level flag is a fact-level priority declaration the LLM-driven `priority` service should never be asked to second-guess); `mode` = `enrichment_led` (provisional); plus the runtime state services need — `elapsedMs` and `estimatedWpm` from the state tracker, `cycleIntervalMs`, `serviceLastSurfacedAt` from the registry, `recentCycles` from the buffer.
2. **Run the tiers.** `registry.getCurationServiceTiers()` → for each tier: `Promise.all(service.curate(enriched, priorContext))` (the services in a tier run concurrently against the *same* prior context — the seed's tier definition guarantees disjoint single-writer fields), then `mergeTierResults(prior, results)` folds the parallel outputs: `decisions` union by service name, `conflicts` concat the deltas, `forceContextLed` true-wins, single-writer fields (`arcPhase`, `urgentSubjects`, `summary`, `pacing`, `selectedEntries`, `selectedAnnotations`) take any divergence (last-writer if two collide — a tier-composition bug, which the seed prevents). Tiers run sequentially because each reads what the previous wrote (`priority` needs `arcPhase` from T1; `conflict_resolver` needs `decisions.priority` from T2).
3. **`applyRemovals(context)`** — union every service's `entriesRemoved` decision, **silently drop canonical ids from the removal set** (canonical entries are state-changing facts, never noise — the guard lives here, once, so a service can't bypass it via its own decision), filter `selectedEntries` and any annotation all of whose `informedBy` ids fell out.
4. **`reconcileBudget(context)`** — if the entry set exceeds `maxContextTokens` (default 20,000 — tuned for the Anthropic plan's 30k input-tokens/min cap on Sonnet, with headroom), score entries (canonical=4 never-evicted, emphasised=3, annotated=2, plain=1; ties newest-first), evict from the bottom until it fits, drop annotations whose `informedBy` all fell out, record a `budget_reconciler` decision. The generator gets exactly the survivors; `batchEntryIds` (carried on the narrative output, not affected by this) preserves the reveal signal for evicted entries.
5. **`decideMode(context)`** — the pendulum: any emphasis from any decision ⇒ `action_led` (a canonical entry was surfaced, or `priority` emphasised something — the cycle is about the feed); else `forceContextLed` set by `saturation_resolver` (every annotation stale against the recent window — nothing fresh to say) ⇒ `context_led`; else no annotations at all ⇒ `context_led`; else ⇒ `enrichment_led`. **Silence is never an outcome** — if a phase warrants no narration, suppression happens *upstream* of curation; once curation runs, it always produces.
6. **Mark threads used** — if mode landed on `context_led` and `context_curator` surfaced `relevantThreads`, call its (duck-typed) `markThreadsUsed(threadIds)` so the recency tracker stamps them; non-context cycles leave the surfaced list "fresh" for the next opportunity. *(This reach-by-name for a service-specific method is the informal-protocol smell — see Open work.)*
7. **Assemble and hand off the `CuratedPayload`** → `{ broadcastId, entries, annotations, originalAnnotations (the full pre-filter list — feedback needs the difference), context, triggerReason, consumerPrompt, drainBoundaryOrdinal, generatedAt }` → the registered `onCurated` handler (wired in `broadcast.ts` to call `narrative.driveGeneration(curated)`).
8. **`sendFeedback(curated)`** (called by `broadcast.ts`'s handler only if generation produced output) — for each annotation in `originalAnnotations`: determine the outcome (`determinePerAnnotationOutcome`): lost a conflict ⇒ `KILLED_WITH_REPLACEMENT` (with the conflict's `replacementReading` if any); dropped from the kept set ⇒ `IGNORED`; kept and its `informedBy` informed an emphasised entry ⇒ `DELIVERED_WITH_EMPHASIS`; kept otherwise ⇒ `ACKNOWLEDGED`. Call the owning enrichment service's `confirmSurfaced(feedback)`. Then `registry.touchSurfacedAt(serviceName)` for any service that got an EMPHASIS or ACK (the "last narrated" timestamp `narrative_gap` reads). Subjects that produced no annotation this cycle get no feedback — their state holds.

### `llm-curation.ts` — the runner; `prompt-assembly.ts` + `baseline-loader.ts` + `spec-types.ts` — the K6.3 plumbing

`runCurationLLM<T>({ client, systemPrompt, toolName, readingSchema, userMessage, parseInput, narrativeContext? })` (K6.3 contract): the caller passes a pre-assembled `systemPrompt: string` and the runner emits it as a single cached system segment, plus — when `narrativeContext` is present — an *uncached* second segment carrying the brief content (aligned with Anthropic's cache-breakpoint structure). One Haiku call, parses the forced tool call through the caller's `parseInput`, returns `T | null` (null ⇒ the caller leaves the context unchanged, logs, continues). `withDecision(prior, serviceName, action)` — the standard "I noticed nothing / I bailed" decision tag, used uniformly for short-circuit and error paths.

The pre-assembly side (called by each service before `runCurationLLM`):
- **`prompt-assembly.ts::assembleCurationSystemPrompt({ concept, taskGuidance, hasBrief, briefExtractionGuidance? })`** composes the cached system prompt from typed fields. Framing prose (the "lens not gate" reminder, default brief-extraction guidance) is profile-agnostic and lives here.
- **`baseline-loader.ts`** carries `loadBaselineSections(URL)` (parses a service's `<service>.baseline.md` into `{ concept, taskGuidance, briefExtractionGuidance? }`), `readCurationSpec(jsonb)` (lifts `{ serviceInstructions: string }` from the resolved spec's jsonb, returns null on placeholder), and `mergeBaselineWithSpec(baseline, spec)` (interleaves per-section by matching `## Header`; throws on drift).
- **`spec-types.ts`** declares `CurationSpecContent` (`{ serviceInstructions: string }`).

Each curation service loads `BASELINE = loadBaselineSections(new URL('./<service>.baseline.md', import.meta.url))` once at module init; the constructor computes `this.merged = mergeBaselineWithSpec(BASELINE, readCurationSpec(spec.spec))`; `curate()` calls `assembleCurationSystemPrompt({ concept: this.merged.concept, taskGuidance: this.merged.taskGuidance, hasBrief, briefExtractionGuidance: this.merged.briefExtractionGuidance })` and hands the result to `runCurationLLM`. *(The section parser in `baseline-loader.ts` is currently duplicated in `enrichment/baseline-loader.ts` and `narrative/spec-types.ts` — small shared util's worth lifting; see Open work.)*

### `state-tracker.ts` — `BroadcastStateTracker`

Per-broadcast runtime state the curator and the narrative engine both read: elapsed time since activation (`getElapsedMs` — cadence/arc decisions); the smoothed consumer-TTS WPM estimate (`recordPacingSignal` clamps to 80–220, bounds a single sample's pull on the EMA to ≤ ~6 wpm, α=0.3; `getEstimatedWpm` — null until the first signal; this is what `pacing` and the engine size word counts against); generation history (`recordGeneration` / `getLastGeneration` / `getGenerationCount`); the latest pacing signal; the running summary (`getRunningSummary` / `setRunningSummary` — the narrator's compressed cross-cycle memory, owned and updated by the narrative engine). It reads enrichment+curation service snapshots through the registry.

### `recent-cycles.ts` — `RecentCyclesBuffer`

A bounded ring (default 30 cycles ≈ 22 min at the 45s cadence) of `{ cycleId, triggeredAt, annotations, prose }`. The pipeline appends one per completed cycle; the curator passes the list into each cycle's context. `saturation_resolver` slices the last 5 (tight restatement); `context_curator` uses the full window (long-distance stale-echo suppression). It's the fast in-memory lookup so the cross-cycle judgement services don't pay a DB round-trip per cycle (the durable record is `pipeline_cycles`).

### `services/`

The eight curation services, in their four tiers. → [`services/README.md`](services/README.md).

## How it fits

```
   ../pipeline/  runCycle  ──▶  curator.curate(EnrichedPayload, triggerReason, consumerPrompt?)
                                       │  build initial CurationContext (selectedEntries = all; decisions =
                                       │    canonical_emphasis baseline; runtime state from stateTracker + recentCycles)
                                       │  run the TIERS (registry.getCurationServiceTiers()):
                                       │    T1 ‖ narrative_arc · narrative_gap · saturation_resolver · context_curator
                                       │    T2 ‖ priority · pacing                  (read T1: arcPhase, urgentSubjects)
                                       │    T3   conflict_resolver                  (reads T2: priority's emphasis)
                                       │    T4   broadcast_summary
                                       │    — within a tier: Promise.all, same prior context → mergeTierResults; between: sequential
                                       │  applyRemovals (union entriesRemoved; CANONICAL GUARD lives here, once)
                                       │  reconcileBudget (evict lowest-priority to fit maxContextTokens; canonical never evicted)
                                       │  decideMode (any emphasis → action_led; forceContextLed → context_led; no annotations →
                                       │    context_led; else enrichment_led — NEVER silence)
                                       │  (if context_led) context_curator.markThreadsUsed(...)
                                       ▼
                                  CuratedPayload { entries, annotations, originalAnnotations, context, triggerReason,
                                                   consumerPrompt?, drainBoundaryOrdinal?, generatedAt }
                                       │
                                       ▼  onCurated handler (set by broadcast.ts)
                            ../narrative/  driveGeneration(curated)  →  NarrativeOutput | null
                                       │  if output:
                                       ▼
                            curator.sendFeedback(curated)  ──▶  ../enrichment/  svc.confirmSurfaced(CuratorFeedback)
                                       │    per ORIGINAL annotation: lost a conflict → KILLED_WITH_REPLACEMENT;
                                       │    dropped → IGNORED; kept + informed an emphasised entry → DELIVERED_WITH_EMPHASIS;
                                       │    kept otherwise → ACKNOWLEDGED.  Then registry.touchSurfacedAt(serviceName) for EMPHASIS/ACK.
```

- **Upstream:** `../pipeline/pipeline.ts::runCycle` calls `curator.curate(enriched, triggerReason, consumerPrompt?)` once per cycle.
- **Downstream:** the `onCurated` handler (set by `broadcast.ts`) calls `narrative.driveGeneration(curated)` ([`../narrative/`](../narrative/README.md)); if that returns output, `broadcast.ts` calls `curator.sendFeedback(curated)`, which loops back into the enrichment services' `confirmSurfaced`.
- **Across:** the curator and the state tracker import `ServiceRegistry` from `../registry.js` — the registry wires both stages and is a pipeline-level component despite living under `enrichment/` (Open work, tracked engine-wide). `curation/types.ts` imports `EnrichmentAnnotation` / `EnrichedPayload` / `EnrichmentReading` / `ServiceSpec` from `../enrichment/types.js` (the enrichment-side type surface is the contract; that's fine).
- **A working stage looks like:** `[curator] tier1/narrative_arc: phase: rising (held — …)`, `[curator] tier2/priority: emphasised 1, removed 0`, … then `[curator] curated: mode=enrichment_led, N entries, M/K annotations kept (trigger=accumulation)` and `[curator] feedback dispatched for K annotations (C conflicts)`. Per-tier wall-clock printed (`t1=…ms t2=…ms …`) — within-tier is parallel so a tier's duration is `max(service durations)`. Most cycles keep 2–3 annotations per service; most cycles have zero conflicts and zero removals; emphasis is scarce (0–3 extra emphasised entries beyond canonical).

## Contract

### Provided
- **To the runtime (`broadcast.ts`):** `new Curator(registry, stateTracker, recentCycles, options)`, `curator.setOnCurated(handler)`, `curator.curate(enriched, triggerReason?, consumerPrompt?)` → `CurationResult { curated, handlerResult, perServiceMs, handlerMs }`, `curator.sendFeedback(curated)`. `new BroadcastStateTracker(broadcastId, registry)`, `new RecentCyclesBuffer(capacity?)`.
- **To curation service authors:** implement `CurationService` — `{ name, spec, curate(payload, prior) → CurationContext, isReady(), reset() }`. A service receives the prior context, returns `{ ...prior, <its writes> }`. It must only write its own `decisions[name]` entry and (within a tier) only the single-writer fields the tier definition assigns it. It expresses "remove this entry" by adding to its decision's `entriesRemoved` (the curator's `applyRemovals` consolidates and applies the canonical guard) — it never mutates `selectedEntries` directly.
- **The `CuratedPayload` contract** (what the generator gets): `entries` = the final selection (curation's authoritative drop decision — never re-filter it); `annotations` = the kept subset; `originalAnnotations` = the full pre-filter list; `context.mode` = one of the three pendulum modes (never "none"); `context.pacing.recommendedWordCount` is the authority over the engine's own derivation; `consumerPrompt` is spliced verbatim (lives on the payload, not the context, because curation never reads it); `context.relevantThreads` is always emitted when a thread inventory exists — the generator acts on it only when `mode === context_led`.
- **The feedback contract:** one `CuratorFeedback` per original annotation; subjects with no annotation get no feedback. Outcomes drive the enrichment services' three-state transitions.

### Depended on
- **From `../enrichment/`:** `EnrichedPayload` (entries + annotations + narrativeContext + drainBoundaryOrdinal); the annotation shape (`meaning.expressed/unexpressed/acknowledged/basis`, `informedBy`); `ServiceRegistry` (from `../registry.ts` — services, tiers, snapshots, `getLastSurfacedAtMap`/`touchSurfacedAt`); each enrichment service's `confirmSurfaced`.
- **From `../narrative/`:** `NarrativeOutput` type (the handler's return); the `onCurated` handler is injected — curation doesn't import the engine.
- **From `../db/`:** `service_specs` (via the registry); the `pipeline_cycles` curation snapshot is built by the pipeline, not here.
- **From `../llm/`:** `LLMClient.generate` (each LLM-driven service; `pacing`'s constructor takes a client but ignores it — the calculation is pure arithmetic).
- **From `../types.ts`:** `FeedEntry`.

## Anti-patterns

- **No second authority on drops** — curation is it. (`narrative/engine.ts` once had a `generateNow` that built its own raw set from the feed and bypassed curation — retired 2026-04-26 after the closing-passage regression; the method is gone and the comment explaining why is the lock.)
- **No oldest-first eviction** — budget pressure resolves by priority (`reconcileBudget`), not age.
- **No silent cycles** — `decideMode` always returns one of three; "hold" cycles that produced no audio were a 2026-04 regression, designed out.
- **A service must not mutate `selectedEntries` directly** — express removal via `entriesRemoved`; the canonical guard lives in `applyRemovals` only.
- **A service must not write outside its lane** within a tier — the seed's tier grouping enforces disjoint single-writer fields; a collision is a tier-composition bug.

## Open work

- **`context_curator`'s protocol is informal** — it has activation hooks (`initializeFromBrief` → a `NarrativeThread[]` inventory persisted on `broadcasts.briefThreadInventory`; `hydrateThreadInventory`) and a post-mode hook (`markThreadsUsed`) that aren't part of the `CurationService` interface, and two call sites reach for them by name (`broadcast.ts` imports `ContextCurator` directly from `./services/context-curator.js`; `curator.ts` does a `getCurationServices().find(s => s.name === "context_curator")`). Either formalise a "service with hooks" interface or accept the special-casing — but it's a service-specific concern leaking across the seam today. `curator.ts` acknowledges it inline ("if more services need post-mode hooks we'll formalise it").
- **The brief-renderer is duplicated** between `llm-curation.ts` and `../enrichment/llm-enrichment.ts` to dodge a `curation → enrichment` import. A shared `prompt/brief-section.ts` (or `llm/brief-section.ts`) both import would remove the duplication. Minor.

## See also

- [`../README.md`](../README.md) — the four-stage pipeline, the data shapes, the anti-patterns.
- [`services/README.md`](services/README.md) — the eight curation services + their tier structure.
- [`../enrichment/README.md`](../enrichment/README.md) — Stage 2 (where the annotations come from) + the cycle pipeline (which calls `curate`).
- [`../narrative/README.md`](../narrative/README.md) — Stage 4 (the `onCurated` handler's target).
