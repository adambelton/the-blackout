---
name: blackout-shared
description: Conventions and rules for packages/blackout/shared (the Blackout side's TypeScript types hub — apps/blackout/server + apps/blackout/client; Kairos does not consume it). Use when reading or writing anything under packages/blackout/shared/**, when defining or changing a WebSocket message contract, when adding a literal-union type, or when a type looks like it's wanted on both sides of the Kairos seam. Keywords: packages/blackout/shared, @blackout/shared, types, discriminated union, cue, fanOut, websocket contract, type guard, TeamSide, BroadcastStatus, Kairos seam, duplicate not share, barrel.
---

# packages/blackout/shared — rules

The **Blackout side's** types hub — `apps/blackout/server` + `apps/blackout/client`. Every shape the Blackout's server and web both touch lives here, declared once. Kairos does *not* consume this package (see below).

## Kairos does not import from `@blackout/shared`
- `apps/kairos/server` has no dependency on `@blackout/shared` and imports nothing from it. The seam between Kairos and the Blackout is the HTTP/WS wire (`apps/blackout/server/src/lib/kairos.ts`), not shared TypeScript — keep it that way. Don't add `@blackout/shared` to `apps/kairos/server/package.json`; don't add a `@blackout/shared/engine-agnostic` sub-barrel or a "domain-agnostic carve-out" to "let Kairos in."
- A shape genuinely needed on both sides of the seam is **duplicated**, not shared — and it's almost always *Kairos* that owns it (it's the engine; the Blackout is the consumer). Kairos owns its API enums; the Blackout side mirrors them on its own (`packages/blackout/shared/types/pipeline-cycle.ts` is exactly this — the consumer-side mirror of Kairos's output shapes, which Kairos never imports back). Duplicating a small, stable shape across a network boundary is correct; coupling the two apps' compile graphs to dodge it is not. If you find yourself wanting `import { X } from "@blackout/shared"` in Kairos, the answer is: define `X` in Kairos. (Long-term direction — a Kairos-owned types package the Blackout imports, replacing the hand-maintained mirror; tracked in `apps/README.md` § Open work.)
- `match-time.ts` is *not* an exception. `parseMatchTime` bakes in football's clock vocabulary (`"45+2"` stoppage, `"HT"` → 45.5, `"FT"` → 9999) — it's the Blackout's reading of the minute the football match is at, shared by `apps/blackout/server` and the matchroom (both Blackout). The function is named in `match` vocab (not `subject` or `content`) because it operates on the value regardless of direction — subject time (input from Kairos's perspective) and content time (output Kairos produces) collapse to the same match-minute label on the Blackout side. Kairos has its own `clampMonotonicMinute` on its side; the parallel implementations are deliberate, not a merge target. See [`docs/vocabulary.md`](../../../docs/vocabulary.md) § Time for the data-flow framing.

## Subject / content / match vocabulary follows data direction
The Blackout broadcasts a *story* about a real-life football match. Three vocabularies, three homes — naming them after the data's *direction of flow*, not its origin:

- **Subject** — only where source data flows TO Kairos. Kairos engine internals, Sportmonks adapter on `apps/blackout/server`, Kairos-client outbound types (`apps/blackout/server/src/lib/kairos.ts` payloads going INTO Kairos). The Blackout client should have *zero* `subject` identifiers — it's downstream of Kairos and only ever sees content.
- **Content** — everywhere Kairos's output flows BACK to consumers. The Blackout server's outbound types to its client (`BroadcastView`, `CanonicalEvent`, `ModeratorFeedEntry`, `BroadcastViewEvent`, `Passage`), the Blackout client (matchroom, moderator console, inspector), the bundle's `revealedCanonical`.
- **Match** — Blackout-shared utilities that operate on the minute label regardless of direction (`parseMatchTime`, `compareEventsByMatchTime`, `MatchTimedEvent`). On the Blackout side, the value IS the match-minute either way; `match` is the common Blackout-side noun.

**The naming follows the seam, not the value.** Subject time and content time may carry byte-identical values under the correctness contract (subject ≡ content); the vocabulary makes the direction of flow explicit. When introducing a wire type the server sends to the client, name it `content*` even if the underlying data was read from Kairos's `subjectTime` — the field on the consumer-facing shape is content.

The defensible-but-wrong call to watch for: renaming `BroadcastViewEvent.contentTime` → `subjectTime` because "the underlying data is subject time on the wire from Kairos." That conflates data origin with consumer-facing field naming. The Blackout server is where the transformation happens — it reads Kairos's `subjectTime`, rebrands it as `contentTime` on its outbound types.

See [`docs/vocabulary.md`](../../../docs/vocabulary.md) § Time.

## WebSocket contracts
- Every WS endpoint has a discriminated union in `packages/blackout/shared/types/` (e.g. `MatchroomCue` is the model). The union is the cross-process contract.
- Both ends of every WS endpoint type the message variable as the union. Server emission site (`fanOut`, `socket.send`) types its payload as the union — no `{ type: string; [k: string]: unknown }` widening. Client `onMessage` dispatches `switch (msg.type)` over the union — no `if (msg.type === "literal")` chains.
- A renamed cue must break compile on both sides, not runtime.

## Don't shadow shared literal unions
- If a type exists in shared (`TeamSide`, `BroadcastStatus`, `BroadcastPhase`, `BroadcastTtsProvider`, etc.), import the named union. Hand-typing `team: "home" | "away" | null` inline when `TeamSide` exists is a maintainability tax — a renamed value silently desyncs every shadow.

## Name collisions across the seam
- Two types with the same name in different files (e.g. `BroadcastStatus` in shared *and* in `apps/kairos/server/src/db/enums.ts` with divergent values, or `ConnectedCue` in shared *and* `apps/blackout/server/src/conductor/types.ts`) are footguns: a wrong import silently binds to the wrong one.
- When a name has to live on both sides of the seam with different shapes, prefix one (`BlackoutBroadcastStatus` for the consumer lifecycle, `KairosBroadcastStatus` for the engine-side state). The collision should be visible at the import site.

## Type guards need tests
- Boundary type guards (`isBroadcastStatus`, `isUserRole`, `isAdmin`, `isTeamSide`, `isKairosSourceName`) are validation gates. Test their behaviour at boundary inputs: empty string, wrong type, mixed case, undefined.
- Pure functions in `packages/blackout/shared` (`canonical-state.ts`, `match-time.ts`, `schedule.ts`) follow the same rule — a regression in `applyRevealingCanonical` desyncs the matchroom and conductor at once.

## Record pairings need exhaustiveness tests
- When a const list (`BROADCAST_TTS_PROVIDERS`, `BROADCAST_PHASES`) pairs with a label catalogue (`BROADCAST_TTS_PROVIDER_LABELS`), add a test that asserts every literal has an entry and vice versa. The `Record<X, string>` typing only enforces this when both are touched in the same PR — a runtime catalogue extension can drift silently otherwise.

## Dead exports are a maintenance liability
- An unused exported type suggests an integration that doesn't exist and constrains refactor.
- Rule: when adding a type, verify it has at least one consumer before merging. Periodically `grep -rn "TypeName" apps/ | grep -v packages/blackout/shared` — anything with zero hits in `apps/` is a candidate for removal.
