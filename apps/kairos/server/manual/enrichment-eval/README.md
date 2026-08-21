# enrichment-eval — reviewer harness for the enrichment stage

`pnpm eval:enrichment` runs all six enrichment services against one
representative cycle (`sporting-event/fixtures.ts`) — each constructed with
its resolved baseline + v1 `sporting_event` spec and a live Haiku client —
and prints what each surfaces alongside that service's `## Eval — soft notes`.

Unlike the narrative harnesses (`generation`/`imagery`/`summary`-eval), there
are **no hard pass/fail invariants**. Enrichment output is structured
judgment (per-subject readings), not prose, so a regex contract doesn't
apply. This is a **reviewer harness**: it makes each service's reading legible
so a human can judge it against the contract its soft notes describe (is
`direction` relative to baseline? is a theme a meaning beneath the events? is
a pattern minted only on a real second instance?). The soft notes live in
each `src/enrichment/services/<name>.baseline.md`'s `## Eval — soft notes`
section and are read via `extractEvalCriteria` (`src/eval/spec-eval.ts`).

**NOT** part of `pnpm test` / CI — it makes live LLM calls. Run it before
shipping a change to an enrichment baseline or spec. Requires
`ANTHROPIC_API_KEY` (loaded from `.env`).

The fixture is one mid-match cycle (Brighton 1-0 Chelsea, ~23') plus the
writer's brief, chosen so all six services have material through their own
lens — momentum (the goal off sustained pressure), tension/conflict (the
table stakes), themes (Rosenior's project, Welbeck's renaissance), character
arcs (Welbeck scoring, Rosenior's composure), relationships (the
Hinshelwood–Welbeck assist), patterns/echoes (the brief threads the moment
now touches).
