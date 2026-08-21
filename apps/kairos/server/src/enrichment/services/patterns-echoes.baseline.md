## Concept

Patterns and echoes are recurrences across the broadcast — motifs that keep returning, callbacks to earlier moments, rhythms the scene settles into. There are two kinds: emergent patterns (where live evidence itself surfaces the same shape more than once) and echoes (where live evidence resonates with something the writer has named in the brief — a historical pattern, a prior encounter, a character with a notable narrative). Both are first-class patterns; the difference is just where the recurrence comes from.

## What counts as a subject

A subject is one specific recurring pattern — a motif, a callback, a rhythm. Each distinct pattern is tracked separately. For emergent patterns, do not invent one from a single event; wait for a second instance before introducing a new subject. For echoes against the brief, the first live touch of a brief-named pattern IS the second instance — the brief established the prior, the live evidence is the echo, and the pattern is real on first contact.

## Reading shape

Each reading has: `description` (one sentence on the pattern); `occurrences` (integer — how many instances so far, including this cycle; for echoes against a brief fragment, count the brief mention as instance 1 and this live touch as instance 2); `weight` (low | moderate | high — narrative significance); `echoesContextEntryIds` (array — brief entry ids this pattern echoes; populate from the `[id:...]` markers in the brief content when relevant; empty for purely emergent patterns).

## Brief — extraction guidance

The brief is your catalogue of echoes to listen for. For every fragment in the brief content, ask: would this become meaningful if a live event touched it? Historical patterns, prior encounters, characters with notable narratives, recurring shapes the writer has named — all are candidate echoes. When live evidence resonates with one, that is a pattern instance. Populate `echoesContextEntryIds` with the `[id:...]` of every brief fragment the pattern echoes (usually one, sometimes two).

Emergent patterns (recurrences purely within live evidence) are equally valid — leave `echoesContextEntryIds` empty for those. The distinction matters because the curator tracks brief-fragment recurrence separately from emergent-pattern recurrence; explicitly naming the fragment is what makes that tracking possible.

## Eval — soft notes

- Reviewer: is a pattern minted only on a genuine second instance — or the first live touch of a brief-named echo (the brief mention is instance 1)? Are `echoesContextEntryIds` populated for echoes and empty for purely emergent patterns? Does a re-fire actually advance `occurrences` (a new instance is the news), rather than restating a stable count?
