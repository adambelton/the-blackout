# narrative/ — the generation stage

Stage 4. Takes the `CuratedPayload` and produces the passage: Sonnet writes the prose against the cached voice/context/task system prompt and the curated entries; Haiku, in parallel, picks the accompanying imagery; the engine then derives the reveal metadata (covers with char-offsets, the batch entry list, the monotonic content-time anchor), refreshes the running summary, persists the `generations` row, emits the `narrative` WS message, runs the post-conditions, and kicks a background Haiku call to refine the narrator's cross-cycle memory.

For where this sits, the data shapes, and the anti-patterns, see [`../README.md`](../README.md). This README goes one level deeper.

## What it does

### `engine.ts` — `NarrativeEngine`

`driveGeneration(curated)` → `run(...)`. The flow:

1. **Gather prior state** (`getPriorState`) — one query over `generations` ordered newest-first: the previous passage's prose (feeds the tone-carry preamble), the running summary (the narrator's compressed memory — from the previous generation's `contextPackage.runningSummary`, falling back to the state tracker), `sinceTimestamp` = the previous generation's `triggeredAt` (the feed boundary for `computeBatchEntries` and the `deltaMode` flag), the prior generations' prose+phase (for `formatRefrainStatus`), the previous imagery rationale (so Haiku can decide hold-vs-change). On the first cycle all of these come back empty and the engine degrades gracefully.
2. **Build the `GenerationContext`** from `curated.entries` — `entries.map(toAssembled)` ([`helpers.ts`](#helpersts) — shapes each `FeedEntry` into an `AssembledEntry` with source name, timestamp, subject-time markers (`minute`/`subjectTime`/`phase`/`phaseSecond` — see [`docs/vocabulary.md`](../../../../../docs/vocabulary.md) § Time), `parentSourceId`/`canonicalSourceId` linkage), `currentSubjectMinute` = `deriveCurrentSubjectMinute(entries)` (max numeric subject minute across entries — so a late earlier-phase entry can't pull the anchor backwards), `currentSubjectPhase`/`currentSubjectPhaseSecond` from the last entry. **No parallel feed scan** — curation is the authority on what the generator sees; the only feed-level reads are voice/context/moderator/canonical-events.
3. **Collect ambient + steering** from the feed cache — `collectVoiceText` / `collectContextText` (the `narrative_voice` / `narrative_context` entries, timestamp-ordered, joined), `collectModeratorDirectives` (every `moderator`-typed entry, chronological — these surface at the *top* of the user message as live editorial steering that applies to every passage from then on, separate from the chunk feed so curation can't evict them).
4. **Canonical events** — `allEntries.filter(e => e.sourceCanonical && e.sourceType === "event")`, *filtered by the cycle's `drainBoundaryOrdinal`* so an event whose entry has arrived in the waiting room but hasn't drained into a cycle yet doesn't appear as ground truth for prose narrating earlier content (listeners would hear the consequence before the cause). These pass to the generator as a dedicated "Canonical events" block — the antidote to running-summary drift (Haiku occasionally drops facts in compression; the raw list never does).
5. **Compute the target word count** (`computeTargetWords(pacing)`) — if curation supplied a `pacing.recommendedWordCount > 0`, that wins (PacingService already did `wpm × cycleMs × phaseModifier` against the measured consumer wpm and the actual cycle interval); otherwise the engine's own derivation (`cycleDurationSeconds × wpm × utilization / 60`, wpm = measured-or-config 150, utilization 0.8 — leaves a gap before the next flush). Plus `formatRefrainStatus` — the per-refrain usage line ("'eleven years' used 2/2 this rising — do not use again this phase").
6. **Generate, in parallel:**
 - `generate(llm, ctx, options)` ([`generator.ts`](#generatorts)) — Sonnet, forced `deliver_narrative` tool. System prompt (cached) = `# Voice` + `# Context` (the consumer's briefs, validated non-empty — `buildSystemPrompt` throws otherwise; activation should have prevented it) + `# Task` (the K6.2 prompts-as-content split — `TASK_INSTRUCTIONS_BASELINE` loaded from `generator.baseline.md` carries the profile-agnostic no-meta-commentary / no-invented-events / canonical-is-ground-truth / telemetry-is-signal-not-script / three-pendulum-modes / cite-and-anchor rules; the resolved `generation` spec's `taskInstructions` carries the per-domain elaboration; assembled section-by-section via matching `## Section` headers — see [`spec-types.ts`](#spec-typests)). User message = moderator directives + canonical-events block + running summary (framed as "compact editorial carry — canonical events are listed separately and are the ground; do not re-narrate listed events") + previous passage ("continue in its voice and tempo") + refrain status + mode preamble (uses the spec's `modeBlurbs` when present) + relevant-threads (only when `context_led`) + target words + consumer prompt + the feed context (entries sorted by content ordinal, parent/child-grouped — `match_action` event_texture rendered indented under its canonical event; orphan children render flat with the parent linkage tagged). The model returns `{ prose, covers }` with inline `{{ref:<entryId>}}` anchors in the prose.
 - `selectImagery(...)` ([`imagery.ts`](#imageryts)) — Haiku, forced `select_imagery` tool. Two steps in the prompt: articulate the image *requirement* (the visual brief, independent of the pool), then satisfy it — `pool` (pick a pre-prepared item by id from `db/content-pool.ts` — instant, no generation cost) or `generate` (write a < 40-word art-directed prompt). Avoid spoilers (the image accompanies the passage being narrated *now*), avoid repeating the previous beat. Malformed output or a pool decision with a bad id degrades to `hold` (keep the current image). The moment Haiku returns, the engine fires an `imagery_decision` WS message ahead of Sonnet so the consumer's image pipeline starts in parallel.
7. **Derive reveal metadata:**
 - `parseToolCall` (in `generator.ts`) calls `extractAnchors` ([`anchors.ts`](#anchorsts)) — strips the `{{ref:...}}` tokens from the prose (they must never reach TTS/the listener), recording each anchor's char-offset *in the stripped prose* (whitespace around stripped anchors collapsed, offsets re-mapped). `RawCover` = `{ entryId, subjectTime?, charOffset? }` — `charOffset` only set if the LLM anchored the cited entry; if it cited without anchoring, a warning logs and the cover keeps no offset (consumer falls back to audio-end reveal for it); if it anchored an id not in `covers`, a warning logs (the cover drops out).
 - `filterPhantomCovers(covers, curatedEntryIds)` — strips covers citing ids not in the curated set (the model occasionally hallucinates ids), returns `{ accepted, phantomCount }`.
 - `computeBatchEntries(allEntries, sinceTimestamp)` ([`helpers.ts`](#helpersts)) — every entry observed since the prior cycle's trigger, excluding ambient sources. This is the consumer's reveal contract: the matchroom reveals every batch entry at audio-end that the narrator didn't explicitly cite, so nothing the cycle observed is invisible. Superset of the covers.
 - `earliestSubjectMinute(batchEntries)` → `clampMonotonicMinute(..., lastEmittedContentTime)` — the earliest subject time in the batch, parsed-leading-int (`"45+2"` → 45), clamped up to the last emitted value so a late-arriving earlier-phase entry can't pull the consumer's content clock backwards. Becomes `contentTime` on the output — the cycle's **content-time anchor**. See `vocabulary.md` § Time.
8. **Refresh the running summary** — two glued blocks ([`summary.ts`](#summaryts)): the `Canonical state:` block is *templated* — regenerated from the canonical-events list every cycle, so it can never drift; the `Narrative arc:` block carries arc direction / motifs / tone / character threads, constrained to *never* touch state language (no scores, no event lists — that's the templated block's job). The state block is refreshed synchronously and glued to the *previous* cycle's narrative block → `templatedSummary`, persisted on this generation's `contextPackage` and set on the state tracker immediately (so the next cycle and any rehydrate have current state + carried-over narrative even before the Haiku refinement lands). The Haiku narrative-block refresh (`updateNarrativeBlock`) runs in the **background** off the cycle's return path (`refineSummaryInBackground` — tracked in `pendingWork` so tests can drain it; bounded by the next tick); on success it replaces the in-memory summary's narrative block, on failure the templated fallback stays.
9. **Persist + emit + check.** INSERT the `generations` row (`id` pre-generated so the early `imagery_decision` message could reference it; `contextPackage` = the full assembly snapshot — ctx entries, current minute/phase, feed window, included entry ids, `toolCallFailed`, target words, delta mode, the templated summary, the imagery, plus the `extraSnapshot` from `driveGeneration` — curated entry ids, annotation count, mode, surfaced thread ids; `output` = the prose; `wordCount`; `tokenUsage`; `durationMs`; `covers`). Build the `NarrativeOutput`. `stateTracker.recordGeneration`. Broadcast `{ type: "narrative", narrative: output }` to subscribers. `checkGenerationInvariants` ([`../invariants.ts`](../README.md) — warns on `phantom_covers` / `tool_call_failed`). `captureEvent("narration_generated")` with word count, latency, trigger, cover count, token/cache figures. Kick `refineSummaryInBackground`.
 - On `LLMRateLimitError`: broadcast `{ type: "generation_skipped", reason: "rate_limited", retryAfterMs, triggerReason }`, `captureEvent("generation_skipped")`, persist nothing, return null. On any other error: log, return null.

`destroy()` is a no-op (no timers — kept for runtime lifecycle symmetry). `drainPendingWork()` is test-facing (await the background summary refresh).

**`generateNow` is gone** — it used to bypass the curator (pull the raw feed, ambient-filter, run straight to generation). The closing-passage regression during the FA Cup SF traced to it (the closing-passage trigger flowed through it and the narrator mined uncovered earlier-half texture). The canonical path — `CyclePipeline.flush({consumerPrompt?})` → enrich → curate → generate — covers every case the bypass did. Removing the method locks the "curation is the only authority on selection" principle in; the comment explaining the removal is the lock.

### `generator.ts` + `generator.baseline.md`

`TASK_INSTRUCTIONS_BASELINE` — the in-code half of the prompts-as-content split (K6.2): loaded once at module init via `readFileSync` from the sibling `generator.baseline.md`. Profile-agnostic prose carrying the no-meta / no-invented-events / canonical-is-ground / telemetry-not-script / three-modes / cite-and-anchor rules. At assembly time, `buildSystemPrompt` merges this baseline with the resolved `generation` spec's `taskInstructions` (the per-domain elaboration — sport-flavoured worked examples for `sporting_event`) by matching `## Section` headers via [`spec-types.ts::assembleSectionedPrompt`](#spec-typests). Sections present in the spec but not the baseline throw loudly — drift between the two is a content bug. The rest of the module: the `deliver_narrative` tool schema, `generate()` (assembles system segments + user message preambles, makes the Sonnet call, parses the tool call, falls back to raw text + empty covers + `toolCallFailed: true` if the model went off-tool), `buildSystemPrompt` / `buildSystemSegments` (the cached voice+context+task block — throws on empty voice or context; takes the resolved `generationSpec` + `tense` through), `collectVoiceText` / `collectContextText` / `collectModeratorDirectives` (feed collectors), and the `format*` preamble helpers (`formatModeratorDirectives`, `formatCanonicalEvents`, `formatSummary`, `formatPreviousPassage`, `formatRefrainHint`, `formatMode` — uses `spec.modeBlurbs[mode]` when present, `formatRelevantThreads`, `formatTargetWords`, `formatConsumerPrompt`, `formatFeedContext` + `renderEntryLine`). `imagery.ts` and `summary.ts` follow the same baseline-plus-spec shape with their own `.baseline.md` siblings.

### `spec-types.ts`

The spec-content type surface for the three narrative-path services — `generation` / `imagery` / `summary`, the three services of the `narrative` stage-type (specs added K6.2; their per-service `serviceType`s consolidated into the single `narrative` type in migration `0004`): `GenerationSpecContent` (`taskInstructions: string` + `modeBlurbs: { action_led, enrichment_led, context_led: string }`), `ImagerySpecContent` (`imageryInstructions: string`), `SummarySpecContent` (`summaryInstructions: string`). Plus `assembleSectionedPrompt(baseline, profileContent)` — the section-by-section merger: splits both inputs on `## Header` lines, appends profile body to baseline body per matching header, throws if the spec has a header the baseline doesn't carry (header drift = content bug). The same shape is used downstream by `enrichment/baseline-loader.ts` and `curation/baseline-loader.ts` for the K6.3 per-service lifts.

### `helpers.ts`

Pure functions on a single `FeedEntry`'s `data` — `getContent`, `getMinute`/`getExtraMinute`/`getSubjectTime`/`getSubjectPhase`/`getSubjectPhaseSecond` (subject-time accessors), `getSubjectMinute` (fallback: parse the numeric prefix of `subjectTime` when there's no typed `minute` — supplies the narrator's subject-time anchor), `formatMinute` — plus the set-level derivations `deriveCurrentSubjectMinute` (max subject minute across entries), `earliestSubjectMinute` (min parsed-leading-int across entries — the cycle's content-time anchor), `clampMonotonicMinute` (clamp the content minute up to a floor), `computeBatchEntries` (everything since `sinceTimestamp`, excluding ambient), and `toAssembled` (`FeedEntry` → `AssembledEntry`).
### `imagery.ts`

`selectImagery(opts)` — the parallel Haiku imagery selector over the content pool. `IMAGERY_INSTRUCTIONS` (the two-step prompt — articulate the requirement, then pool-or-generate; spoiler discipline; anti-repetition; another prompts-as-content lift candidate), the `select_imagery` tool, `ImagerySelection` (`decision: pool|generate|hold`, `requirement?`, `prompt?` (generate), `poolItemId?` + `matchedPoolItem?` (a denormalised `{id, prompt, tags}` snapshot at decision time — survives later edits/deletes of the pool item) + `consumerMetadata?` (pool), `rationale?`). Degrades to `hold` on any malformed/ambiguous output.

### `anchors.ts`

`extractAnchors(text)` → `{ stripped, anchors: [{ entryId, charOffset }] }`. LLMs can't count characters but can place inline tokens at natural positions; this module does the counting. Strips `{{ref:<id>}}` (id captured permissively — not assumed UUID), records each anchor's offset in the *stripped* output, collapses whitespace that opened around stripped anchors and re-maps the offsets. The consumer turns `charOffset / prose.length × audioDurationMs` into a reveal time.

### `refrain.ts`

`formatRefrainStatus(budgets, priors, currentSubjectPhase)` — counts each designated refrain phrase's occurrences across the prior generations (total + within the current phase), renders a usage line per refrain (an explicit "do not use again this phase/broadcast" when over budget; raw "used N so far" when no budget set). Empty when no refrains are configured or none have been used yet. `RefrainBudget` = `{ phrase, maxPerPhase?, maxTotal? }`, consumer-supplied via `broadcast.config.generator.refrains` (a narrator voice brief typically names a handful of motifs the voice leans on).

### `summary.ts`

`formatStateBlock(events)` — the templated `Canonical state:` block (`[subjectTime'] content` lines from the canonical entries, timestamp-ordered; empty before kickoff). `assembleRunningSummary(stateBlock, narrativeBlock)` — glue the two with their headers, skipping empties. `extractNarrativeBlock(summary)` — pull just the narrative-arc text out (so the next cycle's Haiku update call sees only the narrative carry-over, not the templated state it has no authority over). `updateNarrativeBlock({ client, previousNarrative, justNarrated, newEntries })` — the background Haiku call: produce a < 100-word note covering *only* arc direction / motifs / tone / character threads — never the score, never event lists, never "X scored" (the templated block's job), never meta-commentary, never invention. Failure degrades gracefully (the caller carries the previous block forward).

### `types.ts`

`AssembledEntry` (a feed entry as the prompt renders it), `GenerationContext` (what `generate` receives), `NarrativeCover` (`{ entryId, subjectTime?, charOffset? }`), `NarrativeImagery` (the imagery decision attached to the passage — `pool`/`generate`/`hold` + the relevant fields), `NarrativeOutput` (what the engine produces and emits).

## How it fits

```
 ../curation/ onCurated handler (set by broadcast.ts) ──▶ engine.driveGeneration(CuratedPayload) → run(...)
 │
 ▼
 getPriorState() ── one query over `generations` (newest-first): prev passage prose · runningSummary · sinceTimestamp
 (the feed boundary + deltaMode flag) · prior generations (for refrains) · prev imagery rationale
 │
 build GenerationContext from curated.entries (toAssembled — markers + parent/child linkage; deriveCurrentSubjectMinute)
 collect from the feed cache: narrative_voice · narrative_context · moderator directives (top-of-prompt steering)
 canonicalEvents = feed entries where sourceCanonical && type==="event", filtered by drainBoundaryOrdinal (no leak-forward)
 computeTargetWords(pacing) ── curated pacing wins; else engine derivation formatRefrainStatus(...)
 │
 ┌───────────────┴───────────────┐ PARALLEL
 ▼ generate(llm, ctx, options) ▼ selectImagery(...) [Haiku]
 Sonnet, forced `deliver_narrative` pool / generate / hold ──▶ fan an `imagery_decision` WS msg the moment
 tool. cached system = Voice + it returns (AHEAD of Sonnet) so the consumer's image pipeline starts in
 Context + TASK_INSTRUCTIONS; parallel. malformed / bad-id ⇒ `hold`.
 user msg = moderator directives +
 canonical-events block + running
 summary + previous passage +
 refrains + mode + relevantThreads
 (iff context_led) + targetWords +
 consumerPrompt + the feed entries
 (content-ordinal sorted, parent/
 child grouped). → { prose w/ {{ref:…}} anchors, covers }
 └───────────────┬───────────────┘
 ▼ derive reveal metadata:
 parseToolCall → extractAnchors (strip {{ref:…}}, record charOffsets in the stripped prose) ── anchors.ts
 filterPhantomCovers(covers, curatedEntryIds) → { accepted, phantomCount }
 computeBatchEntries(allEntries, sinceTimestamp) → batchEntryIds (everything the cycle observed; ⊇ covers) ── helpers.ts
 earliestSubjectMinute(batch) → clampMonotonicMinute(..., lastEmittedContentTime) → contentTime (content-time anchor, monotonic)
 refresh running summary: templated `Canonical state:` block (regenerated from canonicalEvents — can't drift)
 + previous cycle's `Narrative arc:` block ── summary.ts ; setRunningSummary
 ▼
 INSERT generations row (contextPackage = the assembly snapshot) → NarrativeOutput
 stateTracker.recordGeneration · fanOut { type: "narrative", narrative } · checkGenerationInvariants (../invariants.ts)
 · captureEvent("narration_generated") · kick refineSummaryInBackground (Haiku → updateNarrativeBlock → setRunningSummary)
 on LLMRateLimitError ⇒ fanOut { type: "generation_skipped" }, persist nothing, return null.
```

- **Upstream:** the curator's `onCurated` handler (set by `broadcast.ts`) calls `narrative.driveGeneration(curated)`. The engine doesn't import the curator — the handler is injected; the engine takes `Feed`, the subscriber `Set`, an `LLMClient`, and the `BroadcastStateTracker` in its constructor.
- **Downstream:** writes the `generations` row (`db/`), reads the `content_pool_items` (`db/content-pool.ts` via `listPoolItems`), emits `imagery_decision` / `narrative` / `generation_skipped` to the subscriber set (the same set `ws/feed.ts` registers sockets into). Reads broadcast-level state from the feed cache (voice/context/moderator/canonical). Calls `checkGenerationInvariants` (`../invariants.ts`) and `captureEvent` (`../telemetry.ts`). Imports `subjectOrdinalForEntry` from `../pipeline/subject-time.ts` (for the `drainBoundaryOrdinal` filter on canonical events) and `subjectOrdinal` (for the prompt's content-time sort) — and `CuratedPayload` / `CurationMode` types from `../curation/types.ts`. (Those cross-module reaches are at the type/pure-helper level — the `subject-time.ts` ordinal helpers are arguably pipeline-level utilities; fine.)
- **A working stage looks like:** `[narrative] generated <id> (…in/…out [cache: … read / … write], Nw target=Mw(pacing), delta(K), …covers, trigger=accumulation): <first 80 chars>…`. Cache reads dominate after cycle 1 (the voice+context+task system block is cached). The `imagery_decision` WS message lands before the `narrative` one. No `[narrative] dropped … phantom cover id(s)` / no `deliver_narrative tool was not invoked` warnings (occasional are tolerated; a run of them is a regression). The running summary's `Canonical state:` block always reflecting the current canonical events; the `Narrative arc:` block never naming a score or an event. `contentTime` (the content-time anchor) non-decreasing across cycles.

## Contract

### Provided
- **To the runtime / curator:** `new NarrativeEngine(broadcastId, feed, subscribers, llm, stateTracker, options)`; `engine.driveGeneration(curated) → Promise<NarrativeOutput | null>` (null = rate-limited or errored); `engine.destroy()`; `engine.drainPendingWork()` (tests). `options` = `{ cycleDurationMs?, narrationWpm?, utilization?, refrains? }` (all from `broadcast.config.generator`, plus `cycleDurationMs` = the pipeline's flush interval).
- **The `NarrativeOutput` / `narrative` WS contract** (what the consumer gets): `text` (the stripped prose, ready for TTS — no `{{ref}}` tokens, no meta-commentary), `covers` (a strict subset of `curated.entries` the prose actually cited, each with an optional `charOffset` into the prose — fire the per-entry reveal at `charOffset/text.length × audioDurationMs`), `batchEntryIds` (everything the cycle observed, superset of covers — reveal the uncited ones at audio-end), `contentTime` (the cycle's **content-time anchor** — earliest subject time in the batch, parsed-leading-int, monotonic — drive the consumer's content clock from this), `imagery` (advisory: `pool` → `poolItemId` + `consumerMetadata` (resolve your own bytes); `generate` → `prompt` (run your image provider); `hold` → keep the current image; if `imagery` is absent, hold). `imagery_decision` is the same decision emitted early so the image pipeline can start in parallel with Sonnet.
- **The prose contract** (`TASK_INSTRUCTIONS`): the prose stands on its own as story; never describes the time span it covers or narrates its own act; never refers to the commentary apparatus ("the feed shows", "the booth says"); never invents a state-changing event the feed didn't report (and the canonical-events block, when it conflicts with the running summary, wins); telemetry numerals don't appear in the prose; a reportable event is the passage's centre of gravity; the cited entries are in `covers` and anchored inline.

### Depended on
- **From `../curation/`:** `CuratedPayload` — `entries` (the *only* cycle material the generator sees), `annotations`, `context.mode` (the pendulum mode → the mode preamble + whether `relevantThreads` is used), `context.summary` (the cycle-level summary, highest precedence for the prompt's "broadcast memory"), `context.relevantThreads` (used iff `context_led`), `context.pacing` (`recommendedWordCount` is the word-target authority), `consumerPrompt` (spliced verbatim), `drainBoundaryOrdinal` (the canonical-events filter horizon), `triggerReason`.
- **From `feed.ts`:** the in-memory cache (`getAll()`) — voice, context, moderator, canonical-events reads; the entry shape.
- **From `../curation/state-tracker.ts`:** `getEstimatedWpm()` (word target), `getRunningSummary()` / `setRunningSummary()` (the cross-cycle memory), `recordGeneration(...)`.
- **From the consumer (via `data` on entries):** `phase` / `phaseSecond` (the subject ordinal for the prompt sort + the canonical filter — see `vocabulary.md` § Time), `subjectTime` (the subject-time marker on the entry; surfaces in covers; feeds `contentTime`), `sourceId` / `parentSourceId` (parent/child grouping in the prompt). The generator is robust to all of these being absent.
- **From `../db/`:** the `generations` table (write + the prior-state read), `content_pool_items` (read).
- **From `../llm/`:** `LLMClient.generate`; `LLMRateLimitError` (the one error the engine handles specially → `generation_skipped`).

## Anti-patterns

- **No feed context passed directly to the generator** — the cycle material is `curated.entries`, full stop. The feed-level reads (voice, context, canonical events) are explicitly *not* per-cycle selections.
- **No curator bypass** — `generateNow` is gone; the comment explaining why is the lock. Any path that builds the generator's entry set from the raw feed instead of from a `CuratedPayload` is the regression that produced the FA Cup SF post-FT passage.
- **No fact preservation through Haiku** — state (scores, events) lives in the *templated* `Canonical state:` block, not in the Haiku-produced narrative block. Putting deterministic events through Haiku compression dropped the Haaland goal from the summary at cycle 6, 2026-04-22; the split makes that class of bug structurally impossible.
- **No `{{ref}}` tokens reaching the listener** — `extractAnchors` strips them before the prose leaves the engine; the offsets travel on the covers list.

## Open work

- **`TASK_INSTRUCTIONS` (`generator.ts`), `IMAGERY_INSTRUCTIONS` (`imagery.ts`), and the per-mode `formatMode` fragments are hardcoded engine code** — the prompts-as-content work lifts them into versioned **`generation` + `imagery` service specs** (new `service_specs` `serviceType` values, resolved at activation like the enrichment/curation specs; `event_profiles` stays content-free), and wires `BroadcastConfig.generator.tense` in as a config-derived prompt segment (+ a new `imagery.enabled` short-circuit). `buildSystemPrompt` / `buildImageryPrompt` will read the resolved spec instead of these module constants; the constants are then deleted, their text living in a domain-pack seed file. → [`docs/prompts-as-content-design.md`](../../../../../docs/prompts-as-content-design.md). Tracked engine-wide in [`../README.md`](../README.md).
- **`broadcast_summary`'s `context.summary` vs the state tracker's running summary** — two "summaries" with different lifecycles, easy to conflate; the generator's `formatSummary` precedence (`context.summary` → running summary → previous generation's stored summary) is correct but under-documented in code. Disambiguated in [`../curation/services/README.md`](../curation/services/README.md).
- **Imagery hot-path: `listPoolItems` per cycle.** Cheap today (30s cadence × O(50) items), noted in code as easy to cache if the pool grows.

## See also

- [`../README.md`](../README.md) — the four-stage pipeline, the data shapes, the anti-patterns.
- [`../curation/README.md`](../curation/README.md) — Stage 3, which produces the `CuratedPayload` this stage consumes (via the injected `onCurated` handler).
- [`../db/README.md`](../db/README.md) — the `generations` and `content_pool_items` tables.
- [`../llm/README.md`](../llm/README.md) — the provider-neutral LLM contract; the model defaults (Sonnet for `generate`, Haiku for imagery + summary).
- [`../ws/README.md`](../ws/README.md) — the feed WS that carries `imagery_decision` / `narrative` / `generation_skipped` to the consumer.
