# Kairos — narrative orchestration engine

A domain-agnostic engine that turns a stream into meaning. Given a feed of typed source entries and a brief that frames what matters, it produces prose describing the meaningful moments in the stream, in order, at a consumer-appropriate cadence — with per-entry reveal anchors and an imagery decision attached.

> Chronos is the raw stream — events, commentary, research, moderator input. Time passing, things happening, sources flowing in. Kairos is what the engine produces — the meaningful moment extracted from the stream. The engine's job: transforming Chronos into Kairos.

This README is the engine-as-a-service checkpoint: the consumer contract, the broadcast lifecycle, the runtime model, how to run it, and the boundary that keeps it domain-agnostic. For how the engine works *inside* — the four-stage pipeline, the data shapes, the module map — see [`src/README.md`](src/README.md). For the Kairos service as a whole (this + the planned admin client) see [`../README.md`](../README.md); for the cross-service view (Blackout ↔ Kairos), see [`../../README.md`](../../README.md).

## What Kairos is — and is not

**It is** a narrative orchestration engine with its own process, its own Postgres database, and a per-broadcast lifecycle. One consumer talks to it today (The Blackout); the API and the auth model are built for more than one.

**It is not:**
- **A presentation layer.** TTS, illustrations *as bytes*, viewer UI, audio choreography — all consumer-side. Kairos returns prose + a covers list + an imagery *decision*, not media.
- **A source collector.** Sources arrive over HTTP. Kairos doesn't poll APIs, transcribe audio, or take moderator input directly.
- **Domain-aware.** No football types. No sport logic. The domain shape lives in the event profile and service specs that ship with a broadcast, and in the consumer's source adapters. Kairos batches, enriches, curates, and generates generically.
- **Stateful beyond a broadcast.** Each broadcast has its own durable state in Postgres. Nothing crosses broadcasts except platform content (event profiles, service specs).

## The consumer contract

Dependency is one-way: the consumer knows about Kairos; Kairos doesn't know about its consumer. The seam on the consumer side is `apps/blackout/server/src/lib/kairos.ts`. Everything below is the public surface — if a consumer (or a Kairos-internal module) reaches past it into an internal file, that's a bug.

### Authentication — two surfaces

The server has two auth models, scoped by path prefix:

- **Consumer surface (`/broadcasts/*`, `/health` exempt)** — machine-to-machine. `Authorization: Bearer <token>` against the `KAIROS_API_KEYS` env var (comma-separated; constant-time compared). No keys configured ⇒ every request 503s (fail closed). WS upgrades on `/broadcasts/:id/feed` validate with the same check before the handshake completes (`server.ts`). This is the contract `apps/blackout/server` calls; designed for multi-consumer.
- **Admin surface (`/profiles/*`, `/specs/*`)** — human-to-service. Better Auth session cookie issued by the admin app (`apps/kairos/client`) via email/password sign-in (sign-up disabled; users seeded by `apps/kairos/client/scripts/create-user.ts`). Sessions validate against the `users`/`sessions`/`accounts`/`verifications` tables in Kairos's Postgres; secret + cookie config come from `BETTER_AUTH_SECRET` / `BETTER_AUTH_URL` / `BETTER_AUTH_COOKIE_DOMAIN` / `BETTER_AUTH_TRUSTED_ORIGINS` (must match the admin app's values). Tests + ops scripts use the `INTERNAL_API_SECRET` header bypass (fail-closed: missing env disables the bypass). Factory + schema in [`@kairos/auth`](../../../packages/kairos/auth/README.md).

### REST — consumer → Kairos

