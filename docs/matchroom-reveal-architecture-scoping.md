# Matchroom reveal architecture — scoping doc

> **Status: shipped 2026-05-04.** This doc is preserved as the scoping record. The cluster shipped across 12 commits (`76ea7f7..6cbfd96`); current architecture is documented in [`the-blackout-architecture.md`](./the-blackout-architecture.md) §3 (per-passage canonical-state bundle) and §8 (cue vocabulary — bundle-driven matchroom contract, legacy cues retained for moderator). The "Status at handoff" table at the bottom of this doc is frozen at the pre-implementation state.

> **Vocabulary note (2026-05-16).** Written before the three time domains (subject / content / broadcast) were formalised — see [`vocabulary.md`](./vocabulary.md) § Time. Where the body says "matchMinute," "match clock," or `contentTime`, the consumer-side display label is **content time** under the new vocabulary; the entry-level field is **subject time**. Preserved as the historical record.

This was the working scope for the seventh and final piece of the 2026-05-03 cluster. The first six pieces landed `8617b1e`, `cbc9fb4`, `cb185bd`, `17e45bb`, `f89397b` (commit `e9d2b08` for the cosmetic scrub that preceded). The cluster itself is captured in `docs/live-test-2026-05-03.md`. This doc is the pickup-ready scope for the architectural finale: Design A from the debrief.

## What this piece does

Move the matchroom's UI state authority from "client derives from event-stream" to **server publishes per-passage canonical state**. Every passage carries:

- `revealedCanonical` — the full UI state at this passage's audio-start (everyone joins to the same render, no event replay required).
- `revealingCanonical` — what this passage will change, with `charOffset` per field.

Late joiner: render `revealedCanonical` immediately, drop into the audio at the server-anchored offset, walk markers from there. Replay: client walks from the start with localStorage progress; same data shape.

Subsumes Finding 3 (phase cue wall-clock spoiler) and the match-clock-not-guarding bug from the live test, since both trace to the same wall-clock `PhaseCue` fanout.

## Why architectural, not tactical

- The match-clock bug already has the same root as Finding 3 — fixing them separately is a wasted patch.
- The cluster has touched all of: closing-cycle dispatch, content-time stamping, content-time gate, auto-complete defer. The matchroom is the last surface that hasn't moved to the new model.
- Live mode + replay mode want the same data; only authority over playback offset differs (server-anchored live, client-owned replay). One contract, two consumers.

## Sub-pieces — natural sequencing

Five sub-pieces, landable as separate commits with the conductor dual-emitting during the transition.

1. **Shared types + conductor authors the bundle.** New `CanonicalState` types in `@blackout/shared`. Conductor tracks running canonical state across passages, composes `revealedCanonical` / `revealingCanonical` on each Kairos narrative, sends it on the `narrative` cue alongside (not instead of) the existing fields. Matchroom unchanged. *Deliverable: server emits the bundle, no consumer breakage.*
2. **Phase rides the bundle; `PhaseCue` retires.** Identify the phase-transition cover in `narrative.covers`, lift phase into `revealingCanonical.phase` with charOffset. Conductor stops emitting the standalone `PhaseCue`. Matchroom switches phase rendering to read from the bundle.
3. **Illustration moves into the bundle with charOffset.** See Q1 below — leaning toward the lightest option (charOffset = 0, swap at audio start) for this cluster, with editorial-charOffset as a follow-up.
4. **Matchroom consumes the bundle as the source of truth.** Replace `deriveScore` with `revealedCanonical.score`. Drop `currentBatchMinute`. Drop the `phase` cue handler. Late-joiner snapshot uses `connected.currentPlay.revealedCanonical`.
5. **Replay walks localStorage progress.** Save passage index + audio offset on every audio time-update; restore on mount.

## Channels in scope

| Channel | Today | Design A target |
|---|---|---|
| Event ribbon chips | `covers[]` + charOffset | Already in shape — relabel under `revealingCanonical.events` |
| Scoreline | `deriveScore(events)` client-side | Server-authored; `revealedCanonical.score`, deltas in `revealingCanonical.score` for goal-bearing passages |
| Phase (HT/FT badge + UI mode) | `PhaseCue` wall-clock fanout | Cover marker on the closing passage; `PhaseCue` retires |
| Match clock label | Reads `phase` to decide HT/FT | Auto-fixes when phase moves into bundle |
| Illustration | Separate `illustration` cue | Carries a charOffset; swap timed to a marker |
| Lineup | Not exposed | Defer (per debrief) |

## Open architectural questions

Pin these before coding, not after.

### Q1 — Where does the illustration's charOffset come from?

- (a) Kairos generator declares it: the LLM gets prompted to choose where the image's "moment" lands in the prose. Most accurate; biggest Kairos change.
- (b) Conductor picks heuristically: e.g., charOffset 0 (audio start), a fraction through the prose, or the first event-cover offset. Simpler; less editorial.
- (c) Stay where it is for now (swap on narrative receipt) but rename the field — illustration is *part* of `revealingCanonical` with marker = "audio start." Loses the cinematic offset the debrief described but keeps illustration timing identical to today's.

**Lean:** (c) for this cluster, (a) as a follow-up. The cluster's main job is fixing phase / clock / score reveal — illustration's existing timing isn't broken, just architecturally inelegant.

