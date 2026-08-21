# enrichment/ — the enrichment stage (Stage 2)

The additive stage: a set of services that each track a few *subjects* (a player, a theme, an arc, a conflict — named things they follow over time) and, per cycle, emit zero-or-more annotations for the subjects whose reading materially shifted. Enrichment never removes entries, decides priority, or judges what the passage should be about — it observes the cycle's batch and produces meaning *alongside* it. (The cycle pipeline that batches the entries and runs these services is [`../pipeline/`](../pipeline/README.md); the registry that constructs them is [`../registry.ts`](../README.md). Both used to live under this directory; they were lifted out 2026-05-11 — this module is now just the stage.)

For where this sits in the four-stage picture, the data shapes, and the anti-patterns, see [`../README.md`](../README.md). This README goes one level deeper.

## How it fits

```
   ../pipeline/  runCycle  ──▶  registry.getEnrichmentServices().map(svc => svc.process(FeedChunk))   [PARALLEL]
                                       │  each service:
                                       │    - sees only entries tagged for it (the source's enrichment_tags — the routing
                                       │      contract; there is no "active/inactive source" flag)
                                       │    - holds 3 subject-state maps: expressed / unexpressed / acknowledged
                                       │    - process(chunk): runEnrichmentLLM (Haiku) → fold each report into `unexpressed`
                                       │      → emit an annotation for every subject whose reading MATERIALLY SHIFTED
                                       │      (isMaterialShift — per-service judgement, e.g. momentum's "direction changed
                                       │      OR intensity ≥ 2 levels"; first appearance always material)
                                       ▼
                                  EnrichmentAnnotation[]  (per-service, capped at 5/cycle by the pipeline)
                                       │  { serviceName, subjectId, subjectLabel,
                                       │    meaning: { expressed, unexpressed, acknowledged, basis }, informedBy: string[] }
                                       ▼
                            ../curation/  (curator selects from these; never the other way)
                                       │  ... after generation ...
                            ../curation/  curator.sendFeedback  ──▶  svc.confirmSurfaced(CuratorFeedback)
                                       │    EMPHASIS  → expressed := unexpressed, clear acknowledged
                                       │    ACK       → acknowledged := unexpressed
                                       │    IGNORED   → no-op (state holds; unexpressed keeps accumulating)
                                       │    KILLED w/ replacement → all 3 become the replacement; w/o → unexpressed reverts to expressed
                                       ▼
                            registry.persistEnrichmentStates  ──▶  enrichment_service_states  (so a conductor restart resumes mid-broadcast)

   at activation (broadcast.ts):  svc.initializeFromBrief(briefText)  [PARALLEL, one-shot Haiku per opting-in service]
                                       → seeds subject priors into `unexpressed` before any live evidence (patterns_echoes opts out
                                         — it's purely live-evidence-driven; the base class skips brief-init when guidance is undefined)
```

The shape: enrichment is **additive and scoped** — services don't wait for each other (order-independent, parallel-safe), and meaning *compounds across cycles* (a character arc is the accumulation of past readings, not a one-shot judgement — which is why the three-state subject machinery exists). Curation is the only stage that drops anything; enrichment expresses restraint by producing *fewer annotations*, not by removing entries.

## What it does

### `base-service.ts` — `BaseEnrichmentService<TReading>`

