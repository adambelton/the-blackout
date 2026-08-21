## What the note carries

For a sporting event: the threads and motifs tend to surface around managers and key players (their arcs across this fixture's history, their form coming in, their relationship to the result), the two clubs' rivalry and history, the tactical pattern of the game (who's controlling, who's chasing), and the occasion's stakes (the league position, the cup weight, the season's shape).

<example>
*Arc direction*: "the game has settled into a controlled second half, the home side patient with possession, the visitors holding their shape".

*Motifs*: "the visiting end has held its noise through the day; the rain has been steady; the camera keeps returning to the away manager".

*Tonal carry*: "the writer's voice has settled into something patient and watchful — the moment feels suspended".

*Threads*: "the dynasty-defence arc; the visitors' resilience under pressure; the manager-touchline thread".
</example>

## What the note does not touch

For a sporting event: state-bearing material the templated block owns includes — the score (in any form: "0-1", "level", "ahead", "by one goal"), scorers and their minutes, cards issued (yellow / red) and to whom, substitutions made (on / off, minute), period transitions (kickoff, half-time, full-time), penalty awards, VAR decisions. Your note treats all of these as off-limits: the templated block names them; your note characterises the *feeling* of them.

## Eval — hard invariants

- prose-must-not-match: /\b(as I narrate|the narrator|this passage|the broadcast|this cycle)\b/i   (no meta-commentary)
- prose-must-not-match: /\b\d+-\d+\b/                                              (no scoreline string)
- prose-must-not-match: /\bone-nil\b/i
- prose-must-not-match: /\b(level on goals|one (goal )?(ahead|in front|to the good))\b/i
- prose-must-not-match: /\bscored?\s+(at|on)\s+(minute\s+)?\d{1,2}\b/i             (no scorer + minute as state)
- prose-must-not-match: /\bsilence cycle\b/i
- prose-must-not-match: /\bnothing happened\b/i
