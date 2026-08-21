# Imagery eval — manual LLM golden set

Out-of-band evaluation for the imagery selector
(`src/narrative/imagery.ts`) against the resolved baseline + an event
profile's service spec. **Not** part of `pnpm test` / CI — real
Anthropic calls (Haiku for selection), cost + flakiness from LLM
variance.

## Profile scoping

Fixtures are scoped to one event profile per subdirectory. (The general
prose contract is *not* in the fixtures — since K6.5+ it lives in the
spec's `## Eval` section, parsed by `src/eval/spec-eval.ts`; the fixtures
hold inputs + per-fixture expectations.) Today:

- [`sporting-event/`](sporting-event/) — football fixtures against
  the v1 `sporting_event` spec content (3 fixtures).

## When to run

Run this before shipping any change that affects:

- `imagery.baseline.md` (the in-code profile-agnostic baseline)
- The `imagery` service spec's `imageryInstructions` (lives in
  `src/db/seed-data/sporting-event/imagery.md`)
- `selectImagery` in `src/narrative/imagery.ts`
- `assembleSectionedPrompt` (the assembly helper) in
  `src/narrative/spec-types.ts`
- The Haiku model version (`UTILITY_ANTHROPIC_MODEL` in
  `src/llm/defaults.ts`)

Routine code changes that don't touch any of the above don't need
this run.

## What it does

For each curated fixture, the runner:

1. Resolves the baseline + v1 sporting_event imagery spec from the
   seed-data module (no DB dependency).
2. Calls `selectImagery(...)` against a real Anthropic Haiku client
   with the fixture's context + pool.
3. Asserts the hard invariants in two parts: the **general
   image-prompt contract** parsed from the imagery spec's `## Eval`
   section (via `src/eval/spec-eval.ts` — no in-frame text, no
   spoiler language beyond the passage, no broadcast apparatus), run
   against the fresh-generate prompt, plus each fixture's
   **per-fixture expectations** (allowed decision set, prompt word
   cap, pool allow-list). The general contract lives *with the
   prompt*, not in the fixture (K6.5+ eval-as-spec-content).
4. Prints the decision + rationale + prompt next to the fixture's
   expectation notes for human inspection of soft cases (pool-vs-
   generate judgement, mood alignment with the passage).

## Running

```bash
pnpm --filter @kairos/server eval:imagery        # from anywhere
# or, equivalently, from apps/kairos/server:
pnpm tsx manual/imagery-eval/run.ts
```

Requires `ANTHROPIC_API_KEY` in `.env`. The `eval:imagery` script
is deliberately *not* `test`.

The script exits with code 1 if any hard invariant is violated.
Soft mismatches print a warning but don't fail.

## Cost / runtime

Each fixture is one Haiku call (~200-500 tokens out, with cached
system prompt). A ~6-fixture set runs in 15-30 seconds for a small
fraction of a cent total.

## Adding a fixture

Append to `fixtures.ts`. A fixture tests one selection edge: empty
pool + action-led cycle (must generate), populated pool with a
strong match (should pick), populated pool with no good match
(should generate not stretch), spoiler-avoidance for a building-
pressure cycle, `imageryEnabled=false` short-circuit. Per-fixture
expectations (allowed decision set, prompt word cap, pool allow-list)
go on the fixture; the general image-prompt contract that holds for
*every* fixture lives in the spec's `## Eval` section
(`src/db/seed-data/sporting-event/imagery.md`), not here.
