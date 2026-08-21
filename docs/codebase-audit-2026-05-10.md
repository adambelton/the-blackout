# Codebase audit — 2026-05-10

Full-codebase audit against the Code Quality Pillars (`~/.claude/rules/code-quality.md`) and project conventions (`.claude/skills/blackout-*`). Four parallel `general-purpose` audits, one per surface, each briefed with the relevant skill files. ~388 source files, ~57k LOC across `apps/blackout/server`, `apps/kairos/server`, `apps/blackout/client`, `packages/shared`.

This doc carries the synthesis. Prioritised TODOs by surface, cross-cutting themes that produced new skill rules, and the headlines we want to preserve.

> **Vocabulary note (2026-05-16).** This audit was written before the three time domains (subject / content / broadcast) were formalised — see [`vocabulary.md`](./vocabulary.md) § Time. References to "content time," `contentTime` (the field), and "match-time" mostly mean **subject time** under the new vocabulary; the engine's `clampMonotonicMinute` and `batchContentTime` are **content time**. Preserved as the historical record.

## Status update — 2026-05-10 evening

Five waves landed in this session, in commit order:

- **Wave 9 (test gaps)** — `91271e0`. Added cross-call invariants (server `bundle-invariants.test.ts`), EWMA arithmetic (server `calibration-loop.test.ts`), feed-source-to-prompt routing (kairos `feed-to-prompt.test.ts`), shared type-guard + cue round-trip + Record-pairing exhaustiveness, kairos `mergeTierResults` adversarial cases, server `signalFor` thresholds. **Closes:** the test-coverage gaps that don't require source refactoring. **Open:** matchroom playback / reveal / replay-walk / WS-dispatch coverage — blocked on Wave 4 hook extraction (the inline matchroom code is structurally untestable, per the audit).
- **Wave 1 (type-safety)** — `78e41dd`. `RoomConductor.fanOut` tightened from `ConductorCue | { [k]: unknown }` to a strict union; `TeamSide` shadows replaced (8 sites); `ConductorCue` extended to cover every emitted cue (FeedEntryCue, LatencySampleCue, plus all bundle cues sourced from shared); `GenerationSkippedCue` collision resolved by re-export. Dead types deleted (`BroadcastContext`, `ClubBrief`, `PlayerContext`, `atmosphericIllustrations`). Stale `ttsProvider` JSDoc fixed. **Closes:** the WS-cue type-safety headline + adjacent dead-shape items. **Open:** `BroadcastStatus` / `ConnectedCue` collision rename, moderator WS protocol typing, shared barrel partition — all need design input.
- **Wave 2 (magic strings)** — `0f47472`. `SOURCE` hoisted to `@blackout/shared`; magic-string source-name call sites replaced (3 of the 4 audit-named sites; `phase-logic.ts` deferred — the surrounding function confuses sourceType vs sourceName). `LIVE_PHASES` + `isLivePhase()` predicate added; matchroom inline disjunction replaced. `STORAGE_KEYS` consolidated into `apps/blackout/client/lib/storage-keys.ts`. Kairos `event_priority` decision key renamed to `canonical_emphasis`. **Closes:** SOURCE hoist + LIVE_PHASES predicate + storage-keys consolidation + kairos rename. **Open:** ~289 inline `=== "live"` / `=== "complete"` `BroadcastStatus` checks (different concept from BroadcastPhase; needs status predicates of its own).
- **Wave 3 subset (composition)** — `9b6cd23`. `apps/blackout/server/src/lib/anthropic.ts` (new) — single `getAnthropicClient(purpose)` replaces three duplicated caches (distiller, prompt-suggester, tag-deriver). `assertLiveBroadcastEnv()` in `env.ts` validates `DEEPGRAM_API_KEY` + `SPORTMONKS_API_TOKEN` at runner start; `BroadcastRunner.start` calls it instead of inline reads. **Closes:** Anthropic client consolidation + boot-time env validation. **Open:** `safeCurate` wrapper (deferred — adds dead code unless all 6 callers update together; separate wave); Postgres pool consolidation (concurrency change under load — needs pool-size analysis).
- **Wave 10 (P2 cleanup)** — `5097e6e`. `/storage/:path` gated behind `requireAuth` (member-ethics gate the audit flagged); `INTERNAL_ADMIN_USER` global cast replaced with frozen factories `buildInternalAdminUser()` / `buildInternalSession()`; `matchEventsSourceName` / `matchActionSourceName` constructor injection dropped from `CanonicalIngestDeps` (parameter elaboration, always set to `SOURCE.matchEvents` / `SOURCE.matchAction`). **Closes:** the storage gate + admin-factory + dep-cleanup items. **Open:** `completeBroadcast` lift out of conductor (kills the dynamic-import workaround — bigger event-flow refactor); `getPriorState` push-down into BroadcastStateTracker; `mergeTierResults` runtime invariant.

