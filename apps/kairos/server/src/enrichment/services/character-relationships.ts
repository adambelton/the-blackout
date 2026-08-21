import type { LLMClient } from "../../llm/types.js";
import type { ServiceSpec } from "../types.js";
import { BaseEnrichmentService } from "../base-service.js";
import { loadBaselineSections } from "../baseline-loader.js";

interface CharacterRelationshipReading {
  parties: [string, string];
  dynamic: "adversarial" | "allied" | "complex" | "wary";
  charge: "low" | "moderate" | "high";
  currentState: string;
  [key: string]: unknown;
}

const BASELINE = loadBaselineSections(
  new URL("./character-relationships.baseline.md", import.meta.url),
);

const READING_SCHEMA = {
  type: "object",
  properties: {
    parties: { type: "array", items: { type: "string" }, minItems: 2, maxItems: 2 },
    dynamic: { type: "string", enum: ["adversarial", "allied", "complex", "wary"] },
    charge: { type: "string", enum: ["low", "moderate", "high"] },
    currentState: { type: "string" },
  },
  required: ["parties", "dynamic", "charge", "currentState"],
  additionalProperties: false,
};

export class CharacterRelationshipsService extends BaseEnrichmentService<CharacterRelationshipReading> {
  readonly name = "character_relationships";

  constructor(spec: ServiceSpec, llm: LLMClient) {
    super(spec, llm, BASELINE, READING_SCHEMA);
  }

  /**
   * Material when dynamic, charge, or the parties identity changes.
   * The same pair carrying the same dynamic at the same charge is
   * the relationship sustaining itself — currentState text drift
   * alone is not material.
   */
  protected isMaterialShift(
    prior: { acknowledged: CharacterRelationshipReading | null; expressed: CharacterRelationshipReading | null },
    candidate: CharacterRelationshipReading,
  ): boolean {
    const ref = prior.acknowledged ?? prior.expressed;
    if (!ref) return true;
    if (ref.dynamic !== candidate.dynamic) return true;
    if (ref.charge !== candidate.charge) return true;
    const refPair = (ref.parties ?? []).slice().sort().join("|");
    const candPair = (candidate.parties ?? []).slice().sort().join("|");
    return refPair !== candPair;
  }
}
