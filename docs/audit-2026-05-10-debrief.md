# Audit: 2026-05-10 broadcast debrief findings

Forest v Newcastle. Kairos broadcast `d268dd59-66de-4bae-aeb2-26685c4a9dd7`, Blackout broadcast `b2107453-5700-4ac0-bd6f-ff8a06af920a`.

> **Vocabulary note (2026-05-16).** This debrief was written before the three time domains (subject / content / broadcast) were formalised — see [`vocabulary.md`](./vocabulary.md) § Time. Where the body says "content time," `contentTime`, "match clock," or `matchMinute`, read **subject time** for the input side and **content time** (new) for the output side. Finding A7 ("distillation phaseSecond anchored on line time, canonical on storage time") is precisely the "broadcast → subject conversion drift" failure mode the new vocabulary names. Preserved as the historical record.

## A1 — distiller misclassification of event-announcing commentary as atmosphere

Status: **CONFIRMED**

Evidence:

- `match_action` rows by kind (Kairos):
  ```
       kind      | count
  ---------------+-------
   atmosphere    |   323
   event_texture |    23
  ```
- Multiple atmosphere entries are unambiguous event announcements that the distiller should have routed via `event_texture` or dropped via `event_claim`:
  - `Ryan Yates coming on to inject more energy into the midfield after a sluggish first half.`
  - `The crowd gave warm applause as Omari Hutchinson came on for Dilane Bakwa.`
  - `Chris Wood came on for his one hundredth appearance for Nottingham Forest.`
  - `A substitution is coming onto the pitch for Forest.`
  - `Kieran Trippier is coming on for a late cameo.`
  - `Bruno Guimarães is substituted off late in the match, replaced by Kieran Trippier as Newcastle manage their remaining time.`
  - `William Osula comes off the pitch after his recent scoring streak.`
  - `Lucca, on his second Premier League appearance, replaces the top scorer.`
  - `Harvey Barnes puts Newcastle ahead with a substitute appearance, but Anderson equalizes for Forest in the late stages.` — announces both goals
  - `The physio is coming on to treat a player, and a yellow card has been issued.`
- These are pushed unconditionally as `match_action` with `kind: "atmosphere"` — no canonical-correlation gate applies (`apps/blackout/server/src/lib/broadcast-runner.ts:739-745`).

Notes:

- The distiller's correlation gate is only applied in two paths: (a) `event_claim` outputs are buffered as `pendingClaims` and either match a canonical and fire a calibration sample, or expire and are silently dropped; (b) `event_texture` outputs are buffered as `pendingTextures` and either match a canonical and push with `parentSourceId`, or expire and demote to plain atmosphere. `atmosphere` outputs bypass both paths — `handleAtmosphere` pushes immediately.
- The user's claim that misclassified entries "get pushed unconditionally to Kairos as `match_action`" is correct.

## A2 — distiller system prompt: parallel buckets, eventTexture has the drop-guard, atmosphere doesn't

Status: **CONFIRMED**

Evidence:

- `apps/blackout/server/src/lib/distiller.ts:270-289` — three buckets are presented in parallel under `# Three output classes` with separate `## atmosphere`, `## eventTexture`, `## eventClaim` sections.
- `## eventTexture` (line 278): `"Drop the fact-claim itself; keep the texture around it."`
- `## atmosphere` (line 274): no equivalent guard — only describes what to keep ("Crowd, manager, ambient mood, off-ball moments — texture not anchored on a specific canonical event").
- A general `# What to drop` section earlier (line 246) does say `"The announcement of an event itself when extracting eventTexture: drop \"GOAL!\", \"1-0!\", \"yellow card!\", \"sub coming on\". Those facts come from the canonical event stream."` — but the qualifier `"when extracting eventTexture"` constrains the rule to that bucket. There is no general "never announce events anywhere" rule.

Notes:

- The structural failure mode: a sub-announcement that lacks any reaction/build-up texture has nothing to anchor as `eventTexture`, so the LLM falls through to `atmosphere`, where no rule excludes it. Roster discipline doesn't help — the player names are valid.

## A3 — EVENT_CLAIM_CLASSES contents

Status: **CONFIRMED**

Evidence: `apps/blackout/server/src/lib/distiller.ts:47-58` lists exactly the 10 classes claimed:

