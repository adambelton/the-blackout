# The Blackout — system architecture

> **⚠️ Being decomposed into the README tree (2026-05-11).** The canonical consumer-side architecture now lives in [`apps/blackout/server/README.md`](../apps/blackout/server/README.md) (the backend as a service: source capture, the conductor, the cue vocabulary, the Kairos seam, the broadcast lifecycle) + each `apps/blackout/server/src/<module>/README.md` + (pending) `apps/blackout/client/README.md` + the web route READMEs. **Treat the READMEs as canonical; this document predates the Design-A matchroom-reveal bundle architecture (`passage_*` cues + `revealedCanonical`/`revealingCanonical`), the current distillation pipeline shape (`distiller` → `distillation-buffer` → `event-correlation`), the closing-deadline machinery, and the radio-offset calibration loop — it has drifted.** This file will be retired into a thin index once the `apps/blackout/server` + `apps/blackout/client` verticals are verified.

A canonical mental map of the consumer side. Written 2026-04-25 to sit alongside [`kairos-architecture.md`](./kairos-architecture.md) — the engine doc explains how meaning is produced; this doc explains how a football match becomes a room of people listening to a narrator together.

> **Kairos doesn't know about football. The Blackout doesn't know about orchestration. The Blackout's job is everything Kairos isn't doing — capture sources, synthesise audio, generate illustrations, conduct the room, fan cues out, render the matchroom, gate access.**

## 1. System at a glance

A Mermaid diagram of the consumer-side system — source capture → Kairos → conductor → web clients, with the pacing-feedback loop and auth gate — lives at [`the-blackout-architecture-diagram.md`](./the-blackout-architecture-diagram.md). Open it for the visual; the rest of this doc is the narrative.

## 2. System boundary

### What The Blackout is

The consumer of Kairos. A football-aware product that:

- Captures domain-specific sources (Sportmonks events, BBC / TalkSPORT radio commentary, moderator input).
- Pushes them to Kairos as typed feed entries.
- Receives narrative + imagery decisions back over Kairos's feed WebSocket.
- Synthesises audio, generates illustrations, persists assets to R2.
- Conducts a single shared room — one server-side clock, every connected client hears the same audio at the same instant.
- Renders matchroom + moderator + studio surfaces in Next.js.
- Gates access through Better Auth sessions + role.

### What The Blackout is not

- **Not the narrative engine.** Kairos owns enrichment, curation, generation, refrains, summary, pacing. The Blackout never calls an LLM for prose.
- **Not domain-agnostic.** Football types, Sportmonks shapes, radio stream URLs, ASR roster normalisation — all live here. Kairos sees only `event` / `moderator` / `narrative_context` / `narrative_voice` source types.
- **Not stateless.** The conductor is a long-lived in-memory process per broadcast. Next.js API routes can't hold the playback clock or the fan-out set; the dedicated Hono server can.

### Engine contract

Kairos lives at `apps/kairos/server/` and runs on `:5050`. The Blackout talks to it from `apps/blackout/server/src/lib/kairos.ts` (typed REST + WS client) and `apps/blackout/server/src/lib/kairos-bridge.ts` (high-level lifecycle: link, activate, complete, pacing). Dependency is one-way: Kairos doesn't know its consumer exists.

The seven sources every broadcast registers on Kairos at link-time live in `@blackout/shared::SOURCE` (re-exported from `apps/blackout/server/src/lib/kairos-bridge.ts` for backwards-compat — hoisted to shared 2026-05-10 so any app can type-check against the names without burying the constant in apps/blackout/server):

| Source name | Kairos type | `canonical` | Purpose |
|---|---|---|---|
| `match_events` | `event` | true | Sportmonks goals / cards / subs / VAR / phase transitions. Auto-emphasised by curation. |
| `match_pressure` | `event` | false | Derived zone / pressure signals from trends + ball coords. |
| `match_stats` | `event` | false | Reserved for future Sportmonks stat windows. |
| `match_action` | `event` | false | **Distilled** commentary observations — atmosphere (crowd, manager, ambient) and event_texture (build-up, reactions, body language around canonical events). Raw Deepgram transcription is no longer pushed; the Blackout-side distiller filters editorial / opinion / event-fact claims and emits structured atmosphere + event_texture. event_texture entries carry an optional `parentSourceId` linking them to a canonical Sportmonks event. |
| `moderator` | `moderator` | false | Free-text notes from the moderator console. |
| `narrative_context` | `narrative_context` | — | Match brief + lineup roster (seeded at activation). |
| `narrative_voice` | `narrative_voice` | — | Default product voice from `content/voice.md` (seeded at activation). |

The legacy `transcription` source was retired 2026-04-26 along with the goal-only correlator. The distillation pipeline below is the only path commentary takes into Kairos now.

## 3. The pipeline — three stages

```
SOURCES
 → Source pipelines (apps/blackout/server/src/sources/, apps/blackout/server/src/pipeline/)
 → BroadcastRunner (apps/blackout/server/src/lib/broadcast-runner.ts)
 → Kairos (POST /broadcasts/:id/entries)

ENGINE
 → Kairos enrichment + curation + generation
 → narrative + imagery decisions on the feed WS

PRESENTATION
 → RoomConductor (apps/blackout/server/src/conductor/RoomConductor.ts)
 → TTS synthesis + Replicate imagery, persist to R2
 → Fan out cues to /ws/matchroom + /ws/moderator
 → Web clients render and play in lock-step
```

The Blackout owns the first and third stages. The middle stage is Kairos.

### Stage 1 — Source capture

**Owner:** `apps/blackout/server/src/sources/`, `apps/blackout/server/src/pipeline/`, orchestrated by `apps/blackout/server/src/lib/broadcast-runner.ts`.

**What it does:**

