/**
 * Condensed regression test + demo script — Brighton 3-0 Chelsea (21 Apr 2026)
 *
 * Pumps synthetic source entries through the full Blackout + Kairos pipeline
 * in real time, compressed into ~16 minutes of wall-clock time.
 *
 * ── Testing scope ────────────────────────────────────────────────────────
 *
 * This is a regression gate, not a substitute for a live broadcast. Run it
 * before activating a live match after non-trivial changes to source
 * capture (`apps/blackout/server/src/sources/`, `apps/blackout/server/src/pipeline/`,
 * `apps/blackout/server/src/lib/broadcast-runner.ts`), the conductor
 * (`apps/blackout/server/src/conductor/`), the Kairos pipeline, or TTS.
 *
 * What it catches:
 *   - Broadcast lifecycle plumbing — creation, activation, ambient
 *     seeding (narrative_context + narrative_voice), brief
 *     initialisation pass (per-service Haiku extraction), completion.
 *   - Source-shape acceptance on Kairos (match_events, match_pressure,
 *     match_action) and source-priority routing (canonical vs not).
 *   - Phase FSM progression in replay mode — warming → live_first_half →
 *     halftime → live_second_half → full_time_winddown — and the
 *     conductor's auto-pushed transition entries (KICKOFF, HALFTIME,
 *     SECOND_HALF_KICKOFF, FULL_TIME).
 *   - Cycle pendulum across phases — action cycles on goals/cards/subs,
 *     enrichment cycles between events, improv/gap cycles in halftime.
 *   - Curation parallelism (services within a tier run concurrently).
 *   - Halftime reflection + closing passage explicit-generation triggers.
 *   - Commentary distillation — same Haiku call production uses, real
 *     prompt against real captured TalkSPORT commentary. Atmosphere +
 *     event_texture flow into Kairos as match_action; editorial,
 *     opinions, and event-fact claims are filtered out at this stage.
 *   - TTS synthesis → audio playback → matchroom reveal.
 *   - batchEntryIds reveal-gating — no event surfaces before audio-start.
 *   - Imagery decision routing (generate / pool / hold).
 *   - Pacing feedback loop — wpm reports back to Kairos and shape the
 *     next cycle's target word count.
 *   - Late-joiner snapshot (currentPlay) and phase cue fan-out.
 *   - End-to-end narrative coherence across a 16-minute slice — enough
 *     to surface gross hallucinations, score drift, missed goals.
 *
 * What it can't tell us:
 *   - Sportmonks polling cadence, event-arrival jitter, real fixture
 *     state observation. The script bypasses the runner; events are
 *     pre-shaped and pushed direct to Kairos.
 *   - Deepgram transcription, ASR garble correction, roster
 *     normalisation, lineup fetch — no fixtureId, no radio source.
 *   - Event-correlation calibration loop — the script discards the
 *     distiller's event_claim outputs because there's no correlation
 *     buffer running here. Per-class radio-offset calibration only
 *     exercises in live broadcasts.
 *   - PressurePipeline derivation logic — pressure/zone entries here
 *     are pre-shaped, not derived from raw trends + ball coordinates.
 *   - Long-arc narrative quality — character arc sustainment over
 *     hundreds of cycles, refrain saturation, repetition fatigue.
 *     Brighton-Chelsea live (2026-04-21) ran 144 cycles; this runs
 *     ~20-30. Live testing remains the only ground truth here.
 *   - Token-budget behaviour under sustained load — 16 minutes won't
 *     hit Anthropic TPM ceilings.
 *   - Pacing drift correction over time.
 *   - Mid-broadcast pause / WS reconnect / browser-tab backgrounding.
 *   - Auth/role gating (script bypasses via INTERNAL_API_SECRET).
 *   - Studio illustration pool effects (no pool pre-stocked).
 *
 * ── Phase shape ──────────────────────────────────────────────────────────
 *
 *   Phase          Duration   What fires                        Tests
 *   ────────────────────────────────────────────────────────────────────────
 *   Pre-match         2 min   distilled commentary only         Enrichment
 *   First half        5 min   match_events + match_pressure +   Action +
 *                             distilled commentary              enrichment
 *                             (goal at +1:30)
 *   Half time         2 min   distilled commentary only         Improv/gap
 *   Second half       5 min   match_events + match_pressure +   Action +
 *                             distilled commentary              enrichment
 *                             (goal at +2:00, yellow at +3:30,
 *                              late goal +4:55)
 *   Closing          ~30s    synthetic FULL_TIME entry          Closing
 *                             triggers full_time_winddown        passage
 *
 * Source-to-cycle mapping:
 *  - `match_events` (canonical: true) — goals, cards, subs, transitions.
 *    Triggers action cycles via the significant_event path.
 *  - `match_pressure` (canonical: false) — PRESSURE_UPDATE / ZONE_ENTRY /
 *    ZONE_MIDDLE. Builds enrichment context without auto-emphasis.
 *  - `match_action` (canonical: false) — atmosphere + event_texture
 *    distilled from the captured TalkSPORT commentary. Same Haiku call
 *    production uses; raw transcription never reaches Kairos.
 *  - Pre-match and halftime push transcription only because in production
 *    `RoomConductor.canPushFromSource` gates non-ambient sources to
 *    live_first_half / live_second_half.
 *
 * Phase transitions are driven by `data.phase` on incoming entries (the
 * conductor's replay path — see `phase-logic.ts::nextPhaseFromEntryPhase`).
 * Every entry pumped here carries its phase so the conductor can advance
 * the FSM monotonically. The transitions for halftime_reflection and
 * closing_passage fire automatically off those phase advances.
 *
 * Source data: real Sportmonks events + real TalkSPORT transcription
 * from the captured Brighton vs Chelsea broadcast (f037784b-…), condensed
 * and re-timed. Welbeck goal is synthetic (original occurred at 90+1',
 * outside the transcription window we have).
 *
 * Usage (regression — no TTS, fast feedback):
 *   pnpm --filter @blackout/server exec tsx scripts/replay-condensed-brighton-chelsea.ts
 *
 * Usage (demo — with TTS, real time):
 *   TTS_VOICE_ID=<id> TTS_PROVIDER=elevenlabs \
 *     pnpm --filter @blackout/server exec tsx scripts/replay-condensed-brighton-chelsea.ts
 *
 * Usage (demo with Hume):
 *   TTS_VOICE_ID=<id> TTS_PROVIDER=hume \
 *     pnpm --filter @blackout/server exec tsx scripts/replay-condensed-brighton-chelsea.ts
 *
 * Environment variables:
 *   BLACKOUT_URL     default: http://localhost:4000
 *   KAIROS_URL       default: http://localhost:5050
 *   TTS_VOICE_ID     optional — override server default voice
 *   TTS_PROVIDER     optional — override server default provider
 *   KAIROS_API_KEY   optional — bearer token if Kairos requires auth
 *   INTERNAL_API_SECRET optional — Blackout internal API secret
 */

