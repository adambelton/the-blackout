# Distiller eval — manual LLM golden set

Out-of-band evaluation for the live football commentary distiller
(`apps/blackout/server/src/lib/distiller.ts`). **Not** part of `pnpm test` /
CI — these tests make real Anthropic API calls and incur cost +
flakiness from LLM variance.

## When to run

Run this before shipping any change that affects:

- The distiller's `SYSTEM` prose (system prompt).
- The tool schema (`distill_commentary` input schema descriptions for
  `atmosphere`, `eventTexture`, `eventClaim`).
- The `EVENT_CLAIM_CLASSES` list.
- `buildUserMessage` (rosters, content-time anchor, recent canonical
  events block).
- The Haiku model version (`MODEL` constant).
- The schema `additionalProperties: false` constraint.

Routine code changes that don't touch any of the above don't need
this run.

## What it does

For each curated commentary chunk, the runner:

1. Calls the live distiller (`distillCommentary`).
2. Asserts hard invariants the cascade prompt is supposed to enforce
   (e.g. atmosphere never contains event verbs).
3. Prints the actual classification next to the expected one for
   human inspection of the soft cases.

## Running

```bash
pnpm --filter @blackout/server eval:distiller   # from anywhere
# or, equivalently, from apps/blackout/server:
pnpm tsx manual/distiller-eval/run.ts
```

Requires `ANTHROPIC_API_KEY` to be set in `.env`. The `eval:distiller`
script is deliberately *not* `test` — `pnpm test` / CI never run it
(real Anthropic calls, cost, LLM variance). See the `workflow`
skill, "LLM-using tests live out-of-band" + "LLM prompt changes need
eval verification".

The script exits with code 1 if any hard invariant is violated.
Soft mismatches print a warning but don't fail — LLM output varies,
and judgement on borderline cases belongs to the reviewer, not CI.

## Cost / runtime

Each fixture is one Haiku call. ~10 fixtures, ~30-60 seconds total,
small fraction of a cent per run.

## Adding a fixture

Append to `fixtures.ts`. A fixture tests one classification edge:
substitution announcement, goal claim, claim-vs-reference, build-up
texture vs atmosphere, phase-whistle claim, etc. Keep each fixture
small (1–6 lines of commentary) and grounded in real broadcast
phrasing — paste from `data/broadcasts/<id>/transcription.txt` or
the dev.log when possible. Mark expected claims/textures explicitly;
soft expectations (atmosphere topics) can be a freeform note for
the reviewer.