| Endpoint | Purpose |
|---|---|
| `POST /broadcasts` | Create a `pending` broadcast with its sources. Body: `event_profile`, optional `config`, optional `spec_overrides`, `sources[]` (`{name, type, canonical?, enrichment_tags?, config?}`). `enrichment_tags` only on `event` sources; `canonical` only on `event`/`moderator`. Returns `{ broadcast, sources, resolvedSpecs }`. |
| `PATCH /broadcasts/:id` | Status transitions and config updates. `{ status: "active" }` starts the runtime — refused 422 if there isn't a non-empty `narrative_voice` *and* `narrative_context` entry. `{ status: "complete" }` stops the runtime; feed + generations stay queryable. |
| `DELETE /broadcasts/:id` | Stop runtime + delete the broadcast (cascades sources, entries, generations, cycles). |
| `POST /broadcasts/:id/sources`, `PATCH …/sources/:sourceId`, `DELETE …/sources/:sourceId` | Source management. Same validation as create. |
| `POST /broadcasts/:id/entries` | Push a feed entry: `{ source, data, timestamp? }`. `data` is consumer-defined and opaque to Kairos (see "the stamping responsibility" below). On an `active` broadcast it flows into the runtime's feed + pipeline; on a `pending` broadcast only `narrative_voice` / `narrative_context` entries are accepted (pre-activation seeding). Deduped on `data.sourceId` within `(broadcast, source)`. |
| `POST /broadcasts/:id/feedback` | Pacing signal: `{ signal: "slow_down" \| "speed_up" \| "on_track", words_per_minute }`. Feeds the state tracker's WPM estimate, which sizes the next cycle's word-count target. 409 if not active. |
| `POST /broadcasts/:id/narrative/generate` | Request an off-schedule cycle. Body `{ consumerPrompt: string }` **required** (400 without). Routes through the same enrich → curate → generate path as a cadence cycle; the `consumerPrompt` is spliced verbatim into the generator's user message. This is how the consumer expresses a domain-specific beat (a half-time reflection, a closing passage) without leaking the domain into Kairos's enum. |
| `GET /broadcasts/:id` | The broadcast + sources + resolved specs. |
| `GET /broadcasts/:id/entries` | Feed entries, with `?source` / `?tag` / `?from` / `?to` filters. DB-backed, independent of the runtime. |
| `GET /broadcasts/:id/cycles`, `GET …/cycles/:cycleId` | `pipeline_cycles` rows — one per flush. List view includes per-cycle drift (cadence vs content-time-span vs prose-seconds vs target-seconds, with a colour band). Inspector support. |
| `GET /broadcasts/:id/health` | Flow-health summary: wall-seconds, content-seconds, prose-seconds, target-seconds, cycle/generation counts, per-phase content breakdown. In a healthy 90-minute broadcast all four converge on ~5400s; drift between any two surfaces a failure mode. |
| `GET /broadcasts/:id/generations`, `GET …/generations/:generationId` | Generated passages + their context packages. |
| `GET /broadcasts/:id/services`, `GET …/services/:serviceName` | Live enrichment + curation service snapshots (subject state). 409 if not active. |
| `GET/POST/PATCH/DELETE /broadcasts/:id/pool` | Content pool — pre-prepared tagged items the imagery selector can pick from instead of emitting a `generate` decision. `{ prompt, tags, consumer_metadata }`; `consumer_metadata` is opaque (the consumer stashes a pointer to its own bytes). |

**Admin surface** (session-cookie auth, see *Authentication* above):

| Endpoint | Purpose |
|---|---|
| `GET /profiles`, `GET /profiles/:name` | Event profiles — the domain container. |
| `GET /specs`, `GET /specs/:service/:profile` | Service specs (versioned domain guidance per service). |
| `POST /specs/:service/:profile/:version/promote` | Atomically archive the current `active` spec and activate this one. |

### WebSocket — consumer ← Kairos, read-only

`ws://…/broadcasts/:id/feed`. The consumer subscribes; it never writes (all writes go through REST). Lazily rehydrates an `active` broadcast's runtime on first connect.