Wave 11 (this docs pass) is the final commit of the session.

### Deferred — high-risk / design-required (next session)

These items were classified as risky or design-needing during the planning conversation and weren't attempted today:

- **Wave 4 — matchroom hook extraction** (`useNarrationPlayback`, `useMatchroomConnection`, `usePassageBundles`, `useReplayWalk`). Member-visible risk; the playback driver's closure-capture and timer scheduling mean an extraction without integration tests is brave. Tests needed first.
- **Wave 5 — moderator hook extraction** (`useModeratorConnection`, `useLiveNarrativePlayback`, `useNarratorVoicePicker`, `useGenerationPause`, `useRadioSourceSelection`, `useBroadcastLifecycle`, `useServiceStatus`, `useAutoScroll`).
- **Wave 6 — Kairos prompts-as-content lift** (`TASK_INSTRUCTIONS`, `IMAGERY_INSTRUCTIONS`, `formatMode` blurbs to per-profile content). Behavioural LLM change — needs a generator-side eval first, plus design alignment on `docs/prompts-as-content-design.md`.
- **Wave 7 — god-file splits** (RoomConductor, broadcast-runner, NarrativeEngine.run, ContextCurator, ClosingCycleScheduler extraction). Highest blast radius. Tests-first dependency confirmed (Wave 9 closed some of that gap; integration-level tests for kairos-bridge activation/completion + an end-to-end conductor smoke still missing).
- **Wave 8 — `PHASE_BASE` / `LIVE_PHASES` per-profile metadata**. Pure design call deferred by the audit; needs its own scoping.
- **Postgres pool consolidation** (subset of Wave 3). Concurrency change under load.

### Items the original tables list that DID land

The per-surface tables below are preserved as the audit's snapshot; for active status, read this section. Quick cross-reference:

- Server P1 / P2 closed: `fanOut` tightening (W1); `SOURCE` hoist (W2); single Anthropic client (W3); env-check centralisation (W3); storage gate (W10); INTERNAL_ADMIN_USER factory (W10); drop unused matchEventsSourceName / matchActionSourceName (W10).
- Server P1 / P2 deferred: RoomConductor split, broadcast-runner split, kairos-bridge activation/completion test, Postgres pool consolidation, completeBroadcast lift.
- Kairos P1 closed: rename `event_priority` → `canonical_emphasis` (W2). Test coverage extensions for `mergeTierResults` (W9).
- Kairos P1 / P0 deferred: `TASK_INSTRUCTIONS` / `IMAGERY_INSTRUCTIONS` / `formatMode` lift (W6); ClosingCycleScheduler extraction; `NarrativeEngine.run` decomposition; `ContextCurator` split; `safeCurate` wrapper; `PHASE_BASE` per-profile (W8).
- Web P1 closed: `LIVE_PHASES` + `isLivePhase()` (W2); `STORAGE_KEYS` consolidation (W2).
- Web P0 deferred: matchroom + moderator hook extraction (W4 + W5).
- Shared P1 / P2 closed: dead types removed (W1); `TeamSide` shadow replacement (W1); MatchroomCue round-trip + `*_STATUSES` exhaustiveness + type-guard tests (W9); stale `ttsProvider` JSDoc (W1).
- Shared P1 deferred: name-collision rename (`BroadcastStatus`, `ConnectedCue`); moderator WS protocol typing; ~~barrel partition~~ — **reconsidered & dropped 2026-05-12** (see note below).

