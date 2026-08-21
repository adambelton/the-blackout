# curation-eval — reviewer harness for the curation stage

`pnpm eval:curation` runs each LLM-driven curation service against one
representative cycle (`sporting-event/fixtures.ts`) — a crafted
`EnrichedPayload` plus a base `CurationContext` with the tier-1 fields
pre-set — and prints the field each service writes alongside its
`## Eval — soft notes`. Each service runs against a fresh clone of the base
context, so runs don't bleed into each other. `pacing` is excluded (pure
arithmetic, no LLM).

Curation output is structured judgment, so most of this is **review-only**
(read each decision against its soft note). But unlike the enrichment harness,
three services have **genuinely machine-checkable rules**, asserted as hard
checks (exit 1 on violation):

- **`priority`** — never removes a canonical entry id; stays within the
  emphasis budget (≤ `max(3, 20% of non-canonical)` added emphases).
- **`conflict_resolver`** — every conflict's winner ≠ loser.
- **`saturation_resolver`** — does not force `context_led` on a fresh cycle
  with no recent window (nothing should be saturated).

`context_curator` is hydrated via `initializeFromBrief(BRIEF)` before its
`curate`, so it has candidate threads to rank.

**NOT** part of `pnpm test` / CI — it makes live LLM calls. Run it before
shipping a change to a curation baseline or spec. Requires
`ANTHROPIC_API_KEY` (loaded from `.env`).

The fixture is the same Brighton 1-0 Chelsea, ~23' moment as the enrichment
harness, carried one stage downstream: the enrichment annotations are crafted
(momentum rising, Welbeck's renaissance theme, Welbeck's arc), the cycle is
`action_led` (a canonical goal), the arc phase is `rising`, and the brief
seeds the threads `context_curator` ranks.
