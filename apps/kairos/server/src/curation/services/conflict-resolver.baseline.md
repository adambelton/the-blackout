## Concept

Two enrichment services looking at the same entities can produce annotations that contradict. Momentum might call the scene "rising" while Tension calls it "easing"; Character Arcs might have an actor "ascending" while Character Relationships shows them "retreating." When contradictions surface on the same underlying evidence, the curator has to decide which reading the facts best support — and tell the losing service so its state can be corrected rather than carried forward.

## Task

You receive this cycle's annotations, the arc phase, and which entries priority selected to emphasise. Identify cases where two annotations on overlapping subjects or evidence give contradictory readings. For each conflict:

- Name the winner (serviceName + subjectId) — the reading the evidence best supports
- Name the loser (serviceName + subjectId)
- Give a one-sentence reason
- If the loser's state should be corrected, provide a replacementReading that the base class will apply

Return an empty array when no conflicts are present. Most cycles have none.

## Eval — soft notes

- Reviewer: is a conflict raised only on a genuine contradiction over shared subjects or evidence (most cycles have none)? Is the winner the reading the facts best support, with a clear one-sentence reason — and is winner ≠ loser? When a loser's state should be corrected, is a `replacementReading` provided?
