# apps/blackout/ — the Blackout experience

The two halves of the Blackout concept: a Next.js frontend (`client/`) and a stateful Hono backend (`server/`). One experience, two processes. **The server is the room conductor** — broadcast lifecycle, source capture, the playback clock, the per-passage canonical bundle, WebSocket fan-out. **The client is the renderer** — every user-facing surface (public discovery, listener matchroom, writer/admin moderator console, content studio, admin tooling). Football lives entirely on this side; Kairos sees only typed source entries + a brief.

This README is the consumer-side checkpoint: how the two halves fit, the contract at the internal seam, the no-spoilers reveal principle that constrains both ends. For the cross-service relationship to Kairos, see [`../README.md`](../README.md). For service-internal deep detail, see [`client/README.md`](client/README.md) and [`server/README.md`](server/README.md).

## What's here

- **[`client/`](client/README.md)** — `@blackout/client`. Next.js 16 / React on :3000. Renders. Holds no orchestration state, no clock. Talks to `server/` over HTTP + WebSocket; **never talks to `../kairos/server/` directly** — the engine is behind the server.
- **[`server/`](server/README.md)** — `@blackout/server`. Hono on Node.js on :4000. Stateful. The room conductor. Source capture (Sportmonks events, the moderator's transcribed radio audio), commentary distillation, the Kairos feed subscription, TTS + illustration synthesis, the per-passage canonical bundle the matchroom walks, WebSocket fan-out to matchroom + moderator clients. **Owns the broadcast clock** — `setTimeout(onClipEnd, durationMs)` is the truth.

## How the halves fit

```
   client (:3000)                              server (:4000)
   ┌──────────────────────┐  HTTP REST    ┌──────────────────────┐
   │  matchroom / mod /   │ ────────────▶ │  /broadcasts/*       │
   │  studio / admin      │  Better Auth  │  /broadcasts/:id/*   │
   │  public / replay     │  cookie       │  studio + admin      │
   │                      │ ◀──────────── │                      │
   │  receives cues       │  WebSocket    │  WebSocket fan-out:  │
   │  reacts (no clock)   │ ◀──────────── │   /ws/matchroom      │
   │                      │               │   /ws/moderator      │
   └──────────────────────┘               └──────────────────────┘
                                                    │
                                                    │ HTTP + WS (Bearer KAIROS_API_KEY)
                                                    ▼
                                          ../kairos/server (:5050)
                                          (see ../README.md for the seam)
```

Two seams; each is a one-way dependency. **`client → server`** is intra-service. **`server → ../kairos/server`** is the inter-service seam — documented in detail at [`../README.md`](../README.md) so the cross-service contract lives where it spans.

### client → server

- **HTTP:** [`client/lib/api.ts`](client/lib/api.ts) is the typed client (`apiGet` / `apiPost` / `apiPatch` / `apiDelete`). Studio, admin, broadcasts-page CRUD; auth via Better Auth (issued on the client, validated on the server).
- **WebSocket:** [`client/lib/ws.ts`](client/lib/ws.ts) (`useReconnectingWebSocket`) connects to `ws://server/ws/matchroom?broadcastId=…` (member viewer) and `ws://server/ws/moderator?broadcastId=…` (writer/admin control surface). The cue payloads are defined once in [`@blackout/shared`](../../packages/blackout/shared/README.md) and enforced at compile time across both halves.
- **The server is the clock; the client reacts.** Every `play` cue carries `playbackStartedAt` + `serverNow`; the client seeks audio to `(serverNow − playbackStartedAt) / 1000`. No client-side timeline (replay mode owns playback client-side but anchored to the persisted narration durations, not a free-running timer). Clock drift across browser tabs is structurally impossible because there *is* no client clock.
- **Audio is canonical** — nothing visible on the matchroom (text, events, score, illustration) before the narrator has spoken it. A `narrative` cue stages prose but doesn't reveal it (waits for `play`); a `feed_entry` cue stages an event but doesn't promote it to the ribbon (waits for the citing narration's audio-end, or the cover anchor mid-prose); the match clock is monotonic. The reveal rules are pure in `client/app/matchroom/[broadcastId]/derivations.ts` (tested) — kept there to keep `page.tsx` an orchestrator. **Operator-only cues** (`feed_entry`, `latency_sample`) never reach the matchroom — the server's `matchroom-transform.ts` whitelist enforces this at fan-out time.
- **Contract `client/` depends on `server/` for:** the cue union shape; that the conductor emits passages with `revealedCanonical` + `revealingCanonical` (charOffset markers) so the matchroom can fire per-entry reveals mid-audio; that `broadcast_status_changed` switches the matchroom from live mode (server-anchored) to replay mode (client-owned) on `complete`; that the server's per-passage canonical bundle is a strict subset of what the cycle observed (so reveal events the client doesn't expect never arrive).

### server → ../kairos/server

Summarised here; canonical contract at [`../README.md`](../README.md) § *blackout-server → kairos-server*. In brief: `server/src/lib/kairos.ts` is the typed HTTP/WS client; every request carries `Authorization: Bearer <KAIROS_API_KEY>`; football meanings (Sportmonks event types, the radio offset, club briefs) live entirely on this side — Kairos sees only typed entries + a brief.

### client ↛ ../kairos/server

**Never directly.** Anything the frontend needs from the engine (e.g. the pipeline inspector at `client/app/inspector/`) goes through `server/` routes that proxy or aggregate Kairos's `GET /broadcasts/:id/*` reads. A Kairos URL in `client/` is a seam violation.

## Shared infrastructure

- **[`@blackout/shared`](../../packages/blackout/shared/README.md)** — the Blackout side's TypeScript types hub. WS cue payloads, the bundle types, the broadcast lifecycle enums, content-time helpers. Both halves import from it. A change to a cue shape is caught at compile time across `client/` + `server/`.
- **[`@blackout/auth`](../../packages/blackout/auth/README.md)** — the shared Better Auth factory. `client/` *issues* sessions; `server/` *validates* the same session cookie on every HTTP request and every WS upgrade. The shared cookie-signing secret + table names let one side validate a session from the other without an HTTP hop.
- **`../kairos/server` doesn't consume either package.** Cross-seam shapes are duplicated (Kairos owns them; the Blackout side mirrors) — see [`../README.md`](../README.md) § *Domain-agnostic discipline*.

## Open work — cross-half

Items that span `client/` + `server/` together. Half-internal WIP lives in each half's README.

- **Matchroom reveal architecture — replay variant.** Live + replay share one `Passage` / `CanonicalState` contract (live = server-anchored, replay = client-owned). The admin progressive-rerun variant and a few completed-state polish items are still owed. → [`../../docs/matchroom-reveal-architecture-scoping.md`](../../docs/matchroom-reveal-architecture-scoping.md).
- **Blackout broadcast templates.** Make "how the Blackout uses Kairos" reusable-per-mode (broadcast template = `event_profile` choice + source roster + `BroadcastConfig` + default voice; compiles to the `POST /broadcasts` payload). Authoring lives in `client/`'s content studio; persistence + payload assembly live in `server/`. → [`../../docs/prompts-as-content-design.md`](../../docs/prompts-as-content-design.md).
- **`ConnectedCue` / `BroadcastStatus` name collisions** — the WS protocol's typing crosses both halves and `@blackout/shared`. → [`../../docs/codebase-audit-2026-05-10.md`](../../docs/codebase-audit-2026-05-10.md).

## See also

- [`../README.md`](../README.md) — the two services and the Blackout↔Kairos seam.
- [`../kairos/README.md`](../kairos/README.md) — the engine this consumer side depends on at runtime.
- [`../../packages/README.md`](../../packages/README.md) — `@blackout/shared` + `@blackout/auth`.
- [`../../docs/the-blackout-architecture.md`](../../docs/the-blackout-architecture.md) — canonical consumer-side architecture, being decomposed into `client/` + `server/` READMEs.