The skeleton every enrichment service extends. Holds the three subject-state maps per service: **`expressed`** (what the audience has been told — advances on `DELIVERED_WITH_EMPHASIS`), **`unexpressed`** (the service's running truth — recomputed each cycle), **`acknowledged`** (a snapshot at a light surfacing — suppresses repeat annotations until something changes). **K6.3 contract:** subclasses pass `(spec, llm, baseline, readingSchema)` to `super()` — `baseline` is the parsed `<service>.baseline.md` (via `loadBaselineSections`), `readingSchema` is the per-service JSON schema. The constructor computes `this.mergedBaseline = mergeBaselineWithSpec(baseline, readEnrichmentSpec(spec.spec))` once; `config()` reads from it (no longer abstract — subclasses don't override). The default `process(chunk)`: short-circuit on empty chunks; call `runEnrichmentLLM` with a pre-assembled `systemPrompt` (composed via `assemblePerCycleSystemPrompt(cfg, hasBrief)`) + the known subjects + the three state snapshots + the chunk; fold each returned report into `unexpressed`; emit an annotation for every subject whose reading **materially shifted** (`shouldEmitAnnotation` → `isMaterialShift`, which subclasses override; the default is byte-equality against `acknowledged`, and a first appearance is always material). `confirmSurfaced(feedback)` applies the four curator outcomes to the three maps. `initializeFromBrief(brief)` runs the one-shot activation call (`runBriefInitialization`) — skipped when the merged baseline has no `briefInitializationGuidance` (`patterns_echoes`), when state is already hydrated from persistence, or when the brief is empty. `getKnownSubjects()` / `hydrateStates(...)` / `getExpressedStates()` etc. round out the surface.

### `llm-enrichment.ts` — the Haiku runner; `prompt-assembly.ts` + `baseline-loader.ts` + `spec-types.ts` — the K6.3 plumbing

`runEnrichmentLLM(inputs)` (per-cycle path) and `runBriefInitialization(inputs)` (activation path) both take a pre-assembled `systemPrompt: string` (K6.3 contract). They emit it as a single cached system segment, plus — when the chunk's `narrativeContext` is non-empty — an *uncached* second segment carrying the brief content (aligned with Anthropic's cache-breakpoint structure). The model must call `report_readings`, returning `{ subjectId, label, reading, basis, informedBy }` per subject — reuse ids from the known-subjects list, mint short descriptive ids for new ones, omit unchanged subjects (state holds), treat curator adjudications in `expressed`/`acknowledged` as the baseline. Uses `ENRICHMENT_MAX_TOKENS` (4096 — bumped from the shared 512 after multi-subject tool calls truncated mid-stream and the SDK returned an empty `reports` array that looked like the model declining).

The pre-assembly side:
- **`prompt-assembly.ts`** — `assemblePerCycleSystemPrompt(cfg, hasBrief)` and `assembleBriefInitializationSystemPrompt(config)` compose the cached prompt from typed fields. The shared framing prose (brief lens-not-gate reminder, per-cycle and brief-init task instructions) lives here, profile-agnostic across enrichment services.
- **`baseline-loader.ts`** — `loadBaselineSections(URL)` parses a `<service>.baseline.md` into `{ concept, subjectGuidance, readingGuidance, briefExtractionGuidance, briefInitializationGuidance? }`; `readEnrichmentSpec(jsonb)` lifts `{ serviceInstructions: string }` from the spec row (null on placeholder); `mergeBaselineWithSpec(baseline, spec)` interleaves per section by matching `## Header` (throws on drift — a header in the spec with no baseline counterpart is a content bug).
- **`spec-types.ts`** declares `EnrichmentSpecContent` (`{ serviceInstructions: string }`).

*(The section parser in `baseline-loader.ts` is currently duplicated in `curation/baseline-loader.ts` and `narrative/spec-types.ts` — a shared `prompt/sections.ts` would remove it. Minor; tracked in [`../curation/README.md`](../curation/README.md) § Open work.)*

### `types.ts` — the enrichment-side type surface

`EnrichmentReading` / `SubjectState<TReading>` / `SubjectStateMap` / `ServiceSpec` / `FeedChunk` / `EnrichmentAnnotation` / `EnrichedPayload` / `FEEDBACK_OUTCOMES` + `FeedbackOutcome` / `CuratorFeedback` / `EnrichmentService` (the interface) / `ServiceSnapshot`. This is the contract `../pipeline/`, `../curation/`, and `../registry.ts` import from — the public type surface of the enrichment stage.

### `services/` — the six concrete services

`momentum`, `tension_conflict`, `patterns_echoes`, `themes`, `character_arcs`, `character_relationships` — each ~60–85 lines of mostly prompt content. → [`services/README.md`](services/README.md) for the catalogue (concept / reading shape / materiality test / brief-init per service).

## Contract

