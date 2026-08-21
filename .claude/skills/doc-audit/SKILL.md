---
name: doc-audit
description: Audit the codebase's layered documentation against the documentation-system convention — catch drift since the last audit, correct violations, and harden the affected README/CLAUDE.md (or the convention spec itself) so the same mistake can't recur. Run this at the start of each session so work begins from current docs, when the user asks "are the docs following the convention" / "audit the docs" / "did we update the READMEs", and at session boundaries to verify documentation is being maintained correctly. Keywords: doc audit, documentation audit, README convention, CLAUDE.md, bubble up, doc drift, session start, start of session, session wrap-up, documentation system, did we update the docs.
---

# doc-audit — verify the documentation system is being followed

The codebase documents itself in layers — a README at every meaningful level, contracts stated at each, WIP living deep and bubbling up to `docs/STATUS.md`, CLAUDE.md staying thin. The spec is **[`docs/documentation-system.md`](../../../docs/documentation-system.md)** — read it first; it is the source of truth this audit checks against. This skill is how we keep the system honest: every audit run (a) catches up on what changed since the last run, (b) corrects any drift, and (c) — when a violation reveals a *systemic* gap (a convention people keep getting wrong, a missing checkpoint, an unclear rule) — updates the affected README/CLAUDE.md or the spec itself so the next person can't make the same mistake.

## Procedure

### 1. Establish the audit window

