# Kairos — working notes for AI-assisted dev

Real-time narrative orchestration engine. Chronos is the raw stream — events, commentary, research, moderator input; time passing, things happening. Kairos is what the engine produces — the meaningful moment extracted from the stream. *The engine's job: transforming Chronos into Kairos.*

**Read [`README.md`](README.md) first** for what Kairos is, the consumer contract, the lifecycle, the runtime model, and the dev/deploy commands. [`src/README.md`](src/README.md) is the internal architecture — the four-stage pipeline, the data shapes, the module map, the anti-patterns — and each `src/<module>/README.md` is the checkpoint for that module. This file carries only the rules that bite when you edit `apps/kairos/server/**`; it does not restate the architecture.

## Working rules

The full rule set — domain-agnostic boundary, infrastructure vs content, flow over correctness for narrative, no judgment over fact (events are first-class), the `db:generate` migration discipline — lives in the [`kairos-server` skill](../../../.claude/skills/kairos-server/SKILL.md) and auto-loads on `apps/kairos/server/**` reads. Short version of the load-bearing ones:

- **Domain-agnostic.** No football concepts, no Sportmonks types, no Blackout-specific source names, no imports from `@blackout/server` — and **no imports from `@blackout/shared`** either (Kairos has no dep on it; `@blackout/shared` is the Blackout side's types hub; a type needed both sides is duplicated, Kairos owns it — see the `blackout-shared` skill). ("Moderator" is *not* a leak — it's the generic role of "the person driving the broadcast.") Known violations: `PHASE_BASE` / `LIVE_PHASES` hardcode football phase names — tracked in [`docs/kairos-domain-leak-open-items.md`](../../../docs/kairos-domain-leak-open-items.md) and `README.md` § Open work; don't add more.
- **Flow over correctness for narrative.** A wrong-but-fluent passage is shippable; a broken-flow passage is not. Don't add suppression/retry/blocking to "fix" narrative correctness — fix the inputs (the spec, the brief, the source data), not the emission. Events are first-class facts — no service should suppress an event because it doesn't fit a judgment.
- **Infrastructure vs content.** Code is infrastructure; prompts/specs/seeds are content. A prompt change is a content edit, not an architecture change — but the *plumbing* that loads prompts is code. (Today `TASK_INSTRUCTIONS` / `IMAGERY_INSTRUCTIONS` / per-mode `formatMode` fragments are hardcoded in `src/narrative/` — the prompts-as-content work moves them into versioned `generation` + `imagery` *service specs*, resolved like the enrichment/curation specs; `event_profiles` stays content-free. Until then, treat edits to those constants as content edits. → [`docs/prompts-as-content-design.md`](../../../docs/prompts-as-content-design.md).)
- **ESM** (`"type": "module"`) — `.js` extensions in relative imports.
- **The feed WebSocket is read-only** — all writes go through REST.
- **All persistent state lives in Postgres** — the runtime caches are convenience layers on top; no state held only in memory.

## Migration discipline

The canonical statement is in the [root `CLAUDE.md`](../../../CLAUDE.md) / the [`migrations` skill](../../../.claude/skills/migrations/SKILL.md), and applies here unchanged: edit `src/db/schema.ts`, run `pnpm db:generate`, commit the SQL + `meta/_journal.json` + `meta/<idx>_snapshot.json` together; never hand-write structural DDL; never mix `db:push` and `db:migrate` on the same database.

## Scope

The concept prototype is complete and active development is paused. If work resumes, build only what is needed to explore a concrete question, keep the code domain-agnostic, and avoid abstractions for hypothetical consumers. Error handling, graceful degradation, and recovery remain first-class because Kairos runs through long live sessions. Keep the four-stage boundaries clean (`pipeline/`, `enrichment/`, `curation/`, `narrative/`) and preserve narrow public interfaces.