### Provided
- **To enrichment service authors:** extend `BaseEnrichmentService<TReading>` — provide `name` (must match the `enrichmentFactories` key in [`../registry.ts`](../README.md), the `serviceName` in `service_specs`, and the event profile's `enrichment_services` list), `config()`, and optionally override `isMaterialShift` / `process`. The base class handles the LLM call, the three-state machinery, annotations, feedback, brief-init.
- **The `EnrichmentService` interface** (`types.ts`) — `process(chunk) → EnrichmentAnnotation[]`, the state getters/hydrators, `initializeFromBrief`, `confirmSurfaced`, `isReady`, `reset`. Implemented by `BaseEnrichmentService`; consumed by `../pipeline/` (runs `process`), `../registry.ts` (constructs + hydrates), `../curation/` (sends feedback).
- **The annotation contract** — `{ serviceName, subjectId, subjectLabel, meaning: { expressed, unexpressed, acknowledged, basis }, informedBy: string[] }`; `informedBy` must list the actual entry ids that justified the reading (curation's emphasis/feedback logic depends on this); ≤ 5/cycle (the pipeline caps the tail).

### Depended on
- **From [`../pipeline/`](../pipeline/README.md):** the per-cycle driver — it constructs the `FeedChunk`, runs the services in parallel, caps, persists state. A service throwing anything other than `LLMRateLimitError` is caught per-service in `runCycle` and that service contributes zero annotations for the cycle.
- **From [`../registry.ts`](../README.md):** construction (`enrichmentFactories`), subject-state hydration at startup (`enrichment_service_states`), `persistEnrichmentStates()` after every cycle, `getLastSurfacedAtMap()` / `touchSurfacedAt(serviceName)` (the per-service "last narrated" timestamps the curator's `narrative_gap` reads).
- **From [`../curation/`](../curation/README.md):** `confirmSurfaced(CuratorFeedback)` per annotation after generation — advances/locks/reverts subject state.
- **From `../llm/`:** `LLMClient.generate` (Haiku — `UTILITY_ANTHROPIC_MODEL`, `ENRICHMENT_MAX_TOKENS`).
- **From `../types.js`:** `FeedEntry`. **From `../db/enums.js`:** `ServiceType` / `SpecStatus` (via `types.ts`).

## Anti-patterns

- **Enrichment never drops entries or decides priority** — it produces fewer annotations to express restraint; curation is the only stage that removes anything from the generator's view. (See [`../README.md`](../README.md) for the engine-wide list.)
- **No "active/inactive source" gate** — a service sees an entry iff the source's `enrichment_tags` route it; tagging is the contract, full stop.
- **Subject state must survive a restart** — it lives in `enrichment_service_states` (persisted after every cycle and after the activation brief-init pass); never hold a subject only in memory.

## Open work

- **The brief-renderer is duplicated** between `llm-enrichment.ts` and `../curation/llm-curation.ts` (to dodge a `curation → enrichment` import). A shared `prompt/brief-section.ts` (or `llm/brief-section.ts`) both import would remove it. Minor; tracked in [`../curation/README.md`](../curation/README.md).
- **`character_arcs` runs silent in replay where `character_relationships` fires** — observed against captured Ipswich chunks; `scripts/enrichment-probe.ts` exists to diagnose whether it's an empty `reports` array, a malformed tool call the parser drops, or no tool use at all. Suspected: `trajectory` framed as a delta-vs-baseline rather than an absolute phase. Open investigation. → [`services/README.md`](services/README.md).
- *(The "registry placement" and "`pipeline.ts` is misplaced" items that used to live here are resolved — the registry is now `../registry.ts` and the cycle pipeline is `../pipeline/`.)*

## See also

- [`../README.md`](../README.md) — the four-stage pipeline, the data shapes, the anti-patterns, the module map.
- [`../pipeline/README.md`](../pipeline/README.md) — Stage 1 + the per-cycle driver that runs these services.
- [`../registry.ts`](../README.md) — `ServiceRegistry` (constructs + hydrates the services; also wires the curation tiers).
- [`services/README.md`](services/README.md) — the six enrichment services.
- [`../curation/README.md`](../curation/README.md) — Stage 3 (consumes the annotations, sends the feedback).
