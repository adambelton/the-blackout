# Kairos engine — open domain-leak items

Two pieces of football-specific behaviour survive in the Kairos engine layer despite the module-boundary rule that Kairos must stay domain-agnostic. Both are load-bearing on football phase names; a second consumer would have to use the same strings or fork the engine. Logged here as known accidents to revisit when Kairos onboards a second consumer (or when the architecture audit picks them up explicitly).

Background on the rule: see `apps/kairos/server/CLAUDE.md` ("Module-boundary discipline") and the `feedback_kairos_infrastructure_vs_content` distinction — the rule applies to engine/infrastructure code, not to specs/prompts/seed.

## 1. `PHASE_BASE` map — `apps/kairos/server/src/enrichment/content-time.ts`

Hardcodes football phase names → ordinal stride:

```ts
const PHASE_BASE: Record<string, number> = {
  pre_match: 0,
  warming: 0,
  live_first_half: 1 * PHASE_ORDINAL_STRIDE,
  first_half: 1 * PHASE_ORDINAL_STRIDE,
  halftime: 2 * PHASE_ORDINAL_STRIDE,
  live_second_half: 3 * PHASE_ORDINAL_STRIDE,
  second_half: 3 * PHASE_ORDINAL_STRIDE,
  full_time: 4 * PHASE_ORDINAL_STRIDE,
  full_time_winddown: 4 * PHASE_ORDINAL_STRIDE,
  complete: 4 * PHASE_ORDINAL_STRIDE,
};
```

Load-bearing for the entire content-ordinal model — every `entryOrdinal()` call routes through this map. A non-football consumer would either need to use these exact phase strings or fork the engine.

**Cleanest fix:** the consumer registers its own phase ordinal mapping at broadcast creation (e.g. a `phaseOrdinals: { ... }` field on the broadcast row, or a `setPhaseMap()` API call before activation). Engine reads the consumer's map; doesn't ship a default football one.

## 2. `LIVE_PHASES` set — `apps/kairos/server/src/broadcast-health.ts`

Hardcodes which football phases count as "live match coverage" for the `contentSeconds` health metric:

```ts
const LIVE_PHASES: ReadonlySet<string> = new Set([
  "first_half",
  "live_first_half",
  "second_half",
  "live_second_half",
]);
```

Excludes halftime/full_time as "not match content." A non-football consumer's notion of "live phases" would differ.

**Cleanest fix:** same shape as the `PHASE_BASE` cleanup — consumer-registered phase metadata declares which phases are "live" vs. "interlude," and the health computation reads from there.

## When to revisit

Both move together when Kairos onboards a second consumer. Until then they're known accidents that don't break anything for the current consumer (the Blackout). Bundle the two cleanups into one piece of work — they share the "consumer-registered phase metadata" shape.
