# app/matchroom — the live experience

The member-facing room: a live football match rendered as a real-time authored narrative — the narrator's voice plays, the prose reveals in step, an illustration accompanies it, the event ribbon and score and match-clock surface only what's been spoken. **No spoilers, no clock drift across browser tabs.** The same URL flips to replay mode when the broadcast completes. This is the surface the whole product exists to deliver, and the reveal contract is its hardest constraint.

For where this sits and the cue vocabulary it consumes, see [`../../README.md`](../../README.md) and [`apps/blackout/server/README.md`](../../../server/README.md). This README goes one level deeper.

## How it fits

```
GET /broadcasts/:id ──▶ bootstrap: BroadcastMeta + persisted narrations (with audio URLs + the
 (on mount; refetched revealed/guarded event sets) + the archive shape if `complete` → seed state
 on reconnect; refetched ↓
 on broadcast_status_ ws://server/ws/matchroom?broadcastId=… (useReconnectingWebSocket)
 changed → replay mode) │
 ▼ onMessage → parse envelope → discriminated-union dispatch:
 connected → snapshot: seek to (serverNow − playbackStartedAt); set phase; (bundle: currentPassage too)
 narrative → stage prose + covers + batchEntryIds (NOT visible yet — waits for `play`)
 play → audio.currentTime = (serverNow − playbackStartedAt)/1000; audio.play();
 mark narrative visible; computeCoverRevealSchedule(covers, text, durationMs)
 → setTimeout per cover with a charOffset (reveal mid-audio); the rest reveal at audio-end
 feed_entry → stage in the event map (NOT promoted to the visible ribbon — that happens at the
 audio-end of the narration whose batchEntryIds cite it)
 illustration → swap the image on the passage's audio start (waits its turn if a later one arrives first)
 phase → swap the quiet-window placeholder copy (pre-ramp / halftime / full-time winddown)
 broadcast_status_changed("complete") → refetch GET /broadcasts/:id → enter replay mode
 ▼
 render: Header · Fixture (scoreline + content-clock label) · EventRibbon (revealed events) · NowPlaying
 · Narration (the prose, revealed word-by-word in step with audio) · Illustration · Marginalia
 · PhasePlaceholder (when no passage is in flight) · ConnectionPill
 score = revealedCanonical.score (live, bundle) | deriveScore(revealed events) (replay / legacy fallback)
 content-clock = computeContentMinuteLabel({phase, isReplay, currentContentMinute, fallbackContentMinute, events}) — monotonic
                                          (see ../../../../../docs/vocabulary.md § Time)
```

The clock contract: the server's `setTimeout(onClipEnd, durationMs)` is the truth. The page never advances a timeline — it seeks audio to the server-anchored offset on every `play` and on `connected.currentPlay`/`currentPassage`, and renders against whatever's revealed.

**Replay mode** (same URL, on `complete`): the page refetches `GET /broadcasts/:id` (the archive shape), then drives playback *client-side* from the persisted narrations — but still **no scrubbing and no spoilers even on replay** (the listener is mid-replay; the UI reflects their progress, not the final state — that's why `deriveScore` / `latestContentMinute` / `computeContentMinuteLabel` use the *fallback* derivations in replay rather than the server's final-state score). Progress persists to localStorage (`loadReplayProgress` / `saveReplayProgress`) so a refresh resumes where the listener was. The admin progressive-rerun variant is still owed (`docs/archive-replay-design`).

## What it does

### `[broadcastId]/page.tsx` — the orchestrator (~1355 lines)