- A `BroadcastRunner` is created at activation, one per broadcast. It owns:
 - A `SportmonksEventSource` (`apps/blackout/server/src/sources/sportmonks.ts`) — polls the configured fixture every 15s, deduplicates by row id + semantic fingerprint, normalises events, derives a phase category (pre / live_first_half / halftime / live_second_half / full_time), fires phase callbacks (`onKickoff`, `onHalftime`, `onSecondHalfKickoff`, `onFulltime`), and emits a per-event subject time (the match minute — today's `subjectTime` field) for entries lacking their own.
 - A `TranscriptionPipeline` (`apps/blackout/server/src/pipeline/transcription.ts`) — opens a Deepgram WebSocket and forwards audio chunks pushed in by the moderator's browser. Anchors transcripts on per-utterance `start`/`duration`; the per-stream `defaultOffsetSeconds` calibration (the broadcast↔subject delta — see `docs/vocabulary.md` § Time) is applied downstream when stamping subject time on the resulting entries. An earlier version fetched the radio stream server-side (direct MP3 / HLS / ffmpeg-transcoded), but hosted egress did not reliably satisfy the UK-only source restrictions. Capture now happens in the moderator's UK-resident browser (see "Audio capture (browser-side)" below) and arrives over the moderator WebSocket as binary frames.
 - A `PressurePipeline` (`apps/blackout/server/src/pipeline/pressure.ts`) — derives `zone_entry` / `zone_middle` / `pressure_update` signals from raw trends + ball coords. Raw stats are suppressed from the Kairos push and the moderator feed.
 - A `CommentaryDistillationBuffer` (`apps/blackout/server/src/lib/distillation-buffer.ts`) — buffers Deepgram utterances and flushes them through the distiller (`apps/blackout/server/src/lib/distiller.ts`) every 12s, or reactively the moment a Sportmonks event arrives. Each Haiku call classifies the chunk into `atmosphere`, `event_texture`, and `event_claim`. Atmosphere and event_texture become `match_action` entries on Kairos; event_claim is internal-only — it feeds the correlator below. **Raw transcription never reaches Kairos** — the editorial / opinion / event-fact-claim filtering is what closes the bleed-through path that surfaced the £262m thread in every Brighton-Chelsea test before the distillation pass landed (2026-04-26).
 - An event-correlation ledger (`apps/blackout/server/src/lib/event-correlation.ts`) — three buffers (canonical Sportmonks events, pending event_claims, pending event_texture). When a canonical event arrives, the runner flushes the distillation buffer first, then runs `resolveCanonical` against pending claims/textures: matched textures release as `match_action` with `parentSourceId` set; matched claims fire a calibration sample. Per-class match windows (90s default, 120s for VAR). Phase whistles are mirrored as virtual canonical entries on the conductor's `onKickoff`/`onHalftime`/etc. callbacks, so commentary's matching claims contribute calibration samples from minute one of every match — every event class contributes timing data, not just goals (replaces the goal-only `goal-correlation.ts` retired 2026-04-26).
- Moderator notes arrive through `/ws/moderator` (`apps/blackout/server/src/ws/moderator.ts`). The runner doesn't own them — the WS handler pushes them through the same `kairos.pushEntry` path with `source: "moderator"`.

**Why this shape:**

- **One runner per broadcast.** The runner *is* the broadcast — there's no meaningful state between "live" and "no sources running." Lifecycle is owned by `kairos-bridge`: activation starts the runner, completion stops it (renamed from `AutoBroadcastRunner` 2026-04-22 — the old name implied optional/automated when in fact it's the broadcast).
- **Phase gating at the conductor.** `RoomConductor.canPushFromSource(sourceType)` is consulted before forwarding match_events / pressure / stats. Ambient sources (`narrative_voice`, `narrative_context`) and `match_action` are always allowed (`UNGATED_SOURCES` in `RoomConductor.ts`) — distilled pre-match commentary (atmosphere) fills the warming phase before Sportmonks detects kickoff.
- **Distillation as bleed-protection.** Commentary's value (atmosphere, in-game action context, observations the commentator can see and we can't) and noise (opinions, redundant takes our pressure data already measures, speculation, editorial framing) are mixed in the same source. The Blackout-side Haiku pass at the source draws the line — the narrator sees structured texture, never raw editorial. The distiller is also where domain vocabulary discipline lives (e.g. "pressing" only in its strict out-of-possession sense).
- **Calibration as a measurement loop.** Every event class commentary identifies (KICKOFF / HALFTIME / GOAL / YELLOW_CARD / SUBSTITUTION / etc.) becomes a calibration sample when its canonical row arrives within window. Replaces the goal-only name-substring matcher with a structured signal that works from the opening whistle and across every event type.
- **Subject-time stamping is load-bearing for Kairos batching.** Every entry the runner pushes carries `phase` + `phaseSecond`, derived from the calibrated radio offset (`runner.pushEntry` / `pushModeratorMessage` stamp via `events.getSubjectTime(now - radio_offset)`. Kairos's pipeline now batches cycles by *subject time* (the time IN the match being commentated on), not broadcast wall-clock — entries with stamped ordinals get held until their subject-time window has settled (default 60s lag for late arrivals). Calibration accuracy directly determines whether legitimate late events land in their proper window or get discarded by Kairos's late-arrival policy. See `docs/vocabulary.md` § Time for the three-domain model and `docs/kairos-architecture.md` §Stage 1 for the engine side.
- **Roster normalisation at the seam.** Lineups fetched at activation feed a roster registry (`apps/blackout/server/src/lib/roster-registry.ts`); transcripts pass through `normaliseTranscript(text, roster)` (`apps/blackout/server/src/lib/name-normalise.ts`) before reaching the distiller. ASR garbles ("Fabon", "Aeling") get rewritten to canonical spellings so the engine sees one stable identity per player.

#### Audio capture (browser-side)

Lives in the moderator console (`apps/blackout/client/app/moderator/[broadcastId]/page.tsx`) once the broadcast is `live`, with the entire pipeline encapsulated in a `useAudioCapture` hook (`apps/blackout/client/app/moderator/[broadcastId]/useAudioCapture.ts`). The moderator's browser does the actual fetch of the radio stream URL — `<audio crossOrigin="anonymous">` for direct MP3 (TalkSPORT), `hls.js` (with `liveSyncDuration: 1`) for HLS (BBC). The element is tapped through Web Audio: a `MediaElementAudioSourceNode` splits into two branches — `GainNode → AudioContext.destination` (speakers, default-muted on goLive; the listen toggle controls this branch's gain only) and an `AudioWorkletNode` (capture, always full-volume regardless of speaker gain). The worklet processor (`apps/blackout/client/public/audio-capture-processor.js`) decimates to 16 kHz mono, converts Float32 → Int16 PCM, and posts ~250 ms windows over the worklet port; each window is forwarded to the moderator WebSocket as a binary frame. The server (`apps/blackout/server/src/ws/moderator.ts`) routes binary frames to `pushAudioChunkToRunner(broadcastId, buf)`, which forwards into the runner's transcription pipeline. Deepgram is told the format explicitly (`encoding: linear16, sample_rate: 16000, channels: 1`).

