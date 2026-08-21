import type { LLMClient } from "../../llm/types.js";
import type { ServiceSpec } from "../types.js";
import { BaseEnrichmentService } from "../base-service.js";
import { loadBaselineSections } from "../baseline-loader.js";

interface PatternReading {
  description: string;
  occurrences: number;
  weight: "low" | "moderate" | "high";
  /**
   * Brief entry ids (from the brief content section) that this
   * pattern echoes. Empty when the pattern is purely emergent from
   * live evidence; populated when live evidence resonates with
   * material the writer pre-loaded into narrative_context.
   * ContextCurator's suppression block reads this to detect
   * over-echoing of specific brief fragments across cycles.
   */
  echoesContextEntryIds?: string[];
  [key: string]: unknown;
}

const BASELINE = loadBaselineSections(
  new URL("./patterns-echoes.baseline.md", import.meta.url),
);

const READING_SCHEMA = {
  type: "object",
  properties: {
    description: { type: "string" },
    occurrences: { type: "integer", minimum: 1 },
    weight: { type: "string", enum: ["low", "moderate", "high"] },
    echoesContextEntryIds: {
      type: "array",
      items: { type: "string" },
      description: "Brief entry ids ([id:...] from the # Brief section) this pattern echoes. Empty for purely emergent patterns.",
    },
  },
  required: ["description", "occurrences", "weight"],
  additionalProperties: false,
};

export class PatternsEchoesService extends BaseEnrichmentService<PatternReading> {
  readonly name = "patterns_echoes";

  // No briefInitializationGuidance in baseline.md — patterns_echoes
  // learns purely from live evidence (or from echoes that emerge
  // when live evidence touches the brief). The base class skips
  // brief-init when the field is undefined on the merged baseline.
  constructor(spec: ServiceSpec, llm: LLMClient) {
    super(spec, llm, BASELINE, READING_SCHEMA);
  }

  /**
   * Material when occurrences advance (a new instance of the pattern
   * is itself the news), weight changes category, or the set of brief
   * fragments echoed changes (a new echo claim is itself material).
   * For patterns_echoes, recurrence IS the signal — every fresh
   * occurrence is material until ContextCurator's suppression block
   * decides otherwise.
   */
  protected isMaterialShift(
    prior: { acknowledged: PatternReading | null; expressed: PatternReading | null },
    candidate: PatternReading,
  ): boolean {
    const ref = prior.acknowledged ?? prior.expressed;
    if (!ref) return true;
    if (ref.weight !== candidate.weight) return true;
    if ((ref.occurrences ?? 0) !== (candidate.occurrences ?? 0)) return true;
    const refEchoes = (ref.echoesContextEntryIds ?? []).slice().sort().join("|");
    const candEchoes = (candidate.echoesContextEntryIds ?? []).slice().sort().join("|");
    return refEchoes !== candEchoes;
  }
}
