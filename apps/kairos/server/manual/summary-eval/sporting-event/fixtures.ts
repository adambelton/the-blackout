import type { FeedEntry } from "../../../src/types.js";

/**
 * Curated running-summary updates for the summary eval.
 *
 * Each fixture exercises one note-update edge the assembled baseline
 * + v1 sporting_event summary spec is supposed to enforce.
 *
 * Hard expectations are asserted by the runner — they're contracts
 * the assembled prompt must hold. Soft expectations are notes the
 * reviewer reads alongside the actual updated note.
 */

export interface Fixture {
  name: string;
  describes: string;

  previousNarrative: string;
  justNarrated: string;
  newEntries: FeedEntry[];

  hard: {
    /** Note word count must be at or below this. */
    maxWords: number;
    /** Note must NOT match any of these patterns. Covers: scoreline
     * strings, scorer / card / sub names from canonical events,
     * meta-commentary about the broadcast or the narrator. */
    mustNotMatch?: RegExp[];
    /** Note MUST match each of these patterns — use sparingly, only
     * when a specific motif / thread carry is the point of the test. */
    mustMatch?: RegExp[];
  };
  soft?: {
    notes?: string;
  };
}

const TS = 1714650000000;

function radioEntry(content: string, tOffset: number): FeedEntry {
  return {
    id: `radio-${tOffset}`,
    broadcastId: "fixture-broadcast",
    sourceId: "radio-source",
    sourceName: "radio",
    sourceType: "moderator",
    sourceCanonical: false,
    timestamp: TS + tOffset,
    data: { content, subjectTime: `${Math.floor(tOffset / 60000)}` },
    enrichmentTags: [],
  };
}

function canonicalGoal(player: string, minute: string, tOffset: number): FeedEntry {
  return {
    id: `goal-${tOffset}`,
    broadcastId: "fixture-broadcast",
    sourceId: "sm-evt-9001",
    sourceName: "sportmonks",
    sourceType: "event",
    sourceCanonical: true,
    timestamp: TS + tOffset,
    data: { eventClass: "GOAL", player, subjectTime: minute, content: `GOAL — ${player}` },
    enrichmentTags: [],
  };
}

export const FIXTURES: Fixture[] = [
  // ---- opening cycle ------------------------------------------------
  {
    name: "opening-cycle",
    describes:
      "First passage of the broadcast — previousNarrative empty. Note must establish arc + motif + tone, stay under 100 words, no meta.",
    previousNarrative: "",
    justNarrated:
      "Brighton arrive at the Amex on a grey March afternoon — wind off the sea, the home end already on its feet. Welbeck leads the line; Rosenior tucks Hinshelwood into the right of midfield. Chelsea come settled, holding their shape across the centre circle as the whistle goes.",
    newEntries: [
      radioEntry("Kickoff. Brighton getting first touch.", 0),
      radioEntry("Welbeck looks lively early — chasing a loose ball into the channel.", 60000),
    ],
    hard: {
      maxWords: 100,
      // Meta-commentary + scoreline bans now live in the summary spec eval;
      // only this fixture's own ban remains:
      mustNotMatch: [/\bkickoff\s+goal\b/i],
    },
    soft: {
      notes:
        "Reviewer: does the note set up the broadcast's arc direction (settling in) + carry the wind/sea + home-end motifs + Welbeck-leading-line thread?",
    },
  },

  // ---- post-goal carry ----------------------------------------------
  {
    name: "post-goal-carry",
    describes:
      "Note BEFORE was about Brighton's early dominance; passage just narrated includes Welbeck's goal. Note must carry the arc forward — but must NOT restate the score, name Welbeck-as-scorer, or list the goal as state. The templated block owns state.",
    previousNarrative:
      "Brighton have started on top — sustained pressure through the opening quarter, Hinshelwood and Estupiñán doubling up on the right, the Amex loud behind them. Chelsea waiting for an opening that hasn't come. The arc rising; the home side searching for a first.",
    justNarrated:
      "And Welbeck arrives. Hinshelwood drives down the right, cuts inside, slides it square — Welbeck finishes, low and clean. The Amex erupts. Rosenior, on the touchline, allows himself a single closed fist. Half-an-hour gone, and Brighton lead.",
    newEntries: [
      canonicalGoal("Welbeck", "23", 23 * 60 * 1000),
      radioEntry("Rosenior raises a fist — barely. Composure.", 23 * 60 * 1000 + 8000),
    ],
    hard: {
      maxWords: 100,
      // The general note contract (scoreline strings, generic scorer+minute,
      // meta-commentary) is in the summary spec eval. Only the
      // fixture-specific scorer names remain:
      mustNotMatch: [/\b(Welbeck|Hinshelwood)\s+(at|on)\s+\d{1,2}\b/i],
    },
    soft: {
      notes:
        "Reviewer: does the note carry the arc (the moment has landed; the texture is settled), the Rosenior-touchline thread, the rising-Amex motif? Welbeck can be named when serving arc carry ('Welbeck's finish the payoff') — that's character, not state-listing. The line we're holding: no scoreline strings, no scorer+minute pairs.",
    },
  },

  // ---- context_led — silence ---------------------------------------
  {
    name: "context-led-silence",
    describes:
      "Quiet cycle — no new entries, passage drew from established threads. Note must carry threads forward; no meta about silence.",
    previousNarrative:
      "Brighton lead by one. The tempo has dropped through the half-hour; Chelsea passing patiently across the back. Rosenior watchful, the Amex still vocal. Arc has flattened from rise into hold.",
    justNarrated:
      "Rosenior watches from the rail, hands behind his back. Two seasons on the south coast, and this is the shape he's been building toward — patience with the ball, shape without it. The wind has stilled. The home end carries the silence between phases.",
    newEntries: [],
    hard: {
      // All of this fixture's bans (meta, scoreline, "silence cycle",
      // "nothing happened") now live in the summary spec eval.
      maxWords: 100,
    },
    soft: {
      notes:
        "Reviewer: does the note carry the Rosenior-arc thread + the held tempo + the home-end motif into the next cycle, in the writer's voice?",
    },
  },
];