**Why AudioWorklet/PCM and not MediaRecorder/webm/opus.** The capture branch was originally `MediaRecorder` → `audio/webm;codecs=opus`. Switched to AudioWorklet/linear16 PCM 2026-05-02 after the Ipswich-QPR live test surfaced a hard incompatibility between Chrome's MediaRecorder webm/opus output and Deepgram's parser — Deepgram returned `duration: 0, channels: 0` in the Metadata handshake then closed cleanly with code 1000 every time. Raw PCM bypasses the container/codec compatibility surface entirely; Deepgram parses it with explicit format flags rather than sniffing container framing. Bonus: PCM has no init segment to lose on WS reconnect (the old MediaRecorder path required a recorder-restart to ship a fresh init segment after a disconnect; that whole problem class is gone).

The pivot to browser-side capture was forced by hosted outbound traffic geolocating outside the UK, so server-side fetches could not reach UK-rights audio sources. The moderator is UK-resident by definition, making their browser the reliable UK-origin network seat. As a side benefit, `/admin/radio-sources` ships an in-browser `CaptureTester` that exercises the same pipeline end to end without running a full broadcast.

Operational consequence: the moderator's machine is load-bearing for the whole broadcast — tab refresh / OS sleep / network drop kills capture. A "Resume capture" pill surfaces in the moderator topbar when `status === 'live'` but `captureActive === false` (browser autoplay policy requires a user gesture to restart the AudioContext + worklet).

### Stage 2 — Engine (Kairos)

**Owner:** Kairos. See [`kairos-architecture.md`](./kairos-architecture.md) §2 for the four-stage internal pipeline (ingest+batch → enrich → curate → generate). The Blackout's only handle on this stage is the typed client in `apps/blackout/server/src/lib/kairos.ts`.

The relevant outputs Kairos emits on `ws://…/broadcasts/:id/feed`:

- `entry` — every ingested feed entry (sync on connect + live thereafter). The conductor caches the last 500 for invariant lookups and fans them straight out to subscribers.
- `narrative` — a generated passage with `{ id, text, covers, batchEntryIds, contentTime, imagery, generatedAt, wordCount }`. (`contentTime` is the cycle's **content-time anchor** under `vocabulary.md` § Time.)
- `imagery_decision` — early-fire from Haiku, ahead of the Sonnet narrative. Lets imagery start in parallel with narrative synthesis.
- `generation_skipped` — Kairos chose to hold this cycle. Surfaces to the moderator UI.
- `cycle_complete` — telemetry for the inspector.

### Stage 3 — Presentation

**Owner:** `apps/blackout/server/src/conductor/RoomConductor.ts` (the heart), `apps/blackout/server/src/conductor/synthesiser.ts` (TTS call + persistence), `apps/blackout/server/src/lib/replicate.ts` (image generation), `apps/blackout/server/src/ws/matchroom.ts` and `apps/blackout/server/src/ws/moderator.ts` (fan-out endpoints).

**What it does:**

- One `RoomConductor` per active broadcast (`apps/blackout/server/src/conductor/RoomRegistry.ts`). Created at activation, destroyed at completion.
- The conductor opens a single Kairos feed subscription via `kairos.subscribeFeed(kairosBroadcastId, …)`. Every connected matchroom or moderator WS client multiplies off the same upstream subscription. The subscription carries an application-level heartbeat (`kairos-heartbeat.ts`, 15s ping / 10s pong timeout) that force-terminates the socket on missed pongs and triggers reconnect — TCP keepalive alone takes minutes to detect Kairos restarts leaving the connection half-open. Half-open detection cost the first 1h 56m of the 2026-04-26 FA Cup SF before this landed. The symmetric design has both ends pinging (Kairos pinging clients + a graceful-shutdown close-frame on SIGTERM); today the heartbeat is consumer-only — adding server-side pings on Kairos is owed as a follow-up.
- On `onNarrative`:
 1. Run `checkNarrativeInvariants` (`apps/blackout/server/src/conductor/invariants.ts`) — domain-aware checks (goal-uncovered, score-without-goal, etc.) over the cached batch entries. Warn-only.
 2. Fan a `narrative` cue to all clients immediately — text propagates whether or not TTS is on.
 3. Push onto the synthesis queue. Synthesis runs serially so emission order matches Kairos's order.
- Synthesis: `synthesiseNarration` (`apps/blackout/server/src/conductor/synthesiser.ts`) calls the configured `TtsProvider`, parses the resulting MP3 header for duration (critical for the playback scheduler), writes bytes to storage (`apps/blackout/server/src/lib/storage/`), persists a `broadcast_narrations` row keyed by `narrativeId`.
- Playback scheduling: `setTimeout(onClipEnd, durationMs + INTER_CLIP_GAP_MS)` (`INTER_CLIP_GAP_MS = 400ms`) drives a server-anchored clock. On clip-end the conductor fires `reportPacing(broadcastId, wordCount, playbackSeconds)` back to Kairos and pulls the next ready clip off the queue.
- Imagery: `handleImageryDecision` routes:
 - `generate` → Replicate, persist bytes to `broadcast_illustrations` + R2, fan `illustration` cue.
 - `pool` → look up the `illustrationId` Kairos echoed on `consumerMetadata` (stashed at studio push-time), resolve a storage URL, fan the cue.
 - `hold` → no-op; previous image stays on screen.
 - Deduped by `narrativeId` so the early `imagery_decision` and the later `narrative.imagery` don't both fire image work.
- Phase transitions: Sportmonks phase changes drive `transitionTo(phase)`. Side effects:
 - Push a synthetic `match_events` entry for halftime / second-half-kickoff / full-time so the narrator sees the transition with the same weight as a goal.
 - On `halftime` → call `triggerExplicitGeneration(HALFTIME_REFLECTION_PROMPT)`. On `full_time_winddown` → call `triggerExplicitGeneration(CLOSING_PASSAGE_PROMPT)`. Both use `POST /broadcasts/:id/narrative/generate` with `{ consumerPrompt: <text> }` body. The prompt text lives on the Blackout side (constants at the top of `RoomConductor.ts`); Kairos splices it verbatim into the LLM user message — Kairos doesn't know what "halftime" means. The route flushes the pipeline through enrich → curate → generate, so curation owns selection rather than the bypass path being mined for stale material. (The original `generateNow`-based path was the source of the post-FT regression passage on 2026-04-26 and was retired in the retro that evening.)
 - Fan a `phase` cue (moderator-only — the matchroom whitelist drops it; matchroom phase reveals ride the bundle's `revealingCanonical.phase` marker on the closing-cycle passage's whistle line). On terminal `complete`, also fan `broadcast_status_changed` so matchroom flips into replay mode.
- Late joiner: `addClient(ws, transform)` immediately sends a `connected` cue with `{ broadcast, currentPlay, currentPassage, phase, serverNow }`. The client uses `currentPassage.revealedCanonical` to render the room's state immediately and walks `currentPassage.revealingCanonical` markers from the live audio offset (`Date.now() - playback.startedAt`) — no event-stream replay, no bootstrap-by-walking-events.

**Why this shape:**

- **Server-authoritative clock.** Every client follows the conductor's `setTimeout` schedule. Drift across browser tabs doesn't compound because no client computes timing locally — they receive a `play` cue and act.
- **One Kairos subscription per broadcast, multiplied per client.** The conductor is the single upstream consumer. WS handlers attach themselves with a `transform` (matchroom flattens to a viewer DTO and drops admin signals; moderator passes through nearly everything). Adding a new audience surface is a transform, not a new subscription.
- **Synthesis serial, imagery parallel.** Audio order is the playback order; serialising synthesis is correct. Imagery has no ordering constraint and is the slowest leg, so it fires off the early `imagery_decision` cue, in parallel with both narrative synthesis and Sonnet's still-pending narrative completion.
- **Per-passage canonical-state bundle (Design A — shipped 2026-05-04).** Every passage the conductor authors carries `revealedCanonical` (the visible state at audio-start) and `revealingCanonical` (the deltas this passage will reveal during its audio, each tagged with a `charOffset` into the prose). Score, phase, match-minute label, events, illustration are all channels of one canonical-state object — the matchroom and (future) render pipeline walk it identically. The conductor maintains running canonical state across passages so the chain invariant `revealedCanonical[N+1] === apply(revealedCanonical[N], revealingCanonical[N])` holds. This subsumes the legacy `batchEntryIds` audio-end fallback: events with a marker reveal at their charOffset; events without one reveal at audio-end (same fallback shape, now per-channel rather than batch-wide). Captured as a foundational principle (see [matchroom no-spoilers](../.claude/projects/-Users-oldmanbelton-dev-the-blackout/memory/project_matchroom_no_spoilers.md)).
- **`composeContentMinute` is monotonically clamped (2026-05-10).** Two parallel paths emit the content minute the matchroom snaps the clock to: Kairos's engine emits a numeric `contentTime` (the cycle's content-time anchor) already clamped against `lastEmittedContentTime` (`apps/kairos/server/src/narrative/helpers.ts::clampMonotonicMinute`); the conductor's bundle composer (`apps/blackout/server/src/conductor/canonical-compose.ts::composeContentMinute`) emits a string `revealedCanonical.contentMinute` (preserves stoppage, e.g. "45+2") and threads `lastEmittedContentMinute` through to the same monotonic clamp. Both must clamp because a late-arriving earlier-phase entry would otherwise pull the matchroom clock backwards. The conductor recovers `lastEmittedContentMinute` from persisted narrations on restart so the floor survives mid-broadcast restarts. See `docs/vocabulary.md` § Time.
- **Audio→subject effective offset (2026-05-10).** `BroadcastRunner.effectiveOffsetSeconds` is the broadcast↔subject delta — seconds we subtract from a distillation line's broadcast wall-clock to recover the subject time the audio is describing. Seeded from `radioSource.defaultOffsetSeconds` and EWMA-updated on every matched calibration sample (`apps/blackout/server/src/lib/broadcast-subject-offset.ts::applyCalibrationSample`. The transcription pipeline and the moderator-message anchor both read this value dynamically, so calibration drift during a broadcast feeds back into the timing of subsequent subject-time stamps. Closes the dead-loop where `lastObservedOffsetSeconds` was written by `recordObservation` but never read at stamping time.

## 4. Supporting systems