### Update — 2026-05-12: the "partition the barrel" P1 was dropped

The P1 "Partition `packages/shared/types/index.ts` — engine-agnostic vs Blackout-specific (sub-barrels or grouped re-export with comments)" was reconsidered and **dropped**. Reasoning: the partition's motivation was placement signal — "Kairos may import only domain-agnostic types; anyone adding a new shared type has no signal where to put it." But `apps/kairos/server` has *no dependency on `@blackout/shared`* and imports nothing from it (the audit's own "Module boundary by behaviour" check confirms this), so there is no "Kairos-may-import" set to partition for. The only files that were labelled domain-agnostic turned out to be either mislabelled-football (`match-time.ts` — `parseContentTime` bakes in `"45+2"` / `"HT"` / `"FT"`; it's the Blackout's reading of Kairos's opaque `contentTime` ordinal, used by `apps/blackout/server` + the matchroom, both Blackout) or `apps/blackout/server`/`apps/blackout/client`-only (`service-status.ts` — Kairos never touches it). So the standing rule is the stronger, simpler one: **`apps/kairos/server` doesn't import from `@blackout/shared` at all; a shape genuinely needed on both sides of the seam is duplicated, not shared — and it's almost always Kairos that owns it (it's the engine), with the Blackout side keeping its own mirror (`packages/shared/types/pipeline-cycle.ts` is exactly that).** The forward-looking item that replaces the partition: lift `pipeline-cycle.ts` into a Kairos-owned types package the Blackout imports, so the consumer-side mirror isn't hand-maintained (tracked in `apps/README.md` § Open work). Docs/skills updated to match (`CLAUDE.md`, `packages/{shared/,}README.md`, `apps/README.md`, `apps/kairos/server/{README.md,CLAUDE.md}`, `docs/vocabulary.md`, `docs/the-blackout-architecture.md`, the `blackout-shared` + `kairos-server` skills). The "Partition the barrel" row in the *Skill updates landed* table below is superseded by this.



## Headlines

### Verified — hold the line

- **Migration discipline: clean.** apps/blackout/server has 8 SQL files / 8 snapshots / 8 journal entries, all consistent. apps/kairos/server has 1 migration / 1 snapshot / 1 journal entry.
- **Paid-endpoint auth: clean.** Every paid surface (`/tts`, `/admin/tts/preview`, `/broadcasts/:id/studio/*`, `/fixtures/upcoming`, `/services/status`) carries `requireRole`. CORS origin-locked. WS upgrades validate session before accepting (`apps/blackout/server/src/index.ts:115`).
- **No judgment over fact: honoured exemplarily.** Every Kairos LLM call site (generator + imagery + summary + 8 curation services + 6 enrichment services) audited. No structured-fact extraction by an LLM. The templated-state + LLM-narrative split is enforced and documented (`apps/kairos/server/src/narrative/engine.ts:486-508`).
- **Flow over correctness: clean.** Every drop / cap / suppress / retry in Kairos is a stopping rule or upstream filter, never a correctness gate on a passage. Pacing was migrated from LLM to arithmetic in this very repo.
- **Diagnostic transport: clean.** Inspector uses HTTP polling, not the matchroom WS.
- **Module boundary by behaviour:** `grep -rn "@blackout/shared" apps/kairos/server` returns nothing. The Kairos boundary holds.
- **No LLM-for-prose in `apps/blackout/server`.** Anthropic calls are texture extraction, prompt ideation, tag derivation only.

### Headline concerns

The work is concentrated in five cross-cutting themes (next section). Of those, **WS cue type-safety** and **god-files on every surface** are the highest-leverage. They are also the work the rest of the audit's structural concerns roll up into.

## Cross-cutting themes

These appeared in 2+ surfaces and produced new skill rules.

### 1. WS cue type-safety is broken end-to-end

`RoomConductor.fanOut` (`apps/blackout/server/src/conductor/RoomConductor.ts:1173`) is typed `ConductorCue | { type: string; [k: string]: unknown }`. The escape hatch defeats `ConductorCue` for every cue added since the bundle migration: `feed_entry`, `passage_added`, `passage_audio_ready`, `passage_started`, `passage_skipped`, `passage_updated`, `broadcast_status_changed`, `latency_sample`, `service_status`, `illustration` all fan out untyped.

