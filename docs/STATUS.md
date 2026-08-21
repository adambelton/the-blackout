# Project status

The Blackout is a completed concept prototype. Active development is paused indefinitely, the hosted infrastructure has been retired, and the repository is being preserved as an open-source record of the system and the thinking behind it.

## What the prototype demonstrates

- A live football feed can drive an authored fictional narrative without changing the facts of the match.
- A writer-defined brief can govern voice, characters, motifs, and dramatic boundaries while generative systems handle live variation.
- Narration, prose, illustrations, match state, and replay can share one no-spoilers timeline.
- The Blackout application can remain operationally separate from the domain-agnostic Kairos narrative engine.

## Current state

- The principal prototype flow is implemented across the Blackout client, Blackout server, and Kairos.
- The original hosting and deployment configuration has been removed.
- Dependency maintenance and public-release safety work are documented in the repository history.
- There is no active launch, contributor programme, or service operation.

## Possible technical exploration

The repository contains design notes and identified engineering work that may be useful if the concept is revisited. These are research directions rather than a delivery roadmap:

- Continue extracting the matchroom and moderator orchestration into testable hooks.
- Break up the largest conductor, runner, and narrative-engine modules.
- Complete the prompts-as-content architecture described in [`prompts-as-content-design.md`](prompts-as-content-design.md).
- Improve replay rendering, reference-guided illustration, and qualitative evaluation tooling.
- Consolidate shared protocol types at the service boundary.

Historical live-test notes remain useful evidence about latency, recovery, narrative quality, and human moderation.