| Message | When |
|---|---|
| `{ type: "sync", entries }` | On connect — every entry pushed so far. |
| `{ type: "entry", entry }` | A pushed entry, echoed to subscribers. The conductor relies on this to receive its own synthetic phase markers back. |
| `{ type: "imagery_decision", narrativeId, broadcastId, imagery }` | Fired the moment the parallel Haiku imagery call returns — ahead of the Sonnet narrative — so the consumer's image pipeline can start in parallel. |
| `{ type: "narrative", narrative }` | A generated passage: `{ id, broadcastId, text, generatedAt, feedWindow, usage, covers, batchEntryIds, contentTime, imagery }`. See the data shapes in [`src/README.md`](src/README.md). |
| `{ type: "generation_skipped", reason, retryAfterMs?, triggerReason }` | An LLM rate limit ate the cycle. |
| `{ type: "cycle_complete", cycleId, broadcastId }` | A `pipeline_cycles` row was persisted — inspector signal. |

**Heartbeat is lopsided today:** the consumer-side `kairos-heartbeat.ts` pings every 15s and terminates on missed pong. Server-side ping (Kairos pinging its subscribers) and a graceful-shutdown close-frame on SIGTERM are owed — ~20 lines, tracked in MVP infrastructure-hardening.

### The consumer's stamping responsibility

`data` payloads on feed entries are consumer-defined and opaque to Kairos. But the consumer's stamping is what makes subject-time batching work — see [`../../../docs/vocabulary.md`](../../../docs/vocabulary.md) § Time. By convention (the Blackout's `broadcast-runner` does this for every entry), `data` carries: `content` (the text), `phase` + `phaseSecond` (collapsed to a sortable subject ordinal — the batching key), optional `subjectTime` (the entry's subject-time marker as a human-readable string, surfaced in covers and feeds the consumer's content clock), `closingExtensionSeconds` + `closingPrompt` (mark a phase boundary worth pinning the next cycle's drain to), `sourceId` (stable external id — dedup + parent/child grouping), `parentSourceId` (subordinate this entry to another entry's `sourceId` — used by `match_action` event_texture entries pointing at their canonical event). Kairos interprets none of the football meanings — it batches on the ordinal, dedups on `sourceId`, groups parent/children at prompt-render time. Entries without `phase` fall through every cadence flush harmlessly.

## Broadcast lifecycle

```
pending ──activate──▶ active ──complete──▶ complete
 │ accepts only narrative_voice │ terminal; feed + generations
 │ + narrative_context entries │ stay queryable; runtime stopped
 │ (pre-activation seeding) │
 │ no runtime yet after a server restart, an `active`
 activation gate: ≥1 non-empty entry broadcast's runtime is lazily
 of each ambient type, else 422 rehydrated on first reference
```

(`paused` exists in the `broadcast_status` enum but is vestigial — no runtime path uses it; the real states are the three above. See "Open work".)

## Runtime model

One `BroadcastRuntime` per active broadcast (`src/broadcast.ts`): the feed, the enrichment pipeline (which also drives curation and generation per cycle), the curator, the narrative engine, the state tracker, the recent-cycles buffer, the service registry, the WS subscriber set. Created at activation, destroyed at completion. Concurrent runtimes are supported but uncommon (one active broadcast at a time today); each owns its own DB connections, LLM client, and subscribers, so cross-broadcast state bugs are architecturally impossible. Concurrent activation requests for the same broadcast are serialised (`runtimeStarts` map) so a slow brief-init pass can't produce two runtimes with disjoint subscriber sets.

## Extending Kairos to a new domain

1. Define an **event profile** — the container, e.g. `sporting_event` (the only one shipped) or a hypothetical `political_event`. It lists which enrichment + curation services activate (`event_profiles.enrichment_services`, `curation_service_tiers`).
2. Ship **service specs per profile** — domain-specific guidance per service type. The service *type* is universal (`character_arcs` is `character_arcs` everywhere); the *spec* is domain-bound (what an arc looks like in sport vs in a debate). Specs are versioned: a new one lands `experimental`; promotion atomically archives the previous `active` one without disturbing in-flight broadcasts.
3. Configure **source types + enrichment tags** at broadcast creation — declares which services receive which sources' entries.