Matchroom client uses the typed `MatchroomCue` discriminated union (`packages/shared/types/passage.ts:75-178`). Moderator client (`apps/blackout/client/app/moderator/[broadcastId]/page.tsx:339-447`) hand-rolls 11 string-literal checks. A renamed message type breaks the moderator path silently at runtime.

Three name collisions between `packages/shared` and `apps/blackout/server/src/conductor/types.ts`: `BroadcastStatus` (divergent values), `ConnectedCue`, `GenerationSkippedCue`. Wrong import wins.

### 2. Magic-string identifiers across every surface

- **Server:** `SOURCE` registry defined in `kairos-bridge.ts:42` but bypassed by `kairos.ts:301`, `broadcast-view.ts:108`, `canonical-compose.ts:56`, `phase-logic.ts:251-252` (raw `"match_events"` / `"narrative_voice"`).
- **Web:** ~289 inline `=== "live"` / `=== "complete"` checks; phase disjunctions like `phase === "live_first_half" || phase === "live_second_half" || phase === "warming"` (`matchroom/page.tsx:1191-1196`); `localStorage` keys built ad-hoc in two patterns (`matchroom/.../utils.ts:3` vs `moderator/page.tsx:191,198`).
- **Kairos:** `event_priority` decision key written at `curator.ts:352-353` but never declared as a service; football phase strings as `PHASE_BASE`/`LIVE_PHASES` map keys.
- **Shared:** `team: "home" | "away" | null` shadowed in 7 files instead of importing `TeamSide`.

### 3. God-files violate single-responsibility on every surface

| Surface | File | LOC | Concerns | Recommendation |
|---|---|---|---|---|
| server | `RoomConductor.ts` | 1201 | 10 (subscription, FSM, narration queue, synthesis, playback, illustrations × 2 paths, recovery, snapshots, deadline, materialisation) | Split into `KairosFeedSubscriber`, `NarrationPipeline`, `PlaybackScheduler`, `IllustrationCoordinator` |
| server | `broadcast-runner.ts` | 1043 | 7 (Sportmonks, distillation, transcription, pressure, correlation, watchdog, Kairos pushes) | Split into `SourceWiring`, `TranscriptionWiring`, `LifecycleWatchdog` |
| kairos | `enrichment/pipeline.ts` | 879 | 2 entwined state machines (cadence + closing) | Extract `ClosingCycleScheduler` |
| kairos | `narrative/engine.ts` `run()` | 335 (in one method) | 11 (derive context, fetch state, format refrains, filter canonical, allocate id, fan-out generate+imagery, filter phantom covers, batch entries, clamp minute, persist, broadcast, invariants, telemetry, rate-limit handling) | Extract `prepareGenerationInputs`, `runGeneratorAndImagery`, `assembleAndPersistGeneration`, `handleRateLimit` |
| kairos | `curation/services/context-curator.ts` | 532 | 2 (echo suppression + thread surfacing — own docstring acknowledges this) | Split into `EchoSuppressor` + `ThreadSurfacer` sharing a `ThreadRecencyTracker` |
| web | `matchroom/[broadcastId]/page.tsx` | 1347 | ~10 (44 hook calls) | Hook-extraction plan below |
| web | `moderator/[broadcastId]/page.tsx` | 1016 | ~8 (83 hook calls) | Hook-extraction plan below |

### 4. Test coverage inverted to risk

