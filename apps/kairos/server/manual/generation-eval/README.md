# Generation eval — manual LLM golden set

Out-of-band evaluation for the narrative generator
(`src/narrative/generator.ts`) against the resolved baseline + an
event profile's service spec. **Not** part of `pnpm test` / CI —
real Anthropic calls (Sonnet for prose), cost + flakiness from LLM
variance.

## Profile scoping

Fixtures are scoped to one event profile per subdirectory — subject
references in fixtures are domain-specific (football names, sport
vocabulary) and don't generalise. (The general prose contract is *not*
in the fixtures — it lives in the spec's `## Eval` section; see below.)
Today:

- [`sporting-event/`](sporting-event/) — football fixtures against
  the v1 `sporting_event` spec content (3 fixtures).

A second profile would land as a sibling directory; the runner
takes a `--profile` env when it does (single profile today, so the
runner hard-codes `sporting_event`).

## When to run

Run this before shipping any change that affects:

- `generator.baseline.md` (the in-code profile-agnostic baseline)
- The `generation` service spec's `taskInstructions` or `modeBlurbs`
  (live in `src/db/seed-data/sporting-event/generation.md` + the
  `index.ts` blurb strings)
- `buildSystemPrompt` / `buildSystemSegments` / `generate` in
  `src/narrative/generator.ts`
- `assembleSectionedPrompt` (the assembly helper) in
  `src/narrative/spec-types.ts`
- The Sonnet model version (`DEFAULT_ANTHROPIC_MODEL` in `src/llm/defaults.ts`)

Routine code changes that don't touch any of the above don't need
this run.

## What it does

For each curated fixture, the runner:

1. Resolves the baseline + v1 sporting_event spec content from the
   seed-data module (no DB dependency).
2. Calls `generate(...)` with the fixture's context against a real
   Anthropic Sonnet client.
3. Asserts the hard invariants in two parts: the **general prose
   contract** parsed from the spec's `## Eval — hard invariants`
   section (via `src/eval/spec-eval.ts` — no cycle-window
   meta-commentary, no broadcast-apparatus refs, no telemetry numerals)
   plus each fixture's **per-fixture expectations** (cited covers
   anchored, word cap, mode-specific state-change bans). The general
   contract lives *with the prompt*, not in the fixture (K6.5+
   eval-as-spec-content).
4. Prints the prose + covers next to the fixture's expectation
   notes for human inspection of the soft cases (tone carry, mode
   adherence, opening-window time handling).

## Running

```bash
pnpm --filter @kairos/server eval:generation     # from anywhere
# or, equivalently, from apps/kairos/server:
pnpm tsx manual/generation-eval/run.ts
```

Requires `ANTHROPIC_API_KEY` in `.env`. The `eval:generation` script
is deliberately *not* `test` — `pnpm test` / CI never run it (real
Anthropic calls, cost, LLM variance).

The script exits with code 1 if any hard invariant is violated.
Soft mismatches print a warning but don't fail — LLM output varies,
and judgement on borderline cases belongs to the reviewer, not CI.

## Cost / runtime

Each fixture is one Sonnet call (~500–1500 tokens out at most, with
the cached system prompt amortising the spec across the run). A
~10-fixture set runs in 30–90 seconds and costs a small fraction of
a dollar.

## Adding a fixture

Append to `fixtures.ts`. A fixture tests one prompt-behaviour edge:
the action_led goal passage, the enrichment_led pressure phase, the
context_led silence-cycle, the opening-window time-handling, the
canonical-events ground-truth assertion. Keep fixture entries small
(2–8 feed entries) and grounded in real broadcast material — paste
from `data/broadcasts/<id>/feed.ndjson` or live-test artefacts when
possible. Per-fixture expectations (covers, word cap, mode-specific
bans) go on the fixture; the general prose contract that holds for
*every* fixture lives in the spec's `## Eval — hard invariants` section
(`src/db/seed-data/sporting-event/generation.md`), not here. Soft
expectations are freeform notes for the reviewer.
