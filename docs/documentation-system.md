# The Blackout — documentation system

How this codebase documents itself, how that supported AI-assisted development, and the rules that keep it from drifting.

Written 2026-05-11. The first vertical built to this spec is Kairos (`apps/kairos/server/**`) — read those READMEs alongside this doc to see the shape in practice.

---

## The problem this solves

The codebase has outgrown "hold it all in your head." Four runnable applications, three shared packages, and a domain-agnostic engine with a four-stage pipeline cannot all stay in working memory while one part is changing. So we make smarter assumptions about the parts we're *not* touching, and we make them safely:

- **Resolution-appropriate context, close to the code.** When you open `apps/kairos/server/src/curation/`, the README there tells you what curation is responsible for, how it talks to enrichment and to generation, the contract it depends on from each, and what "working" looks like — without you having to read the curator's 573 lines or the whole-engine architecture doc.
- **Contracts are the load-bearing thing.** Every module README states the API contract it *provides* to its consumers and the contracts it *depends on*. Two reasons: (1) you can validate your change against the intent of the module you're in — am I still delivering what my consumers need? — and (2) if you find one module reaching *inside* another instead of through its stated API, you've found a design flaw to fix, not just a style nit.
- **WIP lives where the work lives.** Open questions, design memos, known issues, tech-debt for a component live in that component's README, beside the code they concern. The README above it carries a one-line summary and a link down; `docs/STATUS.md` is the top of that chain.

Instead of one big architecture document that nobody updates and everybody half-trusts, the architecture is a set of **checkpoints** at every level — easier to keep current, easier to reference, and a forcing function on structure.

This applies equally to a human reviewer and an AI assistant. A reviewer can begin at the root and progressively follow the part of the system that interests them. An assistant working in a subtree can read the nearest checkpoint and obtain the constraints needed to make a local change safely. Neither needs the whole repository in working memory, and neither should have to infer a neighbouring module's behaviour from its implementation.

---

## The two principles

### 1. One source of truth per fact, at the depth the fact belongs to.

A fact lives **once**, at the level it's about:

- A detail of how the enrichment pipeline keys its waiting room → `apps/kairos/server/src/enrichment/README.md`.
- How Kairos and the Blackout server talk to each other → `apps/README.md`.
- What The Blackout *is* → the root `README.md`.

Every level above the fact's home carries a **summary at that level's resolution**, plus a reference down. Never the same prose twice. The same fact, re-expressed at lower fidelity as you climb:

```
apps/kairos/server/src/enrichment/README.md   "The waiting room keys entries by content
                                        ordinal — (phase, phaseSecond) collapsed
                                        to one sortable number — and drains
                                        anything ≤ (highest observed − DELAY).
                                        DELAY defaults to 60s; see content-time.ts."
        ↓ summarised
apps/kairos/server/README.md                  "Cycles batch entries by content time, not
                                        arrival time, so a slice is coherent in
                                        match-time terms. → src/enrichment/"
        ↓ summarised
docs/STATUS.md                          (nothing — this is settled architecture, not
                                        in-flight work; STATUS only carries what's
                                        moving)
```

This cuts both ways. "Correct resolution for the level" means a project-level doc does **not** carry component detail (push it down), and a component-level doc does **not** restate project-level framing (link up). It also means a fact that genuinely spans several components — e.g. the matchroom reveal architecture touches `apps/blackout/server`'s canonical bundles, `apps/blackout/client`'s reveal walk, and the shared `Passage` contract — lives at the level it actually spans (`apps/README.md` or a doc under `apps/`), not artificially shoved into one child and not parked centrally by default.