- **Web (worst):** 6 test files for 177 source files. Pure helpers (`api.test.ts`, `format.test.ts`, `derivations.test.ts`) tested. Riskiest paths (playback driver, reveal contract integration, replay-walk composition, WS dispatch) untested and structurally untestable in their current inline form.
- **Server:** Pure helpers well-covered (correlation, ingest, ledger-seed, compose, transitions, name-normalise, content-time, phase-logic, dedup, view, transform, shape). Paid-spend / state code uncovered: `synthesiser.ts`, `replicate.ts`, `prompt-suggester.ts`, `tag-deriver.ts`, `kairos-bridge.ts` (activation/completion sequence — every retro cites a bug from this), `auth-middleware.ts`, no end-to-end conductor smoke.
- **Kairos:** Healthy at unit level. Gaps: `context-curator` (largest service, no dedicated test), `brief initialization` (rehydrate hot path), `canonicalEvents` drain-boundary filter, `priorityService` removal contract, `mergeTierResults` adversarial cases, `generation_skipped` rate-limit path.
- **Shared:** No round-trip test for `MatchroomCue` union (the cross-process contract). No exhaustiveness test for `*_STATUSES` / `*_PROVIDERS` Record pairings. Type guards (`isBroadcastStatus`, `isUserRole`, `isAdmin`) untested at boundary inputs.

### 5. Kairos domain leaks beyond the known PHASE map

Two new leaks surfaced (the known `PHASE_BASE` / `LIVE_PHASES` from `docs/kairos-domain-leak-open-items.md` re-confirmed unchanged):

- **P1 — `TASK_INSTRUCTIONS` constant** (`apps/kairos/server/src/narrative/generator.ts:13-41`) is concatenated into every generation's system prompt. Contains football vocabulary: "the commentary booth, radio commentators", "47+2", "may have scored", "67% territory", "Brighton are camped in Chelsea's half", "history between these clubs". This is content masquerading as infrastructure — runs every cycle regardless of profile, but is profile-specific.
- **P1 — `IMAGERY_INSTRUCTIONS` constant** (`apps/kairos/server/src/narrative/imagery.ts:71-94`) same pattern: "wide stadium, close on the pitch, crowd detail", "club badges", "if the passage IS the goal moment".

The fix shape is the same: lift to per-profile content (where seed/specs live), assemble system prompt from `voice + context + profile.taskInstructions` instead of `voice + context + hardcoded`.

Note on `SOURCE_TYPES`: the audit's first pass flagged `"moderator"` (`apps/kairos/server/src/db/enums.ts:20`) as a Blackout-specific leak. **It isn't.** "Moderator" is the generic role of "person driving the broadcast" — a debate has one, a courtroom has one, a political event has one. The enum is correct.

## TODO list by surface

Prioritisation: **P0 = correctness/security/cost gap**, **P1 = high-leverage maintainability**, **P2 = nice to have**.

### apps/blackout/server

| P | Item | Pointer |
|---|---|---|
| P1 | Extend `ConductorCue` to cover every `fanOut` call site; drop the `unknown` escape hatch | `conductor/types.ts:73`, `RoomConductor.ts:1173` |
| P1 | Hoist `SOURCE` constants to `packages/shared`; remove magic source-name strings | `kairos.ts:301`, `broadcast-view.ts:108`, `canonical-compose.ts:56`, `phase-logic.ts:251-252` |
| P1 | Create `lib/anthropic.ts`; refactor 3-way duplicated `getClient()` | `lib/distiller.ts:291-300`, `lib/prompt-suggester.ts:106-117`, `lib/tag-deriver.ts:44-53` |
| P1 | Split `RoomConductor.ts` (1201 LOC, 10 things) into `KairosFeedSubscriber` / `NarrationPipeline` / `PlaybackScheduler` / `IllustrationCoordinator` | `conductor/RoomConductor.ts` |
| P1 | Split `broadcast-runner.ts` (1043 LOC, 7 things) into `SourceWiring` / `TranscriptionWiring` / `LifecycleWatchdog` | `lib/broadcast-runner.ts` |
| P1 | Add tests: `synthesiser.ts` (wpm-floor retry), `replicate.ts` (output-shape branch), `kairos-bridge.ts` (activation + completion sequences), one end-to-end conductor smoke | `lib/synthesiser.ts`, `lib/replicate.ts`, `lib/kairos-bridge.ts` |
| P2 | Consolidate Postgres pools — single `db/connection.ts` shared by `db/client.ts`, `lib/auth.ts`, `lib/users.ts` | `db/client.ts:10`, `lib/auth.ts:28`, `lib/users.ts:7` |
| P2 | Move `DEEPGRAM_API_KEY` and `SPORTMONKS_API_TOKEN` checks to `env.ts` (boot fails loud, not at first activation) | `lib/broadcast-runner.ts:218-223` |
| P2 | Gate `/storage/:path` behind `requireAuth` so the in-memory fallback isn't a public surface | `routes/storage.ts:16-30` |
| P2 | Drop unused `matchEventsSourceName` / `matchActionSourceName` constructor injection (parameter elaboration without a payoff) | `lib/canonical-event-ingest.ts:75-77` |
| P2 | Replace `INTERNAL_ADMIN_USER` global cast with frozen factory | `lib/auth-middleware.ts:41-51` |
| P2 | Lift `completeBroadcast` event out of conductor (kills the dynamic-import workaround) | `conductor/RoomConductor.ts:438`, `:1102` |

