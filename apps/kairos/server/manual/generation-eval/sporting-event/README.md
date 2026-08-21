# Generation eval — `sporting_event` fixtures

Three starter fixtures exercising the v1 `sporting_event` spec
content against the in-code baseline. Subject references in the
fixtures (Brighton, Chelsea, Welbeck, the Amex) are football-
specific and belong to this profile only.

- **action-led-goal** — reportable goal in feed. Asserts: prose has
  no cycle-window meta, no broadcast-apparatus references, no
  telemetry numerals; the goal entry is covered + anchored.
- **enrichment-led-pressure** — PRESSURE telemetry, no state change.
  Asserts: prose has no territory percentages, attack/shot/corner
  counts, or fabricated state-change verbs.
- **context-led-silence** — empty entries window. Asserts: prose
  stays under the maxWords cap, no state-change verbs, no apparatus
  references.

See the [parent README](../README.md) for when to run, what the
runner reports, and cost.