### Storage (`apps/blackout/server/src/lib/storage/`)

`StorageProvider` has two implementations: `r2.ts` (Cloudflare R2, including the normal `blackout-dev` development bucket) and `memory.ts` (a test/isolated fallback served by `routes/storage.ts`). Audio lives at `broadcasts/<id>/narrations/<narrativeId>.mp3`; illustrations at `broadcasts/<id>/illustrations/<rowId>.webp`.

**Bucket strategy.** Two buckets in the same Cloudflare account: `blackout-prod` (production) and `blackout-dev` (local development + synthetic-broadcast iteration). Local `.env` defaults to `blackout-dev` so iteration artefacts never bleed into the prod bucket.

**URL strategy.** When `R2_PUBLIC_URL` is set, `getPublicUrl(key)` returns a permanent `${R2_PUBLIC_URL}/${key}` URL — served directly from R2 via Cloudflare's edge cache, never expires, no server bandwidth cost. This is the production path; both buckets have public access enabled via Cloudflare's `pub-…r2.dev` URL. When `R2_PUBLIC_URL` is unset, `getPublicUrl` falls back to a presigned URL with 7-day TTL (the AWS S3 max). The fallback exists for test environments and accidental misconfiguration; the canonical path is public-domain. Asset references in DB store the durable `imageKey` / `audioKey`; the URL is freshly resolved at every consumer-facing read site (`buildBroadcastView`, late-joiner snapshots) so a stale presigned URL is impossible.

### TTS providers (`apps/blackout/server/src/lib/tts/`)

`TtsProvider` interface with four implementations: `openai.ts`, `elevenlabs.ts`, `deepgram.ts`, `hume.ts`. Per-broadcast provider + voice id selected via the `ttsProvider` and `ttsVoiceId` columns. Hume is the experimental expressive option used in the 2026-04-24 live test; ElevenLabs is the production default for beta. Pluggability is a one-config-row switch.

### Pacing feedback loop

The conductor's `reportPacing` (`kairos-bridge.ts::reportPacing`) computes `wpm = wordCount / playbackSeconds * 60` on each clip-end and POSTs to `/broadcasts/:id/feedback` with one of `slow_down` / `speed_up` / `on_track`. Thresholds in `kairos-bridge.ts::PACING_TARGET` (140–200 wpm). Kairos's `state-tracker.ts` consumes the signal into the next cycle's target word count via the `pacing` curation service.

### Commentary distillation + event correlation (`apps/blackout/server/src/lib/distiller.ts`, `distillation-buffer.ts`, `event-correlation.ts`)

A two-stage pipeline that mediates between raw radio commentary and Kairos.

**Distillation.** A single Haiku call per chunk classifies buffered Deepgram utterances into three structured outputs:
- `atmosphere` — crowd, manager, ambient mood, off-ball moments. Pushed to Kairos as `match_action` with no parent.
- `event_texture` — build-up, reactions, body language *around* canonical events. Pushed as `match_action` with a `parentSourceId` linking to the Sportmonks event row when correlation succeeds.
- `event_claim` — internal-only structured signal that commentary asserted a canonical event happened. Drives the calibration loop.

What's deliberately dropped: pure opinions, takes redundant with structured data we already have (commentators saying "Brighton are dominating" when our pressure pipeline is the authoritative source for that), speculation, editorial framing of the broadcast as a whole, and the announcement of an event itself when extracting texture (Sportmonks owns "GOAL"; commentary's job is the build-up and reactions).

The buffer flushes every 12s by default, or reactively the moment a Sportmonks event is about to be processed — that way commentary leading up to the event makes it into the correlator before the canonical row does. Sequential flushes; concurrent requests serialise.

**Roster discipline.** Each `DistillationInput` carries `homeRoster` + `awayRoster` (plus team display names). The system prompt tells Haiku to snap near-miss transcriptions back to canonical roster spellings ("Vogel" → Bogle, "Menzo" → Enzo, "Garnett" → Garnacho) and to drop or de-name mentions whose name doesn't correspond to a real squad member. Closes the gap left by the upstream `normaliseTranscript` fuzzy-match (which only handles surname-edit-distance ≤ 2 and misses first-name garbles or longer mishearings). Surfaced 2026-04-26 when narrative #14 of the FA Cup SF wrote 94 confident words about a fictional Leeds equaliser ("Euler Brand finishes cleanly") in a 1-0 Chelsea win — the distiller had no canonical reference to correct the transcription error.

**Event correlation.** Three ledgers (canonical events, pending claims, pending texture). When a canonical Sportmonks event arrives, `resolveCanonical` matches against pending entries: textures linked by class + player surname (or class alone for phase whistles); claims fire calibration samples that update `radio_sources.lastObservedOffsetSeconds` and broadcast a `latency_sample` cue. Per-class match windows (90s default, 120s for VAR); window expiry releases pending texture and drops claims as no-match telemetry.

**Unverified-eventClass gate.** When an `event_texture` ages out of the correlator without finding a matching canonical event, it's released to Kairos as `kind: "atmosphere"` (no `eventClass` tag). The distiller's `eventClass` is Haiku judgment from commentary tone — propagating it without canonical confirmation lets the narrator treat unverified moments as fact. The post-FT regression on 2026-04-26 fired through this gap before it was closed.

Phase whistles (KICKOFF / HALFTIME / SECOND_HALF_KICKOFF / FULL_TIME) are mirrored as virtual canonical entries when the conductor's `onKickoff`/etc. callbacks fire — every match contributes calibration samples from the opening whistle, not just from goals. The legacy `goal-correlation.ts` (transcription-substring match against scorer surnames, goal-only) was retired with this pass.

### Phase FSM (`apps/blackout/server/src/conductor/phase-logic.ts`)

