import type { LLMClient } from "../../llm/types.js";
import type { ServiceSpec } from "../types.js";
import { BaseEnrichmentService } from "../base-service.js";
import { loadBaselineSections } from "../baseline-loader.js";

interface MomentumReading {
  direction: "rising" | "stable" | "falling";
  intensity: "dormant" | "low" | "moderate" | "high" | "peak";
  [key: string]: unknown;
}

const INTENSITY_ORDER: MomentumReading["intensity"][] = ["dormant", "low", "moderate", "high", "peak"];

/** Baseline prose lifted from in-code constants to
 * `momentum.baseline.md` in K6.3. Loaded once at module init.
 * Profile elaboration (sport-flavoured examples) lives in the
 * `momentum` service-spec for the active profile; assembly
 * interleaves the two via matching `## Section` headers. */
const BASELINE = loadBaselineSections(
  new URL("./momentum.baseline.md", import.meta.url),
);

const READING_SCHEMA = {
  type: "object",
  properties: {
    direction: { type: "string", enum: ["rising", "stable", "falling"] },
    intensity: { type: "string", enum: ["dormant", "low", "moderate", "high", "peak"] },
  },
  required: ["direction", "intensity"],
  additionalProperties: false,
};

export class MomentumService extends BaseEnrichmentService<MomentumReading> {
  readonly name = "momentum";

  constructor(spec: ServiceSpec, llm: LLMClient) {
    super(spec, llm, BASELINE, READING_SCHEMA);
  }

  /**
   * Material when direction changes OR intensity moves by ≥ 2 steps.
   * A single intensity step within the same direction is drift, not
   * a meaningful momentum shift. First appearance is always material.
   */
  protected isMaterialShift(
    prior: { acknowledged: MomentumReading | null; expressed: MomentumReading | null },
    candidate: MomentumReading,
  ): boolean {
    const ref = prior.acknowledged ?? prior.expressed;
    if (!ref) return true;
    if (ref.direction !== candidate.direction) return true;
    const priorIdx = INTENSITY_ORDER.indexOf(ref.intensity);
    const candIdx = INTENSITY_ORDER.indexOf(candidate.intensity);
    if (priorIdx === -1 || candIdx === -1) return true;
    return Math.abs(candIdx - priorIdx) >= 2;
  }
}