import "../src/env.js";
import { distillCommentary } from "../src/lib/distiller.js";

// ─── Configuration ───────────────────────────────────────────────────────────

const BLACKOUT_URL = process.env.BLACKOUT_URL ?? "http://localhost:4000";
const KAIROS_URL = process.env.KAIROS_URL ?? "http://localhost:5050";
const TTS_VOICE_ID = process.env.TTS_VOICE_ID ?? null;
const TTS_PROVIDER = process.env.TTS_PROVIDER ?? null;

// Phase durations in milliseconds (real wall-clock time)
const PHASE = {
  PRE_MATCH_MS: 2 * 60 * 1000,     // 2 minutes
  FIRST_HALF_MS: 5 * 60 * 1000,    // 5 minutes
  HALF_TIME_MS: 2 * 60 * 1000,     // 2 minutes
  SECOND_HALF_MS: 5 * 60 * 1000,   // 5 minutes
  CLOSING_MS: 30 * 1000,           // 30 seconds
} as const;

// ─── Match brief (drawn from real broadcast) ─────────────────────────────────
//
// Seeded into Kairos as `narrative_context` by `activateBroadcast` when the
// moderator activates the broadcast. The voice is the product default
// (`content/voice.md`) — there's no per-broadcast voice override path
// today (kairos-bridge.ts:81), so this script does not push a custom
// `narrative_voice` entry.

const NARRATIVE_CONTEXT = `The match
Brighton & Hove Albion vs Chelsea. Premier League, Gameweek 34. American Express Community Stadium, 8pm BST, Tuesday 21 April 2026. Live on Sky Sports.

The table — the evening's essential frame
Just one point separates Brighton from Chelsea in the congested continental race. Brighton can leapfrog Chelsea in the table with a win tonight. A single football match, between clubs separated by a single point, with European football for next season the prize. That framing contains everything the narrator needs.

The two stories — and why they matter together
Brighton arrive with a sense of rhythm. Their unbeaten run now stands at four matches, extended by Georginio Rutter's stoppage time equaliser against Tottenham. Chelsea arrive in a state of uncertainty. Four successive Premier League defeats, each without scoring, have left their Champions League ambitions in jeopardy. The 1-0 loss to Manchester United last weekend carried a familiar pattern — control without incision, possession without reward.

Brighton — the hosts
Fabian Hürzeler's Brighton have climbed into the Premier League's top half after strong recent form. The Amex has become a fortress of a particular kind — not intimidating through noise or history but through the collective intelligence of how Brighton play.

Brighton have won their last three home meetings with Chelsea.

Key characters:
Danny Welbeck — with 12 league goals, remains the focal point in attack. At 35, playing the best football of his later career at the club that gave him a second chance when others had moved on. Five goals in his last seven Premier League appearances against Chelsea, all as a substitute.
Georginio Rutter — the French striker who broke Tottenham's hearts with a late equaliser. A player full of confidence, arriving in moments.
Kaoru Mitoma — one of the most direct and dangerous wide players in the division. His relationship with space on the left is the thing that defenders across the Premier League have failed to solve.
Jack Hinshelwood — only 20 years old, already a key creative force in Brighton's midfield.

Starting XI (4-2-3-1): Bart Verbruggen / Jan Paul van Hecke, Olivier Boscagli, Ferdi Kadıoğlu / Mats Wieffer, Jack Hinshelwood, Carlos Baleba / Yankuba Minteh, Georginio Rutter, Kaoru Mitoma, Pascal Groß / (none — no traditional striker tonight)
Bench includes: Danny Welbeck, Lewis Dunk, Maxim De Cuyper, Yasin Ayari, Matt O'Riley

Chelsea — the visitors
After a bright start under Liam Rosenior, Chelsea have lost five of their last six Premier League games to fall seven points behind fifth-place Liverpool. Liam Rosenior's playing career ended at Brighton in 2018, and the 41-year-old's hopes of leading Chelsea into Europe's top competition next season could also be effectively over with another dissatisfactory result on the South Coast. That detail is not incidental — it is the human thread of the evening for Chelsea's narrative.

Chelsea have failed to score in their last four Premier League matches. For a club with their resources, their ambitions, their wage bill, that is not a run of bad luck. It is a deeper problem made visible.

Key characters:
Liam Rosenior — his playing career ended at Brighton in 2018. Tonight he returns as the manager of the club that let him go, with everything on the line.
Robert Sánchez — once Brighton's goalkeeper, now standing between the sticks for the club that broke them apart. One of £262 million worth of talent Chelsea have taken from Brighton over the years.
Moisés Caicedo — another former Brighton player, now wearing Chelsea blue.
Liam Delap — the striker carrying Chelsea's attacking burden tonight. No Palmer. No Joao Pedro. The line must be led by Delap alone.
Wesley Fofana — starting at centre-back, carrying injury concerns from the weekend.

Starting XI (5-3-2): Robert Sánchez / Jorrel Hato, Trevoh Chalobah, Wesley Fofana, Marc Cucurella / Moisés Caicedo, Enzo Fernández, Malo Gusto / Roméo Lavia / Pedro Neto / Liam Delap
Bench includes: Alejandro Garnacho, Marc Guiu, Dário Essugo, Tosin Adarabioyo

The £262 million thread
Chelsea have raided Brighton for £262 million worth of talent over the past few years — Caicedo, Sánchez, Joao Pedro, and others. Tonight, some of it comes back. The Amex knows exactly what was taken. Brighton have not forgotten.

Head to head
Five wins each from the last eleven meetings, although Chelsea have lost the last three. Nine of the last ten meetings produced 3+ goals. Chelsea have been awarded the most corners in six straight away games — their attacking intent expressed as set pieces rather than open play.

The question the match asks
For Brighton: can a club built on intelligence and method take the next step — European football earned, not gifted?
For Chelsea: is there anything left in this season, or does tonight confirm that the Champions League dream is over?
For Liam Rosenior: what does it mean to return to the ground where your playing career ended, now managing the club that let you go, with your job perhaps depending on the result? That last question is the one the narrator should hold throughout.`;

