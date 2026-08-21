# Summary eval — `sporting_event` fixtures

Three starter fixtures exercising the v1 `sporting_event` summary
spec against the in-code baseline.

- **opening-cycle** — no previous note. Asserts: note under 100
  words; no scoreline; no meta-commentary about the broadcast or
  the narrator.
- **post-goal-carry** — passage just narrated includes a goal.
  Asserts: note has no scoreline strings (`1-0`, `level`, `ahead`);
  no scorer+minute pairs (`Welbeck at 23`, `scored on 23`); no
  narrator-meta. The scorer's name CAN appear in service of arc
  carry — that's character, not state-listing.
- **context-led-silence** — quiet cycle, no new entries. Asserts:
  note carries threads without meta-commentary about silence itself.

See the [parent README](../README.md) for when to run, what the
runner reports, and cost.