### apps/kairos/server

| P | Item | Pointer |
|---|---|---|
| P0 | Move `PHASE_BASE` and `LIVE_PHASES` to per-profile metadata (already on open-items list) | `enrichment/content-time.ts:27-38`, `enrichment/broadcast-health.ts:44-49` |
| P1 | Lift `TASK_INSTRUCTIONS` and `formatMode` blurbs to per-profile content | `narrative/generator.ts:13-41, 292-300` |
| P1 | Lift `IMAGERY_INSTRUCTIONS` to per-profile content | `narrative/imagery.ts:71-94` |
| P1 | Rename synthetic decision key `event_priority` → `canonical_emphasis`; document as baseline | `curation/curator.ts:352-353` |
| P1 | Extract `ClosingCycleScheduler` from `EnrichmentPipeline` | `enrichment/pipeline.ts` |
| P1 | Decompose `NarrativeEngine.run` into named phases (335-line method) | `narrative/engine.ts:315-650` |
| P1 | Split `ContextCurator` into `EchoSuppressor` + `ThreadSurfacer` sharing a `ThreadRecencyTracker` | `curation/services/context-curator.ts` |
| P1 | Add `safeCurate` wrapper in `llm-curation.ts` (eliminates 6× try/catch repetition) | all curation service files |
| P1 | Add tests: ContextCurator, brief-init, canonicalEvents drain-boundary filter, priority service removal contract, rate-limit `generation_skipped` WS message | various |
| P2 | Push `getPriorState`'s DB read into `BroadcastStateTracker` (bound unbounded growth, decouple engine from DB) | `narrative/engine.ts:238-277` |
| P2 | Reword engine docstrings that name football specifics | `narrative/helpers.ts:49-56`, `feed.ts:58-63`, `enrichment/pipeline.ts:262-265` |
| P2 | Document or enforce `mergeTierResults` single-writer invariant at runtime | `curation/curator.ts:301-328` |

### apps/blackout/client

| P | Item | Pointer |
|---|---|---|
| P0 | Extract `useNarrationPlayback` from matchroom (cover-anchor reveal, audio driver, RAF) — pair with test pinning the no-spoilers contract end-to-end | `app/matchroom/[broadcastId]/page.tsx:147-335` |
| P0 | Extract `useMatchroomConnection` (WS dispatch + cue handlers + status projection) | `app/matchroom/[broadcastId]/page.tsx:763-867` |
| P0 | Extract `usePassageBundles` (TTS-off shortcut + receive + start playback) | `app/matchroom/[broadcastId]/page.tsx:349-514` |
| P0 | Extract `useReplayWalk` (replay-seed branch + canonical-state composition) — paired test for the pure walk function | `app/matchroom/[broadcastId]/page.tsx:524-699, 904-972` |
| P1 | Extract `useModeratorConnection` + `useLiveNarrativePlayback` + `useNarratorVoicePicker` | `app/moderator/[broadcastId]/page.tsx` |
| P1 | Extract `useGenerationPause`, `useRadioSourceSelection`, `useBroadcastLifecycle`, `useServiceStatus`, generic `useAutoScroll` | `app/moderator/[broadcastId]/page.tsx` |
| P1 | Type the moderator WS message protocol in `packages/shared` (discriminated union mirroring `MatchroomCue`); update both ends in same commit | `packages/shared/types/`, `apps/blackout/server/src/conductor/types.ts`, `apps/blackout/client/app/moderator/.../page.tsx:339-447` |
| P1 | Migrate `app/replays/page.tsx` off direct `fetch()` to `apiGet` | `app/replays/page.tsx:7-19` |
| P1 | Add `LIVE_PHASES` set + `isLivePhase()` predicate to `packages/shared`; replace inline disjunctions | `app/matchroom/[broadcastId]/page.tsx:1191-1196` and ~289 status checks |
| P2 | Replace duplicated `idle-hidden-scroll` + `@keyframes` blocks with single CSS module | `studio/page.tsx:466-478`, `inspector/page.tsx:243-252`, `moderator/page.tsx:1002-1011` |
| P2 | Consolidate `localStorage` keys into `lib/storage-keys.ts` | `matchroom/.../utils.ts:3`, `moderator/page.tsx:191,198` |
| P2 | Test `inspector/[broadcastId]/components/utils.ts` (283 LOC pure derivations, fully untested) | `app/inspector/[broadcastId]/components/utils.ts` |
| P2 | Split `admin/tts-voices/components/VoiceDialog.tsx` (457 LOC) into browse + configure step components | as cited |
| P2 | Lift matchroom mobile media-query block (114 LOC) out of `page.tsx` into sibling stylesheet | `app/matchroom/[broadcastId]/page.tsx:1230-1344` |