// ─── Transcription segments (real TalkSPORT commentary, re-timed) ────────────
//
// Each segment is an array of commentary lines to drip over the phase
// duration. Content is taken directly from the captured broadcast
// transcription. In production every transcription entry is stamped with
// `phase` + `phaseSecond` by broadcast-runner.pushEntry; we do the same
// here so the conductor's replay-phase FSM advances naturally on the
// first transcription line of each phase.

const TRANSCRIPTION: Record<string, string[]> = {
  pre_match: [
    "It is the Amex Stadium in Sussex. A pivotal Tuesday night that could entirely redefine the race for European football.",
    "It would be the ultimate irony if Brighton finished higher in the table than Chelsea. The Blues from West London have raided Brighton for £262,000,000 worth of talent over the past few years. Taking their brightest stars to the Kings Road.",
    "It is the Seagulls whose season appears to be taking off at just the right time and Chelsea who are flapping.",
    "A win for Fabian Hürzeler's side will see them leap above Chelsea into sixth place, and it was just two months ago that Brighton were 13 points behind the Blues. Tonight, they are breathing down their necks.",
    "For Chelsea, it is full blown crisis mode. The last time Rosenior's team scored against a top flight side, Arsenal were bumping at the top of the Premier League.",
    "Interesting, isn't it — that Caicedo was given the captain's armband on Saturday, but today Enzo Fernandez gets it back again. Things change quickly with Chelsea.",
    "Brighton attacking the goal away to our right. Chelsea to our left. There's a lot at stake tonight — European football, one point between these clubs, everything.",
    "How do Chelsea find a goal? The line has got to be led tonight by Delap. No Palmer. No Joao Pedro. And if you were going to take two players out of the Chelsea ranks, if you were manager of Brighton, I think those would be top of your list.",
  ],

  first_half_opening: [
    "Ball is away to our left hand side. It's at the feet of Verbruggen who fires it to Kadıoğlu who chips it forward to Rutter who heads it on immediately to Hinshelwood whose late arrival with a run gets to the edge of the box, goes down under pressure from Fofana.",
    "Rutter into the center, stabbed away by Chalobah, who's in the middle of the back three, and then it's cleared out on the far side by Wesley Fofana in an immediate front-footed start from Brighton and Hove Albion.",
    "Fernandez was almost playing up alongside Delap in the opening exchanges, which I find quite surprising. At the weekend he was very deep picking things up and knitting passes through the lines.",
    "Brighton are the Premier League's most in-form side outside of Manchester City. They've taken 16 points from their last 21 available. Chelsea, meanwhile, have taken just five points from their last 24. That is some form flip.",
    "Jack Hinshelwood playing a really good game — fires the ball into Groß the captain who clips it high. Mitoma arriving far post, smashes it over the top — but Sánchez comes out and grabs it. Chelsea completely missed the approach of the Japanese international coming down that left hand side.",
  ],

  first_half_post_goal: [
    "Just three minutes on the clock. Brighton in front. Chelsea didn't defend the corner kick at all well.",
    "It was flicked at the near post back into the danger zone, and when it was fired in by Kadıoğlu, it took a little nick off Fofana and went beyond the goalkeeper.",
    "Gotta say — it was a really poor corner and Fofana just put a tepid header on it. A brilliant finish. Kadıoğlu with his first goal for Brighton in a year and a half. And Chelsea's problems continue.",
    "Chelsea have barely left their own half. Nine minutes gone and they've managed one corner — Delap winning it with honest effort down the left before Kadıoğlu's challenge ended the move. That's the summary of their attacking life so far.",
    "Brighton are simply living in Chelsea's half. Rutter gets his head to it, Hinshelwood arrives late — the movement is there, the intent is there. Chalobah clears once, then again. Another corner. The humiliation is quiet and gathering.",
    "Mitoma cuts inside rather than overlapping, Rutter links for Groß, who threatens and withholds. Then the ball finds Minteh, who clips it wide to Mitoma — free at the far post again. Chelsea scramble. Fofana sweeps it away. Six hours and forty-three minutes without a Premier League goal, and the game pressing in.",
    "Chelsea are down to 21% territory — not a statistic, a suffocation. Delap is the only outlet, isolated and starved. Brighton keep shooting, keep pressing, keep finding the dangerous touch. The mathematics of this game are already cruel.",
    "Sánchez gifts it straight to a Brighton shirt — a fumble so alarming that Hinshelwood's shot needs Chalobah to clear it off his own line. Eighteen minutes in, and Chelsea have been saved by their defender rather than their goalkeeper.",
    "Inside the box, it's bowled out by Sánchez up towards Caicedo. Another former player for Brighton. The amount of people that have come from Brighton to Chelsea — it's a little bit ridiculous when you think about it.",
    "On the right hand side, Minteh has it for Brighton, cuts in on his left foot. Chalobah gets his body in between man and ball. Could they pinch it back again? He comes back to Rutter, tries to kill it towards the far post, but he over-opened up his body and it went well wide.",
    "Fofana picks up a yellow card deep in stoppage time — a fitting punctuation mark on a half he'd rather forget. The whistle goes. One-nil, and it flatters Chelsea enormously.",
  ],

  half_time: [
    "Who fancies a game of leap frog? Brighton seem to. If it stays like this, Brighton will jump above Chelsea into sixth place.",
    "That was domination. Absolute domination. Brighton have been brilliant. Absolutely superb.",
    "Karioglu with the goal. I can't really say much about Boscagli other than he might look a bit awkward and uncomfortable — he's got Liam Delap in his pocket right now. Not much to have in your pocket, to be honest.",
    "Chelsea have been so bad. But let's just praise Brighton first of all — that has been an absolute joy to watch. The rotation of the team has been a big handful for Chelsea to deal with. They've not dealt with it.",
    "Rosenior stood at the touchline, shaking his head. Forty-five minutes to save his season. The ground where his playing career ended. Tonight it threatens to take something else from him too.",
    "There has to be a change from Chelsea. You'd imagine Garnacho comes on — his pace offers something they simply haven't had. The shape too may flatten to a back four, to pin back Kadıoğlu who has been marauding all night.",
    "One-nil at half time. xG 0.04 for Chelsea. One shot. None on target. Four touches in the Brighton box. That is a historical set of numbers for a team with these ambitions.",
  ],

  second_half_opening: [
    "Saints have got to try and do this all over again now. Garnacho down the left hand side, speeds into the box, gets the better of Veltman, the ball onto his right foot, comes into the area, tucks it back towards Caicedo — hit by Lavia over the top of the crossbar.",
    "A more threatening start from Chelsea. Yeah — decent effort there by Lavia. He's just moved it to his right and hit it. It dipped, but to be fair, the goalkeeper had no pressure really.",
    "Going back to Fofana being withdrawn — it must be an injury. He was playing magnificently well. And that will help Chelsea. That's probably the best substitution that was made after half time for them. Garnacho on for Fofana — quite fascinating given the little fallout between Fofana and management at the weekend.",
    "Chelsea passing it around in their own half now. Garnacho involved, Fernández finding pockets — a different shape, a different energy. Brighton sit deep and wait. They know what this is.",
    "Matoma down the left, flipping the ball into Rutter who's blown the ball cleanly. He's got Hinshelwood to his left, free in space — Hinshelwood gets it, makes room. Caicedo crumples. Brighton break again.",
    "Good play once again, given away by Caicedo. I'm not sure — normally when Chelsea don't play particularly well, you can at least semi-rely on Caicedo. Not tonight.",
    "He's been really good this season. Mitoma down the left, flipping the ball, almost kept hold of it. Back to Groß edge of the area, makes room for the shot. Instead, gets it to Mitoma — drags it through the six-yard area at an angle. Goes wide with the left hand upright and out for a goal kick.",
  ],

  second_half_goal: [
    "Garnacho from Fernández's ball cut away by Minteh who turns and fires the ball up to Hinshelwood — in towards Rutter who's laid the ball cleanly.",
    "He's got Hinshelwood to his left, free in space, off Caicedo crumpled. It's Hinshelwood to finish it. Yes. He does. Swings the ball home.",
    "Chelsea disillusioned and fractured are crumbling on the South Coast. Brighton get their second deserved lead.",
    "Chelsea complain — they want a handball on the edge of the box, which it did bounce up. The referee said no, but it's led to the goal. VAR had a look. The goal stands. Hinshelwood's finish was clean and calm, swept to the goalkeeper's right.",
    "Seven hours without a goal already behind them. Thirty-four minutes to overturn a two-goal deficit. This is done.",
    "Minteh picks up a yellow card — clumsy challenge, no malice. Brighton can afford the indulgence. Two goals to the good, the game ebbing away from Chelsea with every passing minute.",
    "The pressure sustains — seventy, seventy-seven percent, the numbers cycling like a tide that never quite retreats. Chelsea cannot hold the ball long enough to breathe. Rosenior watches from the touchline, arms folded, jaw set.",
  ],

  second_half_late: [
    "Marc Guiu coming on for Delap in the 73rd minute — Chelsea's third substitution, an admission. The match long since decided, the question now is merely the scoreline.",
    "Brighton are simply passing Chelsea off the pitch. Mitoma reaches the edge of the area, pulls it back to Kadıoğlu, and then it finds Groß — who recycles possession with the unhurried ease of a team that knows time is on its side.",
    "Welbeck is coming on. Danny Welbeck, 35 years old, the man who was given a second life at this club — replacing Rutter in the 83rd minute. The Amex stands to welcome him.",
    "Ayari on for Mitoma too. Brighton rotating, conserving, enjoying it. Chelsea simply exist now, waiting for the whistle, trying to hold on to what little dignity remains.",
    "Eighty-eight minutes gone. Brighton in total control. The Amex is already celebrating. One last chance for the story to write its own final line.",
  ],
};

