# app/moderator — the live control surface

The writer/admin console for running a live broadcast. It does three things a member's matchroom can't: it **captures the UK radio stream in the moderator's browser** (the audio that becomes the narrator's source of truth — captured here because the moderator is UK-resident and Fly's `lhr` egress geolocates as US, so hosting is not the layer for UK-rights audio); it lets the moderator **steer editorially** (typed directives that apply to every passage from then on, off-schedule beats); and it carries the **operator view** — the raw feed, the latency-calibration samples, the narrator-voice panel, the service-status dots, activation/completion. It subscribes to the same conductor as the matchroom but sees nearly everything the conductor fans out.

For where this sits and the cue vocabulary, see [`../../README.md`](../../README.md) and [`apps/blackout/server/README.md`](../../../server/README.md). This README goes one level deeper.

## How it fits

```
GET /broadcasts/:id/moderator-view ──▶ bootstrap: Broadcast + ModeratorView (historical feed entries
 (on mount; refetched on reconnect) reshaped via toFeedEntry) + service status + voices + radio sources
 ↓
 ┌─────────────────────────────────── moderator browser ───────────────────────────────────┐
 │ HLS radio stream ──hls.js (or <audio src>)──▶ <audio> element ─┬─→ GainNode → speakers │
 │ (page-owned audio el; CORS anonymous) │ (Listen toggle = gain only)
 │ useAudioCapture.armCapture() ─builds Web Audio graph─▶ MediaElementSource → AudioWorkletNode
 │ (down-sample → int16 PCM) → port → WS as BINARY frames ──────┼─────────────────────────▶ /ws/moderator (binary)
 └─────────────────────────────────────────────────────────────────┘ │ → server's Deepgram pipe
 │
 ws://server/ws/moderator?broadcastId=… (useReconnectingWebSocket) │
 │ onOpen → resume capture (re-arm if needed) + re-backfill │
 ▼ onMessage → discriminated-union dispatch: │
 connected → snapshot (currentPlay / currentPassage, phase, serverNow) │
 feed_entry → append to the combined feed (raw — toFeedEntry shape: source + subType) │
 latency_sample → append to the calibration panel (the EWMA offset update happened server-side)
 narrative / play / preload / illustration / phase → the narrator-voice + narratives panels │
 generation_skipped → the generation-pause banner │
 service status (on connect via checkServices) → the status dots │
 │ │
 moderator actions: type a directive → ws.send(text) → server's pushModeratorMessageToRunner ─────┤
 ("activate" → POST/PATCH lifecycle via apiPatch/apiFetch → kairos-bridge.activateBroadcast) │
 ("complete" → ... → kairos-bridge.completeBroadcast) │
 ▼
 render: Topbar · StatusBar · GenerationPauseBanner · LeftColumn (broadcast meta, radio source,
 services, lifecycle controls) · NarratorVoicePanel (voice picker + ttsEnabled switch)
 · CombinedFeedPanel (the raw feed scroll) · NarrativesPanel (generated passages + latency)
```

The moderator is the operator: the matchroom transform whitelist *drops* the operator-only cues (`feed_entry`, `latency_sample`) for members, but the moderator gets them — it's how the writer watches the pipeline run.

## What it does

### `[broadcastId]/page.tsx` — the orchestrator (~1017 lines)

