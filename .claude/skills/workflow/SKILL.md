---
name: workflow
description: Cross-cutting workflow rules for The Blackout monorepo. Use before committing, when starting/supporting a live broadcast or smoke test, when stating capability facts about third-party vendors, when placing artefacts (exports, captures, analysis files), when changing anything that crosses the Blackout/Kairos seam, when proposing a pattern that "looks like the convention", and when starting a new build step. Keywords: commit, dev server, support session, monitoring, vendor capability, artefact, broadcast export, cross-app, both apps, precedent, established convention, assumption, success criterion, retrospective.
---

# Blackout — workflow rules

These are the rules I keep being reminded of. Reading the right ones up-front avoids re-learning.

## Commits
- Do not run `git commit` until the user has confirmed the change looks right with their eyes. Self-verification (typecheck, screenshots) is a checkpoint, not a green light.
- Single exception: the user has explicitly asked me to "commit and push" or similar in this turn.

## Cross-app changes
- `apps/blackout/server` and `apps/kairos/server` are one product behind a deliberate HTTP/WS seam. If a change touches the contract (routes, WS messages, shared concepts, naming, docs), update both in the same pass without being asked.
- Respect the boundary — no shared imports across the seam, Kairos stays football-agnostic. See [kairos-server](../kairos-server/SKILL.md) for the boundary rule in detail.

## Depth-changing renames
- A directory rename that changes a tree's depth (e.g. `apps/web/` → `apps/blackout/client/`, +1 level) silently breaks every upward-relative reference inside the moved tree — markdown links, dynamic test imports (`import("../../../...")`), shell paths in scripts, `.env.example` comments. Static TS imports are caught by the compiler; the rest fail at runtime or render as broken links.
- Pre-flight checklist for any depth-changing rename, run *inside the moved tree* before opening the PR:
  - `grep -rEn '\.\./\.\./(docs|packages|\.claude|content|scripts|CLAUDE\.md)' <moved-tree>/` — these all need `+N` levels bumped to match the new depth.
  - `grep -rEn '\.\./<old-app-name>/' <moved-tree>/` — sibling-app references via the old name.
  - `grep -rEn 'import\(.*\.\./' <moved-tree>/` — dynamic imports the TS compiler can't see through.
  - Look in `.md`, `.ts`/`.tsx`, `.json`, `.sh`, and `.env.example`.