New service *types* are added by implementing the `EnrichmentService` or `CurationService` interface, registering it in `src/registry.ts`, and shipping at least one experimental spec per profile that uses it. See [`src/enrichment/services/README.md`](src/enrichment/services/README.md) and [`src/curation/services/README.md`](src/curation/services/README.md).

## Development

```bash
pnpm run dev # tsx watch on :5050 (predev runs migrate + check first)
pnpm run build # tsc (type-check + emit dist/)
pnpm db:generate # generate a SQL migration from a schema.ts diff
pnpm db:migrate # apply pending migrations (the production migrator)
pnpm db:check # post-migrate drift detector — asserts every schema table exists + cursor matches journal
pnpm db:reset # local-only: drop, migrate, seed. The SOP when db:check flags drift.
pnpm db:seed # upsert the sporting_event profile + placeholder specs
pnpm db:studio # browser DB viewer
pnpm db:push # apply schema.ts directly — local throwaway only, bypasses migrations
pnpm test # node --test against kairos_test (pretest migrates + checks + seeds)
```

`predev` runs migrations and then `db:check` (the drift detector); the test harness does the same on bootstrap. Migration discipline — generate structural DDL with `pnpm db:generate`, commit the SQL + `meta/_journal.json` + `meta/<idx>_snapshot.json` together, never hand-write structural DDL — is documented in the [root CLAUDE.md](../../../CLAUDE.md) and the [`migrations` skill](../../../.claude/skills/migrations/SKILL.md). When `db:check` reports local drift, `pnpm db:reset` is the sanctioned recovery.

Health: `GET http://localhost:5050/health`.

The former hosted deployment has been retired. If this stateful service is hosted again, it must run as a singleton: multiple instances would split the in-memory waiting room and recent-cycle state.