`warming → live_first_half → halftime → live_second_half → full_time_winddown → complete`. Transitions driven by Sportmonks phase observations on the live path; on the replay path the conductor watches `entry.data.phase` and advances the FSM monotonically. `shouldSuppressWinddownComplete` guards against premature completion (a broadcast less than 60 minutes past kickoff cannot genuinely be at full-time — landed after a 2026-04-22 false-positive).

`warming` is the conductor's first state — the broadcast is `live`, the runner is up, sources are flowing, but Sportmonks hasn't reported KICKOFF yet. It is *not* the same as the planned pre-broadcast illustration pregeneration window (lineup-driven Replicate prep that runs before activation while the broadcast is still `scheduled`); that's a separate concept tracked under design open question D4 and not yet implemented.

**Phase recovery from history.** The conductor's `start()` queries Kairos for the broadcast's existing transition entries and recovers `this.phase` from the latest one before subscribing to the feed. Without this, every conductor restart (server reload, deploy, crash) walked the FSM from `warming` and pushed a duplicate transition entry per phase via the feed's sync-on-connect — a bug that surfaced during the 2026-04-26 condensed-replay validation. Stale `full_time_winddown` broadcasts past 4 hours old finalise on respawn rather than re-spinning a conductor.

### Invariants (`apps/blackout/server/src/conductor/invariants.ts`)

Domain-aware post-narrative checks: goal referenced without a GOAL entry in covers, score phrase without a goal, etc. Warn-only — they log and capture PostHog events but do not block. The corresponding domain-agnostic invariants (phantom covers, tool-call failed) live on the Kairos side.

### Auth (`apps/blackout/client/lib/auth.ts`, `apps/blackout/client/proxy.ts`)

Better Auth (self-hosted) with explicitly provisioned email/password accounts. Role model: `admin` / `writer` / `null`. Admin promotion via `ADMIN_EMAIL` env var, applied in a `user.create.before` hook. Role written to a custom `role` column on `users`.

`apps/blackout/client/proxy.ts` is the Next.js routing-middleware (Next.js 16 names it `proxy.ts`, exports `proxy` and `proxyConfig` rather than `middleware` / `config`). Gates:

- `/login` — feature-flagged via PostHog `show-login`; redirects logged-in users home.
- `/matchroom/*` — feature-flagged via `matchroom-enabled`, login required.
- `/broadcasts`, `/moderator/*`, `/studio/*` — writer or admin.
- `/admin/*`, `/broadcasts/:id/inspector` — admin only.

WebSocket auth happens at upgrade time on the server (`apps/blackout/server/src/index.ts`): the same Better Auth session cookie validated on the HTTP side resolves the user before `/ws/matchroom` or `/ws/moderator` is accepted.

### Telemetry (`apps/blackout/server/src/lib/telemetry.ts`)

PostHog event capture (EU residency) for `conductor_started`, `narration_synthesised`, `narration_play_started`, `phase_transitioned`, `illustration_generated`, `winddown_complete_suppressed`, etc. Frontend events (`room_joined`, `audio_played`, `access_gate_hit`) capture from the matchroom directly.

## 5. Web surfaces

`apps/blackout/client/` is Next.js 15 / React 19 with the App Router. All pages are role-gated through `proxy.ts`.

### Public

- `/` — landing.
- `/login` — email/password sign-in for provisioned accounts.

### Member

- `/matchroom/[broadcastId]` — the consumer surface. Subscribes to `/ws/matchroom`, renders the fixture header, scoreboard, event ribbon, narrative text with sentence-level emphasis tracking the audio playhead, and per-passage illustrations (700ms crossfade). All reveals gated on audio-start (no spoilers — the narrator is the canonical voice). Supports a `connected` cue with `currentPlay` for late-joiners; archive replay shipped to the same URL on `status === complete`.

### Writer + admin

- `/broadcasts` — broadcast list + create.
- `/moderator/[broadcastId]` — control panel: activate / complete, runner status, latency-sample strip, source dropdown, generation-paused banner, covers-linked feed entries.
- `/studio/[broadcastId]` — content prep: match brief + author brief editing, illustration prompt iteration (Replicate call per prompt, ephemeral image URL), pool management.

### Admin only

- `/broadcasts/[id]/inspector` — pipeline cycles, generation details, batch / curated / token usage breakdown.
- `/admin/radio-sources` — radio source catalogue management (URL, URL pattern, default offset). Each row carries a `CaptureTester` panel that runs Web Audio + MediaRecorder against the URL in-browser and reports chunks fired, bytes captured, derived bitrate, and a peak-amplitude level meter — verifies a new source works through the same pipeline as production capture without activating a broadcast.

## 6. Persistence

