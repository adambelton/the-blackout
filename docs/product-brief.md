# Concept Brief

The Blackout is an open-source concept for a live literary football experience. It explores what happens when the immediacy of a match and the depth of football writing are brought together in real time.

The repository is a completed prototype and a record of how the concept was designed and tested. It is not an active service, launch plan, or commercial offering.

## The idea

Every Premier League match is broadcast internationally, but UK viewers cannot watch Saturday 3pm fixtures live. Radio can describe what is happening, but it rarely combines the shared immediacy of a live event with the perspective, memory, and thematic depth of considered football writing.

The Blackout imagines a single shared room for one match. Events and live commentary are transformed into authored prose, spoken by a narrator, and accompanied by illustrations. Everyone receives the same passage at the same moment, making the experience closer to a live literary event than a score service, podcast, or conventional commentary feed.

## Creative authorship

Every broadcast begins with a writer. Their research, voice, editorial angle, character notes, and understanding of the clubs form the creative foundation of the experience.

AI is used to support that work at a speed a person could not sustain during a live match. It interprets the match through the writer's brief, assembles prose in real time, and produces imagery within a human-defined direction. It is not treated as an autonomous author or a substitute for creative judgment.

The quality of the output depends on the quality and specificity of the writer's contribution. A thin brief produces a thin broadcast. The technology amplifies creative intent; it does not supply that intent.

## The writer's role

The writer prepares the narrative context before the match: club history, player arcs, tensions, motifs, and the particular perspective that makes this match worth following. During the match they act as moderator, selecting the source, steering emphasis, and adding observations when the live story needs human direction.

The concept is deliberately open to different kinds of football writers: journalists, essayists, long-time supporters, historians, and emerging voices. What matters is sustained creative attention and something genuine to say about the game.

## The experience

- One match is experienced as a shared live room.
- The writer's brief provides the interpretive lens.
- Structured match events provide factual anchors.
- Transcribed commentary contributes atmosphere and texture.
- Kairos enriches and curates the incoming material, then generates a passage.
- Text-to-speech and illustrations turn the passage into a synchronized audiovisual experience.
- A server-side conductor ensures every connected listener receives the same reveal at the same time.

The football remains authoritative. The brief shapes interpretation but cannot manufacture significance that the match does not support.

## Kairos

Kairos is the domain-agnostic narrative engine developed through The Blackout. It accepts normalized entries from live sources, enriches them through several narrative perspectives, curates what matters now, and produces a coherent passage for a consumer to present.

The separation is deliberate:

- The Blackout understands football, captures sources, supplies writer-authored context, and presents the experience.
- Kairos understands live narrative structure but has no football-specific concepts.
- The two communicate through HTTP and WebSocket contracts rather than shared internal state.

This makes The Blackout both a concept in its own right and a concrete proof of a more general live-event storytelling architecture.

## What the prototype demonstrates

- Real-time narrative can remain grounded in structured events while drawing texture from noisy live commentary.
- Human-authored context can guide AI output without becoming a licence to invent.
- Enrichment and curation can separate accumulating meaning from the immediate action.
- A single authoritative playback clock can keep text, audio, events, and imagery synchronized across listeners.
- AI can extend the reach and tempo of creative work while leaving authorship and editorial intent with people.

## Status

The prototype was exercised through full-match live tests and synthetic replays. Development is paused indefinitely, and the hosted infrastructure has been retired. The code and design record remain available as an open-source exploration of the idea.
