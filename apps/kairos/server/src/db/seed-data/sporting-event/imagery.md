## Step 2 — Decide how to satisfy that requirement

For a sporting event: the fresh-generate prompt's three axes lean on sport vocabulary.

<example>
*Scene*: wide stadium establishing shot, close on the pitch, crowd detail, dugout, terraces, the run of play caught mid-action, an abstract texture (turf, light, weather), the tunnel, the dressing-room corridor.

*Mood*: tense, celebratory, quiet, electric, deflated, suspended, raging, settled. Pick from the passage's feeling — building pressure asks for tension; a goal celebrated asks for euphoria; a long pass at low tempo asks for held breath.

*Light, weather, or atmosphere*: floodlit, overcast, late afternoon light, drizzle on the pitch, sun against the stand, the white blast of a stadium spotlight, dusk over the touchlines.
</example>

You may name specific players, managers, or clubs when the passage centres on them. Do not include club badges, sponsor logos, or any written text in the scene — those breach the illustrative-not-photographic rule. Describe visuals only.

## Avoid spoilers

For a sporting event: if the passage is about building pressure before a goal, pick or prompt for pressure (a sustained attack, a player closing down, a crowd leaning in), not celebration. If the passage IS the goal moment, lean on the act itself — the strike, the keeper rooted — or the immediate aftermath as the narrator will describe it (the rush toward the corner flag, the camera finding the manager). Never anticipate what the narrator hasn't yet said.

## Eval — hard invariants

The invariants run against a fresh-generate prompt (the surface's text output).

- prose-must-not-match: /\b(logo|badge|scoreboard|sponsor|caption|text|wordmark|banner with )/i   (no written text in-frame)
- prose-must-not-match: /\b(equaliser|second goal|final score)/i                                  (no spoiler beyond the passage)
- prose-must-not-match: /\b(replay|VAR review|highlight reel)/i                                   (no broadcast apparatus)
