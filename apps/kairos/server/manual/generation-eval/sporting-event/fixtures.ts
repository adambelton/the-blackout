import type { CurationMode } from "../../../src/curation/types.js";
import type { AssembledEntry } from "../../../src/narrative/types.js";
import type { FeedEntry } from "../../../src/types.js";

/**
 * Curated narrative cycles for the generation eval.
 *
 * Each fixture exercises one prompt-behaviour edge the assembled
 * baseline + v1 sporting_event spec is supposed to enforce. Material
 * is drawn from real broadcasts where possible.
 *
 * Hard expectations are asserted by the runner — they're contracts
 * the assembled prompt must hold. Soft expectations are notes the
 * reviewer reads alongside the actual prose + covers.
 */

export interface Fixture {
  /** Short identifier — used in the runner's output. */
  name: string;
  /** What this fixture is testing in one sentence. */
  describes: string;

  // --- Generator inputs --------------------------------------------------
  voice: string;
  context: string;
  mode: CurationMode;
  /** Feed slice the cycle should narrate. */
  entries: AssembledEntry[];
  /** Canonical events list (the authoritative state record) shown
   * separately in the prompt. Empty array = no canonical preamble. */
  canonicalEvents?: FeedEntry[];
  summary?: string;
  previousPassage?: string;
  targetWords?: number;
  cycleDurationSeconds?: number;

  // --- Expectations ------------------------------------------------------
  hard: {
    /** Prose must NOT match any of these patterns. The cascade
     * patterns: cycle-window meta-commentary ("covering minutes …"),
     * broadcast-apparatus refs ("the commentators say"), telemetry
     * numerals leaking from PRESSURE annotations, fabricated state
     * changes. */
    proseMustNotMatch?: RegExp[];
    /** Prose MUST match each of these patterns. Sparingly — only when
     * the fixture is testing that a specific anchor / event lands. */
    proseMustMatch?: RegExp[];
    /** entryIds that MUST appear in the covers list (cited
     * materially). Use for fixtures with a reportable event in
     * context that the passage is expected to centre on. */
    coversMustInclude?: string[];
    /** entryIds that MUST appear with a non-null charOffset (anchored
     * inline via `{{ref:…}}`). Subset of coversMustInclude. */
    coversMustBeAnchored?: string[];
    /** Maximum prose length in words. Use to assert the targetWords
     * window is approximately honoured. */
    maxWords?: number;
  };
  soft?: {
    notes?: string;
  };
}

const HEMINGWAY_VOICE = [
  "Voice: a literary narrator in the spirit of Hemingway — short, weighted",
  "sentences; concrete nouns; the world observed directly; restraint over",
  "ornament. The narrator stands in the moment with the listener.",
].join("\n");

const FIXTURE_CONTEXT_BRIGHTON_CHELSEA = [
  "Match context: Brighton at home to Chelsea, league fixture, late",
  "March. Brighton sit ninth; Chelsea seventh. Rosenior has steadied",
  "Brighton through a difficult winter. Pochettino's Chelsea remain",
  "uneven away from home.",
].join("\n");

