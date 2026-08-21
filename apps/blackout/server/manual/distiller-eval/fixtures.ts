import type { EventClaimClass } from "../../src/lib/distiller.js";

/**
 * Curated commentary chunks for the distiller eval.
 *
 * Each fixture exercises a specific classification edge the distiller
 * is supposed to handle. Phrasing is drawn from real broadcasts where
 * possible (transcription.txt logs from prior live tests).
 *
 * Hard expectations are asserted by the runner — they're contracts
 * the cascade prompt must hold. Soft expectations are notes the
 * reviewer reads alongside the actual output.
 */

export interface Fixture {
  /** Short identifier — used in the runner's output. */
  name: string;
  /** What this fixture is testing in one sentence. */
  describes: string;
  /** Commentary lines as they would arrive from the transcription
   * pipeline. Order matters — the distiller's `fromLine` indices
   * point into this array. */
  lines: string[];
  /** Squad lists for roster discipline. Keep small / relevant to
   * the fixture's player names. */
  homeRoster?: string[];
  awayRoster?: string[];
  homeTeamName?: string;
  awayTeamName?: string;
  /** Match-clock anchor mirroring what the runner would supply
   * (the contentTime around which this chunk landed). */
  contentTimeAnchor?: string;
  /** Recent canonical events context (the runner's last-N canonical
   * stream — distiller uses this to avoid re-claiming). */
  recentCanonicalEvents?: string[];

  /** Hard expectations — runner fails if any is violated.
   *
   * `claimsMustInclude` checks that at least one event_claim with
   * each given class is emitted. `claimsMustNotInclude` checks the
   * inverse (e.g. references shouldn't produce a fresh claim).
   * `atmosphereMustNotContainPhrase` is the cascade's load-bearing
   * rule: atmosphere lines must not name event-class moments. */
  hard: {
    claimsMustInclude?: EventClaimClass[];
    claimsMustNotInclude?: EventClaimClass[];
    atmosphereMustNotContainPhrase?: RegExp[];
  };

  /** Soft expectations — printed for reviewer judgement, not asserted. */
  soft?: {
    notes?: string;
    expectAtmosphereLikely?: boolean;
    expectTextureLikely?: boolean;
  };
}