- Bump with the longest-pattern-first trick (substitute via a placeholder so a `../../docs` → `../../../docs` rewrite doesn't recursively bump the new path). The W6.0a/b/c renames hit this twice (CI caught the test imports reactively; the doc-audit caught the markdown links). One pre-flight pass beats two reactive fixes.
- Same restructure rule applies to the documentation system: a rename that introduces a new namespace level (e.g. `apps/web` → `apps/blackout/client` creates `apps/blackout/`) requires a new namespace-level README in the same pass — see `docs/documentation-system.md` § *Where the layers sit* / *Namespace dirs count as meaningful levels*.

## Shipping a "planned" item — sweep upward through the docs

A PR that ships work the docs have been describing as future (a "will lift X", a "the plan is Y", an Open-work bullet) leaves the *deep* README freshly current and every shallower README and dashboard now wrong. The shallower docs almost always describe the work in future tense — bubble them up to past tense in the same PR.
- **Find what to update.** Grep for the work's name from the touched tree upward to the dashboard: `grep -rn '<work-name>\|<symbol-being-replaced>\|will lift' <touched-tree>/.. docs/STATUS.md docs/mvp-status.md`. Anywhere the term shows up, check whether the surrounding sentence is now past-tense correct.
- **Tense sweep.** "Will lift / planned / TBD / the plan is to / Open work: <thing>" → past-tense description of what shipped + a one-sentence pointer to whatever remains open. The Open-work bullet doesn't necessarily delete — it shrinks to what's still owed.
- **Bubble up the chain.** Module README → parent README → app README → namespace README → `docs/STATUS.md`. Each level says less detail but mentions the shipped work in its own register (e.g. STATUS.md gets a one-line Recently-shipped entry; the module README gets the actual mechanism description).
- **Pickup-point sweep.** If `docs/STATUS.md`'s "Pickup point" line names this work as next, advance it to whatever's actually next. A stale pickup point misdirects the next session's first half-hour.
- **Symbol-name sweep.** If the work renamed or replaced a public symbol (e.g. `TASK_INSTRUCTIONS` → `TASK_INSTRUCTIONS_BASELINE` + spec merge), grep the docs for the old name: `grep -rn '<OLD_SYMBOL>' apps/ docs/ .claude/skills/`. Every hit is a stale description.
- The doc-audit catches this drift retroactively (and hardens against it when a pattern recurs). Sweeping in the shipping PR avoids the next session opening to incorrect docs.

## Editing seed-data/ requires a post-merge ops step in the PR

`apps/kairos/server/src/db/seed-data/**/*.md` is content, not infrastructure. Edits don't propagate on deploy — only `release_command`'s `migrate.js` runs there, and migration is for schema. **A PR that touches any file under `seed-data/` MUST list a post-merge ops step in the PR description**, of the shape:

```
After merge + deploy:
  pnpm --filter @kairos/server db:seed
```

Why this is the rule, not automation: data and infrastructure are different layers (same line the migration rule draws). Forcing seed into `release_command` couples content publication to code merges — wrong shape; runs as no-op once the admin app becomes canonical; widens deploy failure surface for no real win. Workflow discipline catches the "I forgot to run seed" failure mode without that cost.

The K6.2 incident (2026-05-17 — prod sat with v0.1.0 placeholder spec rows for two days after K6.2 merged because its PR didn't include the seed step) is the canonical example of the failure mode this rule prevents. Retires when K6.4 ships the admin-app editing flow — at that point the admin app is the canonical source and `seed-data/` is bootstrap-only.

## When a wrong decision was reasonable, write a skill rule (not a memory)

After a correction — I did X, user said no, we did Y instead — the question that decides where the lesson lives is:

> **Was X a reasonable thing to think, given what someone working in good faith on this codebase would know at that moment?**

If yes (reasonable inference, just wrong for us), **the same wrong decision will recur** any time future-me — or another agent, or the same me without this context loaded — starts from those same priors. The rule has to be in context *automatically* when the trigger fires. That means the matching skill (`migrations`, `blackout-server`, `kairos-server`, `blackout-client`, `blackout-shared`, `workflow`) gets the rule, in its body, written for the next person who's about to make the same plausible-but-wrong call. Do this immediately, in the same session as the correction. Don't park it in memory hoping I'll consult the body next time.

If no (a rule already existed and I missed it): "follow the rule next time" is not a fix — if I missed it once I'll miss it again. The two-part question is **why was the rule ignorable, and how do we make it un-ignorable?** Diagnose:

- **Was the rule actually in context when I made the wrong decision?** Check: was it in a skill body (auto-loaded by trigger), in the always-loaded MEMORY.md index, or only in a memory file body (load-on-demand)? If it was load-on-demand, the trigger is wrong — lift the rule into the matching skill body so it's in context exactly when the trigger fires. The 2026-05-17 drizzle-cursor case was this: the rule existed in a memory body, the body never auto-loaded, so I missed it twice. Fix was lifting into the migrations skill.
- **Was the rule in context but I read past it?** That means the rule was too quiet — buried in a long section, phrased as abstract principle rather than the specific wrong-claim-to-watch-for, or not visually distinctive enough to break my reasoning flow. Rewrite it. Use a `## CRITICAL:` heading or a `DO NOT claim X` prefix. Phrase it as the failure pattern from the reader's point of view (the wrong thing they're about to write), not as the underlying mechanism. Pair with the concrete trigger that should stop them — "if you're about to write 'byte-identical SQL will skip on prod', stop."
- **Was the rule in context and visually loud but I overrode it with escape-hatch reasoning?** ("It's fine this once / special case / I've thought about it.") Add an explicit "no exceptions" clause to the rule, and a sentence about why every defensible-sounding exception in the past was wrong. Make the override harder than the compliance.

Every ignored rule is evidence that the rule's *placement, shape, or volume* needs work. The output is a rule update, not a "try harder."

**The canonical example (2026-05-17):** I claimed "byte-identical SQL means drizzle's migrator will skip the migration on prod" — twice in the same session, in PR #38 and PR #42's descriptions, after writing a memory note about it post-PR #38. The claim was reasonable: most migration systems hash-match. Drizzle doesn't (it's cursor-based on `created_at`; `pg-core/dialect.js:62`). Future-me reading the migrator code with default assumptions would land on the same wrong inference. The rule had to be in the migrations skill body, where it auto-loads on every `drizzle/` touch — not in a memory file whose body only loads when I think to read it.

**Skill is right for:** how a tool, library, framework, our own code actually behaves; failure modes that a defensible reading of the code wouldn't reveal; invariants future-me needs in context the moment the trigger fires.

**Memory is right for:** personal collaboration context (user preferences, tone, what the user has told me about themselves), project state snapshots, decision logs, pointers to external systems. None of these are domain rules.

**The mechanical step after a correction:** find the matching skill, add the rule in the right section, write it for the next plausible-wrong reasoner. Write a memory entry only if the lesson is genuinely about me-and-user collaboration; otherwise no memory entry at all — the skill carries it.

## Dev stack ownership in support sessions
- Pattern: clear log, start in background with tee.
  - `: > /tmp/kairos.log && pnpm --filter @kairos/server dev 2>&1 | tee /tmp/kairos.log`
  - `: > /tmp/server.log && pnpm --filter @blackout/server dev 2>&1 | tee /tmp/server.log`
  - `: > /tmp/web.log && pnpm --filter @blackout/client dev 2>&1 | tee /tmp/web.log`
- All three with `run_in_background: true`. Wait for health endpoints before declaring ready. `pnpm`/`node` available directly — don't source nvm.

## Artefacts
- Per-broadcast artefacts (exports, captures, analysis files) → `<repo-root>/data/broadcasts/<full-uuid>/`. Never `/tmp`. Never outside the repo.
- Logs / debug / smoke output stays in `/tmp` — those die with the session.
- Rule of thumb: worth keeping past this terminal session = `data/`. Dies with the session = `/tmp`.

## Vendor capability claims
- Don't state confident facts about third-party services (auth providers, databases, AI vendors) from memory. WebFetch the docs or flag uncertainty before recommending.
- Especially for dealbreakers: supported provider lists, pricing tiers, region availability, feature parity. Ergonomic preferences ("X is simpler") don't need verification; specific capability claims do.

## Cost discipline
- When testing carries a known cost and a cost-cutting change is staged for the next session, advise stopping once the baseline is captured. Surface the cost-vs-data tradeoff explicitly — don't absorb it silently.
- Real money, single-operator project, limited budget. The user is paying per call across Anthropic, Replicate, OpenAI, Deepgram, ElevenLabs, Sportmonks.

## LLM-using tests live out-of-band
- Tests that make real LLM calls (distiller, generator, imagery, broadcast_summary, anything routing to Anthropic/OpenAI) must NOT live under `apps/<app>/tests/` — `pnpm test` runs in CI / pre-commit and these tests would burn money + flake on LLM variance.
- Home for them: `apps/<app>/manual/<feature>-eval/` — a directory with fixtures, a runner script (`run.ts`), and a README explaining when to invoke. Pattern of record: `apps/blackout/server/manual/distiller-eval/`.
- Runner script's contract: hard invariants (the cascade rules the prompt must hold) → assert + exit 1 on violation; soft expectations (LLM judgement-call cases) → print for human review, don't fail.
- The runner is invoked manually before shipping any change to the system prompt, tool schema, or model version of the component being evaluated. NOT before every commit.

## LLM prompt changes need eval verification
- Any change to a `SYSTEM` prose, a tool schema description, an `EVENT_CLAIM_CLASSES`-style enumeration, the model version, or the few-shot examples in an LLM-calling module is a load-bearing prompt change — not a refactor. Run the corresponding eval before merging.
- "Trivial" prompt edits (typos, wording polish) are still prompt changes — Haiku/Sonnet behaviour can shift on small wording. Run the eval.
- If the eval doesn't exist yet for the prompt being touched, build it before shipping the change. The fixture set should cover at least: the happy path, the regression class that motivated the change, and one or two adversarial cases.
- Pattern of record: `apps/blackout/server/manual/distiller-eval/run.ts` — runs against `fixtures.ts`, asserts hard cascade invariants, prints soft cases.

### Eval harness and smoke/live test verify DIFFERENT things
- **Eval harness** (`apps/<app>/manual/<feature>-eval/`) verifies *prompt plumbing correctness*: objective mechanical things with answers — tool-call output validates against schema, `covers` is a strict subset of cycle entries, every `{{ref:<entryId>}}` resolves, word count within target envelope, tense matches config, no telemetry numerals in prose. Hard invariants assert + exit 1; soft expectations print. Pre-flight checklist; doesn't need a full broadcast.
- **Smoke / live test** is *additional context* for narrative quality: the gestalt — does the prose flow, does the voice hold across a 90-cycle arc, is the tone right. Eyes-on judgment. Catches things the harness can't.
- **Neither substitutes for the other.** Don't offer "we can rely on smoke instead of the harness" as a cost-saving option, or "snapshot-only" as on-par. Snapshot pins assembly output (catches code drift, not LLM plumbing); smoke catches gestalt quality; harness catches plumbing invariants. Three distinct layers. If you propose fewer-verification options, label them as such — surfaced K6.2 (2026-05-16) when I offered them as substitutable.

## Don't leave dangling citations in comments
- When cleaning up a comment / docstring (stripping context to make it domain-agnostic, or any other reason), strip any **dangling citation** the cleanup created — bare dates ("during a live test on 2026-04-22"), `Finding 5 in the YYYY-MM-DD debrief` pointers, `@see` JSDoc tags pointing at incident docs — whose meaning depended entirely on the context just removed.
- A citation in a comment earns its place by *carrying* meaning, not by *pointing* at where meaning used to live. Two rules:
  - If the *principle* the incident illustrated is worth keeping (domain-agnostic, load-bearing), keep the principle and drop the citation. The principle stands; the date adds nothing.
  - If the *principle* requires the stripped incident detail to make sense, drop the comment entirely. Honest about what the code is, no orphan pointers.
- Inline citations to *current architecture* (`see content-time.ts`, `tracked in PHASE_BASE`) are different — they point at present code, not past context. Keep them.
- Surfaced 2026-05-16 (K6.2 docstring cleanup, summary.ts): I drafted "Putting deterministic events through Haiku compression dropped a canonical event during a live test on 2026-04-22; the templated state block makes that class of bug structurally impossible." User corrected: drop the date — the principle is domain-agnostic and earns its place, the date references football-incident detail that's been stripped and is now meaningless.

## PR splits must buy real verification
- Before proposing a "first-the-mechanical, then-the-editorial" (or any equivalent intermediate-state) split, ask explicitly: *will the intermediate state be exercised, by what, and is the result a load-bearing signal?* — a smoke test between the PRs, a deploy that runs traffic, a benchmark, something that turns "behaviour-preserving" into a verified claim.
- If the answer is "no" / "nothing" / "not really," **collapse the split**. The intermediate PR's review + merge overhead is real cost; the bisectability benefit only materialises when a downstream signal can be cleanly attributed to one half or the other. No intermediate exercise = bisectability never gets tested = the split is pure ceremony.
- Surfaced K6.2 (2026-05-16): I proposed K6.2.a (mechanical: read prompts from DB instead of constants, byte-equal copy of today's strings) → K6.2.b (editorial: rewrite for clean baseline/profile-content separation). The bisectability benefit was: K6.2.a's smoke would prove the new mechanism is identical to today's; K6.2.b's would be a clean A/B. When user said "no smoke test between the mechanical and editorial," the split collapsed — K6.2.a became dead-weight scaffolding nobody would exercise.

## Read the rendering code before claiming UI root causes
- When diagnosing a UI symptom (clock display, reveal timing, label content, conditional rendering), don't reason from upstream data shapes about what the UI "must be doing." Read the rendering code first. The data could be perfectly correct and the bug could be entirely in the render path — or the data is wrong but the UI doesn't use it the way I assume.
- Before claiming why a UI value displays a particular way, locate and read the component / hook that produces it. `grep` for the displayed string, the variable name, the rendering function — find the actual source. If reading reveals the mechanism, hypothesise from that; otherwise say "mechanism unverified" and mark the cluster open until verified.
- **One contradicting data point is enough to invalidate a model.** Stop and re-read rather than patching the model. The 2026-04-26 matchroom clock regression: p1's cover had `contentTime="1"` yet matchroom displayed `−1`, refuting my "matchroom walks covers" model immediately — I should have noticed before forming any hypothesis.
- Same rule for prompts shown to LLMs: read the prompt-assembly code before claiming why a model behaved a certain way.

## Precedent vs convention
- "Done this way in N migrations" ≠ "the team's convention." A pattern formed by accident in one session and copied since is precedent, not a deliberate decision.
- Use language that exposes the difference: "this has been done X way — worth deciding if it should be a deliberate convention" rather than "the convention is X."
- When proposing to follow an existing pattern, surface the inflection point: "I'd follow the existing pattern of X, but it looks set incidentally — worth a quick sanity check."

## Discipline prompts (build steps)
- Before a non-trivial build step, prompt for: (1) the assumption being tested, (2) the success criterion (qualitative or quantitative).
- After a build step lands, prompt for a one-paragraph retrospective: hypothesis, what happened, what changes for the next decision.
- Significant decisions go in `docs/product-decisions.md`.
- Don't frame this as "product engineering practice" — community-driven development; members not audience; writers commissioned from day one.

## Member ethics
- Member ethics is a first-class argument in any feature discussion alongside technical/product. Build for members, not growth. Access is not a lever. Manipulation is not a method. Public surfaces describe what The Blackout is and let it speak — no dark patterns, no false urgency, no incomplete journeys.
- Full statement: root `CLAUDE.md` § *How we treat members*.

## Public comms sensitivity
- Radio commentary ingestion is an internal capability. It must not appear in public-facing content (landing pages, brand materials, marketing copy).