```ts
export const EVENT_CLAIM_CLASSES = [
  "KICKOFF","HALFTIME","SECOND_HALF_KICKOFF","FULL_TIME",
  "GOAL","YELLOW_CARD","RED_CARD","SUBSTITUTION","VAR_CHECK","PENALTY_AWARDED",
] as const;
```

## A4 — pendingClaims / pendingTextures correlation contract

Status: **CONFIRMED**

Evidence:

- `apps/blackout/server/src/lib/event-correlation.ts:225-276` (`resolveCanonical`) returns at most one calibration sample (oldest matching claim wins) plus all matching texture releases.
- `apps/blackout/server/src/lib/broadcast-runner.ts:760-787` (`handleEventTexture`): late-arrival texture pushes with `parentSourceId` if a canonical is already in the ledger, else buffers in `pendingTextures`.
- `apps/blackout/server/src/lib/broadcast-runner.ts:789-824` (`handleEventClaim`): late-arrival claim emits a calibration sample if matched, else buffers in `pendingClaims`.
- Aged-out textures: `apps/blackout/server/src/lib/broadcast-runner.ts:904-926` — pushed as `kind: "atmosphere"` with no `eventClass` or `parentSourceId`, exactly as the comment block describes ("Demote to plain atmosphere").
- Aged-out claims: `apps/blackout/server/src/lib/broadcast-runner.ts:928-...` — logged as no-match telemetry; not pushed to Kairos.

The contract matches verbatim.

## A5 — calibration: write path exists, read path doesn't

Status: **CONFIRMED**

Evidence:

- Write: `apps/blackout/server/src/lib/radio-sources.ts:122-135` (`recordObservation`) sets `lastObservedOffsetSeconds`, `lastObservedAt`, increments `observationCount`. Called from `apps/blackout/server/src/lib/broadcast-runner.ts:881-887`.
- Read: `grep -rn "lastObservedOffsetSeconds" apps/blackout/server/src/ apps/blackout/client/src/`:
  - `apps/blackout/server/src/db/schema.ts:217` — column declaration.
  - `apps/blackout/server/src/lib/radio-sources.ts:28,129` — populating the row mapper and the write call.
  - No call site reads it back to influence stamping or offset choice.
- Stamping uses `defaultOffsetSeconds` only:
  - `apps/blackout/server/src/lib/broadcast-runner.ts:269` — `radioSource.defaultOffsetSeconds * 1000`
  - `apps/blackout/server/src/lib/broadcast-runner.ts:497` — `pushModeratorMessage` uses `defaultOffsetSeconds`
  - `apps/blackout/server/src/lib/broadcast-runner.ts:840` — calibration emits `configuredOffsetSeconds = defaultOffsetSeconds`

Notes:

- The schema includes `lastObservedAt` and `observationCount`, both also write-only at runtime. `RadioSource` shared type surfaces them, so admin UIs may render them — but the runner never reads them.

## A6 — matchroom reveal-gate is prose-based via `covers`

Status: **PARTIAL**

Evidence:

- The gate IS `covers`-based, but inverted from the user's framing. Events are **visible by default**; they are **hidden** while a narration whose `covers` reference them is mid-flight, then revealed when its audio ends.
- `apps/blackout/server/src/lib/broadcast-view-logic.ts:43-59` (`computeGuardedEntryIds`):
  ```ts
  for (const n of narrations) {
    if (!n.playbackStartedAt) continue;
    const endedMs = n.playbackStartedAt.getTime() + n.durationMs;
    if (endedMs <= nowMs) continue; // narration finished — its covers are no longer guarded
    for (const c of n.covers) ids.add(c.entryId);
  }
  ```
- `apps/blackout/server/src/lib/broadcast-view.ts:163`: `revealedEvents = allViewerEvents.filter((e) => !guardedEntryIds.has(e.id))`.

Notes:

- The user's claim that an event "is revealed when its canonical-event-id appears in a `covers` entry on a passage that has been narrated" is the right shape inverted — the event is revealed once *all* in-flight passages whose covers reference it have finished. For events never covered by any in-flight narration, they're visible immediately.
- Bundle-driven replay path (`revealedPassages`) uses `revealedCanonical` / `revealingCanonical` snapshots rather than this guard.

## A7 — distillation phaseSecond is anchored on line time, canonical on storage time