Replay & analysis tooling lives in `scripts/`: `replay.ts` (re-stream a captured broadcast through the engine in-process — canned LLM for cheap mechanics validation, or `LIVE_ENRICHMENT=1` / `LIVE_LLM=1` for quality runs), `replay-to-http.ts` (push past entries to a live `:5050` so an external consumer exercises the real multi-process pipeline), `export-broadcast.ts` (dump a broadcast's inputs + outputs to flat files under `data/broadcasts/<id>/`), `dump-prompt.ts` / `enrichment-probe.ts` (offline prompt + service inspection, no LLM cost). Plus `copy-assets.mjs`, which runs after `tsc` to ship runtime `.md` files (narrative baselines + seed-data profile content) into `dist/`.

Out-of-band LLM-eval harnesses live in `manual/`, one subdirectory per surface (all five LLM surfaces covered), each with profile-scoped fixtures (`sporting-event/`) calling the live service. Two shapes: the three **narrative** harnesses (`generation-eval/`, `imagery-eval/`, `summary-eval/`) assert hard regex invariants on prose (exit 1 on violation) + per-fixture expectations; the **enrichment-eval/** + **curation-eval/** harnesses are reviewer harnesses — those surfaces emit structured judgment, so they run the services against one cycle and print each reading + its `## Eval — soft notes` for human review (the curation runner adds three machine-checkable hard checks: priority canonical-protection + emphasis budget, conflict_resolver winner ≠ loser, saturation no-force-on-fresh-cycle). Eval criteria live *with* the prompt as `## Eval` sections parsed by `src/eval/spec-eval.ts`; assembly is also guarded by `tests/spec-content-merge.test.ts`. **Not** part of `pnpm test` / CI — run `pnpm eval:generation` / `:imagery` / `:summary` / `:enrichment` / `:curation` before shipping a prompt/spec change. See `manual/<surface>-eval/README.md` per harness.

## Boundary discipline

Kairos stays domain-agnostic: no football concepts, no Sportmonks types, no Blackout-specific source names, no imports from `@blackout/server`. **And no imports from `@blackout/shared` either** — Kairos has no dependency on it; `@blackout/shared` is the *Blackout side's* types hub (`apps/blackout/server` + `apps/blackout/client`), and the seam between Kairos and the Blackout is the HTTP/WS wire, not shared TypeScript. A type genuinely needed on both sides is duplicated — Kairos owns it (it's the engine; the Blackout is the consumer), the Blackout side keeps its own mirror (`packages/blackout/shared/types/pipeline-cycle.ts` is that mirror today; the longer-term direction is a Kairos-owned types package the Blackout imports). Dependencies flow one way: the Blackout depends on Kairos via the HTTP/WS client; Kairos doesn't know its consumer exists. The runtime seam between `apps/blackout/server` and `apps/kairos/server` is part of that focus, not an IP wall — Blackout devs read and edit Kairos freely; the rule is just that Kairos doesn't learn about football and doesn't compile-couple to its consumer. The full rule set is the [`kairos-server` skill](../../../.claude/skills/kairos-server/SKILL.md), which auto-loads on `apps/kairos/server/**` reads. ("Moderator" is *not* a domain leak — it's the generic role of "the person driving the broadcast"; a debate, a courtroom, a political event all have one.)

## What working looks like

A healthy `active` broadcast, per cycle (~every 45s):
- The pipeline drains entries whose content ordinal ≤ (highest observed − 60s DELAY); `[enrichment] flushed: N entries → M annotations from 6 services`. Late arrivals (post-flush, for an already-shipped window) discard with telemetry — `getLateDiscardedCount()` ≈ 0 means the DELAY is right; a climbing count means tighten the consumer's stamping or widen DELAY.
- Curation runs 4 tiers; `[curator] curated: mode=…, N entries, M/K annotations kept`. Mode is one of `action_led` / `enrichment_led` / `context_led` — never silence.
- Generation: `[narrative] generated <id> (…in/…out [cache: … read / … write], Nw target=Mw(pacing), …covers, trigger=accumulation): …`. Cache reads dominate after cycle 1 (the voice/context/task system prompt is cached).
- The feed WS emits `imagery_decision` then `narrative` then `cycle_complete`. `pipeline_cycles` rows accumulate.
- `GET /broadcasts/:id/health` — wall-seconds, content-seconds, prose-seconds, target-seconds tracking each other (drift between any two is the signal to chase).
- No `phantom_covers` / `tool_call_failed` invariant warnings in the logs / PostHog (occasional ones are tolerated and warn-only; a spike is a regression).

## Open work — engine-wide

WIP that spans more than one `src/` module lives here. Stage-internal WIP lives in that stage's README; service-specific WIP lives deeper still. The items below are retained as technical follow-up ideas, not an active roadmap.

- **`context_curator` has an informal protocol that two call sites reach for by name.** `src/broadcast.ts` imports `ContextCurator` directly from `src/curation/services/context-curator.js` (for `hydrateThreadInventory` / `initializeFromBrief` in the brief-init pass), and `src/curation/curator.ts` does a `getCurationServices().find(s => s.name === "context_curator")` + duck-typed `markThreadsUsed` call. The brief-thread-inventory + thread-recency behaviour isn't part of the `CurationService` interface. Either formalise a "service with activation hooks + post-mode hooks" interface, or accept the special-casing — but it's a service-specific concern leaking across the module seam today. *Tech-debt — low priority; curator.ts acknowledges it inline.*
- **`PHASE_BASE` (`src/pipeline/subject-time.ts`) and `LIVE_PHASES` (`src/broadcast-health.ts`) hardcode football phase names** — `first_half`, `halftime`, `second_half`, `full_time`, `live_first_half`, etc. A phase→ordinal map is a domain concept living in engine code; it should be per-profile metadata. Already tracked: [`docs/kairos-domain-leak-open-items.md`](../../../docs/kairos-domain-leak-open-items.md). Out of scope until a second consumer onboards; revisit then.
- **Prompts-as-content (Phases 5–7) — load-bearing lifts shipped.** **K6.1** (PR #27) landed the schema: `generation` + `imagery` service-spec types + the row-audit timestamp backfill. **K6.2** (PR #33) lifted the three narrative-path surfaces (`generation` / `imagery` / `summary`) into `src/narrative/<surface>.baseline.md` (profile-agnostic prose) + `src/db/seed-data/sporting-event/<surface>.md` (per-domain elaboration), assembled per-section via matching `## Header` markers. `BroadcastConfig.generator.tense` wires in as a config-derived prompt segment; `BroadcastConfig.imagery.enabled` short-circuits the imagery selector. **K6.3** (PR #35) extended the pattern to all enrichment + curation services — `BaseEnrichmentService` and the curation services now load `<service>.baseline.md` at module init and merge the resolved spec content at construction; the runners take pre-assembled `systemPrompt`. **K6.5+** completed the per-service content population: every LLM-driven service now resolves a v1.0.0 `active` sport-flavoured spec — 6 enrichment (`momentum` / `tension_conflict` / `themes` / `character_arcs` / `character_relationships` / `patterns_echoes`) + 7 curation (`narrative_arc` / `priority` / `narrative_gap` / `broadcast_summary` / `saturation_resolver` / `context_curator` / `conflict_resolver`) + the 3 narrative-path surfaces = 16 active rows, across the three stage-types `enrichment` / `curation` / `narrative` (`serviceType` is the stage, `serviceName` the service; migration `0004` consolidated the former per-service `generation`/`imagery`/`summary` types into `narrative`). `pacing` is the only spec-less service (pure arithmetic, no LLM). Each split keeps structural rules in the baseline and adds sport-flavoured capability (recognition palettes, how-to-weigh) in the spec; the merge contract (header-match interleave, no silent drop) is pinned by `tests/spec-content-merge.test.ts`.
  - **Open here**: v2+ content is authored in the `apps/kairos/client` admin UI against the live DB, not engine edits — design in [`docs/prompts-as-content-design.md`](../../../docs/prompts-as-content-design.md) § *PR sequence — Per-service population*. Today's seed-data `.md` files are bootstrap-only and retire post-launch (the DB becomes the canonical source after the admin app ships); tracked as a launch-checklist exit task. Eval is shipped across all five surfaces (`manual/*-eval/`, run via `pnpm eval:*`); the one piece still deferred to the admin UI (K6.4) is the in-app `POST /specs/:service/:profile/:version/eval/run` endpoint — the same `extractEvalCriteria` + check logic the runners use, surfaced as the editor's save-and-run-eval.
- **No server-side WS heartbeat / graceful-shutdown close-frame.** The ping is one-directional (consumer→Kairos). ~20 lines. MVP infrastructure-hardening.
- **`docs/kairos-architecture.md` has drifted from the code** — most notably its §3 "Phase-boundary triggers" describes a `recognizePhaseTransition` / `schedulePhaseFlush` mechanism that doesn't exist; the actual design is the generic consumer-stamped `closingExtensionSeconds` marker (the consumer decides which entries get the extension — a cleaner, more domain-agnostic shape). The diagram doc still shows "Curation (sequential)" and the old `accumulation · gap · improv` trigger enum. That doc is being decomposed into this README + `src/README.md` + the stage READMEs; treat the READMEs as canonical and `docs/kairos-architecture.md` as a legacy reference until it's retired.

## See also

- [`src/README.md`](src/README.md) — the internal architecture: the four-stage pipeline, the data shapes, the module map, the anti-patterns. **Read this for "how Kairos works."**
- [`../README.md`](../README.md) — the Kairos service (this + the planned admin client).
- [`../../README.md`](../../README.md) — `apps/` — the two services (Blackout + Kairos) and the inter-service seam (the consumer side of this contract).
- [`CLAUDE.md`](CLAUDE.md) — conventions for AI-assisted dev (thin pointer + rules).
- [`.claude/skills/kairos-server/SKILL.md`](../../../.claude/skills/kairos-server/SKILL.md) — the rule set, auto-loaded on `apps/kairos/server/**` reads.
- [`docs/kairos-architecture.md`](../../../docs/kairos-architecture.md) — legacy canonical doc, being decomposed here; drifted in places (see Open work).
- [`docs/prototype-status.md`](../../../docs/prototype-status.md) — what the completed concept prototype established.
