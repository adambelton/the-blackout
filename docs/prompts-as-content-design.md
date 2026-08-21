# Prompts as content — design

**Status:** design finalised 2026-05-12; PR sequence + Kairos auth model agreed 2026-05-14 (§ *Auth — mirroring `@blackout/auth`* + § *PR sequence* below). Sequenced behind the audit P0s (`docs/codebase-audit-2026-05-10.md` § *Suggested sequence*).

## Goal

Two related moves, one body of work:

1. **Kairos side — split every prompt into baseline (code) + profile content (DB).** Today's hard-coded prompt strings (`TASK_INSTRUCTIONS`, `IMAGERY_INSTRUCTIONS`, the per-mode `formatMode` blurbs, every enrichment and curation service's prompt blocks) mix two distinct concerns: **structural rules + machine contracts** that apply to *any* consumer (the **baseline** — profile-agnostic), and **consumer-category-specific elaboration** that turns those rules into something concrete for one use-case (the **profile content** — for the `sporting_event` profile: the sport-specific worked examples, "goals are the most important canonical event", "telemetry numerals never appear in prose", etc.). Lift the profile content into versioned `service_specs` rows; keep the baseline in code. Tuning Kairos for a consumer category becomes a content edit on the admin UI, and a second category (`political_debate`, …) slots in with profile content only, no engine edits.

2. **Blackout side — make "how the Blackout uses Kairos" a reusable template, not per-broadcast config.** Which `event_profile`, which sources and their enrichment tags, the pacing/tense/generator settings, the default voice — that bundle is stable across broadcasts of the same kind. Today it's hand-assembled into the `POST /broadcasts` payload every time. It should be a Blackout-side **broadcast template** that compiles down to that payload.

This document scopes the prompts-as-content design for Kairos.

## The layered model — the spine of everything here

Every LLM touchpoint in the system decomposes into the same layers. Getting a piece of content into the right layer is the whole design.

| Layer | The question it answers | Owner | Where it lives | Versioning |
|---|---|---|---|---|
| **1 — infrastructure** | *What does this thing do, generically?* Pipeline mechanics; how a service runs; **the structural rules and machine contracts of each prompt** — tool schemas, output contracts, the mode taxonomy, the canonical-events-as-first-class rule, every rule that applies equally across any consumer category. | Kairos, in code | `apps/kairos/server/src/**` — never mentions football or any specific consumer | Feature flags during dev, then wide release (K13) |
| **2 — profile content** | *What does it do for a **specific consumer category** (e.g. a sporting event)?* The profile-specific elaboration that layers on top of the baseline — worked examples, emphasis, how each baseline rule applies here ("goals are the most important canonical event"; "render the texture of pressure, not the metric"). Per-service tuning lives here. | Kairos, in its DB | **service specs** — `service_specs` rows: enrichment specs, curation specs, and (this work) `generation` + `imagery` specs | `experimental → active → archived` per spec (K7); already built — the `service_specs.status` enum, the registry's `override → active → experimental` resolution, `POST /specs/:service/:profile/:version/promote` |
| **3 — user content** | *What's the story of **this** broadcast?* | the consumer (Blackout), per broadcast | the `narrative_context` entry (the match brief) and the `narrative_voice` entry, pushed at activation; plus the live source data | n/a — content, supplied each time |
| **(control surface) — user config** | *consumer-controlled knobs for this broadcast* (tense, pacing buffers, token cap, model, experimental-spec opt-ins, imagery on/off) | the consumer | `BroadcastConfig` (`broadcasts.config` jsonb on the Kairos side). **On the Blackout side, authored per *template*, not per broadcast** — see § *Blackout side*. | n/a — *not* platform content; significance thresholds / signal weighting belong in profile content, not config |

The `event_profile` is the **manifest** for which services exist for a category, in what curation tiers, and (implicitly) resolves one `generation` spec and one `imagery` spec. It holds **no content itself** — decision K5: "profiles are stable groupings of service types; the content that evolves is the specs, not the profile definition."

## What changed from the 2026-05-10 draft