**Vocabulary follows the same rule.** A term is defined where the concept lives — "enrichment" is defined in `apps/kairos/server/src/enrichment/README.md`, "passage" in the matchroom/conductor READMEs, "broadcast" at `apps/README.md`. `docs/vocabulary.md` survives as a *convenience index* — a single place to look a word up — but the canonical definition is the one beside the code. A term may appear in more than one place (the index entry and the home README, occasionally two homes if it genuinely means something at two levels) **only under a strict discipline: when you change a definition, search for the other copies and update them in the same change.** Drift in a duplicated definition is a bug; the search-on-update rule is the price of the convenience.

### 2. Document deep, bubble up.

The workflow when you finish a piece of work:

1. **Update the deepest doc the change touched** — the README sitting next to the code, or its WIP section. Full fidelity here: the why, the trade-off, the open follow-up.
2. **Walk the summary up the chain.** Each parent README's mention of that area gets re-checked: is the one-line summary still true? Is there a new contract? Did a WIP item open or close? Edit it. Repeat until the summary stops needing to change (often that's one or two levels).
3. **`docs/STATUS.md` is the top of the chain** — if the change moved something that was in flight, blocked, or recently shipped, the one-liner there updates and links down.

If a parent README's summary *can't* be expressed in a line or two without losing something load-bearing, that's a signal the content wanted to live one level down — move it.

This is the only discipline that keeps the system honest. A README is a checkpoint; a checkpoint that's stale is worse than no checkpoint. The bubble-up step is part of "done," not a separate chore.

---

## README.md vs CLAUDE.md — division of labour

Both exist at the levels where both are useful (repo root and each app today; potentially deeper). They are not redundant — they serve two different audiences with two different lifecycles:

| | **README.md** | **CLAUDE.md** |
|---|---|---|
| **Register** | Descriptive — "here's what this is, how it works, the contract, what working looks like." | Imperative — "do X, never Y, this auto-loads, read README.md for the architecture." |
| **When it's read** | On demand. By a human browsing, by GitHub rendering the folder, by an agent that *chose* to open it (or was pointed at it). | Always. Every CLAUDE.md on the path to a file you're editing is auto-injected into context whether or not it's relevant this time. |
| **Audience** | Anyone jumping into this code, or into code that consumes it. | The agent (Claude). |
| **Size discipline** | As long as it needs to be — it's the orientation doc. | Stays thin. CLAUDE.md is spent on *every* session in that subtree; if it's growing, the content wanted to be in README.md. |
| **Contains** | Architecture, contracts, data flow, what success looks like, WIP, links up and down. | Pointers (→ README.md, → skills), the rules that bite when you edit this subtree, dev commands, migration discipline. |

The rule that prevents drift between them: **never duplicate.** CLAUDE.md *points at* README.md for anything descriptive; README.md does not restate rules. If you catch yourself copying a paragraph from one to the other, one of them is in the wrong file.

(The `.claude/skills/blackout-*` files are the same idea as CLAUDE.md — pattern-triggered rules — just loaded by relevance rather than by directory. They're the canonical statement of a rule; CLAUDE.md and README.md reference them, they don't restate them.)

---

## The README template

Every module README follows this shape. Not every section applies to every module — drop the ones that don't, don't invent new top-level ones. Order matters: the reader should be able to stop after the first two sections and have a working mental model.

