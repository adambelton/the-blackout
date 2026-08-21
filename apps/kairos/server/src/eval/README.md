# eval/ — eval criteria as spec content

One module: **`spec-eval.ts`**. It owns the shared vocabulary for the
"eval criteria as spec content" model ([`docs/prompts-as-content-design.md`](../../../../docs/prompts-as-content-design.md)
§ *Eval criteria as spec content*).

The contract a prompt must hold travels *with* the prompt: a
`## Eval — hard invariants` / `## Eval — soft notes` section inside the same
markdown — `<service>.baseline.md` for the profile-agnostic machine
invariants, the service spec for the profile-specific ones. This module is
the single source of truth for the eval header names and the hard-invariant
line grammar, so two callers stay in lockstep:

- **The prompt assemblers** (`enrichment/baseline-loader.ts`,
  `curation/baseline-loader.ts`, `narrative/spec-types.ts`) call
  `isEvalHeader()` to **skip** eval sections — they're assertions about
  output, not prompt text, so they must not leak into the assembled prompt,
  and they must not be mistaken for header drift.
- **The eval runners** (today: `manual/<surface>-eval/run.ts`; later: the
  Kairos admin app's `POST /specs/.../eval/run`) call `extractEvalCriteria()`
  to pull the merged (baseline + profile) invariants and execute the hard
  ones against live output.

## The grammar

Each `-` bullet under `## Eval — hard invariants`:

```
- prose-must-not-match: /regex/flags    (optional trailing gloss, ignored)
- prose-must-match: /regex/flags
- tool-was-called
```

Malformed lines throw — same loud-failure discipline as section-header
drift. New directive kinds extend `HardInvariant` + the directive sets in
`spec-eval.ts`. Soft notes are free-text reviewer guidance, surfaced
alongside output, never executed.

**Per-fixture expectations are not invariants.** "This input's prose must
cover `evt-goal-1`" is about one input's expected output, not a general
contract — it stays with the fixture inputs in code
(`manual/<surface>-eval/sporting-event/fixtures.ts`).

## What working looks like

A spec author adds/edits an eval section; the runner picks it up on the next
run with no code change. A typo'd directive or regex throws loudly at
parse time, not silently mis-passes. Editing the prompt and editing its
contract happen in the same file.