1. **Prompt content splits into two layers, not one.** The 2026-05-10 framing implied all prompt content moves into the DB. The sharper framing: *structural rules + machine contracts* stay in code (baseline — profile-agnostic, applies to every consumer); *profile-specific elaboration* moves to the DB. A prompt assembled at runtime is `baseline + profile content` concatenated.
2. **Generator-level content does *not* live on `event_profiles.system_prompt_content`.** That column idea contradicted K5 (profiles are content-free groupings). Instead, `generation` and `imagery` become **service-spec types**, versioned like every other spec.
3. **The "spec versioning" model is the already-documented K7** (`experimental → active → archived`). We don't keep `v1/v2/v3` around forever; broadcasts are short-lived. Beta-testing a spec = land it `experimental`, run a broadcast with `spec_overrides` pinning it, then `promote` it to `active`.
4. **`BroadcastConfig` is per-broadcast at the Kairos API, but per-*template* in the Blackout's authoring model.** Kairos can't know the consumer has templates (K9); it receives `event_profile` + `config` + `sources[]` + entries each broadcast. The template is purely a Blackout-side payload-assembly convenience.
5. **DB is canonical for profile content; no domain-pack files.** The earlier draft proposed a domain-pack file structure where seed reads from `apps/kairos/server/src/<service>/specs/sporting_event/<spec>.ts`. Dropped: the DB is the source of truth, the **migration SQL is the one-shot v1 carrier**, and subsequent versions are authored in the admin UI (`apps/kairos/client`). No file → DB mirror to maintain.
6. **The lift is editorial, not mechanical.** Today's prompts mix baseline and profile content within paragraphs and sentences; clean separation requires rewriting. End-quality matters more than byte-equality with today's prompt. Quality is verified by a manual / eval pass on the lifted output, not a byte-identical snapshot against the pre-lift assembly.

## Current state — what's hard-coded, and how it splits