### packages/shared

| P | Item | Pointer |
|---|---|---|
| P1 | Tighten `RoomConductor.fanOut` to `ConductorCue \| MatchroomCue` (no `unknown` fallback) | `apps/blackout/server/src/conductor/RoomConductor.ts:1173` |
| P1 | Resolve name collisions: rename shared `BroadcastStatus` → `BlackoutBroadcastStatus`; resolve `ConnectedCue` / `GenerationSkippedCue` shadows in conductor types | `packages/shared/types/broadcast.ts:9`, `passage.ts:74,162` vs `apps/blackout/server/src/conductor/types.ts:96,186` |
| P1 | Partition `packages/shared/types/index.ts` — engine-agnostic vs Blackout-specific (sub-barrels or grouped re-export with comments) | `packages/shared/types/index.ts:6-16` |
| P1 | Replace `team: "home" \| "away" \| null` shadows with `TeamSide` (7 sites) | `apps/blackout/server/src/sources/sportmonks.ts:44`, `lib/lineups.ts:15`, `ws/matchroom-transform.ts:88`, `apps/blackout/client/app/matchroom/[broadcastId]/derivations.ts:58`, others |
| P2 | Add tests: round-trip for `MatchroomCue` union, exhaustiveness for `BROADCAST_*` Record pairings, type guards at boundary inputs | `packages/shared/tests/` |
| P2 | Delete dead types: `BroadcastContext`, `ClubBrief`, `PlayerContext`, `atmosphericIllustrations` | `packages/shared/types/broadcast.ts:109-125` |
| P2 | Fix stale comments: `tts_autoplay` legacy reference, `ttsProvider` JSDoc | `packages/shared/types/broadcast.ts:67-75, 16-22` |
| P2 | Promote `subType` on `ModeratorFeedEntry` to per-source discriminated unions (already flagged as known pending tightening) | `packages/shared/types/broadcast.ts:342` |
| P2 | Split `applyRevealingCanonical` — events vs phase | `packages/shared/types/canonical-state.ts:158-205` |
| P2 | Drop deprecated `BroadcastViewArchive` + `ArchiveNarration` once migration completes | `packages/shared/types/broadcast.ts:268-270` |

## Skill updates landed in this audit

The cross-cutting themes produced these new rules. Skills are the canonical statement; this section maps theme → rule for the audit trail.