### Q2 — Where does the phase-transition cover anchor in the prose?

The closing cycle's prose is supposed to land on the whistle as the final beat (the Piece 4 prompt). The phase transition should reveal at that moment.

- (a) Generator emits a cover for the synthetic phase entry with a charOffset, like any other event cover. The closing-shape prompt nudges the model to anchor it at the whistle line.
- (b) Conductor places the phase marker at a heuristic offset (e.g., end of prose, last sentence boundary).

**Lean:** (a) — let the generator choose. The synthetic entry already has an `entryId`; the closing-shape prompt was designed for this. Verify behaviour during smoke tests.

### Q3 — Does the conductor aggregate score itself?

Today's matchroom does this client-side via `deriveScore(events)`. Moving server-side: the conductor watches `feed_entry` cues for goals and maintains a running score. Same logic, different home.

**Decision:** yes, score lives on the conductor. Football-specific aggregation belongs in the football-aware layer. Kairos stays domain-agnostic.

### Q4 — Late-joiner snapshot shape on `connected`?

Today the `connected` cue carries `currentPlay: PlaySnapshot | null`. We add `currentPlay.revealedCanonical` (state at the playing passage's audio-start) and the audio offset (already present). Marker walk from there.

If no clip is playing (between passages, pre-kickoff, post-FT), the snapshot needs a `revealedCanonical` field on the connected payload directly — "broadcast's current state with no active passage."

**Lean:** add `connected.revealedCanonical` as a top-level field, populated whenever a `currentPlay` is null. Symmetric API.

### Q5 — Replay mode — what does the API serve?

The replay client walks the broadcast from start. Server endpoint serves the ordered passage list with each passage's bundle. Already exists in some form via the broadcast view; needs to include the new bundle fields.

### Q6 — Lineup: include now or fully defer?

- (a) Include the shape (`revealedCanonical.lineup: Lineup | null`) but always populate as `null`. Closes the contract; no bundle-shape change later.
- (b) Defer entirely; add the field when lineup tracking lands.

**Lean:** (a). Cheap insurance against a future contract change.

## Recommended scope for the cluster's last piece

- Sub-pieces 1, 2, 4 (mandatory — fixes the broken parts, retires `PhaseCue`)
- Sub-piece 3 with **Q1 option (c)** — illustration in the bundle, swaps at audio start (no Kairos change)
- Sub-piece 5 — replay localStorage
- Q2 option (a), Q3 yes, Q4 add to connected, Q6 include null
- Defer: lineup population, editorial illustration charOffset, Render pipeline (Design B)

Estimated: 5–7 commits, mostly conductor + matchroom. New shared types. ~800–1200 lines net.

## Files likely touched

**Shared types**
- `packages/shared/types/` — new `CanonicalState`, `RevealedCanonical`, `RevealingCanonical` types and their channel sub-types (score, phase, matchMinute, events, illustration, lineup).
- The narrative WS cue payload type.

**Server**
- `apps/blackout/server/src/conductor/RoomConductor.ts` — running canonical-state tracking, bundle composition on each Kairos narrative, retire standalone `PhaseCue` + `illustration` cue (or dual-emit during transition).
- `apps/blackout/server/src/conductor/types.ts` — cue type updates.
- Possibly new helpers for score aggregation from canonical events.
- Tests in `apps/blackout/server/tests/`.

**Web (matchroom)**
- `apps/blackout/client/app/matchroom/[broadcastId]/page.tsx` — switch reveal logic to walk the bundle. Delete `deriveScore`, `currentBatchMinute`, the `phase` cue handler. Late-joiner consumption from `connected.currentPlay.revealedCanonical` (or `connected.revealedCanonical`).
- localStorage save/restore in replay mode.
- Possibly a small `useReveal` hook to encapsulate the marker-walk logic.

**Replay API**
- The broadcast view endpoint (wherever it returns the passage list for replay) needs to include the bundle fields.

## Resume-tomorrow checklist

1. Read this doc + skim `docs/live-test-2026-05-03.md` (Design A section).
2. Confirm the **Recommended scope** + lean answers to the open questions, or push back on specific ones.
3. If confirmed, design Sub-piece 1 in detail (shared types shape) before touching code.
4. Implement Sub-piece 1, commit, push.
5. Continue through Sub-pieces 2–5, one commit per piece, the same pattern that landed Pieces 1–6 of the cluster.

## Cluster status at handoff (commit `f89397b`)

| # | Piece | Status | Commit |
|---|---|---|---|
| 1 | Closing-cycle boundary intervention | ✅ | `8617b1e` |
| 2 | Finding 2 — canonical-events preamble filter | ✅ | bundled with #1 |
| 3 | Finding 4 — content-time stamping fix | ✅ | `cbc9fb4` |
| 4 | Finding 5 — sort + closing-cycle prompt | ✅ | `cb185bd` |
| 5 | Finding 6 — content-time gate | ✅ | `17e45bb` |
| 6 | Finding 7 — auto-complete defer | ✅ | `f89397b` |
| 7 | Matchroom reveal architecture (Design A) | ⏳ | (this doc) |

Tests at handoff: 285 Kairos + 331 server. All passing. No broken state.
