# curation/services/ — the curation service catalogue

Eight curation services, run by the `Curator` ([`../curator.ts`](../README.md)) in **four tiers**: within a tier the services run concurrently against the same prior context (the seed's tier definition guarantees each writes a disjoint slice — `mergeTierResults` folds the parallel outputs); between tiers they run sequentially because each tier reads what the previous wrote. Seven of the eight make one Haiku call via `runCurationLLM`; `pacing` is pure arithmetic (it takes an `LLMClient` in its constructor only so the registry factory signature stays uniform — it's unused).

## The contract every service here implements

`CurationService` (`../types.ts`): `{ readonly name, readonly spec, curate(payload: EnrichedPayload, prior: CurationContext) → Promise<CurationContext>, isReady(), reset() }`.

- **`name`** matches the key in `curationFactories` (`../../registry.ts`), the `serviceName` in `service_specs`, and the entry in the event profile's `curation_service_tiers`. (Seed uses snake_case throughout: `narrative_arc`, `narrative_gap`, `saturation_resolver`, `context_curator`, `priority`, `pacing`, `conflict_resolver`, `broadcast_summary`.)
- **`curate`** returns `{ ...prior, <its writes> }` — always carry the prior forward; override only your own `decisions[name]` and the single-writer field(s) the tier assigns you. Express "remove this entry" by adding to your decision's `entriesRemoved` (the curator's `applyRemovals` consolidates and applies the canonical-never-evict guard) — never touch `selectedEntries` directly. On a bad/empty LLM tool call, return `withDecision(prior, name, "...")` (the standard no-op tag) — don't throw out of `curate` if you can help it; if you do throw, the curator catches it per-service and tags it, but the cycle continues.
- **`spec`** is the resolved `service_specs` row for this (service, profile) — all eight ship `{ placeholder: true }` today (real domain guidance is the prompts-as-content work). `narrative_arc` reads `spec.spec.expectedDurationMs` if present (falls back to 90 min).
- All eight return `isReady() === true` and a no-op `reset()` *except* `narrative_arc` (`reset` clears `committedPhase` + `previousCandidate`) and `context_curator` (`reset` clears the thread inventory + recency + the extraction-failed flag).

## The four tiers

```
Tier 1 — independent (parallel; each reads only the initial context)
  narrative_arc       judges the dramatic phase from elapsed time + the brief's anticipated shape + this cycle's annotations
  narrative_gap       flags subjects whose parent enrichment service has gone quiet ("overdue for callback")
  saturation_resolver flags annotations restating the recent window; if ALL are stale, sets forceContextLed
  context_curator     manages narrative_context (brief) usage — suppresses stale patterns_echoes echoes + surfaces fresh brief threads

Tier 2 — read tier 1 (parallel)
  priority            LLM-judged fact-level priority — emphasis (and rarely removal) of non-canonical entries; reads arcPhase + urgentSubjects
  pacing              recommendedWordCount = (wpm/60) × (cycleMs/1000) × phaseModifier — pure arithmetic; reads arcPhase + estimatedWpm + cycleIntervalMs

Tier 3
  conflict_resolver   resolves contradictions between annotations on overlapping subjects/evidence; reads priority's emphasis decision

Tier 4
  broadcast_summary   one-or-two-sentence "where the broadcast is now" — synthesises arcPhase + urgentSubjects + conflicts + emphasised entries + pacing
```

(The tier list lives in `event_profiles.curation_service_tiers` as `string[][]` — see `db/seed.ts`. Was a single sequential for-loop until 2026-04-26; the tier-merge fold is what makes the parallelism safe.)

## The eight services