```markdown
# <Module name>

<One sentence: what this module is responsible for. The thing you'd put
on its door.>

## What it does

<2–5 short paragraphs or a tight list. The component's job at this level's
resolution. What's *inside* it (sub-modules / key files), one line each,
each a link down where a deeper README exists. Progressive disclosure:
*what* happens here; *how* is one click further in.>

## How it fits

<How this module talks to its neighbours — the ones above, beside, and
below it. Name the seam. **Include a diagram of the communication flow
at this level's resolution** — an ASCII flow diagram (renders
everywhere, including in-terminal) or a Mermaid block (renders on
GitHub) showing what flows in, what flows out, and who calls/injects
what. At the project level it's the four processes and their
seams; at an app level it's the pipeline stages and the data shapes
between them; at a module level it's "X calls into us via <entry
point>; we call out to Y via <entry point>; Z is injected by <who>."
The diagram reinforces the contract — a reader should be able to see,
not just read, how this piece is wired. This is also where you say
what a *working* instance of this module looks like — the observable
signal that it's doing its job.>

## Contract

### Provided
<The public API this module offers its consumers. Function/class/route/
message names + what each guarantees. If a consumer is reaching past
this list into an internal file, that's a bug — say so here so the
expectation is explicit.>

### Depended on
<The contracts this module relies on from its neighbours. "We assume
<X> from <module>: <the shape, the invariant>." When one of these
breaks, this is the list that tells you what to re-check.>

## What working looks like

<Concrete. The healthy steady state. Logs you'd see, invariants that
hold, metrics that converge. The thing you'd check to know it's fine.
Optional if "How it fits" already covered it.>

## Anti-patterns

<Things this module's design explicitly avoids — drift sentinels.
Anything below appearing in the code is a regression. Optional; only
where there's real history of getting it wrong.>

## Open work

<WIP at this level — design memos, known issues, tech-debt, in-flight
changes. Each item: one line + a link to the deeper doc if there is
one. This is what bubbles up: the parent README summarises this
section, STATUS.md summarises the parents. Mark blocked items.
Omit the section if there's genuinely nothing open.>

## See also

<Links up (parent README) and across (sibling modules whose contracts
touch this one), and to any canonical doc under docs/ that this
supersedes or extends.>
```

A README that's just `# Name` + one sentence + "## See also → parent" is fine for a thin infrastructure module. The template scales down; don't pad it.

---

## Where the layers sit (target shape)

```
README.md                              the project — what it is, how to work in it
  CLAUDE.md                            conventions for AI-assisted dev (thin, points at skills)
  apps/README.md                       the four applications — what each is, how they talk, what a
                                       running system looks like, the cross-app contracts
    apps/kairos/README.md               the engine service — server/workbench split
      apps/kairos/client/README.md      the profile-content workbench
      apps/kairos/server/README.md      pipeline, consumer contract, runtime, lifecycle
        apps/kairos/server/src/README.md      four stages, runtime, and data shapes
          apps/kairos/server/src/enrichment/README.md
            apps/kairos/server/src/enrichment/services/README.md
          apps/kairos/server/src/curation/README.md
            apps/kairos/server/src/curation/services/README.md
          apps/kairos/server/src/narrative/README.md
          apps/kairos/server/src/db/README.md
          apps/kairos/server/src/llm/README.md
          apps/kairos/server/src/routes/README.md
          apps/kairos/server/src/ws/README.md
    apps/blackout/README.md             the experience — client/server split
      apps/blackout/server/README.md    conductor, source capture, synthesis, fan-out
        apps/blackout/server/src/conductor/README.md
        apps/blackout/server/src/sources/README.md
        apps/blackout/server/src/pipeline/README.md
        apps/blackout/server/src/lib/README.md
        apps/blackout/server/src/routes/README.md
        apps/blackout/server/src/ws/README.md
      apps/blackout/client/README.md    public, matchroom, moderator, and admin surfaces
        apps/blackout/client/app/matchroom/README.md
        apps/blackout/client/app/moderator/README.md
  packages/README.md                    the shared packages and ownership boundaries
    packages/blackout/shared/README.md  the Blackout side's types hub — WS contracts, the canonical bundle, the Kairos seam (Kairos doesn't consume it)
    packages/blackout/auth/README.md
    packages/kairos/auth/README.md
```

**How deep:** go as deep as the architecture supports — wherever there's a real module boundary with its own responsibility and its own contract, there's a checkpoint. Stop where the next level down is "individual files doing one obvious thing" — docstrings carry it from there. For Kairos that's `src/<stage>/` and `src/<stage>/services/`; deeper than `services/` is individual service files, each well-docstring'd. For the web app the component layer is mostly docstring-carried — a route directory gets a README only where the orchestration is non-trivial.