// ─── Event entries (real Sportmonks data, re-timed) ──────────────────────────
//
// Per-entry `source` mirrors `kairos-bridge.ts::SOURCE`:
//   - match_events  — canonical (goals, cards, subs, transitions)
//   - match_pressure — non-canonical (PRESSURE_UPDATE / ZONE_*)
//
// `data.phase` drives the conductor's monotonic phase FSM (see
// `phase-logic.ts::nextPhaseFromEntryPhase`). Welbeck goal is synthetic —
// the real event lives outside the captured transcription window.

interface EventEntry {
  offsetMs: number;
  source: "match_events" | "match_pressure";
  data: Record<string, unknown>;
}

const EVENTS: Record<string, EventEntry[]> = {
  // PRE-MATCH: no events. In production, RoomConductor.canPushFromSource
  // gates match_events / match_pressure during the warming phase — only
  // transcription (and ambients) reach Kairos. The pre-match window
  // tests enrichment cycles against radio commentary alone, with the
  // narrative_context (match brief) as the semantic backbone.
  pre_match: [],

  first_half: [
    // Early Brighton territory pressure
    {
      offsetMs: 15_000,
      source: "match_pressure",
      data: {
        content: "[PRESSURE] Brighton & Hove Albion (15s): 100% territory",
        eventType: "PRESSURE_UPDATE",
        team: { name: "Brighton & Hove Albion", side: "home" },
        pressure: {
          shots: 0,
          attacks: 1,
          corners: 0,
          dangerousAttacks: 1,
          attackingThirdShare: 1.0,
          phaseDurationSeconds: 15,
        },
        phase: "first_half",
        phaseSecond: 15,
        subjectTime: "0",
      },
    },
    {
      offsetMs: 30_000,
      source: "match_pressure",
      data: {
        content: "[ZONE] Brighton & Hove Albion into attacking third",
        eventType: "ZONE_ENTRY",
        team: { name: "Brighton & Hove Albion", side: "home" },
        phase: "first_half",
        phaseSecond: 30,
        subjectTime: "0",
      },
    },
    // GOAL — Mitoma at +1:30 of condensed first half
    {
      offsetMs: 90_000,
      source: "match_events",
      data: {
        content: "GOAL — Kaoru Mitoma (Brighton & Hove Albion) 1-0",
        eventType: "GOAL",
        kind: "event",
        team: "home",
        teamName: "Brighton & Hove Albion",
        teamShortCode: "BHA",
        phase: "first_half",
        minute: 3,
        phaseSecond: 216,
        player: "Kaoru Mitoma",
        result: "1-0",
        info: "Field Goal",
        subjectTime: "3",
        extraMinute: null,
        sourceId: 156672294,
      },
    },
    // Continued pressure post-goal
    {
      offsetMs: 120_000,
      source: "match_pressure",
      data: {
        content: "[PRESSURE] Brighton & Hove Albion (120s): 82% territory",
        eventType: "PRESSURE_UPDATE",
        team: { name: "Brighton & Hove Albion", side: "home" },
        pressure: {
          shots: 1,
          attacks: 4,
          corners: 2,
          dangerousAttacks: 3,
          attackingThirdShare: 0.82,
          phaseDurationSeconds: 120,
        },
        phase: "first_half",
        phaseSecond: 330,
        subjectTime: "5",
      },
    },
    {
      offsetMs: 180_000,
      source: "match_pressure",
      data: {
        content: "[ZONE] Brighton & Hove Albion into attacking third",
        eventType: "ZONE_ENTRY",
        team: { name: "Brighton & Hove Albion", side: "home" },
        phase: "first_half",
        phaseSecond: 540,
        subjectTime: "9",
      },
    },
    {
      offsetMs: 210_000,
      source: "match_pressure",
      data: {
        content: "[PRESSURE] Brighton & Hove Albion (60s): 100% territory",
        eventType: "PRESSURE_UPDATE",
        team: { name: "Brighton & Hove Albion", side: "home" },
        pressure: {
          shots: 3,
          attacks: 7,
          corners: 4,
          dangerousAttacks: 5,
          attackingThirdShare: 1.0,
          phaseDurationSeconds: 60,
        },
        phase: "first_half",
        phaseSecond: 630,
        subjectTime: "10",
      },
    },
    // Chelsea brief excursion
    {
      offsetMs: 240_000,
      source: "match_pressure",
      data: {
        content: "[ZONE] Chelsea into middle third",
        eventType: "ZONE_MIDDLE",
        team: { name: "Chelsea", side: "away" },
        phase: "first_half",
        phaseSecond: 720,
        subjectTime: "12",
      },
    },
    // Brighton dominance reasserts
    {
      offsetMs: 270_000,
      source: "match_pressure",
      data: {
        content: "[PRESSURE] Brighton & Hove Albion (90s): 78% territory",
        eventType: "PRESSURE_UPDATE",
        team: { name: "Brighton & Hove Albion", side: "home" },
        pressure: {
          shots: 4,
          attacks: 9,
          corners: 5,
          dangerousAttacks: 7,
          attackingThirdShare: 0.78,
          phaseDurationSeconds: 90,
        },
        phase: "first_half",
        phaseSecond: 900,
        subjectTime: "15",
      },
    },
    // YELLOW — Wesley Fofana at end of first half
    {
      offsetMs: 280_000,
      source: "match_events",
      data: {
        content: "YELLOW_CARD — Wesley Fofana (Chelsea)",
        eventType: "YELLOW_CARD",
        kind: "event",
        team: "away",
        teamName: "Chelsea",
        teamShortCode: "CHE",
        phase: "first_half",
        minute: 45,
        phaseSecond: 2757,
        player: "Wesley Fofana",
        subjectTime: "45+1",
        extraMinute: 1,
        sourceId: 156672737,
      },
    },
  ],

  // HALF TIME: no events. In production the runner's gate is closed
  // during halftime — match_events / match_pressure entries are dropped.
  // Transcription continues to flow (UNGATED), and the first transcription
  // line of the halftime pump carries `phase: "halftime"` which drives
  // the conductor's transition into halftime, firing the
  // halftime_reflection generation. The rest of the window is genuinely
  // quiet — improv/gap cycle territory.
  half_time: [],

  second_half: [
    // Halftime substitutions land at the start of the second half. In
    // production Sportmonks observes the lineup change and emits these
    // around minute 46; the runner's gate is open by then because the
    // conductor has transitioned into live_second_half on the first
    // entry carrying phase: "second_half".
    {
      offsetMs: 5_000,
      source: "match_events",
      data: {
        content: "SUBSTITUTION — Alejandro Garnacho (Wesley Fofana) (Chelsea)",
        eventType: "SUBSTITUTION",
        kind: "event",
        team: "away",
        teamName: "Chelsea",
        teamShortCode: "CHE",
        phase: "second_half",
        minute: 46,
        phaseSecond: 5,
        player: "Alejandro Garnacho",
        relatedPlayer: "Wesley Fofana",
        subjectTime: "46",
        extraMinute: null,
        sourceId: 156672990,
      },
    },
    {
      offsetMs: 10_000,
      source: "match_events",
      data: {
        content: "SUBSTITUTION — Joël Veltman (Mats Wieffer) (Brighton & Hove Albion)",
        eventType: "SUBSTITUTION",
        kind: "event",
        team: "home",
        teamName: "Brighton & Hove Albion",
        teamShortCode: "BHA",
        phase: "second_half",
        minute: 46,
        phaseSecond: 10,
        player: "Joël Veltman",
        relatedPlayer: "Mats Wieffer",
        subjectTime: "46",
        extraMinute: null,
        sourceId: 156673001,
      },
    },
    // Chelsea early pressure — Garnacho making an impact
    {
      offsetMs: 25_000,
      source: "match_pressure",
      data: {
        content: "[ZONE] Chelsea into attacking third",
        eventType: "ZONE_ENTRY",
        team: { name: "Chelsea", side: "away" },
        phase: "second_half",
        phaseSecond: 60,
        subjectTime: "47",
      },
    },
    {
      offsetMs: 45_000,
      source: "match_pressure",
      data: {
        content: "[PRESSURE] Chelsea (40s): 58% territory",
        eventType: "PRESSURE_UPDATE",
        team: { name: "Chelsea", side: "away" },
        pressure: {
          shots: 1,
          attacks: 2,
          corners: 0,
          dangerousAttacks: 1,
          attackingThirdShare: 0.58,
          phaseDurationSeconds: 40,
        },
        phase: "second_half",
        phaseSecond: 100,
        subjectTime: "47",
      },
    },
    // Brighton reassert
    {
      offsetMs: 80_000,
      source: "match_pressure",
      data: {
        content: "[ZONE] Brighton & Hove Albion into attacking third",
        eventType: "ZONE_ENTRY",
        team: { name: "Brighton & Hove Albion", side: "home" },
        phase: "second_half",
        phaseSecond: 240,
        subjectTime: "50",
      },
    },
    {
      offsetMs: 100_000,
      source: "match_pressure",
      data: {
        content: "[PRESSURE] Brighton & Hove Albion (60s): 83% territory",
        eventType: "PRESSURE_UPDATE",
        team: { name: "Brighton & Hove Albion", side: "home" },
        pressure: {
          shots: 2,
          attacks: 5,
          corners: 2,
          dangerousAttacks: 4,
          attackingThirdShare: 0.83,
          phaseDurationSeconds: 60,
        },
        phase: "second_half",
        phaseSecond: 360,
        subjectTime: "52",
      },
    },
    // GOAL — Hinshelwood at ~2:00
    {
      offsetMs: 120_000,
      source: "match_events",
      data: {
        content: "GOAL — Jack Hinshelwood (Georginio Rutter) (Brighton & Hove Albion) 2-0",
        eventType: "GOAL",
        kind: "event",
        team: "home",
        teamName: "Brighton & Hove Albion",
        teamShortCode: "BHA",
        phase: "second_half",
        minute: 56,
        phaseSecond: 669,
        player: "Jack Hinshelwood",
        relatedPlayer: "Georginio Rutter",
        result: "2-0",
        info: "Right foot shot",
        subType: "Right foot shot",
        subjectTime: "56",
        extraMinute: null,
        sourceId: 156673200,
      },
    },
    // YELLOW — Minteh
    {
      offsetMs: 210_000,
      source: "match_events",
      data: {
        content: "YELLOW_CARD — Yankuba Minteh (Brighton & Hove Albion)",
        eventType: "YELLOW_CARD",
        kind: "event",
        team: "home",
        teamName: "Brighton & Hove Albion",
        teamShortCode: "BHA",
        phase: "second_half",
        minute: 58,
        phaseSecond: 808,
        player: "Yankuba Minteh",
        subjectTime: "58",
        extraMinute: null,
        sourceId: 156673236,
      },
    },
    // Chelsea sub — Guiu for Delap
    {
      offsetMs: 240_000,
      source: "match_events",
      data: {
        content: "SUBSTITUTION — Marc Guiu (Liam Delap) (Chelsea)",
        eventType: "SUBSTITUTION",
        kind: "event",
        team: "away",
        teamName: "Chelsea",
        teamShortCode: "CHE",
        phase: "second_half",
        minute: 73,
        phaseSecond: 1678,
        player: "Marc Guiu",
        relatedPlayer: "Liam Delap",
        subjectTime: "73",
        extraMinute: null,
        sourceId: 156673497,
      },
    },
    // Brighton sub — Welbeck for Rutter
    {
      offsetMs: 270_000,
      source: "match_events",
      data: {
        content: "SUBSTITUTION — Danny Welbeck (Georginio Rutter) (Brighton & Hove Albion)",
        eventType: "SUBSTITUTION",
        kind: "event",
        team: "home",
        teamName: "Brighton & Hove Albion",
        teamShortCode: "BHA",
        phase: "second_half",
        minute: 83,
        phaseSecond: 2269,
        player: "Danny Welbeck",
        relatedPlayer: "Georginio Rutter",
        subjectTime: "83",
        extraMinute: null,
        sourceId: 156673618,
      },
    },
    // Brighton total control late
    {
      offsetMs: 280_000,
      source: "match_pressure",
      data: {
        content: "[PRESSURE] Brighton & Hove Albion (120s): 92% territory",
        eventType: "PRESSURE_UPDATE",
        team: { name: "Brighton & Hove Albion", side: "home" },
        pressure: {
          shots: 8,
          attacks: 18,
          corners: 9,
          dangerousAttacks: 14,
          attackingThirdShare: 0.92,
          phaseDurationSeconds: 120,
        },
        phase: "second_half",
        phaseSecond: 2200,
        subjectTime: "88",
      },
    },
    // GOAL — Welbeck (synthetic — real goal at 90+1, placed at end of condensed second half)
    {
      offsetMs: 295_000,
      source: "match_events",
      data: {
        content: "GOAL — Danny Welbeck (Brighton & Hove Albion) 3-0",
        eventType: "GOAL",
        kind: "event",
        team: "home",
        teamName: "Brighton & Hove Albion",
        teamShortCode: "BHA",
        phase: "second_half",
        minute: 90,
        phaseSecond: 2745,
        player: "Danny Welbeck",
        result: "3-0",
        info: "Right foot shot",
        subType: "Right foot shot",
        subjectTime: "90+1",
        extraMinute: 1,
        sourceId: 156673673,
      },
    },
  ],

  closing: [
    // Synthetic FULL_TIME entry — mirrors what RoomConductor.transitionTo
    // pushes on a Sportmonks state change (see phase-logic.ts:71-77).
    // Carrying phase: "full_time" trips the conductor into
    // full_time_winddown, which fires the closing_passage generation.
    // The conductor will also push its own duplicate FULL_TIME entry
    // as part of the transition; that's expected in replay (no
    // Sportmonks adapter to drive transitions independently).
    {
      offsetMs: 0,
      source: "match_events",
      data: {
        content: "Full-time whistle.",
        eventType: "FULL_TIME",
        subjectTime: "90",
        phase: "full_time",
        team: null,
        player: null,
        synthetic: true,
      },
    },
  ],
};