Drizzle ORM + postgres-js, schema in `apps/blackout/server/src/db/schema.ts`. Local Postgres in dev (Homebrew), Neon in prod (separate database from Kairos's, both `aws-eu-west-2`). Migrations applied via `pnpm --filter @blackout/server db:push`.

| Table | Purpose |
|---|---|
| `broadcasts` | The central object. Lifecycle `draft → scheduled → live → complete`. Holds fixture id, radio source id, TTS config, moderator id, `kairosBroadcastId` (the link), match brief. |
| `broadcast_narrations` | One row per Kairos narrative the conductor has handled. Holds prose, word count, audio key in storage, parsed duration ms, voice + provider, `playbackStartedAt`, `batchEntryIds` + `covers` (legacy reveal-gate), `revealedCanonical` + `revealingCanonical` jsonb (per-passage bundle — Design A). |
| `broadcast_illustrations` | Per-narrative or per-pool illustration. `narrativeId` nullable on pool rows. Holds prompt, image key, model, generation duration. |
| `broadcast_discarded_prompts` | Negative context for the studio's LLM-driven prompt suggestion loop. |
| `radio_sources` | Catalogue of radio streams. URL, `urlPattern` (substring matcher for free-text URLs), `defaultOffsetSeconds`, observed offset rolling stats. The `transcode` column is a vestige of the retired server-side ffmpeg path — column persists, no current code reads it. |
| Better Auth tables (`users`, `sessions`, `accounts`, `verifications`) | Auth + role (`admin` / `writer` / `null`). |

Audio and images normally live in Cloudflare R2; development uses `blackout-dev`. An in-memory provider exists for tests and isolated fallback use. Kairos has its own database for engine state — they don't share schema.

## 7. Broadcast lifecycle

```
draft → scheduled → live → complete
```

The Blackout-side states. Kairos's lifecycle (`pending → active → complete`) runs in parallel and is bound by `kairos-bridge.ts`:

- **`draft`:** created in studio. Teams, fixture, radio source, voice, TTS config, match brief.
- **`scheduled`:** content attached (briefs, illustrations). Ready to go live but not yet linked to Kairos.
- **`live`:** `activateBroadcast(blackoutId)` runs. It:
 1. Calls `linkBroadcastToKairos` (idempotent) — creates the Kairos broadcast with the seven sources.
 2. Fetches lineups from Sportmonks (best-effort), appends to the match brief, stashes the roster for transcript normalisation.
 3. Pushes `narrative_context` (brief + lineups) and `narrative_voice` (default voice) entries to Kairos.
 4. PATCHes the Kairos broadcast to `active`.
 5. Updates the Blackout broadcast to `live`.
 6. Calls `ensureRoomConductor(blackoutId)` — opens the Kairos feed subscription, ready for clients.
 7. Calls `startBroadcastRunner(blackoutId)` — starts Sportmonks polling and arms the Deepgram transcription pipeline (the moderator's browser pushes audio chunks to it once the activation completes).
- **`complete`:** `completeBroadcast(blackoutId)` stops the runner, completes the Kairos broadcast, stops the conductor, clears the roster. Audio + illustrations + narrations remain in storage and DB; the matchroom URL switches to archive replay mode.

After a server restart, lazy rehydration: the next REST or WS hit on a `live` broadcast re-creates the conductor (Kairos's runtime rehydrates symmetrically on its side).

## 8. Cue vocabulary

The conductor fans cues (`apps/blackout/server/src/conductor/types.ts` + `packages/blackout/shared/types/passage.ts`) to every connected client. Per-client transforms (`apps/blackout/server/src/ws/matchroom-transform.ts`, `moderator-feed-shape.ts`) decide which cues each audience sees.

### Matchroom-bound (bundle-driven contract — Sub-piece 4 retired the legacy cues from this whitelist 2026-05-04)

| Cue | When | Payload (key fields) |
|---|---|---|
| `connected` | On client connect | `{ broadcast, currentPassage, currentPlay, phase, serverNow }` — late-joiner snapshot. Matchroom prefers `currentPassage` (full bundle); `currentPlay` + `phase` retained for transition compatibility. |
| `passage_added` | Kairos narrative landed; bundle materialises | `{ passage }` where `passage = { narrativeId, narrationId: null, text, audio: null, playback: null, revealedCanonical, revealingCanonical }`. |
| `passage_audio_ready` | TTS synthesis completed | `{ narrativeId, narrationId, audio: { url, durationMs } }` — clients prefetch. |
| `passage_started` | Audio playback starts | `{ narrativeId, narrationId, audio, playback: { startedAt, serverNow } }` — server starts the clock; this passage becomes `currentPassage`. |
| `passage_skipped` | Synthesis failed | `{ narrativeId, reason }` — drops the bundle; running canonical state has already absorbed reveals so the next passage's `revealedCanonical` includes them. |
| `passage_updated` | Field on an in-flight passage changed (e.g. late illustration) | `{ narrativeId, patch: { revealedCanonical: { illustration?, … } } }` — clients mutate the current passage. |
| `broadcast_status_changed` | Lifecycle change (e.g. `complete`) | `{ status, serverNow }` — matchroom refetches REST and flips to replay mode on `complete`. |
| `generation_skipped` | Kairos held a cycle | `{ reason, narrativeId?, … }` — informational; matchroom ignores. |

### Moderator-bound (legacy contract retained for the operator console)

| Cue | When | Payload (key fields) |
|---|---|---|
| `feed_entry` | Every Kairos entry (sync + live) | `{ entry }` — raw Kairos feed entry. Operator visibility into the source stream. |
| `narrative` | Every Kairos narrative | `{ id, text, wordCount, generatedAt, covers, batchEntryIds, contentTime }`. |
| `play` / `preload` | Audio scheduling | as above — moderator console uses for the audio strip. |
| `phase` | Phase FSM transition | `{ phase, serverNow }` — moderator HUD swaps copy. |
| `illustration` | Replicate or pool resolution complete | `{ narrativeId, imageUrl }` — moderator preview pane. |
| `latency_sample` | Per-event-class radio-offset calibration | `{ goalContentTime, rawDeltaSeconds, configuredOffsetSeconds, sourceName }`. |

The matchroom + moderator transforms are pure functions over the cue stream. Adding a new operator-only diagnostic doesn't risk leaking to viewers: the matchroom whitelist is the wall, and unknown cue types default to dropped.

## 9. Anti-patterns — things the design explicitly avoids

- **No LLM calls from The Blackout for prose.** Kairos owns narrative generation. Every prose-shaped string the matchroom renders came back over the Kairos feed WS. The studio's prompt suggester is the only LLM call on the Blackout side, and it's strictly editorial (prompt suggestions for the illustration pool).
- **No per-client TTS synthesis.** Audio is generated once per Kairos narrative on the conductor and distributed. Per-client synthesis was retired 2026-04-22 — multi-client divergence + cost both unacceptable.
- **No client-side timing.** The server's `setTimeout` is the clock. Clients react to cues; they don't compute the next play time themselves. Removes drift across browser tabs over 90 minutes.
- **No matchroom reveals before audio-start.** The narrator is the canonical voice. Score updates, event ribbon entries, illustrations all gate on `play` cue arrival (or a corresponding cover's character offset mid-clip), never on `feed_entry` arrival. Captured as the matchroom no-spoilers principle.
- **No Next.js API routes for orchestration.** The dedicated Hono server is the room conductor. Next.js API routes are stateless and can't hold the playback clock or the fan-out set; using them would mean re-architecting around shared state. The frontend talks to `apps/blackout/server` directly via REST + WS.
- **No Kairos imports of `@blackout/server` — or of `@blackout/shared`.** Module-boundary discipline: Kairos has no dependency on either; the seam between Kairos and the Blackout is the HTTP/WS wire, not shared TypeScript. A type genuinely needed both sides is duplicated (Kairos owns it; the Blackout side mirrors it — `packages/blackout/shared/types/pipeline-cycle.ts` is that mirror), never shared via a package. Football types stay on the consumer side; Kairos doesn't compile-couple to its consumer at all.
- **No second authority on what gets to the audience.** Kairos's curation is the only authority on what reaches the generator; the conductor's reveal-gating is the only authority on what reaches the audience visually. Anywhere either gets second-guessed downstream is drift.
- **No off-cadence cue fan-out.** The conductor doesn't ship narrative-shaped cues on its own — they all originate from a Kairos feed event. The two exceptions (synthetic `match_events` for halftime / fulltime, explicit-generation requests at phase boundaries) round-trip through Kairos so the engine sees them, not just the matchroom.
- **No moderator-driven source pushing.** Moderator notes flow as a separate `moderator` source. The moderator console doesn't push to the `match_events` source — that runs from Sportmonks alone. Misattribution of human notes as canonical events would corrupt the engine's ground truth.

## 10. API surface — summary

### Server REST (`apps/blackout/server/src/routes/`)

- `GET /health` — liveness.
- `GET /broadcasts`, `POST /broadcasts`, `GET /broadcasts/:id`, `PATCH /broadcasts/:id`, `DELETE /broadcasts/:id` — broadcast CRUD.
- `GET /broadcasts/:id/cycles`, `GET /broadcasts/:id/cycles/:cycleId` — inspector, admin-only.
- `GET /broadcasts/:id/moderator-view` — moderator REST bootstrap (richer shape than `BroadcastView`).
- Studio routes (paid LLM / Replicate calls) — writer/admin gated.
- `GET /tts/providers`, `GET /tts/voices` — TTS catalogue.
- `GET /radio-sources`, `POST /radio-sources`, `PATCH /radio-sources/:id`, `DELETE /radio-sources/:id` — admin-only.
- `GET /storage/:path` — serves the in-memory test/fallback provider only.

### Server WebSocket (`apps/blackout/server/src/ws/`)

- `ws://…/ws/matchroom?broadcastId=X` — read-only viewer subscription. Validates session (member+) and broadcast lifecycle (`live` or `complete` for replay).
- `ws://…/ws/moderator?broadcastId=X` — read-write control. Validates session (writer or admin). Accepts inbound activation / completion / moderator note commands.

### Kairos (consumer-side client)

The Blackout consumes Kairos via `apps/blackout/server/src/lib/kairos.ts`. The bridge (`apps/blackout/server/src/lib/kairos-bridge.ts`) wraps the lifecycle calls. The matchroom and moderator do not talk to Kairos directly — every read or write goes through the conductor.

## 11. Runtime boundaries

The `RoomRegistry` (`apps/blackout/server/src/conductor/RoomRegistry.ts`) holds one `RoomConductor` per active broadcast. The `BroadcastRunner` registry holds one runner per active broadcast. They share the broadcast id but not memory; the runner pushes to Kairos, the conductor reads from Kairos. Both teardown on completion.

Multiple concurrent broadcasts are supported but uncommon (the prototype runs one at a time). Each broadcast's state — entry cache, synthesis queue, ready queue, fan-out client set — is fully scoped to its conductor. Cross-broadcast bugs are architecturally impossible.

---

## Reading guide

- Working on source capture: `apps/blackout/server/src/sources/` (Sportmonks adapter), `apps/blackout/server/src/pipeline/` (transcription, pressure), `apps/blackout/server/src/lib/broadcast-runner.ts` (the orchestrator).
- Working on the Kairos seam: `apps/blackout/server/src/lib/kairos.ts` (typed client), `apps/blackout/server/src/lib/kairos-bridge.ts` (lifecycle).
- Working on the conductor: `apps/blackout/server/src/conductor/RoomConductor.ts` (heart), `synthesiser.ts` (TTS + persistence), `phase-logic.ts` (FSM), `invariants.ts` (domain-aware checks).
- Working on TTS: `apps/blackout/server/src/lib/tts/` (provider implementations + interface).
- Working on imagery: `apps/blackout/server/src/conductor/RoomConductor.ts::handleImageryDecision`, `apps/blackout/server/src/lib/replicate.ts`.
- Working on auth + access: `apps/blackout/client/lib/auth.ts` (Better Auth), `apps/blackout/client/proxy.ts` (role gates).
- Working on the matchroom: `apps/blackout/client/app/matchroom/[broadcastId]/page.tsx`, `apps/blackout/server/src/ws/matchroom.ts`, `apps/blackout/server/src/ws/matchroom-transform.ts`.
- Working on the moderator console: `apps/blackout/client/app/moderator/[broadcastId]/page.tsx`, `apps/blackout/server/src/ws/moderator.ts`, `apps/blackout/server/src/ws/moderator-feed-shape.ts`.
- Working on the studio: `apps/blackout/client/app/studio/[broadcastId]/page.tsx`, `apps/blackout/server/src/routes/broadcasts.ts` (studio routes).
- Working on the engine: see [`kairos-architecture.md`](./kairos-architecture.md).
