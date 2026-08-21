## Concept

A broadcast has a dramatic arc. Openings set expectations; a rising middle builds energy; a climax concentrates the drama; a falling action lets pressure release; a resolution closes the story. Recognising where a broadcast sits in this arc shapes every downstream decision — what to emphasise, how quickly to narrate, when to breathe.

The arc is a slow-moving structural anchor, not a per-cycle reading. Phase transitions should be rare and consequential — once or twice per broadcast, not once every minute. A wobble in the cycle's annotations is not a phase change; only a shift sustained across cycles, or a single decisive event, should move the phase.

## Task

You receive the broadcast's elapsed time (ms since activation), an expected total duration, the cycle's trigger reason, the current phase (if one has been committed), the prior phase candidate from last cycle (if any), and the enrichment annotations produced this cycle.

Decide which phase the broadcast is currently in. Use, in order:
  1. The writer's anticipated shape from the brief, if one is named — this is the strongest prior. The writer told you what shape they expect; deviate only when live evidence forces it.
  2. Elapsed-time position in the broadcast — a baseline expectation.
  3. The annotations of this cycle — only as evidence to confirm or override the prior, not as the primary signal.

For changeStrength, return one of:
  • `stable` — your candidate phase matches the current phase. No change being proposed.
  • `tentative` — you are proposing a change but the evidence is moderate (sustained shift in annotations, but no decisive event).
  • `strong` — a single decisive event has shifted the broadcast. The phase should change immediately.

The curator gates phase changes: a tentative change only commits when the prior cycle's candidate was also the same new phase. A strong change commits immediately. So lean conservative — return `stable` unless you genuinely believe the phase has moved, and `strong` only when an unambiguous event justifies it.

Return the phase, the changeStrength, and a one-sentence rationale grounded in what you saw.

## Brief — extraction guidance

From the writer's brief, draw any sense of the dramatic shape the writer anticipates for this broadcast — when they expect rising action, where they think the climax sits, whether they're framing this as a slow-burn or a sharp story. Use this as the prior for arc detection: when live evidence is ambiguous, the writer's anticipated shape carries weight. Live evidence can still override, but in the absence of strong evidence, lean on the writer's expected shape rather than re-rolling phase from the latest annotations alone.

## Eval — soft notes

- Reviewer: is the phase judged from elapsed time *and* what actually happened, not the clock alone? Is `strong` change-strength reserved for a genuinely phase-shifting event, not asserted every cycle? Does the phase hold (return `stable`) on a wobble, moving only on a sustained shift or a decisive event?