export const FIXTURES: Fixture[] = [
  // ---- action_led — goal arrival -----------------------------------
  {
    name: "action-led-goal",
    describes:
      "Reportable goal in the feed — passage must lead with or arrive at the goal, cite + anchor it, no apparatus references, no cycle-window meta.",
    voice: HEMINGWAY_VOICE,
    context: FIXTURE_CONTEXT_BRIGHTON_CHELSEA,
    mode: "action_led",
    targetWords: 90,
    cycleDurationSeconds: 32,
    entries: [
      {
        entryId: "evt-goal-1",
        source: "sportmonks",
        timestamp: 1714650000000,
        minute: "23",
        subjectTime: "23",
        phase: "live_first_half",
        phaseSecond: 1380,
        content: "GOAL — Welbeck scores for Brighton. (Hinshelwood assist)",
        canonicalSourceId: "sm-evt-9001",
      },
      {
        entryId: "tex-buildup-1",
        source: "radio",
        timestamp: 1714649994000,
        minute: "22+54",
        subjectTime: "22+54",
        phase: "live_first_half",
        phaseSecond: 1374,
        content:
          "Hinshelwood drives down the right, cuts inside, slides it square — Welbeck arriving.",
      },
    ],
    hard: {
      // The general prose contract (no apparatus refs, no cycle-window
      // meta, no telemetry numerals) now lives in the generation spec's
      // `## Eval — hard invariants` and runs against every fixture.
      // Only this fixture's own expectations remain here:
      coversMustInclude: ["evt-goal-1"],
      coversMustBeAnchored: ["evt-goal-1"],
      maxWords: 140,
    },
    soft: {
      notes:
        "Reviewer: does the goal sit at the centre of gravity (lead or arrival), or is it buried as a clause? Hinshelwood as build-up is acceptable colour; Welbeck's strike should not feel incidental.",
    },
  },

  // ---- enrichment_led — pressure phase, no state change -----------
  {
    name: "enrichment-led-pressure",
    describes:
      "PRESSURE telemetry in the feed but no reportable event — passage must render the texture (sustained pressure / siege) without quoting numerals or inventing a state change.",
    voice: HEMINGWAY_VOICE,
    context: FIXTURE_CONTEXT_BRIGHTON_CHELSEA,
    mode: "enrichment_led",
    targetWords: 80,
    cycleDurationSeconds: 32,
    entries: [
      {
        entryId: "tel-pressure-1",
        source: "pressure",
        timestamp: 1714650300000,
        minute: "28",
        subjectTime: "28",
        phase: "live_first_half",
        phaseSecond: 1680,
        content:
          "[PRESSURE] Brighton (45s): 71% territory, 14 attacks, 4 dangerous, 2 shots, 3 corners",
      },
      {
        entryId: "tex-radio-1",
        source: "radio",
        timestamp: 1714650306000,
        minute: "28+06",
        subjectTime: "28+06",
        phase: "live_first_half",
        phaseSecond: 1686,
        content:
          "Brighton are camped in Chelsea's half. Hinshelwood and Estupiñán probing the flanks, March drifting infield.",
      },
    ],
    hard: {
      // Telemetry numerals, apparatus refs and cycle-window meta are in the
      // spec eval. These two are mode-specific to enrichment_led — there's no
      // canonical event this cycle, so an implied or asserted state change
      // would be fabrication:
      proseMustNotMatch: [
        /(may have|finally|will be enough|seems within reach)/i, // implied state change
        /(scored|equalised|booked|sent off)/i, // no state-change verb without a canonical event
      ],
      maxWords: 120,
    },
    soft: {
      notes:
        "Reviewer: is the territorial dominance rendered as texture (a siege, sustained pressure, Chelsea pinned back) rather than reported as metric? Hinshelwood / Estupiñán / March can be named — they appear in the radio line.",
    },
  },

  // ---- context_led — silence cycle --------------------------------
  {
    name: "context-led-silence",
    describes:
      "Nothing happening in play — no reportable event, no telemetry signal. Passage must reach into established context (a thread, an arc, an occasion detail) and write something true; silence is not an option.",
    voice: HEMINGWAY_VOICE,
    context: [
      FIXTURE_CONTEXT_BRIGHTON_CHELSEA,
      "",
      "Threads available: Rosenior's first season; Welbeck's late-career renaissance; the Amex's vocal home end.",
    ].join("\n"),
    mode: "context_led",
    targetWords: 70,
    cycleDurationSeconds: 32,
    entries: [],
    summary:
      "Brighton lead by one through Welbeck. Tempo has dropped through the half-hour; Chelsea passing patiently across the back, Brighton holding shape.",
    hard: {
      // General contract in the spec eval; this one is mode-specific —
      // a silence cycle has no canonical event to justify a state change:
      proseMustNotMatch: [/(scored|equalised|booked|sent off)/i],
      maxWords: 110,
    },
    soft: {
      notes:
        "Reviewer: does the passage reach into the established threads (Rosenior's season, Welbeck's renaissance, the Amex atmosphere) and stay in the present moment? It should not narrate a fresh event, and it should not feel like padding.",
    },
  },
];
