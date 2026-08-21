# Summary eval — manual LLM golden set

Out-of-band evaluation for the running-summary updater
(`src/narrative/summary.ts::updateNarrativeBlock`) against the
resolved baseline + an event profile's service spec. **Not** part
of `pnpm test` / CI — real Anthropic calls (Haiku for the note),
cost + flakiness from LLM variance.

## Profile scoping

Fixtures are scoped to one event profile per subdirectory. (The general
note contract is *not* in the fixtures — since K6.5+ it lives in the
spec's `## Eval` section, parsed by `src/eval/spec-eval.ts`; the fixtures
hold inputs + per-fixture expectations.) Today:

- [`sporting-event/`](sporting-event/) — football fixtures against
  the v1 `sporting_event` spec content (3 fixtures).

## When to run

Run this before shipping any change that affects:

- `summary.baseline.md` (the in-code profile-agnostic baseline)
- The `summary` service spec's `summaryInstructions` (lives in
  `src/db/seed-data/sporting-event/summary.md`)
- `updateNarrativeBlock` in `src/narrative/summary.ts`
- `assembleSectionedPrompt` (the assembly helper) in
  `src/narrative/spec-types.ts`
- The Haiku model version (`UTILITY_ANTHROPIC_MODEL` in
  `src/llm/defaults.ts`)

Routine code changes that don't touch any of the above don't need
this run.

## What it does

For each curated fixture, the runner:

1. Resolves the baseline + v1 sporting_event summary spec from the
   seed-data module (no DB dependency).
2. Calls `updateNarrativeBlock(...)` against a real Anthropic Haiku
   client with the fixture's `previousNarrative` + `justNarrated` +
   new feed entries.
3. Asserts the hard invariants in two parts: the **general note
   contract** parsed from the summary spec's `## Eval` section (via
   `src/eval/spec-eval.ts` — no scoreline strings, no scorer-as-state,
   no meta-commentary about the broadcast or the narrator), run
   against every note, plus each fixture's **per-fixture expectations**
   (word cap, must / must-not-match patterns). The general contract
   lives *with the prompt*, not in the fixture (K6.5+
   eval-as-spec-content).
4. Prints the resulting note next to the fixture's expectation
   notes for human inspection of the soft cases (arc-direction
   phrasing, motif carry, tonal continuity).

## Running

```bash
pnpm --filter @kairos/server eval:summary        # from anywhere
# or, equivalently, from apps/kairos/server:
pnpm tsx manual/summary-eval/run.ts
```

Requires `ANTHROPIC_API_KEY` in `.env`.

The script exits with code 1 if any hard invariant is violated.
Soft mismatches print a warning but don't fail.

## Cost / runtime

Each fixture is one Haiku call (~150-300 tokens out, cached system
prompt amortising the spec). A ~6-fixture set runs in 15-30 seconds
for a tiny fraction of a cent total.

## Adding a fixture

Append to `fixtures.ts`. A fixture tests one summary-update edge:
opening cycle (no prior note), post-goal carry, halftime hold,
context_led cycle producing thread carry, late-game arc shift.
Per-fixture expectations (word cap, must / must-not-match patterns)
go on the fixture; the general note contract that holds for *every*
fixture lives in the spec's `## Eval` section
(`src/db/seed-data/sporting-event/summary.md`), not here.
