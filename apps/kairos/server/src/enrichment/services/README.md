# enrichment/services/ — the enrichment service catalogue

Six concrete enrichment services. Each is a subclass of `BaseEnrichmentService<TReading>` ([`../base-service.ts`](../README.md)) that fills in one thing: the *concept* it tracks, the *shape* of a per-subject reading, and the *materiality test* for when a reading has moved enough to be worth re-narrating. Everything else — the Haiku call, the three-state subject machinery, the annotation emission, the curator feedback, the brief-init pass — is the base class. A service file is small (~60–85 lines) and almost entirely prompt content.

## The contract every service here implements

A `BaseEnrichmentService` subclass provides:

- **`readonly name`** — must match the key in `enrichmentFactories` (`../registry.ts`) *and* the `serviceName` in `service_specs` *and* the entry in the event profile's `enrichment_services` list. The seed (`db/seed.ts`) uses snake_case (`tension_conflict`, `patterns_echoes`, `character_arcs`, `character_relationships`); the service `name` fields match.
- **`config()`** → `{ concept, subjectGuidance, readingGuidance, readingSchema, briefExtractionGuidance, briefInitializationGuidance? }`. The `concept` / `subjectGuidance` / `readingGuidance` are written in **domain-agnostic terms** — "narrative energy", "opposing forces and stakes", "an actor's trajectory" — never football. `readingSchema` is the JSON Schema for the `reading` payload the LLM returns. `briefExtractionGuidance` tells the per-cycle Haiku call what to lift from the writer's brief through this service's lens. `briefInitializationGuidance` (optional) tells the one-shot activation call what priors to seed; omitting it makes brief-init a no-op for this service.
- **`isMaterialShift(prior, candidate)`** (override) — the concept-specific judgement. The base default is byte-equality against the last `acknowledged` reading; each service narrows it to its structured fields so text drift on stable structure isn't re-narrated.

The LLM is told: reuse subject ids from the known-subjects list when a subject recurs; mint short descriptive ids (`subj-<something>`) for genuinely new ones; omit subjects whose reading is unchanged (their state holds); treat anything in `expressed`/`acknowledged` that the curator set (an adjudication overruling a previous reading) as the baseline and only revisit on a qualitative change in evidence.

## The six services

