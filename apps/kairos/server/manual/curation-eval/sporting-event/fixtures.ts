import type { EnrichmentAnnotation } from "../../../src/enrichment/types.js";
import type { EnrichedPayload } from "../../../src/enrichment/types.js";
import type { CurationContext } from "../../../src/curation/types.js";
import type { FeedEntry } from "../../../src/types.js";

/**
 * One representative curated cycle for the curation eval: an
 * `EnrichedPayload` (the cycle's entries + the enrichment annotations they
 * produced) plus a base `CurationContext` with the tier-1 runtime fields
 * pre-set, so each curation service can be run in isolation against
 * controlled inputs.
 *
 * The runner runs each service against a *fresh clone* of `baseContext()`
 * and shows the field(s) it writes, alongside its `## Eval — soft notes`.
 * Curation output is structured judgment, so the only pass/fail checks are
 * the few genuinely machine-checkable rules (priority's canonical
 * protection + emphasis budget, conflict_resolver's winner ≠ loser,
 * saturation's default-empty) — wired in the runner.
 */

const TS = 1714650000000;
const MIN_23 = 23 * 60 * 1000;

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

function entry(id: string, sourceName: string, canonical: boolean, content: string, subjectTime: string, data?: Record<string, unknown>): FeedEntry {
  return {
    id,
    broadcastId: "fixture-broadcast",
    sourceId: `${sourceName}-source`,
    sourceName,
    sourceType: canonical ? "event" : "moderator",
    sourceCanonical: canonical,
    timestamp: TS + MIN_23,
    data: { content, subjectTime, ...data },
    enrichmentTags: [],
  };
}

const NARRATIVE_CONTEXT: FeedEntry[] = [
  brief("ctx-rosenior", "Rosenior's first full season at Brighton — a patient rebuild, shape over flash. Can this side protect a lead once it has one?"),
  brief("ctx-welbeck", "Welbeck, 33, in a late-career renaissance after years of injuries — leading the line again."),
  brief("ctx-stakes", "Brighton chasing Europe; a win lifts them above Chelsea in the table."),
  brief("ctx-amex", "The Amex's vocal home end — loudest when Brighton press high."),
];

/** Human-readable brief, for ContextCurator.initializeFromBrief. */
export const BRIEF = NARRATIVE_CONTEXT.map((c) => `[id:${c.id}] ${(c.data as { content: string }).content}`).join("\n");

const ENTRIES: FeedEntry[] = [
  entry("tel-pressure-1", "pressure", false, "[PRESSURE] Brighton (45s): 71% territory, 14 attacks, 2 shots, 3 corners", "22"),
  entry("tex-buildup-1", "radio", false, "Hinshelwood drives down the right, cuts inside, slides it square — Welbeck arriving to finish.", "22+54"),
  entry("evt-goal-1", "sportmonks", true, "GOAL — Welbeck scores for Brighton (Hinshelwood assist)", "23", { eventClass: "GOAL", player: "Welbeck" }),
  entry("tex-touchline-1", "radio", false, "Rosenior, on the touchline, allows himself a single closed fist. Composure.", "23+10"),
];

/** Canonical entry ids — priority must never remove these. */
export const CANONICAL_ENTRY_IDS = ENTRIES.filter((e) => e.sourceCanonical).map((e) => e.id);

const ANNOTATIONS: EnrichmentAnnotation[] = [
  {
    serviceName: "momentum",
    subjectId: "subj-brighton",
    subjectLabel: "Brighton",
    meaning: {
      expressed: null,
      unexpressed: { direction: "rising", intensity: "high" },
      acknowledged: null,
      basis: "Sustained early pressure crowned by Welbeck's goal.",
    },
    informedBy: ["tel-pressure-1", "evt-goal-1"],
  },
  {
    serviceName: "themes",
    subjectId: "subj-welbeck-renaissance",
    subjectLabel: "Welbeck's late-career renaissance",
    meaning: {
      expressed: null,
      unexpressed: { description: "A striker tested by injury delivering in the moments that matter.", weight: "high", status: "emerging" },
      acknowledged: null,
      basis: "Welbeck arrives to finish a worked move.",
    },
    informedBy: ["evt-goal-1"],
  },
  {
    serviceName: "character_arcs",
    subjectId: "subj-welbeck",
    subjectLabel: "Danny Welbeck",
    meaning: {
      expressed: null,
      unexpressed: { role: "leading man", trajectory: "ascending", stakePosition: "high", currentState: "Converts Hinshelwood's assist for Brighton's opener." },
      acknowledged: null,
      basis: "Welbeck's finish puts Brighton ahead.",
    },
    informedBy: ["tex-buildup-1", "evt-goal-1"],
  },
];

export const PAYLOAD: EnrichedPayload = {
  broadcastId: "fixture-broadcast",
  entries: ENTRIES,
  annotations: ANNOTATIONS,
  fromTimestamp: TS + MIN_23 - 60_000,
  toTimestamp: TS + MIN_23,
  narrativeContext: NARRATIVE_CONTEXT,
};

/** Fresh base context — tier-1 fields pre-set so tier-2+ services have
 * realistic inputs. Clone per service so runs don't bleed into each other. */
export function baseContext(): CurationContext {
  return {
    selectedEntries: [...ENTRIES],
    selectedAnnotations: [...ANNOTATIONS],
    decisions: {},
    conflicts: [],
    mode: "action_led",
    triggerReason: "accumulation",
    pacing: { recommendedWordCount: 90, cadenceMs: 32_000 },
    maxContextTokens: 8_000,
    elapsedMs: MIN_23,
    estimatedWpm: 150,
    cycleIntervalMs: 32_000,
    serviceLastSurfacedAt: {
      momentum: TS + MIN_23 - 5 * 60_000,
      themes: null,
      character_arcs: null,
      tension_conflict: null,
      character_relationships: null,
      patterns_echoes: null,
    },
    recentCycles: [],
    arcPhase: "rising",
    urgentSubjects: [],
  };
}
