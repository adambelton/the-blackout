---
name: blackout-client
description: Conventions and rules for apps/blackout/client (the Next.js frontend for matchroom, moderator console, content studio, admin, public surfaces). Use when reading or writing anything under apps/blackout/client/**, when adding components, when the same file holds many useState/useEffect calls, when wiring WebSockets in the client, when fetching from the server, or when designing what a member sees during a live broadcast. Keywords: apps/blackout/client, next.js, app router, react, component, hook, useState, useEffect, websocket, matchroom, moderator, studio, admin, member, no-spoilers, reveal.
---

# Blackout web (apps/blackout/client) — rules

Architecture context: `apps/blackout/client/CLAUDE.md` and `docs/the-blackout-architecture.md`.

## Component composition
- Routes follow a fixed shape: `app/<route>/[id]/page.tsx` is the orchestrator; `app/<route>/[id]/components/` holds the visual pieces (one component per file, PascalCase) plus co-located `types.ts` (per-route shared types) and `utils.ts` (per-route shared helpers).
- Pure derivations (data → data, no React, no IO) live in a sibling `derivations.ts` next to `page.tsx`. Pair with `derivations.test.ts`. Model: `app/matchroom/[broadcastId]/derivations.ts` + its test.
- Shared cross-route components live in `app/components/` (e.g. `Panel.tsx`, `Dialog.tsx`, `Field.tsx`, `PillButton.tsx`). Reach for an existing one before adding a new variant.
- Brand tokens (colours, type) come from `app/lib/palette.ts` — don't hardcode hex values in components.

## Hook extraction
- The page is the orchestrator, not the implementation. When a `page.tsx` accumulates more than ~10 related hook calls (`useState`/`useEffect`/`useRef`/`useCallback`/`useMemo`) for one concern, extract into a hook.
- Naming: `use<Concern>` (camelCase, no prefix beyond `use`). Hook file is a sibling of `page.tsx`, not under `components/` (components are visual; hooks are behavioural).
- Hook owns: state machine, lifecycle (`useEffect` setup/teardown), event handlers, derived values for that concern. Hook receives: external dependencies (refs to DOM elements the page owns, callbacks, primitives). Hook returns: a small surface — values + actions, not internal state.
- Pair every non-trivial hook with `<HookName>.test.ts` if the logic is testable in isolation. Model: `app/moderator/[broadcastId]/useAudioCapture.ts` + `useAudioCapture.test.ts`.
- Concern grouping (one hook each, not one mega-hook): WebSocket lifecycle, audio playback queue, latency tracking, voice picker state, local form state, etc.

### Current extraction backlog (snapshot 2026-05-10)
The matchroom and moderator pages still hold a lot of logic inline. The full extraction plan with proposed hook surfaces lives in `docs/codebase-audit-2026-05-10.md` § *apps/blackout/client*. Headline targets:

- **Matchroom** (`app/matchroom/[broadcastId]/page.tsx`, ~1347 lines, ~44 hook calls): `useNarrationPlayback`, `useMatchroomConnection`, `usePassageBundles`, `useReplayWalk`, `useBroadcastView`.
- **Moderator** (`app/moderator/[broadcastId]/page.tsx`, ~1016 lines, ~83 hook calls): `useModeratorConnection`, `useNarratorVoicePicker`, `useLiveNarrativePlayback`, `useServiceStatus`, `useGenerationPause`, `useRadioSourceSelection`, `useBroadcastLifecycle`, generic `useAutoScroll`.

When extracting, follow the `useAudioCapture` precedent — including the test file.

### Closure-capture refs are a hook signal
- A page accumulating `useEffect(() => { someRef.current = someState }, [someState])` blocks is fighting closure capture in a WS handler / async callback. That's the symptom; the cure is moving the handler + its closed-over state into a hook of its own.

## Matchroom: no spoilers
- Audio is canonical. Nothing visible (text, score, events, illustrations) reveals before the narrator has spoken it.
- Reveal is gated by `covers` markers in narration outputs. Score derivation, event ribbon, scoreboard all read from the visible-state projection — not from raw events.
- When adding a new visible surface in the matchroom, ask: "could a member see this before the narrator gets there?" If yes, route it through the reveal gate.
- Design background: `docs/matchroom-reveal-architecture-scoping.md`.

## Time vocabulary — the client never sees "subject"
- The Blackout broadcasts a *story* about a football match. The factual truth of the match flows TO Kairos (subject); the story flows back FROM Kairos to the consumer (content). Any `subject*` identifier in `apps/blackout/client` is a regression — that's engine vocabulary, not consumer vocabulary.
- Client-side time identifiers use **content** (`contentTime`, `contentMinute`, `currentContentMinute`, `fallbackContentMinute`, `latestContentMinute`, `computeContentMinuteLabel`) or **match** for shared helpers that handle the value regardless of direction (`parseMatchTime`, `compareEventsByMatchTime`).
- The inspector (`app/inspector/`) is the one forward-looking exception — it'll migrate to a Kairos-owned admin app where engine vocab is appropriate. New work shouldn't add subject identifiers on the matchroom/moderator/studio/public surfaces.
- See [`docs/vocabulary.md`](../../../docs/vocabulary.md) § Time for the data-flow framing.

## Auth + paid calls
- Better Auth on the web side is **not** the server's auth. Endpoints in `apps/blackout/server` that spend money need their own auth middleware — see [blackout-server](../blackout-server/SKILL.md).

## WS contracts
- Every WS endpoint defines a discriminated union in `packages/blackout/shared` (matchroom uses `MatchroomCue` — model). Dispatch is `switch (msg.type)` over the union. **No `if (msg.type === "literal")` chains.** A renamed message type must break compile, not runtime.

## API access
- Direct `fetch()` is forbidden in the web app. Use `apiGet` / `apiPost` / `apiPatch` / `apiFetch` from `lib/api.ts`. They carry `credentials: "include"` and route errors through `ApiError` — central handling for auth, network, and shape failures.

## Shared predicates
- Phase / status string predicates (`LIVE_PHASES`, `isLivePhase()`, `BROADCAST_STATUSES`, etc.) live in `packages/blackout/shared`. Never inline disjunctions like `phase === "live_first_half" || phase === "live_second_half" || ...` — they drift silently when phases are renamed or added.

## Storage keys
- All `localStorage` / `sessionStorage` keys live in `lib/storage-keys.ts` (one function per key, e.g. `replayProgressKey(broadcastId)`). A `grep` of that file finds every persisted preference — impossible if keys are inlined.

## Cross-route components
- Components used by ≥2 routes move to `app/components/`. A cross-route import (e.g. admin reaching into moderator's `components/`) is a signal to lift.

## Test discipline
- Every behavioural hook gets `<HookName>.test.ts` for its non-trivial branches.
- Every pure module (`derivations.ts`, route-scoped `utils.ts` with non-trivial helpers) gets `<module>.test.ts`.
- Model: `useAudioCapture.test.ts` and `derivations.test.ts`.

## Conventions in passing
- `"use client"` only where interactivity is required. Default to Server Components.
- Shared types from `@blackout/shared`. Don't duplicate domain types in the web app.
- Auth helpers in `lib/use-current-user.ts`. API helpers in `lib/api.ts`. WS helpers in `lib/ws.ts`. Routes in `lib/routes.ts`.
- Tests use Vitest (`vitest.config.ts`). Pure modules get unit tests; React rendering is not currently a tested surface.

## Member ethics applies to UX
- Acquisition surfaces describe what The Blackout is and let it speak. No dark patterns, no false urgency, no incomplete journeys to pressure signup. See [workflow](../workflow/SKILL.md) and root `CLAUDE.md` § *How we treat members*.