| Theme | Skill | New rule |
|---|---|---|
| WS cue type-safety | `blackout-server` | Every `fanOut` payload is a typed variant; `{ type: string; [k: string]: unknown }` escape hatch is forbidden |
| WS cue type-safety | `blackout-client` | Every WS endpoint defines a discriminated union in `packages/shared`; dispatch is `switch (msg.type)` over the union — never `if (msg.type === "literal")` |
| WS cue type-safety | `blackout-shared` (new) | Cue unions must type the WS emission site at every layer; no widening with `unknown` |
| Magic-string identifiers | `blackout-server` | Source names come from `SOURCE` constants — never hand-write `"match_events"` etc. Hoist `SOURCE` to `packages/shared` |
| Magic-string identifiers | `blackout-client` | Phase / status string predicates live in `packages/shared`, not inline. `localStorage` keys live in `lib/storage-keys.ts` |
| Magic-string identifiers | `kairos-server` | Decision keys live in a single shared constants file or the registry, not as inline literals |
| Magic-string identifiers | `blackout-shared` (new) | Don't shadow shared literal unions inline — import the named union (`TeamSide`, etc.) |
| God-files | `blackout-server` | Conductor and runner files extend by composition. When either crosses ~500 LOC, split before the next change |
| God-files | `blackout-client` | Refs that mirror state to escape closure capture = signal to extract a hook |
| Domain leaks (kairos) | `kairos-server` | Refines infrastructure-vs-content rule: the test isn't "does the file run every cycle" but "is the *string* used regardless of profile". LLM prompt instructions in infrastructure files are content masquerading as infrastructure if they're domain-tuned |
| Single client per third-party | `blackout-server` | One Anthropic client per app (`lib/anthropic.ts`). One Postgres pool per app (`db/connection.ts`). Boot-time env validation in `env.ts`, not at call site |
| Direct fetch | `blackout-client` | Direct `fetch()` is forbidden — use `apiGet` / `apiPost` / `apiPatch` / `apiFetch` |
| Cross-route components | `blackout-client` | Components used by ≥2 routes move to `app/components/` |
| Test discipline | `blackout-client` | Every behavioural hook gets `<HookName>.test.ts` for non-trivial branches; every pure module gets `<module>.test.ts` |
| Dead exports | `blackout-shared` (new) | Unused exports are a maintenance liability — periodically grep for unused; when adding a type, verify it has at least one consumer |
| ~~Partition the barrel~~ → Kairos seam (superseded 2026-05-12) | `blackout-shared` + `kairos-server` | The original rule was "`packages/shared/types/index.ts` partitions engine-agnostic vs Blackout-specific exports." Superseded by: **`apps/kairos/server` doesn't import from `@blackout/shared` at all; a shape needed on both sides of the seam is duplicated, not shared (Kairos owns it; the Blackout side mirrors it in `pipeline-cycle.ts`).** See the *Update — 2026-05-12* note above. |

## Suggested sequence

If picking up the work, the highest-leverage path:

1. **WS contract repair** (1-day): tighten `fanOut` → `ConductorCue | MatchroomCue`, extend `ConductorCue`, type the moderator-side dispatch in shared. Cross-app change per `workflow`. Closes the highest-leverage type gap on the WS surface and fixes ~4 audit items at once.
2. **`SOURCE` hoist** (half-day): move to `packages/shared`, replace ~6 magic-string call sites. Sets the precedent for the other "magic strings → shared constants" work.
3. **Web hook extraction wave 1** (1-2 days): `useNarrationPlayback` + `useMatchroomConnection` for matchroom. Each lands with its `.test.ts`. Closes 4 P0 web items + creates the first behavioural test seam in the app.
4. **Kairos `TASK_INSTRUCTIONS` lift to profile content** (1 day): biggest infra-vs-content leak. Ships alongside `IMAGERY_INSTRUCTIONS` + `formatMode`. Closes 3 P1 kairos items.
5. **Server god-file splits** (multi-day): RoomConductor and broadcast-runner. Lower urgency — the runtime is correct — but unblocks the in-flight `passage_*` migration and unlocks integration tests.

The kairos `PHASE_BASE` / `LIVE_PHASES` (P0) is right to defer until onboarding a second consumer or starting the next architecture cluster — it's load-bearing on the engine type system and needs a profile-metadata design.

## What this audit didn't cover

- Tests in `tests/` directories were used as evidence of coverage, not audited themselves.
- Scripts (`apps/blackout/server/scripts/`, `apps/kairos/server/scripts/`) were skipped — replay/seeding scripts have lower review value than runtime code.
- The four agent reports went deeper than this synthesis on per-pillar concerns. If a TODO is opaque, the agent transcripts in conversation context have the full reasoning.
