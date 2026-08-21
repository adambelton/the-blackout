# Imagery eval — `sporting_event` fixtures

Three starter fixtures exercising the v1 `sporting_event` imagery
spec against the in-code baseline.

- **empty-pool-goal** — action-led, pool empty. Asserts: decision
  is `generate`; prompt under 40 words; no written-text refs (logos,
  scoreboards, captions); no spoiler language.
- **pool-match-pressure** — enrichment-led, pool populated with one
  clear thematic match (pressure) and one misfit (tunnel). Asserts:
  if decision is `pool`, the chosen item is from the allow-list
  (the misfit must not be picked).
- **imagery-disabled-short-circuit** — `imageryEnabled=false`.
  Asserts: decision is `hold` without an Anthropic call.

See the [parent README](../README.md) for when to run, what the
runner reports, and cost.