Holds the page state (`broadcast`, `events` (revealed only), `narratives`, `visibleNarrativeIds` (whose `play` has fired — text UI filters against this so nothing reads ahead of the narrator), `phase`, the staged-event map, the running `CanonicalState`, the replay-progress cursor) and wires: the bootstrap fetch (`apiGet`), the WS subscription (`useReconnectingWebSocket` — `onOpen` triggers backfill), the discriminated-union message dispatch (the cue table above), the audio element (one `<audio>`, seeked on each `play`), the per-cover reveal-schedule `setTimeout`s, the staged→promoted event-set logic (a `feed_entry` cue stages an event; it's promoted to the visible ribbon at the audio-end of the narration whose `batchEntryIds` cite it — or at the cover anchor if cited mid-prose), the illustration queue (swap on passage audio-start, wait-your-turn if out of order), the phase-placeholder copy, the replay-mode flip on `broadcast_status_changed`, the bundle-vs-legacy reveal path (today: legacy `narrative`/`play`/`illustration`; the bundle path — `passage_*` + `revealedCanonical`/`revealingCanonical` walked via `applyRevealingCanonical` — is wired but not yet the source of truth; Sub-piece 4c flips it).

### `[broadcastId]/derivations.ts` — the pure reveal rules (unit-tested in `derivations.test.ts`)

Lifted out of `page.tsx` so the reveal contract is testable without rendering: `deriveScore(events)` (client-side score from revealed goals — the replay/legacy fallback; the bundle path uses `revealedCanonical.score`), `latestContentMinute(events)` (the event with the highest *parsed match-minute*, not the highest push timestamp — so a re-pushed early-minute duplicate from a runner restart doesn't surface as "latest"), `formatMinute` (→ `"47'"` / `"45+2'"`), `isShowableEvent` (the client-side ribbon allow-list — server pre-filters pressure/zone noise, this is the second gate), `eventLabel` / `eventText` (display formatting — sub arrows, goal-scorer + team), `computeCoverRevealSchedule(covers, text, durationMs)` (per-cover `{entryId, delayMs}` — `delayMs = (charOffset / text.length) × durationMs`; covers without a `charOffset` are reserved for audio-end reveal — the caller subtracts the scheduled set from the audio-end batch), `computeContentMinuteLabel({phase, isReplay, currentContentMinute, fallbackContentMinute, events})` (the displayed clock label, priority order: `halftime`→"HT", live `full_time_winddown`/`complete`→"FT", else the current passage's `contentMinute` string, else the server's `currentContentMinute` (live bootstrap fallback), else `latestContentMinute` over revealed events — replay never short-circuits to HT/FT because the listener is mid-replay). Several of these (`deriveScore`, `latestContentMinute`, `computeContentMinuteLabel`'s rule) simplify when the bundle becomes the source of truth (Sub-piece 4) — they characterise *today's* behaviour and lock it against regression until then.

### `[broadcastId]/components/` — the visual pieces

`Header` / `Fixture` (scoreline + match-clock label + team crests) / `EventRibbon` (the revealed events) / `NowPlaying` / `Narration` (the prose, revealed in step) / `Illustration` / `Marginalia` / `PhasePlaceholder` (quiet-window copy) / `ConnectionPill` (the WS status) — plus `types.ts` (`BroadcastMeta` / `Narrative` / `PlayCue`) and `utils.ts` (`loadReplayProgress` / `saveReplayProgress`).

## Contract

### Provided
- The matchroom route: `/matchroom/[broadcastId]` — a member's live (or replay) view of a broadcast. Bootstraps from `GET /broadcasts/:id`, drives off `ws://server/ws/matchroom?broadcastId=…`.
- The pure reveal rules (`derivations.ts`) — characterised in `derivations.test.ts`; this is the testable surface of the no-spoilers contract.

### Depended on
- **From `apps/blackout/server` (HTTP):** `GET /broadcasts/:id` — the bootstrap view (`BroadcastView`: the broadcast row, the persisted narrations with audio URLs + the revealed/guarded event sets, the archive shape on `complete`, the inferred phase, `currentContentMinute`). The web walks this on mount and on every reconnect.
- **From `apps/blackout/server` (WS — `/ws/matchroom`):** the matchroom cue stream, filtered by the server's matchroom whitelist — `connected` (with `currentPlay` + `currentPassage`, `serverNow`, `phase`), `narrative` (text + `covers` with `charOffset` + `batchEntryIds` + `contentTime`), `play` (`playbackStartedAt` + `serverNow` + audio URL + `durationMs` + `batchEntryIds`), `preload`, `phase`, `illustration` (the narrative id + image URL), `feed_entry` (reshaped to the viewer DTO), `passage_added`/`passage_audio_ready`/`passage_started`/`passage_skipped`/`passage_updated` (the bundle cues — wired, not yet the source of truth), `broadcast_status_changed`. The clock contract: seek to `(serverNow − playbackStartedAt)`. **Audio is canonical** — the server only sends what's safe; the client only reveals what's been spoken.
- **From `@blackout/shared`:** `CanonicalEvent` / `CanonicalState` / `Passage` and the helpers `applyRevealingCanonical` / `compareEventsByMatchTime` / `emptyCanonicalState` / `isLivePhase` / `parseMatchTime`.
- **From `lib/`:** `apiGet` / `API_URL` (the bootstrap + the WS origin derivation), `useReconnectingWebSocket` (`lib/ws.ts`), `routes` (path builders). From `app/lib/`: `palette` (brand tokens).

## Anti-patterns

- **No client clock.** The page seeks audio to `(serverNow − playbackStartedAt)`; it never runs its own timeline or trusts the local wall clock. (Replay mode owns playback client-side, but still anchored to the persisted narration durations — not a free-running timer.)
- **Nothing visible before the narrator says it.** A `narrative` cue stages prose but doesn't show it (waits for `play` → `visibleNarrativeIds`); a `feed_entry` cue stages an event but doesn't promote it to the ribbon (waits for the citing narration's audio-end, or the cover anchor mid-prose). The content clock (today's "match clock") is monotonic — `computeContentMinuteLabel` + the server's monotonic clamps ensure it never regresses on a late earlier-phase entry.
- **No scrubbing, no spoilers — even on replay.** Replay reflects the listener's progress, not the final state; the fallback derivations (not the server's final-state score) drive the UI in replay.
- **No talking to Kairos.** The matchroom reads `apps/blackout/server` cues only. (The inspector surface — a different route — reads `apps/blackout/server`'s Kairos-proxy endpoints; the matchroom never does.)

## Open work

- **Hook extraction.** ~1355 lines, many `useState`/`useEffect` — extract the WS subscription + dispatch, the audio scheduler, the reveal-walk, the replay-progress persistence into custom hooks. **Blocked on integration tests first** (extracting the reveal-walk without a test harness risks silent regression). Tracked web-wide in [`../../README.md`](../../README.md) and [`docs/codebase-audit-2026-05-10.md`](../../../../../docs/codebase-audit-2026-05-10.md).
- **Flip to the bundle reveal path.** Sub-piece 4c — consume `passage_*` + `revealedCanonical`/`revealingCanonical` as the source of truth; `derivations.ts`'s `deriveScore` / `latestContentMinute` / `computeContentMinuteLabel` simplify; 4d retires the legacy cues. → [`docs/matchroom-reveal-architecture-scoping.md`](../../../../../docs/matchroom-reveal-architecture-scoping.md).
- **Completed-state polish** — passage skip, credits, and no social drawer in replay.
- **Admin progressive-rerun replay variant** — owed. → [`docs/archive-replay-design`](../../../../../docs/archive-replay-design.md).

## See also

- [`../../README.md`](../../README.md) — the frontend; the surfaces; the web↔server seam.
- [`apps/blackout/server/README.md`](../../../server/README.md) — the conductor's authority + the full cue vocabulary; the matchroom transform whitelist.
- [`apps/blackout/server/src/conductor/README.md`](../../../server/src/conductor/README.md) — the canonical-bundle composition (`canonical-compose.ts`) the bundle path consumes.
- [`../moderator/README.md`](../moderator/README.md) — the control surface that drives the broadcast this room renders.
- [`packages/blackout/shared/README.md`](../../../../../packages/README.md) — `CanonicalState` / `Passage` / the cue types / `applyRevealingCanonical`.
- [`docs/matchroom-reveal-architecture-scoping.md`](../../../../../docs/matchroom-reveal-architecture-scoping.md), [`docs/archive-replay-design`](../../../../../docs/archive-replay-design.md) — the design memos.
