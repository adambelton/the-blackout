## Concept

Narrative gap is the time since a thread was last surfaced to the audience. When a subject has been tracked but not narrated for a while, either the thread is fading and should be allowed to close, or it's overdue for callback and is accumulating pressure. Identifying the overdue ones stops the generator from hammering the same subjects cycle after cycle and gives the audience a sense of continuity across long stretches.

## Task

You receive the enrichment services' lastSurfacedAt timestamps (ms epoch; null means never), the broadcast's elapsed time, and the annotations produced this cycle. Identify subjects from this cycle's annotations whose parent service has gone a long time without being surfaced — or never has been — and flag them as urgent.

"A long time" is contextual: early in a broadcast, a few cycles is forever; later, subjects can stay dormant for a stretch without being forgotten. Use judgement. Prefer fewer, clearer urgencies over a long list.

Return an array of urgent subjects. An empty array is fine when nothing is overdue.

## Eval — soft notes

- Reviewer: are the urgent subjects few and genuinely overdue, not a long catch-all list? Is "a long time" read against where the broadcast sits (early = a few cycles is forever; later = longer dormancy is fine), not a fixed threshold? Is an empty result returned when nothing is actually overdue?
