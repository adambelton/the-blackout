import type { LLMClient } from "../../llm/types.js";
import type { ServiceSpec } from "../types.js";
import { BaseEnrichmentService } from "../base-service.js";
import { loadBaselineSections } from "../baseline-loader.js";

interface CharacterArcReading {
  role: string;
  trajectory: "ascending" | "descending" | "pivoting" | "holding";
  stakePosition: "low" | "moderate" | "high";
  currentState: string;
  [key: string]: unknown;
}

const BASELINE = loadBaselineSections(
  new URL("./character-arcs.baseline.md", import.meta.url),
);

const READING_SCHEMA = {
  type: "object",
  properties: {
    role: { type: "string" },
    trajectory: { type: "string", enum: ["ascending", "descending", "pivoting", "holding"] },
    stakePosition: { type: "string", enum: ["low", "moderate", "high"] },
    currentState: { type: "string" },
  },
  required: ["role", "trajectory", "stakePosition", "currentState"],
  additionalProperties: false,
};

export class CharacterArcsService extends BaseEnrichmentService<CharacterArcReading> {
  readonly name = "character_arcs";

  constructor(spec: ServiceSpec, llm: LLMClient) {
    super(spec, llm, BASELINE, READING_SCHEMA);
  }

  /**
   * Material when role, trajectory, or stakePosition changes. A
   * character continuing the same trajectory in the same role with
   * the same stake on the line is not new information — currentState
   * text drift alone is not material.
   */
  protected isMaterialShift(
    prior: { acknowledged: CharacterArcReading | null; expressed: CharacterArcReading | null },
    candidate: CharacterArcReading,
  ): boolean {
    const ref = prior.acknowledged ?? prior.expressed;
    if (!ref) return true;
    if (ref.role !== candidate.role) return true;
    if (ref.trajectory !== candidate.trajectory) return true;
    if (ref.stakePosition !== candidate.stakePosition) return true;
    return false;
  }
}
