# sources/ — football-specific source adapters

The domain-aware capture adapters. Today there's one: the Sportmonks event/stat poller. It knows about football — fixtures, periods, minutes, event types, ball positions — and turns the API's firehose into the kinds of observations the rest of the pipeline can use: canonical match events (goals, cards, subs), raw stat updates (for the pressure pipeline to reshape), and phase whistles. Everything domain-specific about *what data football produces and how it's shaped* lives here; the rest of `apps/blackout/server` is domain-generic (it pushes "feed entries" to Kairos and schedules "narratives").

## What it does

### `sportmonks.ts` — `SportmonksEventSource`

Polls a Sportmonks fixture (the runner calls `startPolling(fixtureId)`) and emits via the callbacks the runner installs:
- **`onEvent(data)`** — a canonical match event (a goal, a card, a substitution, a VAR check, …): a Sportmonks-shaped payload carrying `eventType` (mapped via `lib/sportmonks.ts::mapEventType` + the type-id cache in `lib/sportmonks-types.ts`), `minute`/`extraMinute`, `team`/`player`/`relatedPlayer`, `sourceId` (the stable Sportmonks event id — dedup + parent linkage), `contentTime`. Deduped against what the runner has already seen (and reseedable from existing Kairos entries via `seedFromExistingEntries` — without that reseed, every fresh runner re-pushes every event on its first poll: 38 GOAL entries for a 2-goal match across 4 restarts in the 2026-05-02 test).
- **`onStat(data)`** — a raw stat update: `ball_position` (`x`/`y`/`minute`/`contentTime`/`timestamp`) or `trend` (`statCode`/`value`/`team`/`minute`/`contentTime`). Fired far too often and at too low a semantic level for a human or Kairos to use directly — the runner pipes these into the `PressurePipeline` ([`../pipeline/README.md`](../pipeline/README.md)), which reshapes them into meaningful pressure/zone moments.
- **`onKickoff` / `onHalftime` / `onSecondHalfKickoff` / `onFulltime`** — phase whistles. The runner responds by pushing a synthetic `match_events` transition entry to Kairos (which the conductor observes on its feed sub — same path replay uses) and mirroring the observation into the local correlator.
- **`onError(msg)`** — surfaced to the runner's `lastError`.

It also exposes the **content-time clock** the runner stamps entries with — `getContentTime(atWallClockMs?)`, `getPhaseAnchor(atWallClockMs?)` (`{ phase, phaseStartMs, phaseSecond }`), `getCountsFrom()` (the period's `counts_from` for normalising minutes), `getWallClockForMinute(minute, extra?)`, `getContentTime()` — all derived from the Sportmonks `periods[]` snapshot via `lib/content-time.ts`. This is the Blackout-owned content-time vocabulary: `"67"` (in-play minute), `"90+3"` (stoppage), `"pre_match"`, `"HT"`, `"FT"`; the `phase`/`phaseSecond` pair collapses to the content ordinal Kairos batches on.

(`lib/sportmonks.ts` — the HTTP client, the fixture/period/participant types, `mapEventType`; `lib/sportmonks-types.ts` — the type-id reference cache, warmed at server startup so the source resolves `type_id`s locally without every live row carrying a full `.type` object — are infra siblings under `lib/`, see [`../lib/README.md`](../lib/README.md). The `src/scripts/probe-*.ts` tools explore Sportmonks endpoint shapes offline.)

## How it fits

- **Upstream:** `lib/broadcast-runner.ts` constructs a `SportmonksEventSource`, installs the callbacks, calls `start({...})` then `startPolling(fixtureId)`. The runner reseeds the dedup state from existing Kairos `match_events` entries first (`seedFromExistingEntries`).
- **Downstream:** the runner routes `onEvent` → `ingestCanonicalEvent` (flush distiller → build canonical → `resolveCanonical` → `normaliseEventNames` → push `SOURCE.matchEvents`, `canonical: true`); `onStat` → `PressurePipeline` → push `SOURCE.matchPressure`; whistles → push synthetic `SOURCE.matchEvents` transition entries. Every push is stamped with the source's content-time anchor (radio-offset-corrected for the audio-derived sources, Sportmonks-clock-derived for events).
- **Note:** Kairos never sees a Sportmonks type. The adapter does all the football→generic translation; what reaches Kairos is `{ source, data }` where `data` is consumer-defined and opaque to the engine.

## Contract

### Provided
- `new SportmonksEventSource()`; `start({ onEvent, onStat, onError, onKickoff, onHalftime, onSecondHalfKickoff, onFulltime })`; `startPolling(fixtureId)`; `stop()`; `seedFromExistingEntries(rows)`; the content-time clock accessors (`getContentTime` / `getPhaseAnchor` / `getCountsFrom` / `getWallClockForMinute`).
- The event-payload shape `onEvent` emits — the runner depends on `eventType`, `minute`/`extraMinute`, `team`/`player`/`relatedPlayer`, `sourceId`, `contentTime` being present and football-shaped (Kairos doesn't, but the runner's correlation + the conductor's invariants do).

### Depended on
- `lib/sportmonks.ts` (the HTTP client + types + `mapEventType`), `lib/sportmonks-types.ts` (the type-id cache), `lib/content-time.ts` (the period→content-time math), `@blackout/shared` (`MatchEvent`, `TeamSide`). `SPORTMONKS_API_TOKEN` env. The Sportmonks API's fixture/event/period schemas — the adapter is the one place that knows them.

## Open work

- **One adapter today.** The directory is plural by design — a second domain (a debate, a courtroom) would add its own source adapter here, domain-aware, emitting generic feed entries. No work pending; noted so the shape is clear.
- **Sportmonks `attackingThirdShare` saturates at 100%** in sustained-siege phases (the stat data, not the adapter, but it surfaces through `onStat` → the pressure pipeline). Tracked server-wide in [`../../README.md`](../../README.md).
- **Per-event-class correlation tuning** (different lead/lag per KICKOFF / GOAL / cards / subs / VAR) is MVP work — the adapter emits the events; the per-class windows live in `lib/event-correlation.ts` + the radio-source offset profile.

## See also

- [`../../README.md`](../../README.md) — the backend as a service; the source-capture pipeline diagram.
- [`../lib/README.md`](../lib/README.md) — `sportmonks.ts` (HTTP client), `sportmonks-types.ts` (type cache), `content-time.ts` (period→content-time), the distillation + event-correlation files the runner pairs Sportmonks events with.
- [`../pipeline/README.md`](../pipeline/README.md) — the pressure pipeline that reshapes `onStat`, and the transcription pipeline (the *other* source — audio).
