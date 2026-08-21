---
name: kairos-server
description: Conventions and rules for apps/kairos/server (the domain-agnostic narrative orchestration engine). Use when reading or writing anything under apps/kairos/server/**, when extracting structured fact via an LLM (anywhere in the stack), when proposing to suppress/block/retry narrative emission to fix correctness, when writing engine docstrings, or when editing prompts/specs/seeds. Keywords: apps/kairos/server, narrative, generation, curation, enrichment, prompt, spec, profile, seed, infrastructure, content, suppress, retry, block, judgment, fact, event, template, hallucination.
---

# Kairos (apps/kairos/server) — rules

Architecture context: `apps/kairos/server/CLAUDE.md`, `docs/kairos-architecture.md`, and pipeline design in `memory/project_kairos_pipeline_design.md`.

## Domain-agnostic boundary
- The engine/infrastructure layer (anything in `apps/kairos/server/src/` that runs the pipeline: feed, runtime, enrichment framework, curation framework, narrative engine, WS, REST) **must not know about football.** No football concepts, no Sportmonks types, no Blackout-specific source names.
- **No imports from `@blackout/server` and none from `@blackout/shared` either.** `apps/kairos/server` has no dependency on either package; the seam between Kairos and the Blackout is the HTTP/WS wire, not shared TypeScript. A type genuinely needed on both sides is duplicated — Kairos owns it (it's the engine), the Blackout side keeps its own mirror — not pulled in via a shared package. See the [`blackout-shared` skill](../blackout-shared/SKILL.md) for why; don't add `@blackout/shared` to `apps/kairos/server/package.json`.
- Engine docstrings stay consumer-agnostic — a future second consumer's developer should be able to read engine code without assuming Kairos is football-specific.
- Dependencies flow one way: The Blackout depends on Kairos via the HTTP/WS client. Kairos doesn't know its consumer exists.

## Infrastructure vs content
- Infrastructure (above) stays generic.
- Content — specs, prompts, profiles, service definitions, DB seed — is allowed to be domain-tuned per consumer use-case. Today the seed ships `sporting_event` with goal/card/sub references because The Blackout is the consumer. That's content, not domain leakage.
- Test for which side of the line: **"is the *string* used regardless of profile?"** Not "does the file run every cycle." A constant in `narrative/generator.ts` (e.g. `TASK_INSTRUCTIONS`) that gets concatenated into every system prompt regardless of profile is content masquerading as infrastructure if its text is domain-tuned. Lift to per-profile content; engine assembles `voice + context + profile.<key>`.
- Edge case: a docstring in engine framework code that uses football examples to explain a generic mechanism = infrastructure, NOT allowed. Use consumer-agnostic examples.

## What counts as a domain leak (and what doesn't)
- **Leak:** football-specific *vocabulary* in engine code (kickoff, halftime, pitch, club, fixture, goal, card, sub). Football-specific *mechanics* baked into engine constants (the `PHASE_BASE` ordering of pre_match → first_half → halftime → ...). Hardcoded prompt instructions referencing football scenes / commentary booth / Brighton-Chelsea examples.
- **Not a leak:** generic role names that happen to apply to football. `moderator` (the person driving the broadcast — a debate has one, a courtroom has one, a political event has one). `event` as a source type. `narrative_voice` / `narrative_context` as ambient source types. The test is "would this concept exist for a debate / courtroom / political-event consumer?" — if yes, it's generic.

## Decision keys live in shared constants
- Curator decision keys (e.g. `"event_priority"`, `"canonical_emphasis"`) live in a single shared constants file or the service registry. Never inline string literals at the writing site, especially for synthetic baselines that don't correspond to a registered service.

## Flow over correctness for narrative
- For narrative passages, **never propose suppression, blocking, or retry** to fix a correctness issue. Silence is worse than hallucination.
- Why: AI-generated nature is transparent (listeners are primed for slips); structured-data UI carries the factual record independently; narrative is ephemeral (a slip passes in 30s, dead air is felt every time); the product is a quiet, purposeful experience where dropped narration reads as broken.
- Quality issues route to: better prompt structure, better ground-truth surfacing, telemetry for post-broadcast review, optionally operator-visible warnings — never to client-side gates.

## No judgment over fact
- LLM calls are reserved for judgment. Events (goals, cards, gamestate transitions, score) are first-class — never compressed through an LLM.
- Examples of fact (template, don't LLM): scores, scorers, cards, subs, gamestate transitions, timestamps, player names, team identities, derived structured signals (pressure metrics, possession %).
- Examples of judgment (LLM is the right tool): narrative arc, character motif, tonal carry, motif resonance, what to surface when, what to compress when, when a passage is ready.
- When fact and judgment must coexist (running summary, narrative passage), structure the output: templated fact block + LLM judgment block, glued in code. Don't trust the LLM to preserve fact while interpreting it.
- This applies across the wider stack too — audit any LLM call that extracts structured fact, not just Kairos.

## Pipeline stage is defined by operation, not by where the output feeds
- A component belongs to the pipeline stage that matches *what it consumes and what its operation is*, NOT the stage that consumes its output.
- Worked example: `narrative/summary.ts` digests the just-generated passage into a compact running-summary note. Its output feeds into the *next* cycle's generation prompt. The tempting categorisation is "produces context for generation → therefore curation." Wrong — its input is a generation product and its operation is digesting that product. It belongs in `narrative/` (the generation module). Every stage's output feeds something else; that doesn't make every stage "the same stage."
- Surfaced K6.2 (2026-05-16): I argued summary.ts should move to `curation/services/`. The reasoning ("output feeds generation, therefore curation") was a reasonable but wrong categorisation. Output-routing is plumbing; operation × input type defines the stage.

## Engine conventions
- ESM (`"type": "module"`). `.js` extensions in relative imports.
- Feed WebSocket is read-only. All writes go through REST.
- All persistent state lives in Postgres. The runtime cache is in-process convenience on top of the DB; no state is held only in memory.
- Source `data` payloads are consumer-defined. The generator's context shaping reads `content`, `minute`/`extraMinute`, `phase`/`phaseSecond`, optional `subjectTime` — all subject-time markers (see [`docs/vocabulary.md`](../../../docs/vocabulary.md) § Time); the `subjectTime` field renames to `subjectTime`. Nothing in the pipeline requires those fields.
- Generator system prompt is assembled from broadcast's `narrative_voice` + `narrative_context` at generation time — there is no hardcoded voice fallback. Activation gate enforces both non-empty; `buildSystemPrompt` throws if violated.
- Generator must call the `deliver_narrative` tool returning `{ prose, covers }`. Engine filters phantom cover ids against `includedEntryIds` before persist + emit.
- Output duration is bounded by source span duration — prose read-aloud time can't exceed the window of source it covers, or the narrator falls behind live play.

## Migrations
- See [migrations](../migrations/SKILL.md) — auto-loads when touching `schema.ts` or `drizzle/`.