Status: **CONFIRMED**

Evidence:

- Distillation `observedAtMs` is the latest `fromLines` timestamp from the buffered Deepgram lines: `apps/blackout/server/src/lib/distillation-buffer.ts:191-199`.
- `pushEntry` stamps `phaseSecond` from `events.getPhaseAnchor(atWallClockMs)` where `atWallClockMs` is the line-time anchor: `apps/blackout/server/src/lib/broadcast-runner.ts:452-477`.
- Spot check (Hutchinson sub):
  ```
  -- canonical
  SUBSTITUTION | Omari Hutchinson | ct=64 | ps=1218 | 2026-05-10 15:23:46.926+01

  -- distillation
  atmosphere   | "The crowd gave warm applause as Omari Hutchinson came on for Dilane Bakwa."
               | ct=64 | ps=1082 | 2026-05-10 15:22:30.324+01
  ```
  The distillation entry has `phaseSecond=1082` (line time was about 76s before storage time), canonical is `phaseSecond=1218` — delta ~136s in match-time anchoring. Confirms the line-time vs storage-time mismatch the claim describes.

Notes:

- The Yates sub case shows multiple distillations stamped during halftime (`contentTime: "HT"`, no phaseSecond) for the canonical sub at `phaseSecond=181` after second-half kickoff. Line-time anchoring put them in the previous phase entirely — same root, more extreme effect.

## B1 — FULL_TIME canonical event has `contentTime: "90"`

Status: **CONFIRMED**

Evidence:

```sql
SELECT data FROM feed_entries fe
  JOIN sources s ON s.id=fe.source_id
  WHERE fe.broadcast_id='d268dd59-66de-4bae-aeb2-26685c4a9dd7'
  AND s.name='match_events'
  AND fe.data->>'eventType'='FULL_TIME';
```

```json
{
  "team": null, "phase": "full_time", "player": null,
  "content": "Full-time whistle.",
  "eventType": "FULL_TIME",
  "synthetic": true,
  "contentTime": "90",
  "phaseSecond": 0,
  "closingPrompt": "## Closing the phase\n\nThis passage is being generated as the phase draws to a close...",
  "closingExtensionSeconds": 15
}
```

Note: `contentTime` is the literal string `"90"` even though stoppage time was `90+5+`. `phaseSecond` is also reset to 0 (synthetic phase-transition stamping).

## B2 — multiple cover-contentTime regressions across consecutive passages

Status: **CONFIRMED**

Evidence (from `broadcast_narrations` for `b2107453-5700-4ac0-bd6f-ff8a06af920a`):

- `matchMinute` regressions across consecutive passages include:
  - `18 → 18 → 17 → 20` (passages 23-26 by play order)
  - `33 → 34 → 32` (around passage 44)
  - `38 → 40 → 40 → 41 → 41 → 42 → 41 → 42 → 43 → 42 → 44`
  - `45+1 → 45+2 → 45 → HT` (the `45+2 → 45` regression the claim calls out)
  - `41 → 41 → 42 → 41` etc.
- The exact "44 → 43" pair the user cites does not appear; the closest is `42 → 41`. The shape (regression) is real and frequent; the specific minutes were misremembered.

Render path:

- `apps/blackout/client/app/matchroom/[broadcastId]/page.tsx:1026` — `matchMinute` is derived from `currentBatchMinute` state.
- `currentBatchMinute` is updated from `cue.batchContentTime` (line 315-317), and from `passage.revealedCanonical.matchMinute` (lines 425-431, 459-465, 686-688, 934-938).
- The page never compares to the prior value to enforce monotonicity. `clampMonotonicMinute` exists in `apps/kairos/server/src/narrative/helpers.ts:125-132` but is server-side only and clamps the *generated* minute, not the displayed one.

## B3 — passage 1 displays "-1" as match clock

