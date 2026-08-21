import type { CurationMode } from "../../../src/curation/types.js";
import type { ContentPoolItem } from "../../../src/db/pool.js";
import type { AssembledEntry } from "../../../src/narrative/types.js";

/**
 * Curated imagery-selection cycles for the imagery eval.
 *
 * Each fixture exercises one selection edge the assembled baseline
 * + v1 sporting_event imagery spec is supposed to enforce.
 *
 * Hard expectations are asserted by the runner — they're contracts
 * the assembled prompt must hold. Soft expectations are notes the
 * reviewer reads alongside the actual decision + rationale.
 */

export interface Fixture {
  name: string;
  describes: string;

  mode: CurationMode;
  /** The cycle's curated entries — what the narrator will work
   * with. Imagery sees the same material. */
  entries: AssembledEntry[];
  summary: string;
  previousImageryRationale: string;
  poolItems: ContentPoolItem[];
  imageryEnabled?: boolean;

  hard: {
    /** Decision MUST be one of these values. */
    decisionMustBeOneOf: ReadonlyArray<"pool" | "generate" | "hold">;
    /** The fresh-generate prompt, if produced, must NOT match these
     * patterns. Covers: written-text references (scoreboards, logos,
     * captions), spoiler language beyond the passage, named badges. */
    promptMustNotMatch?: RegExp[];
    /** Maximum word count for the fresh-generate prompt. */
    promptMaxWords?: number;
    /** When decision must be `pool`, the chosen pool item id must be
     * in this allow-list (the pool items the fixture deems acceptable). */
    poolItemIdMustBeOneOf?: string[];
  };
  soft?: {
    notes?: string;
  };
}

const TS_KICKOFF = 1714650000000;

export const FIXTURES: Fixture[] = [
  // ---- empty pool — action-led goal — must generate ----------------
  {
    name: "empty-pool-goal",
    describes:
      "Action-led cycle with a goal in feed, pool empty — decision must be `generate`, prompt must depict the goal moment or its immediate aftermath, no written-text references, no spoiler beyond the passage.",
    mode: "action_led",
    entries: [
      {
        entryId: "evt-goal-1",
        source: "sportmonks",
        timestamp: TS_KICKOFF,
        minute: "23",
        subjectTime: "23",
        phase: "live_first_half",
        phaseSecond: 1380,
        content: "GOAL — Welbeck scores for Brighton.",
        canonicalSourceId: "sm-evt-9001",
      },
    ],
    summary:
      "Brighton on top through the first quarter, working the Chelsea back line. The Amex has been steady throughout.",
    previousImageryRationale:
      "wide stadium shot, overcast late-afternoon light, the away end visible",
    poolItems: [],
    hard: {
      // The general image-prompt contract (no in-frame text, no spoiler
      // language, no broadcast apparatus) now lives in the imagery spec's
      // `## Eval — hard invariants` and runs against every generate prompt.
      // Per-fixture expectations only here:
      decisionMustBeOneOf: ["generate"],
      promptMaxWords: 40,
    },
    soft: {
      notes:
        "Reviewer: does the prompt centre on the goal act itself (the strike, the keeper, the rush toward the corner flag) or its immediate aftermath, with mood and light? Welbeck may be named.",
    },
  },

  // ---- populated pool — strong match — should pick -----------------
  {
    name: "pool-match-pressure",
    describes:
      "Enrichment-led pressure phase, pool contains a clear thematic match — decision should be `pool` (don't stretch a loose match, but a clear fit should win over generate).",
    mode: "enrichment_led",
    entries: [
      {
        entryId: "tel-pressure-1",
        source: "pressure",
        timestamp: TS_KICKOFF + 5 * 60 * 1000,
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
        timestamp: TS_KICKOFF + 5 * 60 * 1000 + 6000,
        minute: "28+06",
        subjectTime: "28+06",
        phase: "live_first_half",
        phaseSecond: 1686,
        content: "Brighton are camped in Chelsea's half — sustained pressure.",
      },
    ],
    summary: "Brighton lead by one. Chelsea pinned back through this passage.",
    previousImageryRationale:
      "close on the Brighton dugout, Rosenior leaning on the touchline rail, watchful",
    poolItems: [
      {
        id: "pool-pressure-1",
        broadcastId: "fixture-broadcast",
        prompt:
          "sustained attacking pressure in an opponent's third, players in blue and white pushing forward, away defenders compressed inside their own penalty area",
        tags: ["pressure", "siege", "attacking-third", "tension"],
        consumerMetadata: null,
        createdAt: TS_KICKOFF,
      },
      {
        id: "pool-tunnel-1",
        broadcastId: "fixture-broadcast",
        prompt: "tunnel before kickoff, players in single file, lit from above",
        tags: ["tunnel", "pre-match", "quiet"],
        consumerMetadata: null,
        createdAt: TS_KICKOFF,
      },
    ],
    hard: {
      decisionMustBeOneOf: ["pool", "generate"],
      // Don't force pool — the model is judgement-led. But if it
      // does go pool, only the pressure-tagged item should be chosen.
      poolItemIdMustBeOneOf: ["pool-pressure-1"],
    },
    soft: {
      notes:
        "Reviewer: was the pool-pressure-1 match strong enough? If the model chose generate, did the prompt describe a different angle (still pressure, but a fresh shot)? The tunnel item must never be picked here — that's a misfit.",
    },
  },

  // ---- imageryEnabled=false short-circuit --------------------------
  {
    name: "imagery-disabled-short-circuit",
    describes:
      "imageryEnabled=false must short-circuit without an LLM call — decision must be `hold` with the cost-gate rationale.",
    mode: "action_led",
    entries: [
      {
        entryId: "evt-goal-1",
        source: "sportmonks",
        timestamp: TS_KICKOFF,
        minute: "23",
        subjectTime: "23",
        phase: "live_first_half",
        phaseSecond: 1380,
        content: "GOAL — Welbeck scores for Brighton.",
      },
    ],
    summary: "Brighton on top.",
    previousImageryRationale: "wide stadium shot",
    poolItems: [],
    imageryEnabled: false,
    hard: {
      decisionMustBeOneOf: ["hold"],
    },
    soft: {
      notes:
        "Reviewer: no Anthropic call should be made for this fixture. The runner should report cost ~0 for this row.",
    },
  },
];