- Look for the last-run marker: a memory file `doc_audit_state.md` in `…/memory/` (its one-liner is in `MEMORY.md` as **[Doc-audit state](doc_audit_state.md)**). It records the last-audited commit SHA + date.
  - **Marker found:** the window is `git log <last-sha>..HEAD`. Also fold in the working tree — `git status --porcelain` — so uncommitted doc/code changes in *this* session get audited too (they're the most likely to need a sweep).
  - **Marker missing** (fresh clone, new machine, first ever run): don't guess a deep window. Audit the working tree (`git status`) plus the last ~10 commits (`git log -10 --stat`), tell the user the marker was absent, and write a fresh marker at the end.
- `git log <window> --stat` (and `git diff <window> --stat`) — get the list of files that changed. Bucket them by which README "owns" them: a change under `apps/kairos/server/src/curation/**` is owned by `apps/kairos/server/src/curation/README.md`, then `apps/kairos/server/src/README.md`, then `apps/kairos/server/README.md`, then `apps/README.md`, then `docs/STATUS.md`. Code-only changes still count — a behaviour change should have bubbled up; if the code changed and no README in its chain did, that's a finding.

### 2. Check each touched chain against the convention

For every README in the ownership chain of a changed area, verify against `docs/documentation-system.md`:

- **Currency.** Does the README still describe the code? Read the README and the changed code side by side. A stale "what it does", a wrong contract, a removed-but-still-documented entry point, a renamed module the README still calls by its old name — all findings.
- **Stale forward-looking claims** (recurring — caught 2026-05-17 *and* 2026-05-22). Grep the touched docs for forward-looking phrasing: `not yet`, `unbuilt`, `still …`, `deferred`, `not (yet )?pushed`, `in flight`, `awaiting`, `planned`, `will`, `local on \`<branch>\``. For each, verify it's *still true at HEAD*. A "deferred / not built / not pushed / in flight" claim that the window's own work (often the same session) then did is a finding — it's now a lie. This bites hardest in `docs/STATUS.md` (its "In flight" + "Latest commit" + recently-shipped "(local)" / "(in flight)" labels) but also in any README that says "X is not built yet" right before the same session builds X. The fix: past-tense it / move it to recently-shipped / drop the label.
- **Bubble-up.** Did the change move something that should have surfaced upward? If a contract changed, the parent's summary of that area should reflect it; if a WIP item opened or closed, the parent's one-liner (and `docs/STATUS.md`) should reflect it. A deep README updated but the parent's summary untouched (and it needed touching) is a finding. Conversely: a parent README carrying a paragraph of detail that should live one level down is a finding (push it down, leave a line + link).
- **Single source of truth.** Same fact stated twice across levels (not summarised — *restated*)? Same fact in README.md *and* CLAUDE.md? Same vocabulary term defined differently in two places (or in `docs/vocabulary.md` and a home README, out of sync)? Findings. The fix is: keep the one canonical statement, replace the others with a summary + link, and — for vocabulary — apply the search-on-update rule.
- **Template adherence.** Does each README still open with the one-sentence "what it is" + "what it does"/"how it fits" (a reader should have a mental model after the first two sections)? Is there a **Contract** section (provided + depended-on) — even short? Is there a **flow diagram** in "How it fits" at this level's resolution, and is it still accurate against the code (a renamed entry point, a removed seam, a new caller — all stale-diagram findings)? New top-level sections invented outside the template? Findings.
- **CLAUDE.md thinness.** Did a CLAUDE.md grow descriptive content that belongs in a README? Did a README restate rules that belong in CLAUDE.md / a skill? Findings — re-partition.
- **Reaching past an API.** While reading the changed code: did a module start importing an internal file of another module rather than its README'd public surface? If so it should be recorded as tech-debt in the *target* module's README "Open work" — if it isn't, that's a finding (record it; don't just route around it).
- **The redirect docs.** If `docs/the-blackout-architecture.md` / `docs/kairos-architecture.md` (or their diagrams) describe something that's now in a README and the README's version is canonical, the legacy doc should carry the redirect header / drift note. A legacy doc that's drifted further without the note updated is a finding.

### 3. Correct the violations

Fix what you found, in the docs. Update the stale README sections. Bubble the summaries up the chain to `docs/STATUS.md`. De-duplicate (canonical statement stays; the rest become summary+link). Re-partition README↔CLAUDE.md. Add the missing Contract section. Record the unrecorded tech-debt in the right "Open work". This is doc surgery, not code surgery — if a *code* change is needed to fix a real structural problem the audit surfaced, that's a separate task; flag it (record it as tech-debt + tell the user), don't silently refactor code under cover of a doc audit.

### 4. Learn from the mistake — harden against recurrence

A violation is a signal that something made it easy to get wrong. For each one, ask: *why did this happen, and what change makes it not happen again?*
- A stale README because the convention's bubble-up step wasn't followed → does `docs/documentation-system.md`'s house rules state it clearly enough? Does the relevant CLAUDE.md remind people? If not, tighten the wording.
- A missing checkpoint (a real module with no README, or a README that should go one level deeper) → create it (or note it for creation), and check whether the "how deep" guidance in the spec covers that case.
- A duplicated fact → was it duplicated because the canonical home was unclear? Make the home explicit (the spec's layer-shape section, or a "this lives in X" line in the parent).
- A README↔CLAUDE.md mis-partition → is the division-of-labour table in the spec clear? Is CLAUDE.md's "this file carries only X; it does not restate the architecture" line present?
- A recurring class of mistake (you've seen it in a past audit too) → that's a strong signal the convention or a CLAUDE.md needs a sharper rule, or this skill's checklist needs an explicit item for it. Add it.

Make the hardening change in the same pass. The point of running this every session is that the system gets *more* drift-resistant over time, not just patched.

### 5. Record the run

- Rewrite `…/memory/doc_audit_state.md`:
  - `Last run:` today's date (absolute).
  - `Last-audited commit:` `git rev-parse HEAD` (the commit at the end of the audit window — if there are uncommitted changes the audit covered, note that the next run should re-check the working tree).
  - A short note of what was found + fixed this run (1–3 lines), and any *carried-forward* finding (something flagged but not yet fixed — e.g. a structural code refactor the audit surfaced but that's a separate task).
- Keep the `MEMORY.md` pointer line current.
- Tell the user, plainly: window audited, findings, fixes applied, anything carried forward, where the marker now sits. If the audit found nothing — say that too; "docs are in step, marker advanced to <sha>" is a valid and useful result.

## Notes

- This is a *documentation* audit. It does not check code quality (that's `/audit` against the Code Quality Pillars), it does not run tests, and it does not refactor code — it checks that the prose describing the code is true, current, well-placed, and non-duplicated, and it improves the convention when a violation shows the convention was weak.
- Run this at the **start** of each session — that way every session begins from current docs, and anything the previous session left unaudited (a forgotten bubble-up, a stale README the work touched but didn't update) is swept up *before* new code is written on top of it. The catch-up design (audit from the last marker forward) means a missed run is not a problem; the next session's start-of-run sweeps it up.
- If the working tree is dirty with unrelated changes, audit only the doc/code areas the session actually touched — don't sweep the whole repo unless the marker is missing or stale by many commits.