Status: **PARTIAL** (cause confirmed; one of two paths has the guard, one doesn't)

Evidence:

- Passage 1 of this broadcast: `revealed_canonical->>'matchMinute' = "pre_match"`, first cover contentTime `"1"`.
- `parseContentTime("pre_match")` returns `-1` (`packages/shared/types/match-time.ts:24-26`).
- Bundle-driven live path (`apps/blackout/client/app/matchroom/[broadcastId]/page.tsx:459-466`) DOES guard:
  ```ts
  if (minuteNum != null && Number.isFinite(minuteNum) && minuteNum >= 0) {
    setCurrentBatchMinute(minuteNum);
  }
  ```
- BUT `minuteNum` is computed *before* the guard and then passed into the constructed `PlayCue` as `batchContentTime: minuteNum` (line 503). When playback then runs through `startPlayback`, line 315-317 sets:
  ```ts
  if (cue.batchContentTime != null) {
    setCurrentBatchMinute(cue.batchContentTime);  // no >= 0 guard
  }
  ```
  So `-1` flows into state via the cue path even though the bundle path filters it.
- Replay path at line 937-938 has no guard either:
  ```ts
  if (minuteNum != null && Number.isFinite(minuteNum)) {
    setCurrentBatchMinute(minuteNum);
  }
  ```
- Resume path at line 686-688 likewise has no `>= 0` check.

Notes:

- The user's diagnosis is correct: passage 1 displays `-1`. The fix surface is incomplete — guarding only the bundle-path setter (lines 459-466) misses three other entry points.

## C1 — FULL_TIME canonical includes a populated `closingPrompt` field

Status: **CONFIRMED**

Evidence: The same query as B1 shows the canonical includes `closingPrompt: "## Closing the phase\n\nThis passage is being generated as the phase draws to a close. Narrate the dying moments in the order they happened — the action and texture leading up to the whistle, then the whistle itself as the final beat. Don't open with the whistle and circle back; let the audience feel play being interrupted, not announced. A reflective passage will follow this one; this passage carries the audience to the threshold."` and `closingExtensionSeconds: 15`.

## C2 — external pipeline cycle at 15:59:02 was skipped

Status: **CONFIRMED but with important context the claim missed**

Evidence:

```
   triggered_at         | flush_trigger    | chunk_size | generated
------------------------+------------------+------------+----------
 2026-05-10 15:58:50    | closing          | 1          | t
 2026-05-10 15:59:02    | consumer_prompt  | 0          | f
 2026-05-10 15:59:41    | cadence          | 0          | f (empty cap)
```

Important context:

- A closing passage **was** generated at 15:58:50.517 — `flush_trigger='closing'`, `chunk_size=1`, drove a generation. Output: *"Forest's last corner is cleared... Then — the whistle. Not a roar, not a groan. Just the sound of something finishing."* (covers `fcb70b6a-...` which is the FULL_TIME canonical at contentTime `"90"`).
- The `consumer_prompt` cycle at 15:59:02 is the conductor's `triggerExplicitGeneration(CLOSING_PASSAGE_PROMPT)` arriving via `kairos.triggerNarrativeGeneration → flush({ consumerPrompt })`. It was deferred while the closing-pinned cycle ran (`apps/kairos/server/src/enrichment/pipeline.ts:557-579`), then dispatched after — by that point, all entries had already been drained by the closing cycle, so the waiting room was empty. Engine skip at `apps/kairos/server/src/narrative/engine.ts:328` (`if (entries.length === 0) return null`) fired.

Notes:

- Two distinct closing-shaped triggers exist: (a) the `closingPrompt` field on the FULL_TIME synthetic entry, which drives the closing-pinned cycle; (b) the conductor's `CLOSING_PASSAGE_PROMPT`, which drives a consumer-prompt cycle. Both were intended to produce the closing passage; only (a) survived. The user's "no closing passage generated" framing is wrong — there *was* one. What was lost is whatever the consumer-prompt would have added.

## C3 — same shape as 2026-05-03 finding 7 ("auto-complete races closing passage")

Status: **REFUTED**

Evidence:

- 2026-05-03 finding 7 (`docs/live-test-2026-05-03.md:211-243`): the broadcast auto-completed at 12:57:05 UTC, ~37 seconds **before** the deferred closing-passage's phase-flush would have fired. **The closing passage was never generated.** Root cause: `decideClipEndAction` interpreted "queue empty in `full_time_winddown`" as "we're done", tearing down the engine before the closing passage's roundtrip landed.
- 2026-05-10: the closing passage **was** generated (closing-pinned cycle at 15:58:50, output exists in the generations table). The broadcast did not auto-complete prematurely. The fix from 2026-05-03 (`closingPassagePending` flag + `wait_for_closing_passage`) appears to be working — broadcast remained live long enough for the closing-pinned cycle to dispatch and synthesise.
- The 2026-05-10 bug is different: a redundant secondary trigger (the conductor's `CLOSING_PASSAGE_PROMPT` consumer-prompt) gets deferred behind the closing-pinned cycle and then runs empty. The shape is "two paths trying to do the same job, one drains the other dry" — not "completion races generation".

## C4 — code path: closingPrompt does NOT bypass the empty-entries skip

Status: **CONFIRMED** (claim's described code shape exists; "proposed fix surface" framing is approximately right)

Evidence:

- The skip site is `apps/kairos/server/src/narrative/engine.ts:328`: `if (entries.length === 0) return null;`. Unconditional — no closingPrompt or consumerPrompt check.
- The two closing paths in Kairos:
  1. **Pinned closing** (drives the actual closing passage on this broadcast). `pipeline.ts:367-411` (`dispatchClosingCycle`) drains via `drainUpToBoundary(boundary)` then calls `runCycle(drained.entries, "accumulation", "closing", closingPrompt, boundary)`. The closingPrompt is passed as the cycle's consumer-prompt.
  2. **Deferred consumer-prompt** (the redundant 15:59:02 cycle). When `flush({ consumerPrompt })` is called while `pendingClosingBoundary !== null`, the call is deferred (`pipeline.ts:565-579`); after the closing-pinned cycle finishes, `drainPendingConsumerPrompt` re-fires the deferred flush via `flush({ consumerPrompt: pending.prompt })` → `doFlush` → `drainAll` → `runCycle`. By this point `drainAll()` returns `[]` because the closing-pinned cycle already drained the waiting room.
- A `closingPrompt`-bypasses-skip patch at engine.ts:328 would only help if the closingPrompt were attached to the empty cycle. In path (2), the deferred cycle carries the conductor's `CLOSING_PASSAGE_PROMPT` as its `consumerPrompt`, not the FULL_TIME entry's `closingPrompt`. So bypassing skip when `consumerPrompt` is present (not `closingPrompt`) would produce a generation against zero entries — effectively double-narrating the closing.

Notes:

- The proposed fix surface should target the **deferred-consumer-prompt drain path**, not the engine skip. Either: (a) when the closing cycle drained from a pending state, abandon the deferred consumer-prompt with `pending.resolve(null)` rather than re-firing it; or (b) detect that the closing cycle already covered the conductor's intent and skip the conductor's `triggerExplicitGeneration(CLOSING_PASSAGE_PROMPT)` when a `closingPrompt` is on the FT entry. The current behaviour (defer-then-skip) leaves a misleading `chunk_size=0, generation_id=NULL` row that looks like a bug but is actually defensive — engine.ts:328 prevented an empty narration.

## D1 — moderator message at 15:27:18

Status: **CONFIRMED**

Evidence:

```
SELECT data, fe.timestamp FROM feed_entries fe
  JOIN sources s ON s.id=fe.source_id
  WHERE fe.broadcast_id='d268dd59-66de-4bae-aeb2-26685c4a9dd7' AND s.name='moderator';

{"phase":"second_half","content":"No more quoting the match clock directly.","contentTime":"69","phaseSecond":1385} | 2026-05-10 15:27:18.454515+01
```

## D2 — string `"clock"` does not appear in any subsequent passage's context_package

Status: **PARTIAL** (the moderator's text doesn't survive to context_package, but `"clock"` appears for unrelated reasons)

Evidence:

- `context_package` is a JSONB blob. Searching all generations from 15:27:52 onward for `context_package::text ILIKE '%clock%'` returns 3 hits.
- All three are spurious: `"clock"` appears in the `imagery.rationale` (e.g. "...the clock running down...") which Haiku writes during imagery selection. None of the hits are the moderator's verbatim text.
- The literal moderator content `"No more quoting the match clock directly."` does not appear in any `context_package`.
- The moderator entry itself (id, content) IS persisted as a feed entry; the question is whether it surfaces to the generator. Curation only renders entries it selects (`apps/kairos/server/src/narrative/generator.ts:181-216`, `formatFeedContext`). I haven't independently confirmed which cycles selected the moderator entry, but the absence of "clock" or "match clock" or even the inverted form in any prompt's context strongly suggests no cycle emphasised it for the generator's view.

## D3 — moderator entries are not surfaced as a top-of-prompt steering directive

Status: **CONFIRMED**

Evidence:

- `apps/kairos/server/src/narrative/generator.ts:419-420` — the user message is built from preambles in this order:
  ```
  canonicalEvents | summary | previousPassage | refrain | mode | relevantThreads | targetWords | consumerPrompt | feedHeader | formatFeedContext(ctx)
  ```
  No `moderator` preamble. Only `consumerPrompt` is a top-of-prompt opaque steering channel — and `consumerPrompt` is the conductor's `HALFTIME_REFLECTION_PROMPT` / `CLOSING_PASSAGE_PROMPT`, not user-supplied moderator text.
- `formatFeedContext` (line 149-217) renders all entries via `renderEntryLine` — `[id:... · <source>] content`. Moderator entries are flattened in chronological order alongside everything else; the source label `moderator` appears inline but there's no surfacing or weighting of the entry's content.
- Curation may de-prioritise or evict a moderator entry like any other (token-budget eviction at `apps/kairos/server/src/curation/curator.ts:158`, `reconcileBudget`). Nothing pins a moderator entry into the prompt.

## E1 — passage 4 contains `"as the brief suggested he might be"`

Status: **CONFIRMED**

Evidence:

```
$ grep -n "the brief" data/broadcasts/d268dd59-66de-4bae-aeb2-26685c4a9dd7/generations.md
19:The question answered itself almost immediately. Newcastle have identified the space, but so has Forest. Hall is being dragged wide, stretched — the improvised right-back exposed in the first minutes, exactly as the brief suggested he might be...
```

## E2 — `pipeline_cycles.curation` contains `broadcast_summary` with literal brief-derived text

Status: **PARTIAL** (the field name and shape are different from what the claim describes)

Evidence:

- The field is **not** named `broadcast_summary` at the top level. It's named `summary` at the top of `curation`, AND it's nested under `curation.decisions.broadcast_summary.meta.summary`.
- First cycle's `curation.summary`: *"Nottingham Forest arrive at the City Ground seventy-two hours after a 4-0 European semi-final defeat, seeking the league win that would confirm their Premier League survival against a Newcastle side that has not lost at this ground in seven visits. Taiwo Awoniyi, who a year ago was placed in a medically induced coma after a collision at this venue, leads Forest's line on the anniversary of that injury."*
- This is **not** the verbatim brief text — it's Haiku's compressed re-statement, produced by the `BroadcastSummaryService` (`apps/kairos/server/src/curation/services/broadcast-summary.ts`). The service's prompt instructs it to draw "through-lines" from the writer's brief. So the wording is derived, not raw.
- The literal brief text *does* live on the feed in `narrative_context` source entries (separate channel, fed into the system prompt as `# Context`).

Notes:

- The user's claim conflates two distinct surfaces: (a) the brief-text rendered into `# Context` of the system prompt (sourced from `narrative_context` feed entries), and (b) the per-cycle Haiku-distilled summary stored in `curation.summary` and rendered into the user message via `formatSummary`. Both reflect the brief; they are not the same text.

## E3 — `broadcast_summary` is rendered as a separate labelled field in the prompt, duplicative with narrative_context

Status: **CONFIRMED** (with the field-name correction from E2)

Evidence:

- `apps/kairos/server/src/narrative/engine.ts:321`: `const runningSummary = summary?.trim() || prior.runningSummary || "";` — `summary` here is `curated.context.summary` from the broadcast_summary service.
- `apps/kairos/server/src/narrative/generator.ts:405,420` — `formatSummary(options.summary)` produces `"Broadcast state so far (compact memory — state is templated and authoritative; arc is interpretive carry. Do not re-narrate listed events):\n${trimmed}\n\n"`.
- `apps/kairos/server/src/narrative/generator.ts:118-128` — `buildSystemPrompt(voice, context)` produces `"# Voice\n\n${voice}\n\n# Context\n\n${context}\n\n# Task\n\n..."` where `context` is the joined `narrative_context` entry content.
- Both the system-prompt `# Context` (raw brief) and the user-message `Broadcast state so far` (Haiku-distilled brief through-lines) are present in every generation.

Notes:

- A material wrinkle: `formatSummary`'s text starts `"Broadcast state so far"`, which sounds like canonical state. In practice, `runningSummary` carries the **templated canonical state** (`Canonical state:\n- [1'] Kickoff...`) on most cycles — see `engine.ts:507` (`templatedSummary = assembleRunningSummary(stateBlock, previousNarrative)`). Whether the broadcast_summary's distilled brief or the templated canonical state ends up in `summary?.trim()` depends on the precedence chain at line 321:
  - If `curated.context.summary` is non-empty → that's used. `BroadcastSummaryService` writes it on every cycle → so the brief-derived summary wins on the cycle that runs.
  - But `prior.runningSummary` carries the templated state. The fallback chain `summary?.trim() || prior.runningSummary` means: when curation's summary IS populated, the templated canonical state from prior is **shadowed** for that one cycle.
- I haven't traced the actual contents of `curated.context.summary` for every cycle in this broadcast to confirm which path won where — but the structural duplicate (system prompt's `# Context` + user message's `Broadcast state so far`) is real and present every cycle.

## F1 — cycle 107 (chronological) was skipped with empty chunk

Status: **CONFIRMED**

Evidence:

```
 idx |         triggered_at          | flush_trigger | chunk_size | skipped
-----+-------------------------------+---------------+------------+---------
 106 | 2026-05-10 15:32:36.972927+01 | cadence       |         11 | f
 107 | 2026-05-10 15:32:47.33379+01  | cadence       |          0 | t
 108 | 2026-05-10 15:33:50.787232+01 | cadence       |          7 | f
```

Cycle 107 fired only ~10 seconds after cycle 106 — likely the empty-cap-cadence-tick after a closing dispatch (Harvey Barnes goal at 15:33:03 was an upcoming canonical, the prior pinned closing for the goal was about to fire). It's a benign empty cycle, not a content gap visible to listeners.

## F2 — cycles 1-10 at 45-50s intervals; gaps are TTS, not generation

Status: **CONFIRMED in shape, with one outlier**

Evidence:

- Cycles 3-10 (the first eight that actually generated; 1-2 were the activation-window empty cycles):
  ```
   3 | 14:02:09 | chunk=4
   4 | 14:02:55 | chunk=4   (+46s)
   5 | 14:03:42 | chunk=8   (+47s)
   6 | 14:04:34 | chunk=8   (+52s)
   7 | 14:05:19 | chunk=10  (+45s)
   8 | 14:06:03 | chunk=8   (+44s)
   9 | 14:07:05 | chunk=12  (+62s)
  10 | 14:07:54 | chunk=9   (+49s)
  ```
  The 62s gap between cycles 8 and 9 is one outlier — likely a flush-in-flight stack. Otherwise generation cadence is healthy.
- Inter-passage playback gaps (`broadcast_narrations.playback_started_at` deltas) for the first 12 narrations: 44-62s, mean ~46s. Tracks the cycle cadence closely.

TTS instrumentation:

- `broadcast_narrations.synthesized_at` (TTS done) and `playback_started_at` (audio reaches the matchroom) both exist.
- Kairos's `generations.triggered_at` is the cycle start. So three timestamps are available: `triggered_at` (gen start) → `synthesized_at` (TTS done) → `playback_started_at` (audio plays).
- For passages 1-12: `synthesized_at - generations.triggered_at` is roughly the gen+synth time; `playback_started_at - synthesized_at` is the queue/handoff latency. Spot check on passage 1: gen triggered 14:02:09.376, synth at 14:02:15.093 (≈5.7s); playback 14:02:15.236 (≈0.14s). Subsequent: 0.1-0.2s synth-to-play, single outlier of 5.4s on the 12th passage.
- Conclusion on the user's hypothesis: the data supports it. Gap from cycle trigger to audible passage is dominated by gen + synth (≈5-6s for the first; up to ~10s for some), and the 45-50s perceived inter-passage gap matches the cycle cadence almost exactly. There's no separate "early gap" beyond TTS first-byte.

There is no `narration_started_at` field distinct from `playback_started_at`. The instrumentation that does exist (`triggered_at` / `synthesized_at` / `playback_started_at`) already separates the three layers.

## Surprises / things the original analysis missed

- **A4 is more nuanced than stated**: aged-out textures DO push to Kairos as `match_action` (kind: atmosphere) — not as `match_action` per se but specifically with the `eventClass` and `parentSourceId` stripped. The narrator gets the texture content but not the misleading event-class assertion. The runner comment explicitly cites the 2026-04-26 FA Cup SF "fictional Leeds equaliser" as the precedent for this demotion. This is a deliberate safety mechanism, not an accident.
- **A6 is inverted**: matchroom reveal-gate is **hide-while-narrating**, not **reveal-when-narrated**. Late joiners see all events that aren't currently mid-narration; events that are never narrated are visible immediately after their narration completes (or were never guarded). The user's framing implies events stay hidden until covered, which would leave a sparser matchroom. The actual contract is a hold-during-mid-flight, release-on-end model.
- **B3 fix surface is incomplete**: the `>= 0` guard exists at one of four `setCurrentBatchMinute` call sites driven by `parseContentTime`. The other three (line 315 via `cue.batchContentTime`, line 686 in resume, line 937 in replay) all pass `-1` through unfiltered. A patch that only adds the guard at line 459 would not fix the live-path display.
- **C2 + C4 — the user has the wrong fix surface**: their proposed fix is "make the closingPrompt bypass the empty-entries skip in the engine". But the closingPrompt is consumed by the closing-pinned cycle (which generates fine). The empty cycle is the conductor's `CLOSING_PASSAGE_PROMPT` consumer-prompt, deferred behind the closing-pinned cycle, then arriving empty. Engine-side skip is doing its job — bypassing it would produce a redundant zero-entry generation. The real bug is **two redundant closing triggers**: the FT canonical's `closingPrompt` field and the conductor's `triggerExplicitGeneration(CLOSING_PASSAGE_PROMPT)`. One should be removed, or the deferred-consumer-prompt drain logic should abandon when the pending closing already drained the buffer.
- **C3 — the user wrongly equated this with 2026-05-03 finding 7**: 2026-05-03 was an auto-complete teardown before any closing passage generated. 2026-05-10 has a closing passage; the second-trigger empty cycle is unrelated to the auto-complete pathway and would have been "skipped" successfully even on the broken 2026-05-03 codebase.
- **D2 has spurious "clock" hits**: searching for the literal substring `"clock"` is too coarse — it matches `"clock running down"` in imagery rationale on 3 cycles. The narrower question (does the moderator's verbatim content reach any prompt?) is "no", consistent with the claim's intent, but the chosen test would have been misleading without inspection.
- **E2 field naming**: there's no top-level `broadcast_summary` key in `pipeline_cycles.curation` — the field is named `summary`. The decision-meta IS under `decisions.broadcast_summary.meta.summary`. Anyone scripting against this shape needs both names.
- **E3 has an internal precedence chain not flagged**: `engine.ts:321` says `summary?.trim() || prior.runningSummary || ""`. When the broadcast_summary service produces a non-empty summary (every cycle), it shadows the templated canonical state for that cycle's prompt — so the user message's "Broadcast state so far" block is the brief-distilled text rather than the canonical event log on every regular cycle. The canonical state list shows up in the persisted `runningSummary` (line 530) but isn't what's sent to the generator. This is a subtler duplication problem than "two copies of the brief": the canonical state log the templated chain assembles is being **replaced**, not added to, when the user message is built.
- **F1 — cycle 107 chunk=0 is benign**: the surrounding cycles are healthy; cycle 107 fired just 10s after cycle 106 with `flush_trigger="cadence"`. This is the queued-while-in-flight pattern (a tick was queued during the prior flush, fires immediately on completion, finds nothing left to drain). Engine skip works as designed. Calling it out as a problem would be misdiagnosis.
- **A1 root-cause framing**: the user attributes the misclassification to the prompt structure (A2). That's likely correct *but the parent-grouping render in formatFeedContext (`generator.ts:200-214`) means an atmosphere entry that falsely announces "Hutchinson came on for Bakwa" is rendered alongside its time-adjacent canonical SUBSTITUTION as siblings*, not parent-child. The narrator sees both lines — the canonical row and the duplicating atmosphere — which can cause double-narration even when both are "factually correct". A2's fix (atmosphere-side drop guard) is necessary; what's also worth noting is that current rendering has no de-duplication when class+player+minute collide.
