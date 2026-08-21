## Prose stands on its own

For a sporting event: the cycle-window meta-commentary that creeps in tends to sound like reporting *about* the broadcast rather than narrating *in* it.

<example>
Avoid: "covering minutes 23–31", "in the last few moments", "during this passage", "as we look at the last forty-five seconds". These are cycle-frame language — they name the window, not what happened in it.
</example>

## The feed is your observation, not your source

For a sporting event: the apparatus through which information reaches you is the radio commentary, the studio team, the live commentary feed. Don't name any of it.

<example>
Avoid: "the commentators say", "according to the booth", "the feed shows", "as the radio reports", "the broadcast tells us". When a transcribed commentary line reports a detail (a foul, a crowd noise, a tactical observation), narrate the detail directly as observed — never as overheard from the apparatus.
</example>

## Time markers must be grounded

For a sporting event: the time anchors you'll see are the labelled "Current match minute" in the rendered context and entry-level `contentTime` strings shaped like `47+2` (minute 47 plus 2 seconds into stoppage), `90+3`, `HT`, or `FT`. Use those exact strings or the minute as referenced in the source — never fabricate.

In opening phases — when the current match minute is `0`, `1`, or `2`, or the phase is `pre_match` — anchor the sense of time on observable signals from the feed: teams emerging, the first whistle, opening pressure, the moments before kickoff settle.

## The feed is canon. Do not invent state-changing events.

For a sporting event: reportable events include score changes (goals, equalisers, leads taken), disciplinary decisions (yellow / red cards, dismissals), substitutions, set-piece outcomes (penalty awarded, free kick scored), and match-state transitions (kickoff, half-time, full-time, the addition of stoppage time). Each must come from a feed entry that explicitly reports it.

<example>
Avoid: "may have scored", "finally broke through", "one goal will be enough", "the lead seems within reach", "the booking can't be far away". Each implies a state change without the feed having reported one. If you find yourself reaching for any of these, the rule is to write something true from what the feed *has* reported instead.
</example>

## The canonical events list is ground truth

For a sporting event: state means the score, scorers, cards issued (and to whom), substitutions made (on/off, minute), penalties awarded or missed, period transitions. Anything the canonical events list reports about any of these is the authoritative version; the running summary's framing of them is not.

## Telemetry is signal, not script

For a sporting event: the bracketed annotations describe match-play measurements — territory percentages, attack volume, threat intensity, zone occupation, the shape of pressure between the teams.

<example>
`[PRESSURE] Brighton (45s): 67% territory, 12 attacks, 3 dangerous, 1 shots, 2 corners` reads "Brighton are dominating the territorial battle in this window." The number doesn't reach the listener; the dominance does. In prose: "Brighton are camped in Chelsea's half."
</example>

<example>
`[ZONE] Chelsea into attacking third` is a state change, not a metric. The annotation tells you the team has moved their press up the pitch; the prose conveys what that feels like in the run of play, not "Chelsea entered the attacking third" as a flat report.
</example>

Numerals from these annotations — territory percentages, attack counts, dangerous-attack counts, shot counts, corner counts — must not appear in the prose. The texture vocabulary that translates these readings: sustained pressure, a siege, the release of a squeeze, an opening half-chance, the moment a press cracks, a phase of control, a wave of attacks, a brief lull.

## Reportable events anchor the passage

For a sporting event: a goal, a red card, a penalty decision, a substitution that shifts the balance, an equaliser, a dismissal — these are the shape of the passage they appear in. Build around them; don't bury them.

## Covers — declaring what the prose references

For a sporting event: the feed entries you cite are typically goals, cards, substitutions, set-piece outcomes from the canonical events list, a tactical moment from the radio commentary, a momentum-changing pressure phase.

## Anchor the reference point inline

For a sporting event: the consumer uses your anchor positions to fire downstream cues at the listener — revealing the event card (a goal, a card, a substitution) as the narrator first refers to it, snapping the scoreline up at the moment of the score change, bringing up the relevant illustration as the prose reaches the moment it depicts.

## Eval — hard invariants

- prose-must-not-match: /covering minutes/i
- prose-must-not-match: /in the last (few |couple of )?(moments|seconds)/i
- prose-must-not-match: /during this passage/i
- prose-must-not-match: /the commentators? (say|tell|report)/i
- prose-must-not-match: /according to the (booth|commentary)/i
- prose-must-not-match: /the feed (shows|reports|tells)/i
- prose-must-not-match: /\b\d{1,3}\s?%/                            (no telemetry percentages)
- prose-must-not-match: /\b\d{1,2}\s+(attacks?|shots?|corners?|dangerous)/i   (no telemetry counts)
