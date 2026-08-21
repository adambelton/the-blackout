# apps/blackout/server — the Blackout backend (room conductor)

The stateful Hono service that *is* the live broadcast. It captures the football-specific sources (Sportmonks events, the moderator's transcribed radio audio), distils commentary into structured texture, pushes typed feed entries to Kairos, receives narratives back, synthesises TTS and illustrations, authors the per-passage canonical bundle the matchroom walks, and schedules timing cues — one server-side clock, fanned to every matchroom and moderator client over direct WebSocket. It does **no** prose generation; that is [Kairos](../../kairos/server/README.md)'s job. Runs on :4000.

This README is the backend-as-a-service checkpoint: what it owns, the source-capture pipelines, the conductor's authority + cue vocabulary, the seams to Kairos and to the web, the broadcast lifecycle, how to run it, what working looks like. For the Blackout consumer side as a whole (this + `../client/`) see [`../README.md`](../README.md); for the cross-service view (Blackout ↔ Kairos), see [`../../README.md`](../../README.md). For internals, see the `src/<module>/README.md` files. The legacy [`docs/the-blackout-architecture.md`](../../../docs/the-blackout-architecture.md) is the canonical consumer-side architecture; it is being decomposed into this vertical + the `apps/blackout/client` one and carries a redirect header.

## What it owns — and what it doesn't

**It owns:**
- **Source capture.** Football-specific adapters: the Sportmonks event/stat poller (`src/sources/sportmonks.ts`), the moderator's UK-resident-browser radio audio (Web Audio + AudioWorklet → linear16 PCM frames over the moderator WS → the Deepgram transcription pipeline), and moderator-typed editorial notes. Each is stamped with a content-time phase anchor (radio-offset-corrected) and pushed to Kairos as a generic feed entry.
- **Distillation.** Raw radio commentary never reaches Kairos. The Haiku distiller (`src/lib/distiller.ts`) classifies utterances into `atmosphere` / `event_texture` / `event_claim`; the buffer + the event-correlation ledgers (`src/lib/distillation-buffer.ts`, `event-correlation.ts`, `canonical-event-ingest.ts`) match texture/claims against canonical Sportmonks events, link texture to its parent event, and feed the radio-offset calibration loop (`effective-offset.ts`).
- **The room conductor.** One `RoomConductor` per broadcast (`src/conductor/`): subscribes to Kairos's feed WS, runs the broadcast-phase FSM, synthesises each narrative to audio (`synthesiser.ts` → TTS), generates or resolves an illustration (`generateImage` → Replicate, or a pre-prepared pool image), composes the per-passage canonical bundle (`canonical-compose.ts`), schedules playback by `setTimeout` keyed on clip duration, and fans cues to every subscribed WS client. The server-side `setTimeout` is the authoritative clock; clients react.
- **The web-facing surface.** HTTP routes (`src/routes/`): broadcasts CRUD + lifecycle, the content studio (illustration pool prep + brief editing), admin (users, TTS-voice catalogue), the pipeline inspector (proxying/aggregating Kairos's read endpoints), TTS preview, radio-source catalogue, and storage serving. Two WebSocket endpoints (`src/ws/`): `/ws/moderator` (writer/admin control surface — read-write) and `/ws/matchroom` (listener viewer — read-only).
- **Persistence + assets.** Its own Postgres (Drizzle): broadcasts, narrations (audio artefacts + canonical bundles), illustrations, radio sources, TTS voices, and discarded prompts. Asset bytes normally go to Cloudflare R2; development uses the `blackout-dev` bucket. The in-memory provider is reserved for tests and isolated fallback use. Auth: Better Auth (session validation only — the web side issues sessions; this side reads them).

**It doesn't own:** prose generation (Kairos), narrative orchestration / curation / the four-stage pipeline (Kairos), the unified feed (Kairos owns the durable feed; this server's "entry cache" is a 500-entry LRU for invariant checks), any user-facing rendering (the web app). The seam to Kairos is `src/lib/kairos.ts` (the typed HTTP/WS client); it is one-way — the server depends on Kairos, Kairos doesn't know its consumer.

## The pipelines, end to end

```
moderator browser ──PCM frames──▶ /ws/moderator ──▶ TranscriptionPipeline (Deepgram)
 │ utterance + utteranceEndWallClock
 ▼ (− effectiveOffsetSeconds → real match moment)
 name-normalise (against the roster)
 ▼
 CommentaryDistillationBuffer ──12s timer / pre-canonical flush──▶ distiller (Haiku)
 │
 ┌─────────────────────────────┼─────────────────────────────┐
 ▼ atmosphere ▼ event_texture ▼ event_claim (internal — never to Kairos)
 push match_action correlate vs canonical correlate vs canonical → calibration sample
 │ │ (parentSourceId on match) │ (EWMA-updates effectiveOffsetSeconds;
 │ │ else buffer in pendingTextures) │ recordObservation on the radio source;
 │ ▼ │ latency_sample cue to the moderator UI)
 └──────────────────▶ pushEntry(SOURCE.matchAction, …) ◀────────┘

SportmonksEventSource ──poll fixture──▶ onEvent / onStat / onKickoff|Halftime|SecondHalfKickoff|Fulltime
 onEvent → ingestCanonicalEvent → flush distiller → buildCanonical → resolveCanonical (release matched textures w/ parentSourceId,
 emit calibration) → normaliseEventNames → pushEntry(SOURCE.matchEvents, canonical: true, …)
 onStat → PressurePipeline (ball position + trends → zone_entry / pressure_update signals) → pushEntry(SOURCE.matchPressure, …)
 on…whistle → push synthetic match_events transition entry (KICKOFF/HALFTIME/SECOND_HALF_KICKOFF/FULL_TIME, phaseSecond=0,
 + closingExtensionSeconds=15 & closingPrompt on HALFTIME/FULL_TIME) → conductor observes it on its feed sub → phase FSM advances

 every pushEntry stamps: subjectTime (subject time, radio-offset-corrected), phase, phaseSecond — and consults the conductor's
 decideSourcePushAllowed gate (live phases: open; post-whistle ≤15s: closing-window texture; warming: only match_action pre_match;
 else: suppressed)

Kairos feed WS (per broadcast) ──▶ RoomConductor.onKairosNarrative / onImageryDecision / onGenerationSkipped / onEntry
 onEntry → cacheEntry (LRU 500) + maybeTransitionFromEntry (phase FSM) + fanOut feed_entry (moderator renders; matchroom drops)
 onImageryDecision → handleImageryDecision: pool → resolve illustration bytes by illustrationId from consumerMetadata → illustration cue
 generate → Replicate (parallel with synthesis) → illustration cue
 hold → no-op
 onKairosNarrative → checkNarrativeInvariants (event-uncovered, score-phrase-without-goal) → composePassageBundle
 (revealedCanonical snapshot + revealingCanonical deltas; fold revealing into runningCanonical) → fanOut narrative
 + passage_added → enqueue → drainSynthesisQueue (serial): synthesiseNarration (TTS → measure MP3 duration → persist
 broadcast_narrations row w/ the bundle) → passage_audio_ready → onNarrationReady → startPlayback:
 fanOut play + passage_started, persist playbackStartedAt, setTimeout(onClipEnd, durationMs + 400ms gap)
 onClipEnd → reportPacing(words, seconds) to Kairos → decideClipEndAction (advance_queue | wait_for_closing_passage
 | complete_broadcast | suppress_winddown_complete) → advance or complete

 fanOut → every subscribed WS client; matchroomTransform whitelists the playback/reveal cues and reshapes feed_entry → viewer DTO;
 moderator gets nearly everything (incl. feed_entry, latency_sample). The conductor's clock is the truth — clients compute
 offset from (serverNow − playbackStartedAt) on every `play` and on `connected.currentPlay`/`currentPassage`.
```

## The conductor's authority — the cue vocabulary

The matchroom and moderator clients hold no state and no clock — they react to cues from the conductor (full type union: `ConductorCue` in `src/conductor/types.ts`; the bundle cues are sourced from `@blackout/shared` so server and web type the same wire shapes). The Design-A reveal architecture (`docs/matchroom-reveal-architecture-scoping.md`) is mid-migration: legacy playback cues (`connected` / `narrative` / `preload` / `play` / `phase` / `illustration`) still fire alongside the bundle cues (`passage_added` / `passage_audio_ready` / `passage_started` / `passage_skipped` / `passage_updated` / `broadcast_status_changed`) — the matchroom currently consumes the legacy path; a later sub-piece flips it to the bundle path and a later one retires the legacy cues. The reveal contract: a passage carries `revealedCanonical` (the room's visible state at this passage's audio-start) + `revealingCanonical` (the deltas this passage reveals during its audio — each marker either has a `charOffset` into the prose, for an early reveal mid-audio, or no offset, for an audio-end reveal); folding `revealingCanonical` forward into the running state upholds the chain invariant (`revealedCanonical[N+1] === apply(revealedCanonical[N], revealingCanonical[N])`). Nothing is visible before the narrator has spoken it — *audio is canonical* (the matchroom no-spoilers principle). Operator-only cues (`feed_entry`, `latency_sample`) reach the moderator but the matchroom whitelist drops them.

## The seam to Kairos

`src/lib/kairos.ts` is the typed HTTP/WS client (every Kairos call goes through it — no direct DB or internal imports across the boundary); `src/lib/kairos-bridge.ts` wraps the per-broadcast lifecycle (`linkBroadcastToKairos` creates the Kairos broadcast + seeds `narrative_voice`/`narrative_context` + persists `kairosBroadcastId`; `activateBroadcast` flips both sides to active + seeds the lineups block + starts the runner; `completeBroadcast` flips both to complete + stops the runner + clears the roster; `reportPacing` maps a clip's words/seconds to a `slow_down`/`speed_up`/`on_track` signal); `src/lib/kairos-heartbeat.ts` pings the feed WS every 15s and terminates on missed pong (Kairos restarts under `tsx watch` leave consumer sockets half-open and TCP keepalive alone takes minutes). The source names are the `SOURCE` constants in `@blackout/shared` — `matchEvents` (canonical: goals/cards/subs/synthetic transitions), `matchPressure` / `matchStats` (contextual — non-canonical so the canonical flag stays on real events), `matchAction` (distilled atmosphere + event_texture), `moderator` (typed notes), `narrativeContext` / `narrativeVoice` (the brief + author voice, seeded pre-activation). The consumer's stamping responsibility — `phase`/`phaseSecond` (the subject ordinal Kairos batches on, set from the runner's calibrated radio-offset estimate — see [`../../docs/vocabulary.md`](../../docs/vocabulary.md) § Time), `subjectTime` (the subject-time string), `closingExtensionSeconds`/`closingPrompt` on phase whistles, `sourceId`/`parentSourceId` — is the runner's `pushEntry`. See [`../../README.md`](../../README.md) § "blackout-server → kairos-server" for the full contract.

## The web-facing surface

HTTP (`src/routes/`, all behind origin-locked CORS + the `authContext` middleware; role gates per-route via `requireAuth` / `requireRole`): `broadcasts` (CRUD + `linkBroadcastToKairos`/`activateBroadcast`/`completeBroadcast` + `getBroadcastRunnerStatus` + `buildBroadcastView`/`buildModeratorView`), `studio` (illustration pool: generate via Replicate, push to Kairos's content pool with the `illustrationId` stashed on `consumerMetadata`, derive tags, suggest prompts with discarded ones as negative context; brief editing), `admin` (users → set role; TTS-voice catalogue CRUD + preview — admin only), `inspector` (proxies Kairos's `listCycles`/`getCycle`/`getBroadcastHealth`/`getGeneration`/`listBroadcastEntries` + resolves narration/illustration storage URLs — writer/admin), `tts` (voice list + preview synthesis — writer/admin, gated again on the broadcast's `ttsEnabled` kill switch), `radio-sources` (catalogue CRUD — admin), `storage` (serves bytes when the in-memory provider is active — auth-gated; R2 URLs point at Cloudflare, not here), `health`. WebSocket (`src/ws/`): `/ws/moderator` (writer+admin; relays audio chunks to the runner's transcription pipe, moderator notes to the runner, registers with the conductor, sends `checkServices` status on connect) and `/ws/matchroom` (any authenticated user — tier gating lands later; registers with the conductor via a matchroom-shaped transform). WS upgrades don't go through Hono middleware — `src/index.ts` validates the Better Auth session cookie on the raw upgrade event and routes manually.

## Broadcast lifecycle

```
draft ──(create in studio)──▶ scheduled ──(activate)──▶ live ──(complete)──▶ complete ──(admin curate)──▶ archived
 │ kairosBroadcastId linked │ conductor stopped, runner │ excluded from
 │ (linkBroadcastToKairos); │ stopped; matchroom flips │ /replays
 draft/scheduled: no conductor, no runner. │ Kairos broadcast → active │ to replay mode (refetches
 The Kairos broadcast may already be linked │ (seeds voice/context, gated │ GET /broadcasts/:id)
 but is `pending`. │ on non-empty author brief);
 │ runner starts (Sportmonks
 │ poll, Deepgram arm, pressure);
 │ conductor starts (Kairos feed
 │ sub, phase FSM at `warming`)
```

The broadcast-phase FSM (the conductor's view, distinct from the row's lifecycle status — `BroadcastPhase` in `@blackout/shared`): `pre_ramp` → `warming` (activation→kickoff; Kairos's empty-buffer cycles produce 1–2 scene-setters then fall silent) → `live_first_half` (kickoff→HT whistle; entries flow) → `halftime` (HT→2H kickoff; one explicit "first-half reflection" generation, then quiet, no entries pushed) → `live_second_half` (2H kickoff→FT; entries flow) → `full_time_winddown` (FT→completion; one explicit "closing passage" generation; the closing-deadline timer protects the broadcast from auto-completing mid-roundtrip) → `complete` (terminal). Transitions are driven by Sportmonks whistle callbacks → the runner pushes a synthetic `match_events` transition entry → the conductor observes it on its feed subscription (same path replay uses) → `nextPhaseFromEntryPhase` advances the FSM (monotonic — never backwards; idempotent on same phase). On a server restart, `rehydrateLiveBroadcasts` re-creates the conductor + runner for every broadcast still marked `live`; the conductor recovers its phase from Kairos's latest transition entry and its running canonical state by folding every persisted narration's `revealingCanonical` forward (a stale `live` broadcast with a FULL_TIME entry that's hours old gets finalised instead of respawned — the condensed-replay-run case).

## What a working broadcast looks like

`pnpm --filter @blackout/server dev` (or `pnpm run dev` from the repo root). A healthy live broadcast:
- `[broadcast-runner:<id>] transcription armed for <source> (browser-capture mode, offset Ns)`, `[broadcast-runner:<id>] polling fixture <id>`, `[broadcast-runner:<id>] canonical ledger seeded with N entries`.
- `[transcript:<id>] "<utterance>" @<subjectTime>` per radio line; distiller flushes every ~12s; `[broadcast-runner:<id>] [latency] GOAL@67 raw Δ -2.3s (offset 8.0s → 8.7s; seed 9s)` when a calibration sample lands — the `[latency]` deltas converging tells you the radio offset is calibrated.
- `[conductor:<id>] started (kairos=<id>, tts=on)`, then per cycle: `narrative` arrives → `[conductor:<id>] phase live_first_half → ...` only at whistles → synthesis (2–3s, serial) → `narration_synthesised`/`narration_play_started` telemetry → `play` cue → `setTimeout(onClipEnd)` → `onClipEnd` reports pacing back to Kairos.
- No `event_uncovered` / `score_phrase_without_goal` invariant warnings in the logs/PostHog (occasional are tolerated; a run is a regression — the "full time, a draw at 3-0" family).
- The matchroom reveals text/events/score/illustration in step with the narrator's audio; the moderator console shows the raw feed (`feed_entry` cues), the latency samples, and the service-status dots.
- `GET /broadcasts/:id/runner-status` shows the runner active with no `lastError`; `checkServices` shows Sportmonks/Deepgram/Kairos green.

## Development

```bash
pnpm --filter @blackout/server dev # tsx watch on :4000 (predev runs migrate + check)
pnpm --filter @blackout/server build # tsc
pnpm --filter @blackout/server test # node --test (pure / module-mocked — no real LLM, no DB except the e2e roundtrip)
pnpm --filter @blackout/server eval:distiller # `manual/distiller-eval/run.ts` — real-Anthropic golden set; NOT in `pnpm test` / CI; run before shipping a distiller-prompt change
# db: pnpm db:generate / db:migrate / db:check (post-migrate drift detector) / db:reset (local-only drop+migrate+seed; the SOP when db:check flags drift) / db:push (local throwaway only) / db:studio
```

Health: `GET http://localhost:4000/health`. WS: `ws://localhost:4000/ws/moderator?broadcastId=…` (writer/admin), `ws://localhost:4000/ws/matchroom?broadcastId=…` (any authenticated user). `predev` and the test harness apply migrations and run `db:check`; a mismatch between the applied-migration cursor and journal, or a missing schema table, fails fast. When `db:check` reports local drift, `pnpm db:reset` is the sanctioned recovery. Migration discipline is documented in the [root CLAUDE.md](../../../CLAUDE.md) and the [`migrations` skill](../../../.claude/skills/migrations/SKILL.md). `src/scripts/` holds local operator/probe tooling. `manual/distiller-eval/` is the real-LLM golden set for the distiller prompt. The former hosted deployment has been retired.

## Open work — server-wide

WIP spanning more than one `src/` module lives here; module-internal WIP lives in that module's README; cross-half items (spanning `../client/` + `../server/`) in [`../README.md`](../README.md) § Open work; cross-service items (spanning Blackout + Kairos) in [`../../README.md`](../../README.md) § Open work. The items below are retained as technical follow-up ideas from the codebase audits and live-test debriefs, not an active roadmap.

- **`RoomConductor.ts` is a 1240-line god-file.** Synthesis queue, playback clock, illustration routing, the canonical-bundle composition wiring, phase side-effects, WS fan-out, the closing-deadline machinery, recovery — all in one class. Candidate splits: a `PlaybackScheduler` (queue + clock + clip-end), an `ImageryRouter`, a `BundleComposer` wiring layer. Needs an end-to-end conductor smoke + the kairos-bridge activation/completion tests first. Tracked in [`docs/codebase-audit-2026-05-10.md`](../../../docs/codebase-audit-2026-05-10.md).
- **`broadcast-runner.ts` is a 1073-line god-file.** Source wiring, distillation-buffer wiring, the three correlation ledgers, the calibration loop, the synthetic-transition emission, the lifecycle watchdog, the prune sweep — one class. Candidate splits: a `SourceCapture` layer, a `CorrelationLedger` wrapper, the calibration loop. Same tests-first requirement.
- **The legacy reveal cues are still firing alongside the bundle cues.** `passage_*` + `broadcast_status_changed` are emitted, but the matchroom consumes the legacy `narrative`/`play`/`illustration` path. Sub-piece 4c flips the matchroom; 4d retires the legacy cues. Until then both paths emit the same content-time values via separate code (the monotonic clamp on the emitted content minute is duplicated between Kairos's `clampMonotonicMinute` and the server's `composeContentMinute`, because `play.contentTime` and `revealedCanonical.contentMinute` are separate channels). → [`docs/matchroom-reveal-architecture-scoping.md`](../../../docs/matchroom-reveal-architecture-scoping.md); summarised in [`src/conductor/README.md`](src/conductor/README.md).
- **`ConnectedCue` name collision.** The conductor's legacy `ConnectedCue` (`currentPlay`) shadows the shared `Connected` cue (`currentPassage`); both ship on `connected` today. Resolving it is the moderator-WS-protocol typing work — a discriminated-union design for the moderator channel. Cross-service; tracked in [`docs/codebase-audit-2026-05-10.md`](../../../docs/codebase-audit-2026-05-10.md) and [`../../README.md`](../../README.md) § Open work.
- **`distiller` event-class tags are unverified Haiku judgment until correlated.** Uncorrelated `event_texture` whose `eventClass` never matched a canonical is demoted to plain `atmosphere` (the "Euler Brand finished cleanly" fictional-equaliser fix from the 2026-04-26 FA Cup SF) — but the demotion happens on the prune sweep (30s), not immediately. A claim that arrives, fails to correlate, and ages out is just dropped (no-match telemetry). Per-event-class correlation windows + per-class radio-offset profiles are MVP tuning work.
- **`attackingThirdShare` saturates at 100%.** The pressure pipeline's territory metric pins at 100% in sustained-siege phases (observed across live tests), which the narrator (correctly told not to recite numerals) renders fine, but the inspector's pressure trace is uninformative when saturated. Open.
- **Moderator WS protocol is loosely typed.** The handler accepts text + binary frames without a discriminated message union; same gap as the inspector audit flagged. → [`src/ws/README.md`](src/ws/README.md).
- **`docs/the-blackout-architecture.md` has drifted** — it predates the Design-A bundle architecture, the distillation pipeline's current shape, and the closing-deadline machinery. It carries a redirect header pointing here; treat this vertical as canonical for `apps/blackout/server` and the legacy doc as background until it's retired.

## See also

- [`../README.md`](../README.md) — the Blackout consumer side (the two halves) and the client↔server seam.
- [`../../README.md`](../../README.md) — `apps/` — the two services (Blackout + Kairos) and the inter-service seam contract in full.
- [`src/conductor/README.md`](src/conductor/README.md) — the room conductor, the phase FSM, the cue vocabulary, the canonical-bundle composition.
- [`src/sources/README.md`](src/sources/README.md), [`src/pipeline/README.md`](src/pipeline/README.md), [`src/lib/README.md`](src/lib/README.md), [`src/routes/README.md`](src/routes/README.md), [`src/ws/README.md`](src/ws/README.md), [`src/db/README.md`](src/db/README.md) — the modules.
- [`apps/kairos/server/README.md`](../../kairos/server/README.md) — the engine this server is the consumer of.
- [`apps/blackout/client/README.md`](../client/README.md) — the frontend that reads this server's cues. *(pending)*
- [`CLAUDE.md`](CLAUDE.md) — conventions for AI-assisted dev (thin pointer + rules).
- [`.claude/skills/blackout-server/SKILL.md`](../../../.claude/skills/blackout-server/SKILL.md) — the rule set, auto-loaded on `apps/blackout/server/**` reads.
- [`docs/the-blackout-architecture.md`](../../../docs/the-blackout-architecture.md) — legacy canonical doc, being decomposed here; drifted (see Open work).