Holds the page state (the `Broadcast` row, the `ModeratorView` bootstrap, the feed entries, the narrative records, the latency samples, the radio sources + TTS voices, the service statuses, capture state, console preferences from localStorage) and wires: the bootstrap fetch (`apiGet` `/broadcasts/:id/moderator-view`), the WS subscription (`useReconnectingWebSocket` — `onOpen` resumes capture + re-backfills), the discriminated-union dispatch (the cue table above), the audio-capture hook (`useAudioCapture` — see below), the moderator-directive send path (`ws.send(text)` → the runner's moderator-note path → stamped with the radio-offset-corrected subject time, normalised against the roster, pushed to Kairos's `moderator` source), the lifecycle actions (`activateBroadcast` / `completeBroadcast` via `apiPatch`/`apiFetch` → the server's `kairos-bridge`), the voice picker + the `ttsEnabled` kill-switch toggle, the schedule-blocker checks (`collectScheduleBlockers` from `@blackout/shared` — gates activation). Admin-only bits gate on `user?.isAdmin`.

### `[broadcastId]/useAudioCapture.ts` — the audio pipeline (~321 lines)

Owns the entire UK-resident-browser audio pipeline: `audioEl → MediaElementSource ─┬─→ GainNode → speakers; └─→ AudioWorkletNode → port → WS (binary)`. The audio element is page-owned (rendered into the DOM; the hook gets a ref); the moderator WS is page-owned too (the hook only forwards binary PCM frames into it). Pipeline: (1) `hls.js` (or a direct `<audio src>`) loads the radio stream into the page's audio element, CORS anonymous so Web Audio can tap it; (2) `armCapture()` (call inside a user-gesture handler — the "Go live" button) builds the Web Audio graph: source → worklet (down-samples + emits int16 PCM) → port → the WS as binary frames; the server pipes those into Deepgram with `linear16/16kHz/mono`; (3) the Listen toggle controls the speaker branch's gain only — capture stays full-volume regardless; (4) `disarmCapture()` tears the graph down (idempotent). Replaced the original `MediaRecorder → webm/opus` capture — `AudioWorklet → linear16 PCM` is structurally more reliable on desktop moderators (no codec init segment to drop on WS reconnect; Deepgram parses raw PCM with explicit encoding rather than sniffing container framing — confirmed live 2026-05-02). `lib/transcription.ts` carries the worklet processor + the down-sampling.

### `[broadcastId]/components/` — the visual pieces

`Topbar` / `StatusBar` / `GenerationPauseBanner` / `LeftColumn` / `NarratorVoicePanel` (the voice picker + the `ttsEnabled` switch — `VoiceCard` / `VoiceRow`) / `RadioSourcePanel` / `CombinedFeedPanel` (the raw feed scroll) / `NarrativesPanel` (the generated passages + the latency samples) — plus `types.ts` (`TtsVoice` / `NarrativeRecord` / `ModeratorPlayCue` / `LatencySample`). `app/admin/components/CaptureTester.tsx` exercises the audio pipeline (`useAudioCapture` + the worklet) in isolation, outside a broadcast.

## Contract

### Provided
- The moderator route: `/moderator/[broadcastId]` — a writer/admin's control surface for a broadcast. Bootstraps from `GET /broadcasts/:id/moderator-view`, drives off `ws://server/ws/moderator?broadcastId=…` (text + binary), exposes activation/completion + the editorial-steering channel + the voice/ttsEnabled controls.
- `useAudioCapture` — the browser audio pipeline (reusable; the admin capture-tester uses it standalone). The binary-frame contract into `/ws/moderator`: down-sampled int16 PCM, the server expects `linear16/16kHz/mono`.

### Depended on
- **From `apps/blackout/server` (HTTP):** `GET /broadcasts/:id/moderator-view` (the bootstrap — the broadcast row, the historical feed reshaped via `toFeedEntry`, service status, voices, radio sources); `PATCH /broadcasts/:id` (the `ttsEnabled` switch, the voice, the brief, the status — lifecycle); the lifecycle actions that route through `kairos-bridge.activateBroadcast` / `completeBroadcast`.
- **From `apps/blackout/server` (WS — `/ws/moderator`):** the cue stream (nearly everything the conductor fans out — `connected`, `feed_entry` (reshaped via `toFeedEntry` — preserves the engine taxonomy: `source` = the Kairos source name, `subType` = the data-level classification), `latency_sample`, `narrative`/`play`/`preload`/`illustration`/`phase`, `generation_skipped`), plus the service-status message on connect. Outbound: text frames (moderator directives → the runner's note path → the `moderator` Kairos source) and binary frames (PCM → the runner's transcription pipe → Deepgram). The runner's `effectiveOffsetSeconds`-correction is applied server-side — the directive timestamps and the utterance timestamps both get the broadcast↔subject calibration so `subjectTime` tracks the subject time the audio is describing.
- **From `@blackout/shared`:** `Broadcast` / `BroadcastStatus` / `BroadcastTtsProvider` / `ModeratorFeedEntry` / `ModeratorView` / `RadioSource` / `ServiceStatus` / `collectScheduleBlockers`.
- **From `lib/`:** `apiGet` / `apiFetch` / `apiPatch` / `API_URL`, `useReconnectingWebSocket`, `routes`, `storage-keys` (the `STORAGE_KEYS` registry — console preferences), `transcription.ts` (the worklet + down-sampler), `use-current-user.ts` (the `isAdmin` gate). From `app/lib/`: `palette`. External: `hls.js`.

## Anti-patterns

- **Capture happens in the moderator's browser, not on the server.** The server-side radio fetch is retired (Fly's `lhr` egress geolocates as US — wrong layer for UK-rights audio). Don't reintroduce a server-fetch path; the moderator's browser is the source.
- **The moderator steers, the moderator doesn't write prose.** Typed directives are *steering* (they apply to every passage going forward — surfaced at the top of Kairos's generator prompt, separate from the chunk feed so curation can't evict them); "activate"/"complete" are lifecycle actions; off-schedule beats ask *Kairos* for a passage with a consumer-prompt. The console never authors narrative.
- **The conductor is the clock here too.** The narrator-voice + narratives panels render against the same `play`/`connected` cues the matchroom does, anchored to the server's `playbackStartedAt`. No parallel timeline.
- **`ttsEnabled` is a real kill switch.** Role gets you the console; the per-broadcast `ttsEnabled` flag gates whether synthesis actually fires (so testing doesn't burn TTS credits). The voice picker writing the broadcast row doesn't enable audio — the switch does.

## Open work

- **Hook extraction.** ~1017 lines, many `useState`/`useEffect` — extract the WS subscription + dispatch, the lifecycle-action handlers, the voice/source-catalogue state into custom hooks (the capture lifecycle is already `useAudioCapture`). Lower stakes than the matchroom one (no reveal contract to break) but the same shape. Blocked on tests-first. Tracked web-wide in [`../../README.md`](../../README.md) and [`docs/codebase-audit-2026-05-10.md`](../../../../../docs/codebase-audit-2026-05-10.md).
- **The moderator WS protocol is loosely typed** — text + binary frames inbound, the cue union outbound, without a discriminated message envelope on the inbound side. Tightening it is the same work that resolves the `ConnectedCue` name collision on the server side (the conductor's legacy `ConnectedCue` `currentPlay` vs the shared `Connected` `currentPassage`, both on `connected`). Cross-app; tracked in [`apps/blackout/server/README.md`](../../../server/README.md) § Open work and [`../../../README.md`](../../../README.md) § Open work.
- **Moderator-console scoping** — further separate writer and administrator views if the prototype is revisited.
- **Per-event-class radio-offset profile** — the calibration loop the moderator watches via `latency_sample` currently EWMA's a single effective offset per source; per-class lead/lag (KICKOFF / GOAL / cards / subs / VAR each different) is MVP tuning — the moderator UI may want to surface the per-class breakdown.

## See also

- [`../../README.md`](../../README.md) — the frontend; the surfaces; the web↔server seam.
- [`apps/blackout/server/README.md`](../../../server/README.md) — the conductor's authority + the cue vocabulary; `decideSourcePushAllowed`; the broadcast lifecycle.
- [`apps/blackout/server/src/pipeline/README.md`](../../../server/src/pipeline/README.md) — the Deepgram transcription pipeline the binary frames feed; [`apps/blackout/server/src/lib/README.md`](../../../server/src/lib/README.md) — `broadcast-runner` (the moderator-note + audio-chunk relays), `kairos-bridge` (activation/completion), `effective-offset` (the calibration the latency samples come from).
- [`../matchroom/README.md`](../matchroom/README.md) — the member's view of the broadcast this console runs.
- [`packages/blackout/shared/README.md`](../../../../../packages/README.md) — `Broadcast` / `ModeratorView` / `ServiceStatus` / `collectScheduleBlockers`.