| Service (`name`) | Concept | Reading shape | Material when… | Brief-init? |
|---|---|---|---|---|
| **`momentum`** | Rate + direction of change in narrative energy — is something building, holding, fading? | `{ direction: rising\|stable\|falling, intensity: dormant\|low\|moderate\|high\|peak }` | Direction changes, OR intensity moves ≥ 2 levels. (One step within the same direction is drift, not a shift.) | Yes — 1–3 subjects, usually "stable" at kickoff. |
| **`tension_conflict`** | Pressure between opposing forces and the stakes that make their collision matter. | `{ poles: string[], stake: string, level: low\|moderate\|high\|critical, trajectory: escalating\|easing\|holding }` | Level changes category, OR trajectory inverts, OR identity (poles or stake) shifts. (The same conflict grinding on at the same level isn't material.) | Yes — 2–5 conflicts, usually "holding" at kickoff. |
| **`patterns_echoes`** | Recurrences across the broadcast — motifs that return, callbacks, rhythms. Two kinds: *emergent* (live evidence surfaces the same shape twice) and *echoes* (live evidence resonates with something the writer named in the brief — the brief mention is instance 1, the live touch is instance 2). | `{ description: string, occurrences: int, weight: low\|moderate\|high, echoesContextEntryIds?: string[] }` — `echoesContextEntryIds` lists the `[id:…]` brief fragments this echoes (empty for emergent patterns); the curator's `context_curator` reads it to suppress over-echoed fragments. | Occurrences advance (a new instance IS the news), OR weight changes category, OR the set of echoed fragments changes. | **No** — purely live-evidence-driven; the base class skips brief-init when `briefInitializationGuidance` is undefined. |
| **`themes`** | The meaning the broadcast carries — what the story is *about* beneath the events. Themes move slowly: emerge → established → fade. | `{ description: string, weight: low\|moderate\|high, status: emerging\|established\|fading }` | Status transitions, OR weight changes category. (Description text drift on stable status+weight isn't material.) | Yes — 2–5 themes, usually "emerging", weight low/moderate. |
| **`character_arcs`** | An actor's trajectory through the narrative — role, stake, current state. One subject per actor. (Collectives/crowds/teams belong in `character_relationships` (as a pair) or `momentum` (as the overall scene), not here.) | `{ role: string, trajectory: ascending\|descending\|pivoting\|holding, stakePosition: low\|moderate\|high, currentState: string }` | Role, trajectory, or stakePosition changes. (currentState text drift alone isn't material.) | Yes — 3–6 actors. |
| **`character_relationships`** | The dynamic between two actors — a pair is the subject (ordered alphabetically by label so the same pair always hashes to the same id; three-way dynamics decompose into pairwise). | `{ parties: [string, string], dynamic: adversarial\|allied\|complex\|wary, charge: low\|moderate\|high, currentState: string }` | dynamic, charge, or the parties identity changes. (currentState text drift alone isn't material.) | Yes — 2–5 pairs. |

## How it fits

The pipeline (`../../pipeline/pipeline.ts::runCycle`) runs all six in parallel against the `FeedChunk`, times each, caps each at 5 annotations/cycle, and merges. A service only sees entries tagged for it via the source's `enrichment_tags` (the routing contract — there's no active/inactive flag). After curation, the curator dispatches per-annotation feedback (`IGNORED` / `ACKNOWLEDGED` / `DELIVERED_WITH_EMPHASIS` / `KILLED_WITH_REPLACEMENT`) back to each service's `confirmSurfaced`, which advances/snapshots/reverts the subject's three readings. Subject state persists to `enrichment_service_states` after every cycle (and after the activation brief-init pass) so a conductor restart resumes mid-broadcast.

**Working looks like:** annotations appearing on cycles where something genuinely moved, *not* every cycle (the materiality tests are the throttle); subject ids stable across cycles for recurring subjects; the curator's saturation/conflict feedback actually quieting subjects that have been over-narrated (a `KILLED_WITH_REPLACEMENT` should stop a subject re-firing until evidence qualitatively changes).

## Adding a new enrichment service

1. `class FooService extends BaseEnrichmentService<FooReading>` with `name`, `config()`, and an `isMaterialShift` override. Keep the concept domain-agnostic.
2. Register it in `../registry.ts` (`enrichmentFactories`).
3. Add `name` to the event profile's `enrichment_services` (in `db/seed.ts` — or a migration) and ship at least one `experimental` `service_specs` row per profile that uses it.
4. Sources that should feed it get `name` in their `enrichment_tags`.

## Open work

- **`character_arcs` runs silent in replay where `character_relationships` fires** — observed against captured Ipswich chunks; `scripts/enrichment-probe.ts` exists to diagnose whether it's an empty `reports` array, a malformed tool call the parser drops, or no tool use at all. Suspected cause: `trajectory` framed as a delta-vs-baseline rather than an absolute phase makes the model reluctant to report. Open investigation.
- **The `subj-<descriptive>` id convention is LLM-honour-system, not enforced** — the prompt asks for it; nothing validates it. A model that mints unstable ids fragments a subject's history. Hasn't bitten in practice; worth a validator if it does.

## See also

- [`../README.md`](../README.md) — the enrichment stage + the `BaseEnrichmentService` machinery + the cycle pipeline.
- [`../../curation/services/README.md`](../../curation/services/README.md) — the curation services that consume these annotations.
- [`../../README.md`](../../README.md) — the four-stage pipeline, the data shapes, the anti-patterns.