export const FIXTURES: Fixture[] = [
  // ---- Cascade rule 1: explicit substitution claim ------------------
  {
    name: "substitution-announcement",
    describes:
      "Commentary announcing a substitution as it happens — must produce a SUBSTITUTION claim, never atmosphere.",
    lines: [
      "And here comes the substitution for Forest. Chris Wood is coming on for Awoniyi.",
      "Wood takes the pitch — his hundredth appearance for Forest after six months out.",
    ],
    homeRoster: ["Chris Wood", "Taiwo Awoniyi"],
    awayRoster: [],
    homeTeamName: "Nottingham Forest",
    awayTeamName: "Newcastle",
    contentTimeAnchor: "74",
    hard: {
      claimsMustInclude: ["SUBSTITUTION"],
      atmosphereMustNotContainPhrase: [
        /comes on/i,
        /coming on/i,
        /takes the pitch/i,
      ],
    },
    soft: {
      notes:
        "Texture about Wood's six-months-out / 100th appearance is editorial colour and may go to eventTexture or atmosphere — both acceptable.",
    },
  },

  // ---- Cascade rule 1: goal claim with build-up texture -------------
  {
    name: "goal-claim",
    describes:
      "A goal moment — must produce a GOAL claim. Build-up phrasing is texture, not atmosphere.",
    lines: [
      "Murphy threads through with precision —",
      "and Barnes finishes! GOAL! Newcastle ahead.",
      "Composed finish from the substitute, six minutes after coming on.",
    ],
    homeRoster: [],
    awayRoster: ["Jacob Murphy", "Harvey Barnes"],
    homeTeamName: "Nottingham Forest",
    awayTeamName: "Newcastle",
    contentTimeAnchor: "75",
    hard: {
      claimsMustInclude: ["GOAL"],
      atmosphereMustNotContainPhrase: [/GOAL/, /scored/i, /finishes/i],
    },
    soft: {
      expectTextureLikely: true,
      notes: "Murphy's threaded pass is build-up texture for the goal claim.",
    },
  },

  // ---- Cascade rule 1: yellow card ----------------------------------
  {
    name: "yellow-card",
    describes:
      "A booking — must produce a YELLOW_CARD claim.",
    lines: [
      "Jesus catches him late. The referee is straight to the pocket.",
      "Yellow for Igor Jesus — and he can have no complaints.",
    ],
    homeRoster: ["Igor Jesus"],
    awayRoster: [],
    homeTeamName: "Nottingham Forest",
    awayTeamName: "Newcastle",
    contentTimeAnchor: "49",
    hard: {
      claimsMustInclude: ["YELLOW_CARD"],
      atmosphereMustNotContainPhrase: [/yellow/i, /booked/i, /booking/i],
    },
  },

  // ---- Cascade rule 2: reference back, no fresh claim ---------------
  {
    name: "goal-reference-no-claim",
    describes:
      "Commentary referring back to an earlier goal — must NOT emit a new GOAL claim.",
    lines: [
      "Forest, who fell behind to Anderson's equaliser earlier in the second half, push forward again.",
      "His goal at eighty-eight was the moment of the match.",
    ],
    homeRoster: ["Elliot Anderson"],
    awayRoster: [],
    homeTeamName: "Nottingham Forest",
    awayTeamName: "Newcastle",
    contentTimeAnchor: "92",
    recentCanonicalEvents: [
      "GOAL (Anderson) @88",
    ],
    hard: {
      claimsMustNotInclude: ["GOAL"],
    },
    soft: {
      notes:
        "May produce eventTexture anchored on the earlier GOAL or atmosphere about Forest's late push. Neither should re-claim.",
    },
  },

  // ---- Cascade rule 2: substitute reference, no fresh claim ---------
  {
    name: "substitute-reference-no-claim",
    describes:
      "Reference to an earlier substitute — must NOT emit a new SUBSTITUTION claim.",
    lines: [
      "Trippier, the substitute who came on at sixty-one, drives forward with the ball.",
    ],
    homeRoster: [],
    awayRoster: ["Kieran Trippier"],
    homeTeamName: "Nottingham Forest",
    awayTeamName: "Newcastle",
    contentTimeAnchor: "78",
    recentCanonicalEvents: [
      "SUBSTITUTION (Trippier) @61",
    ],
    hard: {
      claimsMustNotInclude: ["SUBSTITUTION"],
    },
  },

  // ---- Cascade rule 3: pure build-up texture ------------------------
  {
    name: "buildup-texture",
    describes:
      "Build-up to a canonical event — texture only, no announcement to claim.",
    lines: [
      "Bruno drops between the centre-halves, picks his pass.",
      "Hall takes it down the line, looks up, swings it across the box.",
      "Pope claims it under pressure.",
    ],
    homeRoster: ["Nick Pope"],
    awayRoster: ["Bruno Guimarães", "Lewis Hall"],
    homeTeamName: "Nottingham Forest",
    awayTeamName: "Newcastle",
    contentTimeAnchor: "23",
    hard: {
      // No canonical event happens here — this is mid-phase build-up.
      // Should NOT emit any event claim.
      claimsMustNotInclude: [
        "GOAL",
        "YELLOW_CARD",
        "SUBSTITUTION",
        "RED_CARD",
        "PENALTY_AWARDED",
      ],
    },
    soft: {
      expectAtmosphereLikely: true,
      notes:
        "Mid-phase build-up with no event endpoint — atmosphere is the right home. Texture only fits if a canonical event endpoint is visible.",
    },
  },

  // ---- Cascade rule 4: pure ambient atmosphere ----------------------
  {
    name: "ambient-atmosphere",
    describes: "Crowd / manager body language with no event tied to it.",
    lines: [
      "The City Ground is in full voice. Pereira gestures from the touchline.",
      "Banners along the Trent End — three days since Villa Park, the crowd hasn't forgotten.",
    ],
    homeRoster: [],
    awayRoster: [],
    contentTimeAnchor: "31",
    hard: {
      claimsMustNotInclude: [
        "GOAL",
        "YELLOW_CARD",
        "SUBSTITUTION",
        "RED_CARD",
        "PENALTY_AWARDED",
        "VAR_CHECK",
      ],
    },
    soft: {
      expectAtmosphereLikely: true,
    },
  },

  // ---- Phase whistle claim ------------------------------------------
  {
    name: "halftime-whistle",
    describes: "Halftime whistle — must produce HALFTIME claim.",
    lines: [
      "And the whistle goes for half-time. Goalless at the break.",
    ],
    contentTimeAnchor: "45+2",
    hard: {
      claimsMustInclude: ["HALFTIME"],
      atmosphereMustNotContainPhrase: [/half-time whistle/i, /whistle goes/i],
    },
  },

  // ---- Penalty awarded ----------------------------------------------
  {
    name: "penalty-awarded",
    describes: "A penalty is awarded — must produce PENALTY_AWARDED claim.",
    lines: [
      "He goes down in the box — and the referee points to the spot.",
      "Penalty to Newcastle.",
    ],
    homeRoster: [],
    awayRoster: [],
    contentTimeAnchor: "62",
    hard: {
      claimsMustInclude: ["PENALTY_AWARDED"],
      atmosphereMustNotContainPhrase: [/penalty/i, /points to the spot/i],
    },
  },

  // ---- Roster discipline (out-of-roster names dropped) --------------
  {
    name: "out-of-roster-name",
    describes:
      "A player name that doesn't match either roster must be dropped or de-named — not propagated.",
    lines: [
      "Walter Bader drives forward with the ball, looks for an outlet.",
    ],
    homeRoster: ["Bruno Guimarães", "Lewis Hall"],
    awayRoster: ["Nick Pope", "Dan Burn"],
    homeTeamName: "Nottingham Forest",
    awayTeamName: "Newcastle",
    contentTimeAnchor: "44",
    hard: {
      // The fictional name "Walter Bader" must not appear in any
      // output content. Distiller's roster discipline should either
      // drop the line or rewrite it without the name.
      atmosphereMustNotContainPhrase: [/Walter Bader/i],
    },
    soft: {
      notes:
        "This is the 2026-05-10 'Walter Bader' regression class — roster discipline should catch it. The line may also be dropped entirely, which is fine.",
    },
  },
];