| Service | Tier | Writes (besides `decisions[name]`) | What it does |
|---|---|---|---|
| **`narrative_arc`** | 1 | `arcPhase` | Decides which dramatic phase (`opening`/`rising`/`climax`/`falling`/`resolution`) the broadcast is in. Priors, in order: the writer's anticipated shape from the brief (strongest), elapsed-time position, this cycle's annotations (confirm/override only). Returns a `changeStrength` (`stable`/`tentative`/`strong`); the service *gates* the change: first commit always sticks; a candidate matching the committed phase is a no-op; `strong` commits immediately (a goal that turns the game, a red card, the whistle); `tentative` commits only if the previous cycle's candidate was the same new phase. The arc is a slow-moving structural anchor — transitions should be once or twice per broadcast, not per minute. Holds `committedPhase` + `previousCandidate` in-instance (the registry keeps the service for the broadcast's lifetime). |
| **`narrative_gap`** | 1 | `urgentSubjects` | Reads each enrichment service's `lastSurfacedAt` (from `serviceLastSurfacedAt` in the context), the elapsed time, and this cycle's annotations; flags subjects whose parent service has gone a long time (contextual — a few cycles is forever early on; later, subjects can stay dormant) without surfacing. Prefers few, clear urgencies. Stops the generator hammering the same subjects and gives the audience continuity across long stretches. `priority` reads the list. |
| **`saturation_resolver`** | 1 | `conflicts` (synthetic), `forceContextLed` | Slices the last 5 recent cycles (annotations + prose) and judges, *semantically* (not byte-equal — "West Ham 100% territory" and "West Ham at 88% dominating" are the same broad point), whether each of this cycle's annotations restates something already carried. For each saturated `(service, subject)` it appends a synthetic conflict whose `replacementReading` = the current `expressed` (or `unexpressed`) — locking the subject's state so the enrichment service's own `isMaterialShift` returns false next cycle until evidence genuinely moves. If *every* annotation is saturated, sets `forceContextLed: true` → `decideMode` pivots the cycle to `context_led` (the narrator leans on the pre-match world rather than restating stale signals). Most cycles: empty + false. No-op when there are no annotations or no history (first few cycles). |
| **`context_curator`** | 1 | `conflicts` (suppression), `relevantThreads` | Single source of truth for `narrative_context` (brief) usage. **(a) Suppression:** for each `patterns_echoes` annotation claiming a pattern echoes a brief fragment, if that fragment was already echoed within the recent window (full 30-cycle buffer), append a conflict whose `replacementReading` strips the stale fragment id (keeping any fresh ones) — kills the redundant echo (the "£262m problem"). Pure logic, no LLM. **(b) Surfacing:** at activation, `initializeFromBrief` makes a one-shot Haiku call extracting a `NarrativeThread[]` inventory from the brief (each thread = a coherent storyline + anchor snippets quoted from the brief + a rationale; 4–10 threads; persisted on `broadcasts.briefThreadInventory` so a conductor restart skips the call — `hydrateThreadInventory` loads it). Per cycle: filter the inventory by recency (a ~3-min heuristic floor — threads narrated within the window drop out, stops the LLM lifting the same thread on consecutive cycles), exclude threads anchored on fragments already cited by surviving `patterns_echoes` annotations this cycle, then ask Haiku which of the freshened pool are *alive right now* given the broadcast state + arc phase + cycle evidence (≤ 5, "a Rosenior-return thread is alive when his job is genuinely on the line, not just because Rosenior exists"). Output flows on `relevantThreads`; the generator uses it only when mode is `context_led`. Recency only updates when the cycle actually narrates from a surfaced thread (the curator's `markThreadsUsed` call, gated on mode). Replaces the older standalone `context_resonance_resolver`. *(Its activation/post-mode hooks aren't in the `CurationService` interface — see [`../README.md`](../README.md) § Open work.)* |
| **`priority`** | 2 | (only `decisions[priority]` — `entriesEmphasized`, `entriesRemoved`) | LLM-judged fact-level priority. Reads `arcPhase`, `urgentSubjects`, this cycle's annotations, this cycle's entries. Decides which **non-canonical** entries to emphasise (canonical are auto-emphasised before it runs by `buildBaselineDecisions` — it's told not to re-emphasise them). Emphasis is scarce — 0–3 extra per cycle for most cycles, up to ~20% of non-priority entries in dramatic moments; emphasising "more than 1 in 5" isn't prioritising. May also `removeEntryIds`, but the bar is high (inputs are already consumer-curated before they reach Kairos) — remove only an actively-misleading or wildly-off-arc *non-canonical* entry; empty is the common case; never list a canonical id (the curator's guard protects it anyway). The service records the decision; `applyRemovals` does the actual filtering centrally. |
| **`pacing`** | 2 | `pacing` | Deterministic arithmetic, no LLM: `recommendedWordCount = clamp(60..380, round((wpm/60) × (cycleMs/1000) × phaseModifier))`, where `wpm` = `estimatedWpm` (the state tracker's EMA of the consumer's measured TTS rate) or 150 fallback, `cycleMs` = `cycleIntervalMs` (the actual flush interval — fixing a structural bug where a hardcoded 30s prompt was out of sync with the 45s flush, so narrations underfilled the window), `phaseModifier` = `{opening: 0.85, rising: 1.0, climax: 1.2, falling: 1.0, resolution: 0.85}[arcPhase]` or 1.0. The engine prefers this over its own derivation. Replaced an LLM-judged version (~1.5s of cycle latency removed). |
| **`conflict_resolver`** | 3 | `conflicts` | Reads this cycle's annotations, `arcPhase`, and which entries `priority` emphasised; identifies cases where two annotations on overlapping subjects/evidence give contradictory readings (momentum "rising" vs tension "easing"; an actor "ascending" in `character_arcs` while "retreating" in `character_relationships`). For each: winner `(serviceName, subjectId)`, loser `(serviceName, subjectId)`, a reason, optionally a `replacementReading` for the loser's state. Most cycles: empty. The conflicts (these + saturation's + context_curator's suppression conflicts) drive the `KILLED_WITH_REPLACEMENT` feedback. |
| **`broadcast_summary`** | 4 | `summary` | Writes the one-or-two-sentence (< 60 words) "where the broadcast is right now" the generator reads at the top of its prompt — synthesises `arcPhase` + `urgentSubjects` + `conflicts` resolved + the *content* of emphasised entries + this cycle's annotations + pacing into a single legible present-tense statement, free of meta-commentary ("this cycle", "priority selected"). It's the last line of defence between raw enrichment state and the generator's prompt. *(Note: this `summary` rides on the `CurationContext` and is the cycle-level synthesis; it's distinct from the `BroadcastStateTracker`'s running summary, which is the cross-cycle narrator memory the narrative engine owns and templates. The generator's `summary` precedence: curator's per-cycle summary if present → the running summary → the previous generation's stored summary.)* |

## How it fits

The `Curator` builds the initial `CurationContext`, runs the tiers (parallel-within, sequential-between, merging after each), then `applyRemovals` → `reconcileBudget` → `decideMode` → (if `context_led`) `markThreadsUsed`, then ships the `CuratedPayload` to the generator and (post-generation) dispatches per-annotation feedback derived from the conflicts and the kept/dropped sets. See [`../README.md`](../README.md) for the full flow. **Working looks like:** per-tier wall-clock logged (`t1=…ms t2=…ms t3=…ms t4=…ms`); each service logging its action (`tier1/narrative_arc: phase: rising (held — …)`, `tier2/priority: emphasised 1, removed 0`, …); most cycles ending `mode=enrichment_led` or `action_led`, occasional `context_led`; conflicts and removals rare; the `pipeline_cycles` curation snapshot capturing `{ mode, forceContextLed, decisions, conflicts, summary, pacing, selectedEntryIds, selectedAnnotations, triggerReason }` for the inspector.

## Adding a new curation service

1. `class FooService implements CurationService` — `name`, `spec`, `curate(payload, prior)` (return `{ ...prior, decisions: { ...prior.decisions, [name]: {...} }, <any single-writer field this service owns> }`), `isReady`, `reset`. Use `runCurationLLM` for the LLM call and `withDecision` for the no-op/error path. Keep the concept domain-agnostic.
2. Register it in `../../registry.ts` (`curationFactories`).
3. Add it to the right tier in the event profile's `curation_service_tiers` (`db/seed.ts` — or a migration), being careful it reads only what earlier tiers wrote and writes a field no other service in its tier writes.
4. Ship at least one `experimental` `service_specs` row per profile that uses it.

## Open work

- **`context_curator`'s out-of-interface protocol** — its activation hooks + `markThreadsUsed` aren't part of `CurationService`; two call sites reach for it by name. Tracked in [`../README.md`](../README.md).
- **`broadcast_summary`'s `summary` vs the state tracker's running summary is an easy thing to conflate** — two different "summaries" with different lifecycles. The naming could be tighter (`cycleSummary` vs `runningSummary`). Documented here so it's at least disambiguated.
- **All eight specs are `{ placeholder: true }`** — the real per-profile domain guidance is the prompts-as-content work ([`docs/prompts-as-content-design.md`](../../../../../docs/prompts-as-content-design.md)). Until then, the concept/task guidance is hardcoded in each service file.

## See also

- [`../README.md`](../README.md) — the curator, the tiers, the merge fold, the feedback contract.
- [`../../enrichment/services/README.md`](../../enrichment/services/README.md) — the enrichment services whose annotations these consume (and whose state the feedback advances).
- [`../../narrative/README.md`](../../narrative/README.md) — Stage 4, which reads the `CuratedPayload` these produce.
- [`../../README.md`](../../README.md) — the four-stage pipeline, the data shapes, the anti-patterns.
