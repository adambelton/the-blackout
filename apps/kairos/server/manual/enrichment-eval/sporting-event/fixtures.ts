import type { FeedChunk } from "../../../src/enrichment/types.js";
import type { FeedEntry } from "../../../src/types.js";

/**
 * A representative mid-match cycle for the enrichment eval: one `FeedChunk`
 * plus the writer's brief (`narrativeContext`). Each enrichment service
 * reads the same material through its own lens; the runner prints what each
 * surfaces alongside that service's `## Eval — soft notes` for review.
 *
 * Enrichment output is structured judgment, not prose — so there are no hard
 * regex invariants here. This is a reviewer harness: it makes each service's
 * reading legible against the contract its soft notes describe.
 */

const TS = 1714650000000;

function brief(id: string, content: string): FeedEntry {
  return {
    id,
    broadcastId: "fixture-broadcast",
    sourceId: "brief",
    sourceName: "brief",
    sourceType: "narrative_context",
    sourceCanonical: false,
    timestamp: TS,
    data: { content },
    enrichmentTags: [],
  };
}

function entry(args: {
  id: string;
  sourceName: string;
  canonical: boolean;
  content: string;
  subjectTime: string;
  tOffset: number;
  data?: Record<string, unknown>;
}): FeedEntry {
  return {
    id: args.id,
    broadcastId: "fixture-broadcast",
    sourceId: `${args.sourceName}-source`,
    sourceName: args.sourceName,
    sourceType: args.canonical ? "event" : "moderator",
    sourceCanonical: args.canonical,
    timestamp: TS + args.tOffset,
    data: { content: args.content, subjectTime: args.subjectTime, ...args.data },
    enrichmentTags: [
      "momentum",
      "tension_conflict",
      "themes",
      "character_arcs",
      "character_relationships",
      "patterns_echoes",
    ],
  };
}

/** Brighton 1-0 Chelsea, ~23'. Welbeck has just scored from a Hinshelwood
 * assist after a sustained Brighton spell; Rosenior stays composed. The brief
 * carries the season-long threads the live moment now touches. */
export const CHUNK: FeedChunk = {
  broadcastId: "fixture-broadcast",
  fromTimestamp: TS,
  toTimestamp: TS + 60_000,
  narrativeContext: [
    brief(
      "ctx-rosenior",
      "Rosenior's first full season at Brighton — a patient rebuild, shape over flash. The winter-long question: can this side protect a lead once it has one?",
    ),
    brief(
      "ctx-welbeck",
      "Welbeck, 33, in a late-career renaissance after years of injuries — leading the line again, defying his body.",
    ),
    brief(
      "ctx-stakes",
      "Brighton are chasing Europe; Chelsea remain uneven away from home. A win lifts Brighton above them in the table.",
    ),
    brief(
      "ctx-amex",
      "The Amex's vocal home end — at its loudest when Brighton press high.",
    ),
  ],
  entries: [
    entry({
      id: "tel-pressure-1",
      sourceName: "pressure",
      canonical: false,
      content: "[PRESSURE] Brighton (45s): 71% territory, 14 attacks, 2 shots, 3 corners",
      subjectTime: "22",
      tOffset: 0,
    }),
    entry({
      id: "tex-buildup-1",
      sourceName: "radio",
      canonical: false,
      content: "Hinshelwood drives down the right, cuts inside, slides it square — Welbeck arriving to finish.",
      subjectTime: "22+54",
      tOffset: 54_000,
    }),
    entry({
      id: "evt-goal-1",
      sourceName: "sportmonks",
      canonical: true,
      content: "GOAL — Welbeck scores for Brighton (Hinshelwood assist)",
      subjectTime: "23",
      tOffset: 60_000,
      data: { eventClass: "GOAL", player: "Welbeck" },
    }),
    entry({
      id: "tex-touchline-1",
      sourceName: "radio",
      canonical: false,
      content: "Rosenior, on the touchline, allows himself a single closed fist. Composure.",
      subjectTime: "23+10",
      tOffset: 70_000,
    }),
  ],
};