| Symbol | File | Baseline (stays in code) | Profile content (moves to `sporting_event` spec) |
|---|---|---|---|
| `TASK_INSTRUCTIONS` | `apps/kairos/server/src/narrative/generator.ts` | The `deliver_narrative` tool schema; "always call the tool"; the `covers` + `{{ref:<entryId>}}` anchor mechanics; the three-mode names as infrastructure; the structural rules — *the feed is your observation*, *time markers must be grounded*, *the feed is canon — do not invent state-changing events*, *the canonical events list is ground truth*, *telemetry is signal, not script*, *reportable events anchor the passage* — expressed without the sport-flavoured worked examples. | The sport-flavoured elaborations: the specific apparatus list ("commentary booth", "radio commentators"), specific time examples ("47+2"), the worked telemetry example ("67% territory" → "camped in Chelsea's half"), the specific event-list examples (goals, cards, subs), the per-mode blurbs' wording. |
| `formatMode` per-mode blurbs | `apps/kairos/server/src/narrative/generator.ts` | The mode names (`action_led`, `enrichment_led`, `context_led`) as the infrastructure cycle-mode taxonomy. | The blurb text per mode — lives in the `generation` spec's `modeBlurbs: { action_led, enrichment_led, context_led }`. |
| `IMAGERY_INSTRUCTIONS` | `apps/kairos/server/src/narrative/imagery.ts` | The `select_imagery` tool schema; "always call the tool"; the two-step "articulate requirement, then decide" framing as structural concept; the spoiler discipline expressed as a structural rule. | The sport-flavoured description prose — pool-vs-generate worked examples ("wide stadium", "celebratory, quiet, electric"), the goal-moment spoiler example, the club-badge / written-text exclusions. |
| Each enrichment / curation service prompt | `apps/kairos/server/src/{enrichment,curation}/services/<name>.ts` | The structural concept (e.g. `themes`' "themes are the meaning the broadcast is carrying"), the input + output structure, the structured-output schema, every rule that's profile-agnostic. | Sport-flavoured worked examples and emphasis (e.g. "the kinds of themes a football broadcast tends to surface"); per-service profile content shape decided when the service's PR lands. |

**Split shape varies per service.** Some services (e.g. `themes`) read as already mostly profile-agnostic — v1 profile content for those may be small or empty (and that's a positive signal: the service was well-abstracted). Some (`generation`, `imagery`) have prose-heavy profile content. The per-service split is a real design step per PR, not a copy-paste.

## Target shape — Kairos side

### Schema

- The `service_specs` `serviceType` enum is the **pipeline stage** (`enrichment` / `curation` / `narrative`); `serviceName` is the specific service. `generation` / `imagery` / `summary` are three services of the `narrative` stage. *(K6.1 first added them as separate enum values; migration `0004` consolidated them into the single `narrative` stage-type — symmetric with how enrichment/curation always worked. The enum-recreate's `USING` remap was hand-edited per the migration escape hatch, justified inline in `drizzle/0004_open_harrier.sql`.)*
- `service_specs.spec` jsonb for the new types:
  - `generation` spec: `{ taskInstructions: string, modeBlurbs: { action_led: string, enrichment_led: string, context_led: string } }`.
  - `imagery` spec: `{ imageryInstructions: string }`.
- Other service specs evolve their own shapes when their PR lands.
- `event_profiles` is unchanged structurally. Every profile resolves exactly one `generation` spec and one `imagery` spec, **implicitly by spec name** (the registry already resolves specs by service name × profile name × the override → active → experimental precedence). No new columns on `event_profiles`. Mirrors how `narrative_context` / `narrative_voice` are ambient-by-convention.

### Source of truth for profile content

**The DB is canonical.** The 15 placeholder `service_specs` rows already in prod (one per service, all v0.1.0 experimental with `{placeholder: true}`) are scaffolding for the right shape; this work transforms them.

**How v1 lands.** Hand-written DML in migrations was tried during K6.2 and rejected (the migration-discipline rule: drizzle-kit generates structural DDL; content lives in code, not in hand-written SQL). The shipped pattern is:

- v1 profile content lives in `apps/kairos/server/src/db/seed-data/sporting-event/**/*.md` — one `.md` per service, structured as `## Section` blocks that the spec-content assembler reads.
- `db/seed.ts` reads those `.md` files via `readFileSync` and **upserts** v1.0.0 `active` rows into `service_specs` via `onConflictDoNothing`, idempotent across re-seeds.
- The v0.1.0 `experimental` placeholder rows stay alongside the v1.0.0 `active` rows. The registry's `override → active → experimental` precedence selects the v1.0.0 row at resolution time; the placeholder remains as the floor-fallback shape.
- K6.2 shipped this for `generation` / `imagery` / `summary`; K6.3 extended it to `momentum` / `tension_conflict` / `narrative_arc`; K6.5+ swept the remaining nine LLM-driven services, so every service except `pacing` (no LLM) now ships a v1.0.0 `active` `.md`.

**Seeds retire post-launch.** The `seed-data/` directory is a bootstrap-and-launch artefact, not a long-lived source. Its jobs:
- Bootstrap fresh dev / test / new prod copies of the DB so they reach the same content shape live prod has.
- Provide the v1 audit trail via git history of the `.md` files.

Once we've gone live and the DB is the canonical source for any later edit:
1. Delete `apps/kairos/server/src/db/seed-data/sporting-event/`.
2. Trim `db/seed.ts` to placeholder bootstrap only (the `sporting_event` profile row + v0.1.0 experimental placeholders).
3. v2+ of any spec is authored in the admin UI (`apps/kairos/client`) against the live DB — no seed-file ↔ DB mirror to maintain.

Tracked as a K6.x exit task on the launch checklist.

### Prompt assembly

`buildSystemPrompt` / `buildImageryPrompt` and each service's prompt builder read the resolved spec at runtime and compose baseline + profile content. The assembled generation system prompt becomes:

```
[ generation baseline (code): tool schema reminder, covers + anchor mechanics,
  the structural rules expressed profile-agnostically ]
[ generation profile content (DB): the sport-flavoured elaboration / worked examples ]
[ mode blurb for this cycle: profile content's modeBlurbs[mode] ]
[ config-derived: tense directive ]
[ narrative_voice entry ]
[ narrative_context entry / brief ]
[ per-cycle material: curated entries, canonical events, relevant threads, moderator directives ]
```

Order is the assembly contract: baseline rule → profile elaboration of that rule → user content → cycle material. The per-component split decides where exactly the join sits.

### `BroadcastConfig` wiring

- `BroadcastConfig.generator.tense` (`past | present | dynamic`) → a small **config-derived prompt segment** the runtime appends (e.g. `Tense: present — write in the present tense throughout.`). Not a template language inside spec content — keep spec text plain; keep "config → prompt" a tiny, testable transformation in engine code.
- `BroadcastConfig.generator.max_tokens` / `model` — already plain runtime params.
- **`BroadcastConfig.imagery: { enabled: boolean }`** (default `true`) — when `false`, the imagery selector short-circuits (returns `hold` / doesn't run), saving the Haiku call. Distinct from the Blackout-side render kill-switch (`illustrationsEnabled` on the Blackout's `broadcasts` row).

### Schema tidy-up — Kairos timestamp backfill (folded in)

Kairos's schema applies row-audit timestamps unevenly. Since this work touches the `service_specs` enum anyway:

- `event_profiles` — add `createdAt` + `updatedAt` (it's mutable platform content).
- `service_specs` — add `createdAt` + `updatedAt` (the `spec` jsonb is edited while a version is `experimental`).
- `sources` — add `createdAt` (write-once at broadcast creation).
- Existing `updatedAt` columns (`broadcasts`, `enrichment_service_states`) — switch to Drizzle's `.$onUpdate(() => new Date())`.
- All new columns: `timestamp with time zone not null default now()`.

The new Blackout `broadcast_templates` table follows the same pattern from the start.

### Migration plan

1. **`pnpm db:generate`** after editing `apps/kairos/server/src/db/schema.ts` — adds `generation` + `imagery` to the `service_specs` `serviceType` enum *and* the timestamp columns above. One run captures both. Commit SQL + `meta/_journal.json` + `meta/<idx>_snapshot.json` together.
2. **Hand-written DML appended to the generated SQL** — INSERT the v1 active `generation` and `imagery` rows for `sporting_event` with the lifted profile content (extracted from `TASK_INSTRUCTIONS` / `IMAGERY_INSTRUCTIONS` / `formatMode` per the per-component split). Idempotent (`INSERT … WHERE NOT EXISTS`). Embed multi-line content as dollar-quoted PostgreSQL strings (`$$...$$::jsonb`) for review-friendliness.
3. **Refactor in the same PR** — `buildSystemPrompt` / `buildImageryPrompt` read the resolved spec; assembly composes baseline (constants in code) + profile content from spec; the old constants reduce to their baseline content (deleted entirely where everything was profile-flavoured). Wire `tense` as config-derived; add `imagery.enabled` short-circuit.
4. **Quality verification, not byte-equality** — the lift involves editorial rewriting at the sentence level (today's prompts mix baseline and profile content within paragraphs, so a clean separation requires rephrasing). End-quality matters more than byte-equality. Verification: a snapshot test pins the *post-lift* assembled prompt as the regression guard going forward (catches future accidental drift in assembly logic); a manual / eval pass against the pre-lift output checks intent preservation — does the post-lift generator obey the same rules and produce the same shape of prose? Run a smoke broadcast on a captured fixture before merging.

## Spec-authoring discipline (the rule that constrains every layer-2 spec)

**Profile content adds context on top of the baseline; it does not restate the baseline.** The baseline expresses the structural rule; the profile content tells the model how that rule applies to this consumer category — typically through worked examples, emphasis, or category-specific elaboration.

Profile content is written as **capability + how-to**, not **instance lists**. The `themes` spec teaches *what kinds of themes a sporting event tends to surface and how to weigh them*; the match brief (layer 3) says *which themes are live this match and how much they weigh*. **Layer 3 configures emphasis (salience); it does not redefine (capability).**

Corollary: a spec must not bake in instance-level defaults (no "always surface league position" in the spec). Then "not in the brief" = "not salient" cleanly, with no per-broadcast suppression mechanism needed.

For `generation` specifically: the baseline teaches *the structured-output contract and the rule that the canonical events are first-class*; the profile content teaches *what those mean concretely for sport* (goals are the most important canonical event, telemetry numerals don't appear in prose for sport, etc.); the per-mode blurbs in profile content say *what a cycle's job is for sport*; the voice (layer 3) says *how that narrator handles each cycle type*. Deliberately non-overlapping.

## Eval criteria as spec content

Once spec content moves into the DB, **the contract a spec edit must hold belongs in the spec too**. Today's hard invariants for the generator (no `covering minutes`, no broadcast-apparatus references, no telemetry numerals) live in `apps/kairos/server/manual/generation-eval/sporting-event/fixtures.ts` as regex assertions. The fixtures (the *inputs*) stay in code; the **invariants** (claims about *output*) are content — they describe what the prompt promises to produce, and they evolve with the prompt.

**Convention.** `spec.serviceInstructions` carries an `## Eval — hard invariants` section alongside the prose sections. The eval runner parses that section at run-time, same way the prompt-assembly machinery parses `## Brief — extraction guidance` etc. Sketch:

```markdown
## Concept
…

## Brief — extraction guidance
For a sporting event: …

## Eval — hard invariants
- prose must not match `/covering minutes/i`
- prose must not match `/the commentators? (say|tell|report)/i`
- prose must not match `/\b\d{1,3}\s?%/`  (no telemetry numerals)

## Eval — soft notes
- reviewer should look for arc carry around the manager's touchline presence
```

**Baseline-level invariants** (the profile-agnostic ones — "every cover has a charOffset", "tool was called") stay in `<service>.baseline.md`'s eval section. **Profile-level invariants** (sport-specific — "no `covering minutes`") live in the spec's eval section. The same `## Section` header interleave that joins baseline prose with profile prose joins baseline eval with profile eval; header drift between the two throws loudly (same discipline as `assembleSectionedPrompt`).

**API surface (K6.4).**

- `POST /specs/:service/:profile/:version/eval/run` — parses the assembled (baseline + spec) eval section, executes the invariants against the in-code fixtures, returns `{ passed, failed, results: [{ fixture, prose, failures }] }`. Same fixtures the manual eval already uses; same regex-match runner.
- The admin app's spec editor surfaces a **save-and-run-eval** action. Save persists to the experimental row; the eval response renders inline as pass/fail per fixture, with the prose alongside each failure for editorial judgement.
- A **promote-to-active** gate can optionally refuse to promote a spec whose eval has hard failures — leans toward an opt-in flag on the promote endpoint for v1, hard gate later.

**Why this split works.**
- Editing the spec edits the contract — the editor sees a regression the moment a save changes behaviour against the existing fixtures.
- Fixtures stay in code: they're tied to the codebase's evolution of the source-data shape (FeedEntry, sourceType, etc.), and they're rare to change.
- Invariants travel with the prompt: they change every time the prompt iterates, and they should land in the same review surface as the prose they constrain.
- A new spec version (`experimental`) gets validated against the same fixtures before promote; a non-developer editorial pass can run the loop without touching code.

This **resolves open question #4 below** (post-lift evaluation method): both — the in-code fixtures are the input set, the in-spec invariants are the assertions, the admin app runs them on save.

## Auth — mirroring `@blackout/auth`

`kairos-client` and `kairos-server` are two halves of the Kairos service — the same relationship as `apps/blackout-client` ↔ `apps/blackout-server` — so the auth pattern is the same shape: a shared Better Auth factory, web-issues / server-validates asymmetry, cross-subdomain cookie via shared `secret`. Just a separate package, separate DB, separate users — Kairos has its own employee base, structurally distinct from Blackout's.

**`@kairos/auth`** — new package parallel to `@blackout/auth`. `factory.ts` (`createAuth(opts) → betterAuth(...)`) + `schema.ts` (`users` / `sessions` / `accounts` / `verifications` Drizzle pgTables in Kairos's Postgres, added via `apps/kairos/server/src/db/schema.ts` per the standard migration flow).

**`kairos-client` (issuer)** instantiates `createAuth` with the configured sign-in provider. The cookie is host-only in local development and can use a shared parent-domain scope when sibling workbench and API hosts are configured. Its `kairos-auth.` prefix prevents collisions with the Blackout session.

**`kairos-server` (validator)** instantiates `createAuth` without the provider. Two distinct auth surfaces:
- **Consumer routes** (`POST /broadcasts`, `POST /feed`, etc.) — existing service-token middleware; used by `blackout-server`; untouched.
- **Admin routes** (CRUD on specs, profiles) — Better Auth session middleware (mirrors `apps/blackout-server`'s `authContext`).

**Shared env vars.** `BETTER_AUTH_SECRET` and `KAIROS_DB_URL` are shared by both apps. Both connect to the same Postgres; `kairos-client` reads/writes auth tables only, while spec content goes through HTTP to `kairos-server`.

**Hardenings deferred.** Solo use today; passkey MFA via Better Auth's plugin, an Origin-check middleware on admin routes (defence-in-depth on top of `SameSite=Lax`), an audit-log table, and a least-privilege two-role DB split are all defensible additions when the user base grows past one. None require re-architecting; each is a small change on top of this pattern. Tracked as forward work, not in-scope here.

## Target shape — Blackout side: the broadcast template

A Blackout-side **broadcast template** concept — the generalisation of decision #42's voice-preset library (same principle: Blackout-owned, *not* Kairos content, compiles down to whatever the per-broadcast Kairos payload needs; the seam stays clean). It is *not* a Kairos `event_profile` — folding consumer config (pacing derived from the Blackout's TTS speed; tense; the source roster) into a Kairos-owned profile crosses the ownership line (K6) and makes "the Blackout configures multiple profiles" mean "the Blackout authors Kairos profiles". Name it **template** (or "broadcast template") — *not* "profile", which is already booked.

A template bundles:
- which Kairos **`event_profile`** to point at (today: always `sporting_event`);
- the **source roster** — which sources, their `type`s (`event` / `moderator` / `narrative_context` / `narrative_voice`), and the `enrichment_tags` on the `event` sources;
- the **`BroadcastConfig`** — tense, pacing buffers / `target_words_per_minute` (derived from the chosen TTS voice/speed), `max_tokens`, optional `model`, `imagery.enabled`;
- a **default voice** — a #42 preset, or a placeholder meaning "writer-authored — supplied per broadcast".

A specific broadcast = **pick a template** + supply the **match brief** (`narrative_context` — always per-broadcast; it's content, the thing that makes each match specific; never template-level) + the **voice** (the template's default, *or* a writer's per-broadcast authorship, which overrides it — #42) + the **live source data**. Optionally, a per-broadcast override of `spec_overrides` (and, rarely, `tense`) for a trial — content-studio-only, defaults off; it just edits the assembled payload before send.

A handful of named templates — `standard-match`, `no-radio-match` (women's / lower-league with no `match_action` source), possibly `cup-final` (if the pacing arc differs for extra time). Not per-broadcast. There is deliberately **no per-broadcast "disable source X" toggle** — source inclusion is defined by attachment + tags; runtime source unavailability is a conductor-degrades-gracefully concern.

Where it lives: the content studio (template authoring/management); the Blackout's DB (a `broadcast_templates` table — shape TBD when building); the broadcast-creation flow picks a template and compiles the `POST /broadcasts` payload from it.

Plus a small separate Blackout-side item that pairs with this: an **`illustrationsEnabled` column on the Blackout's `broadcasts` row** — the *render* kill-switch (does the conductor act on a `generate` / `pool` decision and call Replicate?), mirroring `ttsEnabled`. Distinct from Kairos's `BroadcastConfig.imagery.enabled` (the "should Kairos run the selector" switch).

**Kairos side unchanged by any of this** — `POST /broadcasts { event_profile, config, sources[], … }` per broadcast; the brief and voice arrive as `narrative_context` / `narrative_voice` entries as they do now. The template is purely how the Blackout *assembles* that payload.

## Scope — in vs out

**In (this body of work):**
- Kairos engine: per-component baseline / profile-content split for `generation` + `imagery` + every enrichment + curation service; migration SQL carrying v1 profile content; implicit registry resolution of `generation` + `imagery`; prompt assembly composing baseline + profile content; `BroadcastConfig.generator.tense` + `imagery.enabled`; quality verification per lift; the spec-authoring discipline written down. Plus the **Kairos timestamp backfill** riding the same `db:generate` migration.
- Kairos admin app (`apps/kairos/client`): the CMS for profile content. GitHub OAuth gated to the org. Authors v2+ of any spec.
- Blackout: the broadcast-template concept (DB + content-studio surface + broadcast-creation flow compiles the payload); the `illustrationsEnabled` column on `broadcasts`.

**Out (adjacent — same neighbourhood, separate work):**
- The `PHASE_BASE` / `LIVE_PHASES` domain leak (P0) — different problem (engine mechanics, not content); needs the profile-metadata design deferred until a second consumer.
- The member-facing experience presets (#3 — "The Hemingway Room") — a different "preset": consumer-facing experience flavour, not operational config.
- Engine docstrings that still name football specifics (`narrative/helpers.ts`, `feed.ts`, `pipeline/*`) — reword in the same PR if convenient; not load-bearing.

## Open questions (the remaining ones)

1. **Test fixture shape** — `tests/fixtures/sporting_event_system_prompt.txt` (file) vs inline expected strings. Lean: files.
2. **Engine docstring cleanup** in the same PR or a follow-up. Cheap; do it if convenient.
3. **`broadcast_templates` table shape (Blackout side)** — whether the source roster is a jsonb array on the template or a child table. Decide when building B6.9.
4. ~~**Post-lift evaluation method** — automated eval against a fixed input set, manual review of a smoke broadcast, or both.~~ **Resolved 2026-05-17:** both. In-code fixtures (`manual/<service>-eval/sporting-event/fixtures.ts`) carry the inputs; in-spec invariants (the `## Eval — hard invariants` section parsed from `spec.serviceInstructions`) carry the assertions. The admin app surfaces a save-and-run-eval action that joins them. See § *Eval criteria as spec content*.
5. **Promotion UI shape** (admin app) — buttons-per-row is the starting suggestion (Q4 from PR sequence discussion); review critically before K6.4 merges.

## What this closes / advances

- Closes the two `apps/kairos/server` P1s in `docs/codebase-audit-2026-05-10.md`: "lift `TASK_INSTRUCTIONS` and `formatMode` blurbs to per-profile content"; "lift `IMAGERY_INSTRUCTIONS` to per-profile content".
- Sweeps the parallel per-service population into the same body of work via K6.5+.
- Gives the `kairos-server` infrastructure-vs-content rule its concrete worked example (every prompt now layered as baseline + profile content).
- Covers the generator-level slice of "prompts are versioned content not hard-coded strings", plus the full `BroadcastConfig` and the Blackout-side template that makes the config reusable.

## PR sequence

Behind the audit P0s, per the standing call (`docs/codebase-audit-2026-05-10.md` § *Suggested sequence*).

### Pre-W6 — naming cleanup *(shipped)*

The original sketch was flat paths (`apps/blackout-server` etc.). The PRs that actually shipped (2026-05-14, #22/#24/#26) settled on **nested paths + a pnpm `@kairos` scope** for Kairos-owned packages. The naming convention now: `apps/<namespace>/<surface>/` with `@<namespace>/<package>` for siblings under `packages/<namespace>/`.

- **W6.0a** *(shipped, PR #22)* — `apps/web` → `apps/blackout/client`; `@blackout/web` → `@blackout/client`.
- **W6.0b** *(shipped, PR #24)* — `apps/server` → `apps/blackout/server`; package name `@blackout/server` unchanged.
- **W6.0c** *(shipped, PR #26)* — `apps/kairos` → `apps/kairos/server`; `@blackout/kairos` → `@kairos/server`. New `@kairos` pnpm scope introduced for the namespace.

`apps/kairos/client` ships into this consistent set when K6.3b lands. `packages/kairos/{auth,shared}` use the same `@kairos` scope.

### Kairos engine — the lift

- **K6.1** — Schema migration: `serviceType` enum gains `generation` + `imagery`; timestamp backfill on `event_profiles` / `service_specs` / `sources`; `.$onUpdate` on existing `updatedAt`s. One `pnpm db:generate` run; SQL + journal + snapshot committed together.
- **K6.2** *(shipped)* — `generation` + `imagery` + `summary` lift (load-bearing). Per-component baseline / profile-content split designed (editorial rewriting at sentence level acceptable). v1 profile content lives in `apps/kairos/server/src/db/seed-data/sporting-event/*.md`; `db/seed.ts` upserts v1.0.0 active rows via `readFileSync` + `onConflictDoNothing`. Engine reads from resolved spec; baseline constants stay (reduced) in `<surface>.baseline.md`; profile-content constants deleted. `BroadcastConfig.generator.tense` config-derived segment + `imagery.enabled` short-circuit. Post-lift assembled prompt captured as snapshot fixture (going-forward regression guard). Manual eval harnesses at `apps/kairos/server/manual/<service>-eval/` scaffold the live-LLM checks.

### Kairos client — the CMS

- **K6.3a** — `@kairos/auth` package (factory + schema, parallel to `@blackout/auth`) + auth tables migration on `apps/kairos/server` + admin-route Better Auth middleware on `kairos-server`.
- **K6.3b** — `apps/kairos/client` bootstrap. Next.js App Router; consumes `@kairos/auth` for sign-in and uses a distinct `kairos-auth.` cookie prefix. Read-only **Profiles → Services → Spec versions** tree; each spec rendered via a per-service-type form; calls Kairos HTTP routes for data.
- **K6.4** — Editing. Per-service-type forms editable on `experimental` rows; **promote** / **archive** / **clone-active-to-experimental** buttons call the existing `POST /specs/...` routes. New: a **save-and-run-eval** action surfaces pass/fail per fixture inline, backed by `POST /specs/:service/:profile/:version/eval/run` (parses the `## Eval — hard invariants` section from the assembled baseline + spec, runs against in-code fixtures — see § *Eval criteria as spec content*). Forward consideration: an "assembled prompt preview" panel showing baseline + current spec content composed; optional hard-gate on promote when eval has hard failures.

### Per-service population — same pattern, one service per PR

Each: read the service's prompt code, design the split (baseline = structural rules; profile content = sport-flavoured worked detail — editorial rewriting expected); land v1 profile content as a new `.md` under `apps/kairos/server/src/db/seed-data/sporting-event/<category>/<service>.md`; `db/seed.ts` upserts a v1.0.0 `active` row alongside the existing v0.1.0 placeholder; service code reads from resolved spec.

K6.3 shipped the lift for **`momentum` / `tension_conflict` / `narrative_arc`** (those carried sport-specific examples in their original constants).

- **K6.5+ — complete.** The remaining nine LLM-driven services were lifted in one sweep (`themes`, `character_arcs`, `character_relationships`, `patterns_echoes` on the enrichment side; `priority`, `narrative_gap`, `broadcast_summary`, `saturation_resolver`, `context_curator`, `conflict_resolver` on the curation side). Every LLM-driven service now resolves a v1.0.0 `active` sport-flavoured spec — **16 active rows** total (6 enrichment + 7 curation + the 3 narrative-path surfaces). `pacing` is the only spec-less service (pure arithmetic, no LLM). Each split kept the structural rules in the baseline and added capability-level sport flavour (recognition palettes, how-to-weigh, what-resets-the-clock — never instance defaults) to the spec; the merge contract is pinned by `apps/kairos/server/tests/spec-content-merge.test.ts`. The original one-PR-per-service sketch (`themes` first, then sweep) collapsed into a single editorial pass once the mechanic proved boring, as anticipated.

### Blackout side — broadcast templates

- **B6.8** — `illustrationsEnabled` column on `apps/blackout-server`'s `broadcasts` row. Conductor honours it (mirror `ttsEnabled`).
- **B6.9** — `broadcast_templates` table + seed `standard-match`. Decides "source roster as jsonb on the template vs child table" here.
- **B6.10** — `apps/blackout-client` template authoring (content studio) + broadcast-creation form picks a template and compiles the `POST /broadcasts` payload.
