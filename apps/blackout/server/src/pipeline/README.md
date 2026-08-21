# pipeline/ — transcription & pressure derivation

Two stream-processing pipelines that sit between a raw input and the runner's `pushEntry`. They reshape firehose-level data into something with semantic weight: Deepgram's word-by-word transcription into utterance lines, and Sportmonks' ball-position/trend updates into pressure/zone moments. Neither talks to Kairos directly — they hand their output to the broadcast-runner, which stamps the content-time anchor and decides what flows on (and through the distiller, for transcription).

## What it does

### `transcription.ts` — `TranscriptionPipeline`

Wraps a Deepgram listen socket. The moderator's UK-resident browser captures the radio audio (Web Audio + AudioWorklet → linear16 PCM frames) and streams the frames over `/ws/moderator` → the runner relays them via `pushAudioChunk` → this pipeline pushes them to Deepgram. It emits via callbacks: `onTranscript({ text, utteranceEndWallClock })` per finalised utterance (the runner subtracts `effectiveOffsetSeconds` from the wall-clock to recover the real match moment, normalises the text against the roster, logs the forensic trail, and buffers it for distillation); `onStatus(status, message)` — the lifecycle states `opening` / `streaming` / `closed` / `error` (only `error` carries a message; the runner drives self-healing off `streaming` clearing a prior error so the broadcasts-page indicator flips back to green). Resilience: a close-then-reopen retry budget (`MAX_REOPEN_ATTEMPTS` = 5, `REOPEN_DELAY_MS` = 1000) for transient network blips / Deepgram hiccups; beyond that it's a hard error rather than burning Deepgram credit in a loop. Handles the post-stop / pre-open chunk races (a `pushAudioChunk` after stop, or before the socket is open, is dropped silently — capture races activation, the first few hundred ms after pre-arming are expected to land before the runner is registered).

### `pressure.ts` — `PressurePipeline`

Consumes raw Sportmonks `ball_position` and `trend` updates (via `ingestBallPosition` / `ingestTrend`, with `setPeriod({countsFrom})` for minute normalisation) and derives a per-team **pressure** signal — what's happening during each team's current attacking push. Model: each team has running counters (attacks, shots, corners, dangerous_attacks) + accumulated attacking-third time; when a team's ball position crosses into *that team's* attacking third it emits a `zone_entry` signal and **resets that team's counters** (pressure is measured relative to the most recent push); every `emitIntervalMs` (default 15s) any team with non-zero counters emits a `pressure_update` (the accumulated counts + the `attackingThirdShare`); a `zone_middle` signal when play comes back out. The runner converts these to `match_pressure` source data (`[PRESSURE] <team> (45s): 67% territory, 12 attacks, 3 dangerous, …` / `[ZONE] <team> into attacking third` — the bracketed-annotation form Kairos's generator is told to read as *signal, not script*: render the texture, never recite the numerals). Pressure lives on its own non-canonical source so the canonical flag on `match_events` only ever applies to real events.

## How it fits

- **Upstream:** the broadcast-runner constructs both at `start()` — `TranscriptionPipeline(deepgramApiKey, {onTranscript, onStatus})` then `await transcription.start()`; `PressurePipeline()` then `pressure.start(emitPressureSignal)`. Audio chunks arrive at the runner from the moderator WS and are relayed; Sportmonks stat updates arrive via the `SportmonksEventSource`'s `onStat` callback and the runner pumps them into the pressure pipeline.
- **Downstream:** transcription's `onTranscript` → the runner's `effectiveOffset`-correction + roster-normalisation + the `CommentaryDistillationBuffer` (→ distiller → atmosphere/event_texture/event_claim, see [`../lib/README.md`](../lib/README.md)) — *raw transcription never reaches Kairos*; pressure's signals → the runner's `toPressureEventData` → `pushEntry(SOURCE.matchPressure, …)`. Both go through the runner's content-time stamping + the conductor's `decideSourcePushAllowed` gate.

## Contract

### Provided
- `new TranscriptionPipeline(apiKey, { onTranscript({text, utteranceEndWallClock}), onStatus(status, message?) })`; `start()` / `stop()` / `pushAudioChunk(buffer)`. Lifecycle states `opening` / `streaming` / `closed` / `error`.
- `new PressurePipeline()`; `start(emitSignal)` / `stop()` / `setPeriod({countsFrom})` / `ingestBallPosition({x,y,minute,contentTime,wallClockMs})` / `ingestTrend({team,statName,value,minute,contentTime})`. Signal types `zone_entry` / `zone_middle` / `pressure_update` (the `PressureSignal` union).

### Depended on
- `@deepgram/sdk` (transcription) — `DEEPGRAM_API_KEY` env (the runner reads it and passes the value in; `env.ts` validates presence). `@blackout/shared` (`TeamSide`) for the pressure signals. The runner owns the wall-clock→content-time mapping and the effective-offset correction — the pipelines just produce raw output.

## Open work

- **The moderator WS protocol carrying audio chunks is loosely typed** — text + binary frames without a discriminated message union (the inspector audit flagged this). The transcription pipeline handles the chunk races robustly, but the WS-level contract could be tighter. → [`../ws/README.md`](../ws/README.md).
- **`attackingThirdShare` saturates at 100%** in sustained-siege phases — the metric pins, which the narrator handles fine (told not to recite numerals) but makes the inspector's pressure trace uninformative when saturated. Tracked server-wide.
- **Server-side radio fetch is retired** — capture lives in the moderator's UK-resident browser (Fly's `lhr` egress NAT geolocates as US; hosting is not the layer for UK-rights audio access). The transcription pipeline is browser-capture-only now; the old server-fetch path is gone.

## See also

- [`../../README.md`](../../README.md) — the backend as a service; the source-capture pipeline diagram (transcription → distiller; pressure → match_pressure).
- [`../sources/README.md`](../sources/README.md) — the Sportmonks adapter that feeds `onStat` into the pressure pipeline.
- [`../lib/README.md`](../lib/README.md) — the distillation pipeline (`distiller.ts` / `distillation-buffer.ts` / `event-correlation.ts`) that consumes transcription's output; `effective-offset.ts` (the radio-offset calibration); `content-time.ts` (the period→content-time math).
- [`../ws/README.md`](../ws/README.md) — the moderator WS that relays audio chunks into the transcription pipeline.
