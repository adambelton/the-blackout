# Kairos admin workbench — design

The admin app at `apps/kairos/client` is a **per-cycle tuning workbench**: inspect a past cycle's data, the spec version that produced it, the output it produced; iterate the spec against that cycle; publish when the eval passes and the editorial comparison confirms improvement.

This doc captures the design after several rounds of refinement on 2026-05-18. It builds on the [`prompts-as-content`](prompts-as-content-design.md) design (which defines the spec model, eval refactor, and K6.4 form-based editor) and extends it with the per-cycle inspection + tuning loop. K6.4 in its current scope is form-based editing + save-and-run-eval; this doc describes what K6.4 grows into when the workbench is actually wired up against real broadcast data.

## What's already shipped (where we start from)

- **K6.3b (PR #44, `f4f6e64`).** `apps/kairos/client` bootstrap: scaffold and auth loop. Email/password sign-in; sign-up disabled and admin users seeded via `scripts/create-user.ts`.
- **K6.3b daisyui swap (`bf5835c`).** shadcn → daisyui because the admin app is utilitarian. Per [`apps/kairos/client/CLAUDE.md`](../apps/kairos/client/CLAUDE.md): "No brand palette, no custom colours. If a design decision feels like 'let me make this pretty,' pause."
- **K6.2 prompts-as-content lifts (`#33`).** `generation` / `imagery` / `summary` specs added — three services of the `narrative` stage-type (`apps/kairos/server/src/db/enums.ts`; they began as separate enum values, consolidated into the single `narrative` type in migration `0004`). Engine reads spec content from DB via `ServiceRegistry.resolveSpec` (`apps/kairos/server/src/registry.ts:220-246`); baseline content stays in `<service>.baseline.md`. **The admin UI groups specs by these three stage-types** (`enrichment` / `curation` / `narrative`), not by service.
- **K6.3 + K6.5+ enrichment + curation lifts (`#35` + the K6.5+ sweep).** `momentum` / `tension_conflict` / `narrative_arc` lifted in K6.3; K6.5+ swept the remaining nine LLM-driven services in one editorial pass. Every LLM-driven service now resolves a v1.0.0 `active` sport-flavoured spec (16 active rows); `pacing` alone has none (pure arithmetic, no LLM).
- **K6.3a (PR #39).** `@kairos/auth` package + admin-route session middleware on `apps/kairos/server`. The admin app is issuer; `apps/kairos/server` validates admin routes against the same Better Auth tables.

The workbench is not the next pickup. It depends on prompts-as-content completing in full first (see § *Dependencies* below). When the workbench does land, it **subsumes K6.4's scope** as written in [`prompts-as-content-design.md`](prompts-as-content-design.md) § *Kairos client — the CMS*: that scope is form-based editing with eval, which the workbench delivers as part of its Spec block + Compare + Publish surface, plus the inspector layer + cycle pool + output diff on top.

## Dependencies

**Prompts-as-content per-service population (K6.5+) is complete — this prerequisite is satisfied and the workbench is unblocked.** Per [`prompts-as-content-design.md`](prompts-as-content-design.md) § *Per-service population*, each lift landed v1 profile content as a `<service>.md` under `apps/kairos/server/src/db/seed-data/sporting-event/<category>/`, with `db/seed.ts` upserting a v1.0.0 active row.

K6.3 + the K6.5+ sweep have now lifted all 16 LLM-driven services (`generation`, `imagery`, `summary`; the 6 enrichment services; the 7 LLM curation services). No service runs baseline-only any more except **`pacing`**, which has no LLM and no `.baseline.md` — see below.

**`pacing` is special** — it's a curation service that does pure arithmetic (`wpm × cycleMs / 60000 × phaseModifier`), no LLM call, no `.baseline.md`. There's nothing to split into baseline + profile content, and nothing to tune in the workbench. It appears in the curation sidebar section but with a "no spec, view-only" affordance.

**Why this is a hard prerequisite, not a soft sequencing preference:** the workbench's `resolvedSpecVersions` backfill writes one entry per service per broadcast. Services without a DB row produce no entry; the cycle-pool filter then excludes that service for those broadcasts. If K6.5+ is partial when the workbench ships, the inspector half works for all services (it renders persisted cycle data either way) but the tuning half is incomplete — some services aren't tunable, and the corpus of tuning-eligible cycles shrinks unpredictably depending on which services have rows. Cleaner to wait for full coverage.

**K6.4's form-based editor as a standalone PR is no longer needed.** Its scope — form-based per-service-type editor + promote/archive/clone + save-and-run-eval — *is* the workbench's editing surface, plus more. The infrastructure pieces it would have shipped (the PATCH state machine for `experimental → active → archived`, the eval-refactor endpoint at `POST /specs/:service/:profile/:version/eval/run`) still need to land — they ship as part of workbench Phase 2.

## The pipeline as a tuning surface

Five service types in the schema, four sidebar sections in the UI (per the user-facing taxonomy):

| Sidebar section | Schema service types | LLM? | Tunable? |
|---|---|---|---|
| Assembly | — (no spec; mechanical) | No | No — inspection only |
| Enrichment | `enrichment` (`SERVICE_TYPES`, `apps/kairos/server/src/db/enums.ts:16`) | Yes | Yes |
| Curation | `curation` | Yes (most services); one is pure arithmetic | Yes |
| Generation | `generation`, `imagery`, `summary` (three distinct schema types grouped under one UI section) | Yes | Yes |

### The dependency graph (the load-bearing facts)

The pipeline is a four-stage cascade: Assembly → Enrichment → Curation → Generation. Data flows strictly downstream — enrichment never reads curation decisions, curation never reads generation outputs.

**Enrichment runs in parallel and is broadcast, not channeled.** All enrichment services (loaded from `event_profiles.enrichmentServices`, `apps/kairos/server/src/db/schema.ts:26`) run via `Promise.all` against the same `FeedChunk` (`apps/kairos/server/src/pipeline/pipeline.ts:709-722`). Their annotations merge into a single `EnrichmentAnnotation[]`. Every downstream curation service reads the full annotation list — there's no per-curation-service routing of enrichment outputs. Today's registered enrichment services (`apps/kairos/server/src/registry.ts:34-41`): `momentum`, `tension_conflict`, `patterns_echoes`, `themes`, `character_arcs`, `character_relationships`.

**Curation runs in tiers.** Tier membership is data: `event_profiles.curationServiceTiers` is a `string[][]` (`schema.ts:31`). The orchestrator iterates tiers sequentially; within a tier, services run via `Promise.all` against the same `priorContext` (`apps/kairos/server/src/curation/curator.ts:114-140`). Each tier's outputs merge into the next tier's input via `mergeTierResults` (`curator.ts:131`). The seed's production tiers (`apps/kairos/server/src/db/seed.ts:46-51`):

```
Tier 1 (parallel, read FeedChunk + annotations):
  narrative_arc, narrative_gap, saturation_resolver, context_curator
Tier 2 (parallel, read T1 outputs: arcPhase, urgentSubjects):
  priority, pacing
Tier 3 (reads priority.entriesEmphasized):
  conflict_resolver
Tier 4 (synthesises everything):
  broadcast_summary
```

This tier structure is the only explicit data-dependency graph in the pipeline. Enrichment → curation has *no* such graph — it's all-to-all broadcast.

**Generation reads the final `CuratedPayload` as a whole.** Narrative-generation (Sonnet) and imagery (Haiku) run in parallel against the same curated payload (`apps/kairos/server/src/narrative/engine.ts`). Neither picks "which curation service's contribution" it wants — both consume the merged result.

**The implication for tuning.** Tuning a single enrichment service affects every downstream curation service uniformly. There's no way to isolate "E1's output flows into C1 but not C2." Tuning a curation service affects generation. The architecture allows **stage-bound tuning** — each service in isolation, against its real input — but not coherent chained tuning across stages.

## The version model

Three statuses (`apps/kairos/server/src/db/enums.ts:22`): `experimental → active → archived`. Schema lives in `service_specs` (`apps/kairos/server/src/db/schema.ts:36-53`):

```
service_specs
  serviceName, serviceType, eventProfileName, version,
  status,                          ← spec_status enum
  spec (jsonb), notes,
  activatedAt, archivedAt
  unique (serviceName, eventProfileName, version)
```

**Resolution precedence:** `active ?? experimental` (`registry.ts:232-234`). When loading services at broadcast activation, the registry picks the active row if present, falls back to the experimental row, skips if neither exists.

**Save** writes to the experimental row. **Publish** transitions experimental → active and (atomically) the previous active → archived, and spawns a fresh experimental row cloning the new active. The `serviceSpecs` schema already has `activatedAt` + `archivedAt` columns to record the transitions; the K6.4 PATCH endpoint handles the state machine.

### Per-broadcast version capture — the gap and the fix

The workbench's cycle-pool filter relies on **knowing which spec version each broadcast resolved to per service**. The schema today doesn't carry this:

- **`enrichment_service_states.specVersion`** (`schema.ts:193`) is written (`registry.ts:154-180`) and logged on rehydrate (`registry.ts:99-109`) but **never read in any conditional logic**. Pure dead bookkeeping — being dropped as part of this work (see *Migration* below).
- **No equivalent for curation, generation, imagery, or summary services.** Their resolved versions exist in memory on the live `ServiceRegistry` instance (built by `resolveSpec`, `registry.ts:220-246`) but are not persisted.
- **`broadcasts.specOverrides`** (`schema.ts:61`) — a `Record<string, { version: string }>` jsonb column. Defined in schema, **never read or written anywhere**. Designed as the *input* to resolution (consumer-supplied override) but the implementation never materialised, and the *output* of resolution (the actual picked versions) was never captured either.

**The fix:** replace `broadcasts.specOverrides` with **`broadcasts.resolvedSpecVersions`** — a single jsonb column capturing the full resolution outcome at activation:

```ts
// schema.ts (replaces specOverrides)
resolvedSpecVersions: jsonb("resolved_spec_versions")
  .notNull()
  .default(sql`'{}'::jsonb`)
  .$type<Record<string, string>>(),  // serviceName → version
```

`registry.initialize` (`registry.ts:75-152`) writes the map as it resolves each service — enrichment in the loop at l. 92-112, curation in the tier loop at l. 114-129, the three narrative-path specs at l. 136-138. One `update` against the broadcasts row at the end of `initialize`.

**Override and resolution are input vs output of the same decision, and they live in different columns.** Once `BroadcastConfig` is implemented as a typed shape over `broadcasts.config` (currently empty in production; see § *Out of scope for Phase 2: BroadcastConfig*), it will carry a `spec_overrides` field — the consumer's *requested* override. Resolution flow then becomes:

1. Consumer sets `broadcasts.config.spec_overrides[serviceName]` when configuring the broadcast.
2. `resolveSpec` consults `config.spec_overrides[serviceName]` first, falls back to `active ?? experimental`.
3. The picked version (whichever path produced it) is written to `resolvedSpecVersions[serviceName]`.

Audit trail: both "what the consumer asked for" and "what the engine picked" persist, in different columns, surviving any later changes to `service_specs`. The workbench's cycle-pool filter only needs `resolvedSpecVersions`:

```sql
broadcasts.resolved_spec_versions ->> '<serviceName>'
  = (SELECT version FROM service_specs
     WHERE service_name = '<serviceName>'
       AND status = 'active'
       AND event_profile_name = '<profile>')
```

The override flow (BroadcastConfig.spec_overrides → resolveSpec consult) is **future, not Phase 2** — see § *Consumer override — future*. For Phase 2, `resolveSpec` keeps its current `active ?? experimental` precedence.

**Migration.** One structural migration:

```sql
ALTER TABLE broadcasts DROP COLUMN spec_overrides;
ALTER TABLE broadcasts ADD COLUMN resolved_spec_versions jsonb NOT NULL DEFAULT '{}';
ALTER TABLE enrichment_service_states DROP COLUMN spec_version;
```

Generated via `pnpm db:generate` per root [`CLAUDE.md`](../CLAUDE.md) § *Migration discipline*. Paired with a registry code change (write `resolvedSpecVersions` at activation; stop writing `enrichmentServiceStates.specVersion`).

**Backfill** is a one-shot ops script (`apps/kairos/server/scripts/backfill-resolved-spec-versions.ts`), not part of the migration — per the rule that pure data fixes do not belong in `drizzle/`. Logic: mirror `resolveSpec`'s precedence (`active ?? experimental`) — for each service in each event profile, pick the existing row's version, build `{ serviceName → version }`, write that map to `resolvedSpecVersions` on every existing broadcasts row.

**The backfill writes full coverage for every service.** Per § *Dependencies*, prompts-as-content K6.5+ has completed by the time the workbench begins, so every service has a v1 row. There's no "no row" case to handle. And no promotion has happened yet (K6.4's state machine is part of the workbench, not before it), so each service has exactly one row — backfill picks that row's version. No archival to back-resolve against.

**One residual imprecision worth naming:** broadcasts that ran *before* a given service got its K6.5+ lift had that service running baseline-only (no spec content overlay; prompt assembled from code constants alone, per `registry.ts:144-145`'s "baseline-only assembly" log). The backfill writes the current v1.0.0 version for those broadcasts too — but the aired output for that service was actually produced by baseline-only, not by v1.0.0. The "aired output IS current-active baseline" invariant doesn't hold for those (broadcast, service) pairs. The cycle-pool filter would still include those cycles as tuning-eligible. Acceptable: small prod corpus today, the editorial mismatch surfaces as "the experimental output looks meaningfully different from the aired output even before the user edits anything" — visible but not load-bearing.

**Dropping `enrichment_service_states.specVersion` — one thing we lose:** the per-service-state version tag, which would matter if we ever wanted to invalidate persisted runtime state when a spec changes (e.g., "this expressed-state map was produced by v1.0.0 but now v2.0.0 is active and the subject labels may not be comparable"). We don't do that check today. If it becomes relevant later, the version is derivable from `resolvedSpecVersions[serviceName]` for the broadcast that owns the state row — or re-add the column.

### Out of scope for Phase 2: BroadcastConfig

**`broadcasts.config`** (`schema.ts:62`) — the `jsonb` blob that *would* hold the planned `BroadcastConfig` type (tense, imagery.enabled, narration_wpm, refrains, and — when the override workflow ships — `spec_overrides`). Read today by three locally-scoped helpers in `apps/kairos/server/src/broadcast.ts` — `readGeneratorConfig` (l. 80-82), `readImageryConfig` (l. 63-65), `readPipelineConfig` (l. 84-86) — each returning `?? {}`. **There is no `BroadcastConfig` TypeScript interface** despite docstring references throughout `narrative/`; the readers each carry their own narrow type. **Empty in production** — every Blackout broadcast runs on the engine-side defaults.

The workbench is about engine-resolved spec versions (`resolvedSpecVersions`); BroadcastConfig is consumer-supplied runtime knobs. They co-exist on `broadcasts` but answer different questions. When the `BroadcastConfig` type gets formalised and `spec_overrides` ships as a field on it, the workbench's resolution flow accommodates it cleanly — see § *Per-broadcast version capture* and § *Consumer override — future*.

## The comparison model

The load-bearing logic of the workbench. Three rounds of design discussion converged on this:

### Baseline = current-active, NOT aired-version

The version that produced cycle X's aired output may now be archived. Comparing experimental against aired risks regression — your edit could beat the archived version but lose to the current active. The publish decision is forward-looking: **is my edit better than our current best?**

### Cycle pool = broadcasts whose resolved version IS the current active

By restricting tuning input to cycles from broadcasts that ran the current-active spec, **the aired output IS the current-active baseline**. No regeneration needed. The output you see in the inspector — actual prose listeners heard — is what current-active produces for that cycle's inputs. The editorial comparison becomes:

- **Experimental output** (computed on save) vs **aired output** (already persisted, produced under current-active)

Which directly answers "is v1.5-experimental better than v1.4-active?" against an output you trust because it aired.

### Cycle pool filter, formally

For service S with current-active version A:

```
broadcasts_eligible_for_tuning(S) =
  { b : broadcast_spec_versions[b][S] == A AND b.status == 'complete' }
```

Per-service pool. Same broadcast may be eligible for narrative-generation tuning but not for priority tuning if those services have different version histories.

### Empty pool edge case

When current-active is brand new and no broadcasts have run under it yet, the cycle pool is empty. **The UI shows an empty state.** No fallback to archived versions. "If there's nothing to tune against, there's nothing to tune." The forensic ability to "go back to that one weird cycle from three publishes ago and try to fix it" is intentionally out of scope — if you've moved on from that spec version, you've already addressed whatever was weird; publishing a new version IS the fix.

### What the comparison surface shows

For service S at cycle X (both selected from the eligible pool):

- **Aired output** — already persisted on `generations.output` (`schema.ts:110`). Labelled "v1.4 (active)" since by construction the cycle's resolved version equals current active.
- **Experimental output** — computed on save by running the experimental spec against cycle X's inputs (reconstructable from the persisted cycle record: `pipeline_cycles.chunkEntries`, `annotations`, `curation`, `schema.ts:137-139`).
- **Compare dialog** — three diffs:
  - Prompt diff (markdown — current-active vs experimental spec body)
  - Eval result diff (per-criterion pass/fail — current-active vs experimental, run against in-code fixtures per [`prompts-as-content-design.md`](prompts-as-content-design.md) § *Eval criteria as spec content*)
  - Output diff (aired prose vs experimental prose)

The publish gate is **eval passes on experimental + confirmation dialog**. Editorial judgement of the output diff is human-judged; not an automated gate.

### Consumer override (opt-into-experimental) — future, not Phase 2

The eventual workflow: in-house consumers (the Blackout) opt a broadcast into running an experimental version to validate it over a full broadcast before publishing. **Out of scope for the workbench Phases 1–2.** Documented here so the design accommodates it cleanly when it lands later.

When implemented:

- The override is a `spec_overrides` field on the planned `BroadcastConfig` type, persisted in `broadcasts.config.spec_overrides` (the input — what the consumer asked for).
- `registry.resolveSpec` consults `config.spec_overrides[serviceName]` before falling back to `active ?? experimental`.
- The resolved versions (including the overridden one) land in `broadcasts.resolvedSpecVersions` (the output — what the engine picked). Both columns survive any later changes to `service_specs`, so the audit trail is preserved.
- For tuning: a broadcast that ran experimental v1.5 is **not eligible** for v1.5-experimental tuning (current active is v1.4 — pool requires match against active). After v1.5 publishes, those broadcasts *do* become eligible for v1.6-experimental tuning (v1.5 is now active, and they ran under v1.5). Override-broadcasts thus seed the tuning corpus for the next iteration cleanly.

The "validate over a full broadcast" workflow and the "iterate against individual cycles" workflow are complementary, not overlapping.

## UX shape

### Sidebar

```
Profile: [sporting_event ▾]
─────────────────────────
▾ Assembly
    pipeline-management        (read-only)
▾ Enrichment
    momentum
    tension_conflict
    patterns_echoes
    themes
    character_arcs
    character_relationships
▾ Curation
    narrative_arc              (T1)
    narrative_gap              (T1)
    saturation_resolver        (T1)
    context_curator            (T1)
    priority                   (T2)
    pacing                     (T2)
    conflict_resolver          (T3)
    broadcast_summary          (T4)
▾ Generation
    narrative                  ← (first tunable surface)
    imagery
    summary
```

Tier labels on curation services are informational — they communicate dependency order without requiring the user to read the design doc.

Archived spec versions are **never in the nav**. They appear only as clickable version labels in panel headers ("Aired under v1.4") and open a read-only modal/page when clicked.

### Right panel — tuning surface (for LLM services)

```
Generation › Narrative
─────────────────────────────────────────────────────────
Profile: sporting_event   Current active: v1.4   Experimental: v1.5-draft

Broadcast: [Brighton 3-0 Chelsea ▾]    (showing N eligible)
Cycle:     [◀ 87 of 144 ▶]

┌─ Spec ─────────────────────────────────────────────────┐
│ Prompt (markdown, textarea, font-mono)                 │
│   …                                                    │
│ Eval criteria (markdown, textarea, font-mono)          │
│   ## Eval — hard invariants                            │
│   …                                                    │
└────────────────────────────────────────────────────────┘
┌─ Cycle inspector ──────────────────────────────────────┐
│ Inputs (from cycle 87)                                 │
│   FeedChunk: <n entries>                               │
│   Annotations from upstream: <n>                       │
│   …                                                    │
│ Outputs                                                │
│   Aired (v1.4):       <prose>                          │
│   Experimental (v1.5-draft):  <prose, after Save>      │
└────────────────────────────────────────────────────────┘

[Save experimental]   [Run eval]   [Compare…]   [Publish]
                                                 ↑
                                                 gated on
                                                 passing eval
```

**Right panel — read-only inspector (Assembly + non-tunable services).** Same structure minus the Spec block; the cycle inspector shows inputs + outputs for visual inspection. Assembly's "inspector" is an ordered list of feed entries from the cycle — chronological visual check against external sources.

### Compare dialog

Three side-by-side diffs as listed above. Eval result diff renders per-fixture; failures show the offending prose alongside.

### Publish flow

1. User clicks **Publish**.
2. If eval has any hard failures on the experimental, button is disabled with reason ("eval has 2 hard failures — fix or accept and override").
3. On click of enabled button: confirmation dialog ("Publish v1.5-experimental to active? Current v1.4-active will move to archived.").
4. Confirm → `PATCH /specs/:service/:profile/:version` transitions experimental → active, atomically moves previous active → archived, spawns fresh experimental.

The "single-developer publish, just me" assumption from the user means no approval workflow, no role checks beyond admin auth, no staging environment between publish and live.

## Slicing and sequencing

**Prerequisite: prompts-as-content K6.5+ complete (see § *Dependencies*).** Then: read-only inspector + narrative-generation tuning, in that order, in two PRs.

**Phase 1 — read-only inspector across all four service types.** Direct port of the existing pipeline inspector at `apps/blackout/client/app/inspector/[broadcastId]/` (`page.tsx`, ~183 lines, plus 28 components in `components/`). Reuses `AssemblyBody`, `EnrichmentBody`, `CurationBody`, `OutputBody` as direct transplants (they're stateless renderers per the survey of 2026-05-18). Drops live-poll wiring (the workbench is past-broadcast only). Adds:
  - Sidebar with profile dropdown + 4 service-type sections, services nested. Driven by `event_profiles.enrichmentServices` + `event_profiles.curationServiceTiers` + the static `generation` / `imagery` / `summary` triplet.
  - Broadcast picker filtered to `status = complete` broadcasts (initially un-filtered by spec version — the cycle-pool filter applies once tuning lands).
  - Cycle navigation (◀/▶) within the selected broadcast.
  - Click an aired version label → read-only archived-spec modal.

**Phase 2 — narrative-generation tuning workbench.** Adds the Spec block + Run-eval + Compare + Publish to the narrative service only. Requires:
  - Schema migration: drop `broadcasts.specOverrides` + `enrichmentServiceStates.specVersion`, add `broadcasts.resolvedSpecVersions` (`jsonb not null default '{}'`). `registry.initialize` writes the map at activation; stops writing the dropped column.
  - One-shot backfill script (`apps/kairos/server/scripts/backfill-resolved-spec-versions.ts`) — writes current-active version map to every existing broadcast row.
  - Eval refactor per [`prompts-as-content-design.md`](prompts-as-content-design.md) § *Eval criteria as spec content* — hard invariants lifted into `spec.serviceInstructions`, `POST /specs/:service/:profile/:version/eval/run` runs them against in-code fixtures, returns per-fixture results.
  - "Compute experimental output" endpoint — runs the experimental spec against a specified cycle's inputs, returns the prose.
  - Cycle-pool filter on the broadcast picker — `broadcasts.resolved_spec_versions ->> '<service>' = $current_active_version`.
  - Compare dialog + publish flow.

**Phase 3+ — extend tuning to imagery, then summary, then curation services, then enrichment.** Same pattern templated out service by service. Imagery is next because it shares generation's editorial surface (the existing `manual/imagery-eval/run.ts` already exists). Curation and enrichment follow as their eval scripts get built.

The pattern from [`prompts-as-content-design.md`](prompts-as-content-design.md) § *Per-service population* applies: one PR per service initially; batch if the mechanic proves boring.

## Prerequisites

| Item | Owner | Status |
|---|---|---|
| Schema migration: drop `specOverrides` + `enrichmentServiceStates.specVersion`; add `resolvedSpecVersions` | apps/kairos/server | Not started |
| Registry writes `resolvedSpecVersions` at activation; stops writing `enrichmentServiceStates.specVersion` | apps/kairos/server | Not started |
| Backfill script — writes current-active map to every existing broadcasts row | apps/kairos/server | Not started |
| Eval refactor: hard invariants in spec body | apps/kairos/server | Designed in `prompts-as-content-design.md`; not built |
| `POST /specs/:service/:profile/:version/eval/run` | apps/kairos/server | Not started |
| `POST /specs/:service/:profile/:version/test-cycle/:cycleId` (compute experimental output) | apps/kairos/server | Not started |
| Cycle reconstruction is deterministic from `(cycle_record, spec_version)` | apps/kairos/server | Should already be true; verify when implementing |
| Inspector component port to `apps/kairos/client` | apps/kairos/client | Not started |

The first three are load-bearing for Phase 2 and land together (schema + code + backfill in one PR). The fourth and fifth are net-new endpoints on the Kairos server. The sixth is an invariant to verify, not work to do.

**Not prerequisites for Phase 2** (per § *Out of scope for Phase 2: BroadcastConfig*): override-into-experimental workflow, full `BroadcastConfig` type formalisation. Both land in their own time; the workbench doesn't depend on either.

## What we explicitly defer

- **Chained tuning across stages.** The architecture makes this incoherent: enrichment is broadcast to all curation, so "experimental E1 fed into experimental C1" doesn't make sense as an isolated chain. Each service tunes against its real input (the input it actually received in the aired broadcast).
- **Carry-forward of experimental outputs.** No `experimental_run_outputs` storage. Each service stands alone.
- **Release-set publishing.** If "publish E1 + C2 + narrative together as a coordinated change" becomes valuable, that's a separate surface (pick a set of experimental specs, regenerate end-to-end through that mix, evaluate the final narrative). Different mental model from per-service tuning. Deferred until a real use case demands it.
- **Forensic tuning against archived versions.** Cycles from old broadcasts (pre-current-active) are not eligible for tuning. Inspector half remains available for investigation; the tuning half does not.
- **Regenerating current-active output on demand + caching.** Not needed; aired output IS the baseline by construction.
- **Live tail of in-flight broadcasts.** Past-broadcast only.
- **Multi-user / role-based workflows.** Single-developer assumption (Adam).
- **Diffing between arbitrary historical versions.** Click-through to read-only archived spec is the only historical surface; no two-archived-version compare UI.

## Open questions

1. **Sidebar nesting for `generation` / `imagery` / `summary`.** Should they sit as siblings under one "Generation" parent (the user's stated taxonomy), or be three top-level sections? Either works; the user said "Generation (narrative & imagery)" but the schema also has `summary` as a distinct type. Recommendation: one parent "Generation" with three children, matches the schema-implied parent-of-narrative-path-content concept.
2. **Compare dialog mid-tuning vs. on publish.** The publish flow requires viewing the compare. Should the compare dialog auto-open when the user clicks Publish, or is "Compare" a manual step that the user is trusted to have run before publish? Recommendation: manual; the publish confirmation dialog includes a "ran compare? [link to open it]" line.
3. **Surfacing eval failures non-blocking.** A spec can be saved with failing eval (you're iterating). It just can't be published. Should failing-eval-on-save be a soft warning or invisible? Recommendation: soft warning inline ("eval has 2 hard failures") with no impedance on save.
4. **Inspector for in-flight broadcasts.** Deferred per § *What we explicitly defer*, but worth confirming the workbench Phase 1 inspector is past-broadcast only and doesn't accidentally regress the existing pipeline-inspector's live-poll capability on `apps/blackout/client`. The two surfaces are independent; this doc's inspector is a separate Next.js app.

## References

### Code (load-bearing)

- `apps/kairos/server/src/db/schema.ts` — full schema; `service_specs` (l. 36-53), `broadcasts.specOverrides` (l. 61), `pipeline_cycles` (l. 124-153), `generations` (l. 104-115), `enrichment_service_states` (l. 189-204).
- `apps/kairos/server/src/db/enums.ts:16` — `SERVICE_TYPES = ["enrichment", "curation", "generation", "imagery", "summary"]`.
- `apps/kairos/server/src/registry.ts:220-246` — `resolveSpec`, the `active ?? experimental` precedence.
- `apps/kairos/server/src/pipeline/pipeline.ts:709-722` — enrichment `Promise.all`.
- `apps/kairos/server/src/curation/curator.ts:114-140` — tier execution loop.
- `apps/kairos/server/src/db/seed.ts:46-51` — production curation tier definition.
- `apps/blackout/server/src/routes/inspector.ts` — existing inspector HTTP endpoints (`/broadcasts/:id/cycles`, `/cycles/:cycleId`, `/health`, `/generations/:generationId`).
- `apps/blackout/client/app/inspector/[broadcastId]/` — the existing inspector UI (28 components).
- `apps/kairos/server/manual/{generation,imagery,summary}-eval/run.ts` — current manual eval scripts.

### Design context

- [`prompts-as-content-design.md`](prompts-as-content-design.md) — the broader content-model design. The workbench builds on it.
- [`prompts-as-content-design.md`](prompts-as-content-design.md) § *Eval criteria as spec content* — the eval refactor this workbench depends on.
- [`prompts-as-content-design.md`](prompts-as-content-design.md) § *Kairos client — the CMS* — K6.3a/K6.3b/K6.4 sequence.
- [`kairos-architecture.md`](kairos-architecture.md) — canonical engine architecture.
- [`apps/kairos/client/CLAUDE.md`](../apps/kairos/client/CLAUDE.md) — the "utilitarian, no brand palette" rule that governs the UX.
- [`apps/kairos/client/README.md`](../apps/kairos/client/README.md) — current state of the admin app.

### History (where the design crystallised)

This doc records the design conversation from session of 2026-05-18, including:
- The retraction of "chained tuning" after surveying the actual pipeline dependency graph.
- The shift from "comparison baseline = aired" to "comparison baseline = current-active" with the cycle-pool filter falling out as a consequence.
- The empty-pool decision: empty state, no fallback to archived versions.
