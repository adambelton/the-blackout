import type { LLMClient } from "../../llm/types.js";
import type { ServiceSpec } from "../types.js";
import { BaseEnrichmentService } from "../base-service.js";
import { loadBaselineSections } from "../baseline-loader.js";

interface TensionReading {
  poles: string[];
  stake: string;
  level: "low" | "moderate" | "high" | "critical";
  trajectory: "escalating" | "easing" | "holding";
  [key: string]: unknown;
}

const BASELINE = loadBaselineSections(
  new URL("./tension-conflict.baseline.md", import.meta.url),
);

const READING_SCHEMA = {
  type: "object",
  properties: {
    poles: { type: "array", items: { type: "string" }, minItems: 1 },
    stake: { type: "string" },
    level: { type: "string", enum: ["low", "moderate", "high", "critical"] },
    trajectory: { type: "string", enum: ["escalating", "easing", "holding"] },
  },
  required: ["poles", "stake", "level", "trajectory"],
  additionalProperties: false,
};

export class TensionConflictService extends BaseEnrichmentService<TensionReading> {
  readonly name = "tension_conflict";

  constructor(spec: ServiceSpec, llm: LLMClient) {
    super(spec, llm, BASELINE, READING_SCHEMA);
  }

  /**
   * Material when level changes category, trajectory inverts, or the
   * conflict's identity (poles or stake) shifts. Holding at the same
   * level + trajectory + identity is not material — the same conflict
   * grinding on doesn't need re-narration every cycle.
   */
  protected isMaterialShift(
    prior: { acknowledged: TensionReading | null; expressed: TensionReading | null },
    candidate: TensionReading,
  ): boolean {
    const ref = prior.acknowledged ?? prior.expressed;
    if (!ref) return true;
    if (ref.level !== candidate.level) return true;
    if (ref.trajectory !== candidate.trajectory) return true;
    if (ref.stake !== candidate.stake) return true;
    const priorPoles = (ref.poles ?? []).slice().sort().join("|");
    const candPoles = (candidate.poles ?? []).slice().sort().join("|");
    return priorPoles !== candPoles;
  }
}