**Namespace dirs count as meaningful levels.** A directory that groups halves of a service — `apps/blackout/` (client + server of one experience), `apps/kairos/` (server + admin workbench) — is a real checkpoint and gets its own README. The namespace README states what the service is, names its halves and the seam between them, and hosts any contract that belongs above either child. Without that checkpoint, the parent carries detail it should not own and the children duplicate seam content.

**What stays in `docs/`:** artefacts that aren't summaries of anything deeper — they're authored at the project level and decompose into nothing. `product-brief.md` (the vision/why), `product-decisions.md` (a chronological cross-component log, not localisable by nature), `the-blackout-brand-guide.md`. Plus the convenience indexes: `vocabulary.md` (the dictionary), `STATUS.md` (the dashboard). Everything else currently in `docs/` either becomes a thin index/redirect (the big architecture docs) or gets decomposed down into the READMEs (the phase-status docs are themselves aggregations — they should bubble up from component READMEs, not stand as a parallel store of truth).

**Migration posture:** the big architecture docs (`docs/kairos-architecture.md`, `docs/the-blackout-architecture.md`) are being decomposed into the README tree. Until each app's vertical is built, the architecture doc for that app stays in place but carries a header pointing at the READMEs and a warning that the READMEs are now canonical. Once a vertical is complete, the architecture doc becomes a thin index (a table of "for X, see Y/README.md") or is retired. Don't delete a linked-to canonical doc in the same pass that decomposes it — leave the redirect.

---

## Enforcement — the `doc-audit` skill

The system stays honest because we audit it. `.claude/skills/doc-audit/SKILL.md` is the procedure: it reads its last-run marker (`memory/doc_audit_state.md`), `git log`s the window since, buckets the changed files by which README's ownership chain they fall in, checks each touched chain against *this document* (currency, bubble-up, single-source-of-truth, template adherence, CLAUDE.md thinness, reaching-past-an-API, the redirect docs), corrects the drift in the docs, and — crucially — when a violation reveals a *systemic* weakness (a convention people keep getting wrong, a missing checkpoint, an unclear rule), it hardens the affected README/CLAUDE.md or **this spec** so the same mistake can't recur. Then it rewrites the last-run marker. Run `/doc-audit` when wrapping up a session that changed code or docs; the catch-up design means a missed session is swept up by the next run. The point of running it often is that the convention gets *more* drift-resistant over time, not just patched.

## House rules

- **Two sections is the floor for "I have a mental model."** If a reader has to get past "How it fits" to understand what the module is *for*, the first two sections are wrong.
- **Contracts are not optional.** Every module README has a Contract section (provided + depended-on), even if short. This is the part that makes the system more than nicely-organised prose — it's what you validate against and what catches structural rot.
- **A diagram per level.** Every README's "How it fits" carries a flow diagram at that level's resolution (ASCII for portability, Mermaid where the graph warrants it) — what flows in, what flows out, who calls/injects what. A reader should be able to *see* the wiring, not just read it. The diagrams nest: the project diagram's "kairos" box is the whole of `apps/kairos/server/README.md`'s pipeline diagram, whose "enrich" stage is `enrichment/README.md`'s diagram.
- **WIP lives deep; summaries bubble up.** Don't put a paragraph of in-flight reasoning in a parent README — put a line and a link. Don't put a component bug in STATUS.md — put it in the component README and let STATUS link to it.
- **Update on the way out.** Touching code in a module means re-checking that module's README (and bubbling up) before you're done. Stale checkpoint = broken checkpoint.
- **Don't duplicate across levels or across README/CLAUDE.md.** Same fact in two places = a future drift bug. Summarise and link instead.
- **Reaching past a stated API is a finding.** If module A imports an internal file of module B (not B's README'd public surface), that's a design flaw — record it in B's README "Open work" as tech-debt, don't just route around it.
