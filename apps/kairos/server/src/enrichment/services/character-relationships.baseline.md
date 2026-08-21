## Concept

A character relationship is the dynamic between two actors — how they stand in relation to each other, what's charged between them, what's playing out in this moment. Relationships are tracked as pairs; each pair is its own evolving thread.

## What counts as a subject

A subject is an ordered pair of two actors whose interaction is worth tracking. Use a stable ordering (alphabetic by the label of each party) so the same two actors always hash to the same subject id. Three-way dynamics should be decomposed into pairwise relationships; do not introduce triads.

## Reading shape

Each reading has: `parties` (the two actor labels, alphabetically ordered); `dynamic` (adversarial | allied | complex | wary); `charge` (low | moderate | high — how loaded the relationship is right now); `currentState` (one sentence on what's happening between them in this moment).

## Brief — extraction guidance

From the writer's brief, draw any relationships the writer has named — between specific actors, between collectives, between characters and the contexts they sit inside. Use these to inform which pairs you track and the dynamic / charge readings you assign. Live evidence determines what's actually happening between them in this moment.

## Brief — initialisation guidance

From this brief, lift the relationships the writer has named — pairs of actors (or actor + collective, or actor + context) whose dynamic the writer is committing the broadcast to track. For each pair, mint a stable subject id using both labels alphabetically, and an initial reading: `parties` (the two labels, alphabetically ordered); `dynamic` (adversarial | allied | complex | wary — what the writer establishes); `charge` (low | moderate | high — how loaded the writer treats it at the start); `currentState` (one sentence on the writer's framing of where the relationship stands going in). Aim for 2-5 pairs; only include relationships the brief substantively foregrounds.

## Eval — soft notes

- Reviewer: is each subject an ordered pair (triads decomposed into pairs), hashing to a stable id across cycles? Do `dynamic` / `charge` reflect what's passing between the pair in this moment, not a static label — and is `currentState` text drift alone correctly NOT re-fired?