// ─── HTTP helpers (mirrors replay-full-stack.ts) ──────────────────────────────

function kairosHeaders(): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  const key = process.env.KAIROS_API_KEY;
  if (key) h["Authorization"] = `Bearer ${key}`;
  return h;
}

async function kairosPost(path: string, body: unknown): Promise<Response> {
  return fetch(`${KAIROS_URL}${path}`, {
    method: "POST",
    headers: kairosHeaders(),
    body: JSON.stringify(body),
  });
}

function blackoutHeaders(): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  const secret = process.env.INTERNAL_API_SECRET;
  if (secret) h["X-Internal-Api-Secret"] = secret;
  return h;
}

async function blackoutPost(path: string, body: unknown): Promise<Response> {
  return fetch(`${BLACKOUT_URL}${path}`, {
    method: "POST",
    headers: blackoutHeaders(),
    body: JSON.stringify(body),
  });
}

async function blackoutPatch(path: string, body: unknown): Promise<Response> {
  return fetch(`${BLACKOUT_URL}${path}`, {
    method: "PATCH",
    headers: blackoutHeaders(),
    body: JSON.stringify(body),
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Entry pump ──────────────────────────────────────────────────────────────

async function pushEntry(
  kairosBroadcastId: string,
  source: string,
  data: Record<string, unknown>,
): Promise<void> {
  const res = await kairosPost(`/broadcasts/${kairosBroadcastId}/entries`, {
    source,
    data,
  });
  if (!res.ok) {
    console.error(`[condensed] push failed: ${res.status} ${await res.text()}`);
  }
}

/**
 * Distil a phase's worth of raw commentary lines and drip the
 * outputs (atmosphere + event_texture) over the phase duration as
 * `match_action` entries. Calls the production distiller code so the
 * regression test exercises the same Haiku prompt that the
 * broadcast-runner uses on a live broadcast.
 *
 * event_claim outputs are deliberately discarded — they're internal
 * calibration signals on the live path; the replay script doesn't
 * have a correlation buffer wired up. event_texture entries are
 * pushed without `parentSourceId` (we'd need the runner-side
 * correlation buffer to attach one) — they still land in the same
 * cycle as their canonical event when timed correctly, which is
 * enough for Sonnet to connect them by adjacency.
 *
 * Distillation runs once at phase start (one Haiku call per phase,
 * ~5 calls per replay run, ~$0.05 total). Outputs drip evenly over
 * the phase to mimic real-time arrival.
 *
 * `phase` is stamped on every entry's data — production's
 * broadcast-runner does the same via getSubjectPhaseAnchor(). Phases not
 * in DATA_PHASE_TO_BROADCAST_PHASE (e.g. "pre_match") are ignored
 * by the conductor, which is the desired outcome for warming-window
 * text.
 */
async function pumpDistilledCommentary(
  kairosBroadcastId: string,
  rawLines: string[],
  phaseDurationMs: number,
  subjectTimeLabel: string,
  phase: string,
): Promise<void> {
  if (rawLines.length === 0) return;

  const distilled = await distillCommentary({
    lines: rawLines,
    subjectTimeAnchor: subjectTimeLabel,
  });

  // Combine atmosphere + event_texture into a single chronological
  // drip. We don't preserve fromLines order strictly because the
  // distiller may reorder during classification; instead emit
  // atmosphere first, then event_texture, in distillation order.
  type DripEntry =
    | { kind: "atmosphere"; content: string }
    | { kind: "event_texture"; content: string; eventClass: string };

  const drip: DripEntry[] = [
    ...distilled.atmosphere.map((a): DripEntry => ({ kind: "atmosphere", content: a.content })),
    ...distilled.eventTexture.map((t): DripEntry => ({
      kind: "event_texture",
      content: t.content,
      eventClass: t.eventHint.eventClass,
    })),
  ];

  console.log(
    `[condensed] [distiller] ${phase}: ${rawLines.length} raw lines → ${distilled.atmosphere.length} atmosphere, ${distilled.eventTexture.length} texture, ${distilled.eventClaim.length} claim(s) (claims discarded — no correlator in replay)`,
  );

  if (drip.length === 0) return;

  const interval = phaseDurationMs / drip.length;
  for (const entry of drip) {
    await sleep(interval);
    const data: Record<string, unknown> = {
      kind: entry.kind,
      content: entry.content,
      subjectTime: subjectTimeLabel,
      phase,
    };
    if (entry.kind === "event_texture") {
      data.eventClass = entry.eventClass;
    }
    await pushEntry(kairosBroadcastId, "match_action", data);
    const label = entry.kind === "event_texture" ? `texture/${entry.eventClass}` : "atmosphere";
    console.log(`  [match_action] ${label}: ${entry.content.slice(0, 80)}`);
  }
}

/**
 * Pump event entries at their specified offsets within a phase.
 * Events fire immediately regardless of transcription drip timing.
 * Runs concurrently with pumpTranscription. Each entry's `source`
 * field selects between match_events (canonical) and match_pressure.
 */
async function pumpEvents(
  kairosBroadcastId: string,
  events: EventEntry[],
): Promise<void> {
  const t0 = Date.now();
  for (const event of events) {
    const wait = event.offsetMs - (Date.now() - t0);
    if (wait > 5) await sleep(wait);
    await pushEntry(kairosBroadcastId, event.source, event.data);
    const label = String(event.data.eventType ?? "entry");
    const content = String(event.data.content ?? "").slice(0, 60);
    console.log(`  [${event.source}] ${label}: ${content}`);
  }
}

/**
 * Run a complete phase: events fire at their offsets while distilled
 * commentary drips concurrently.
 */
async function runPhase(
  kairosBroadcastId: string,
  label: string,
  durationMs: number,
  events: EventEntry[],
  rawCommentaryLines: string[],
  subjectTimeLabel: string,
  phase: string,
): Promise<void> {
  console.log(`\n[condensed] ── ${label} (${durationMs / 1000}s) ──`);
  await Promise.all([
    pumpEvents(kairosBroadcastId, events),
    pumpDistilledCommentary(
      kairosBroadcastId,
      rawCommentaryLines,
      durationMs,
      subjectTimeLabel,
      phase,
    ),
  ]);
  console.log(`[condensed] ${label} complete`);
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("[condensed] Brighton 3-0 Chelsea — condensed regression/demo broadcast");
  console.log(`[condensed] blackout: ${BLACKOUT_URL}  kairos: ${KAIROS_URL}`);
  console.log(
    `[condensed] phases: pre-match ${PHASE.PRE_MATCH_MS / 1000}s | ` +
      `first-half ${PHASE.FIRST_HALF_MS / 1000}s | ` +
      `half-time ${PHASE.HALF_TIME_MS / 1000}s | ` +
      `second-half ${PHASE.SECOND_HALF_MS / 1000}s | ` +
      `closing ${PHASE.CLOSING_MS / 1000}s`,
  );

  // 1. Create the broadcast. matchBrief is seeded into Kairos as
  //    narrative_context by activateBroadcast when the moderator flips
  //    status to live; narrative_voice is seeded from the product
  //    default in the same path.
  const create = await blackoutPost("/broadcasts", {
    homeTeam: "Brighton & Hove Albion",
    awayTeam: "Chelsea",
    competition: "Premier League",
    matchDate: new Date().toISOString(),
    matchBrief: NARRATIVE_CONTEXT,
  });
  if (!create.ok) {
    throw new Error(
      `Broadcast create failed: ${create.status} ${await create.text()}`,
    );
  }
  const blackout = (await create.json()) as {
    id: string;
    kairosBroadcastId: string;
  };
  console.log(`\n[condensed] blackout broadcast: ${blackout.id}`);
  console.log(`[condensed] kairos broadcast:   ${blackout.kairosBroadcastId}`);

  // 2. Override TTS if requested
  if (TTS_VOICE_ID || TTS_PROVIDER) {
    const patch: Record<string, unknown> = {};
    if (TTS_VOICE_ID) patch.ttsVoiceId = TTS_VOICE_ID;
    if (TTS_PROVIDER) patch.ttsProvider = TTS_PROVIDER;
    const vp = await blackoutPatch(`/broadcasts/${blackout.id}`, patch);
    if (!vp.ok) {
      throw new Error(
        `Set TTS voice/provider failed: ${vp.status} ${await vp.text()}`,
      );
    }
    console.log(
      `[condensed] tts: provider=${TTS_PROVIDER ?? "(default)"} voiceId=${TTS_VOICE_ID ?? "(default)"}`,
    );
  }

  // Enable TTS
  const tts = await blackoutPatch(`/broadcasts/${blackout.id}`, {
    ttsEnabled: true,
  });
  if (!tts.ok) {
    throw new Error(`Enable TTS failed: ${tts.status} ${await tts.text()}`);
  }

  // 3. Activate the broadcast.
  //    The moderator UI's schedule path requires a fixtureId + radioSourceId
  //    (collectScheduleBlockers in apps/blackout/server/src/routes/broadcasts.ts);
  //    replay broadcasts deliberately have neither. The HTTP API allows
  //    direct draft → live and the runner soft-fails on the missing
  //    fields (kairos-bridge.ts:154), so the script activates itself.
  //    A 5s delay before the PATCH gives an operator time to open the
  //    matchroom URL printed above.
  const matchroomBase = BLACKOUT_URL.replace(":4000", ":3000");
  console.log(`\n[condensed] broadcast ready — auto-activating in 5s`);
  console.log(`[condensed] ┌─────────────────────────────────────────────────────────`);
  console.log(`[condensed] │  matchroom: ${matchroomBase}/matchroom/${blackout.id}`);
  console.log(`[condensed] │  moderator: ${matchroomBase}/moderator/${blackout.id}`);
  console.log(`[condensed] └─────────────────────────────────────────────────────────`);
  await sleep(5000);

  const activate = await blackoutPatch(`/broadcasts/${blackout.id}`, {
    status: "live",
  });
  if (!activate.ok) {
    throw new Error(`Activate failed: ${activate.status} ${await activate.text()}`);
  }
  console.log(`\n[condensed] ── LIVE — pumping entries ──`);

  // Short delay for conductor to attach to Kairos feed before entries arrive
  await sleep(2000);

  const bid = blackout.kairosBroadcastId;

  // 4. Run phases sequentially. The `phase` argument stamps every
  //    transcription line with data.phase — the conductor's replay-FSM
  //    advances on the first entry it sees with a known phase string.

  // PRE-MATCH — transcription only ("pre_match" is not a recognised
  // FSM phase, so the conductor stays in `warming` throughout).
  await runPhase(
    bid,
    "PRE-MATCH",
    PHASE.PRE_MATCH_MS,
    EVENTS.pre_match,
    TRANSCRIPTION.pre_match,
    "pre_match",
    "pre_match",
  );

  // FIRST HALF — first match_pressure entry at +15s carries
  // phase: "first_half" → conductor transitions to live_first_half,
  // pushes its own canonical KICKOFF entry, and fires the phase cue.
  const firstHalfLines = [
    ...TRANSCRIPTION.first_half_opening,
    ...TRANSCRIPTION.first_half_post_goal,
  ];
  await runPhase(
    bid,
    "FIRST HALF",
    PHASE.FIRST_HALF_MS,
    EVENTS.first_half,
    firstHalfLines,
    "first_half",
    "first_half",
  );

  // HALF TIME — transcription only. The first transcription line
  // carries phase: "halftime", which trips the conductor's transition
  // and fires the halftime_reflection generation.
  await runPhase(
    bid,
    "HALF TIME",
    PHASE.HALF_TIME_MS,
    EVENTS.half_time,
    TRANSCRIPTION.half_time,
    "HT",
    "halftime",
  );

  // SECOND HALF — halftime substitutions land at +5s/+10s, then play
  // resumes. First entry's phase: "second_half" trips the FSM into
  // live_second_half.
  const secondHalfLines = [
    ...TRANSCRIPTION.second_half_opening,
    ...TRANSCRIPTION.second_half_goal,
    ...TRANSCRIPTION.second_half_late,
  ];
  await runPhase(
    bid,
    "SECOND HALF",
    PHASE.SECOND_HALF_MS,
    EVENTS.second_half,
    secondHalfLines,
    "second_half",
    "second_half",
  );

  // CLOSING — synthetic FULL_TIME entry trips the conductor into
  // full_time_winddown, which fires the closing_passage generation.
  // The 30s window lets that passage generate, synthesise, and play.
  await runPhase(
    bid,
    "CLOSING",
    PHASE.CLOSING_MS,
    EVENTS.closing,
    [],
    "full_time",
    "full_time",
  );

  console.log(`\n[condensed] all phases complete.`);
  console.log(
    `[condensed] broadcast ${blackout.id} left LIVE — complete via moderator console when done.`,
  );
  console.log(`[condensed] matchroom: ${matchroomBase}/matchroom/${blackout.id}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
