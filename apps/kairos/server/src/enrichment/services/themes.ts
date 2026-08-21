import type { LLMClient } from "../../llm/types.js";
import type { ServiceSpec } from "../types.js";
import { BaseEnrichmentService } from "../base-service.js";
import { loadBaselineSections } from "../baseline-loader.js";

interface ThemeReading {
  description: string;
  weight: "low" | "moderate" | "high";
  status: "emerging" | "established" | "fading";
  [key: string]: unknown;
}

const BASELINE = loadBaselineSections(
  new URL("./themes.baseline.md", import.meta.url),
);

const READING_SCHEMA = {
  type: "object",
  properties: {
    description: { type: "string" },
    weight: { type: "string", enum: ["low", "moderate", "high"] },
    status: { type: "string", enum: ["emerging", "established", "fading"] },
  },
  required: ["description", "weight", "status"],
  additionalProperties: false,
};

export class ThemesService extends BaseEnrichmentService<ThemeReading> {
  readonly name = "themes";

  constructor(spec: ServiceSpec, llm: LLMClient) {
    super(spec, llm, BASELINE, READING_SCHEMA);
  }

  /**
   * Material when status (emerging | established | fading) transitions
   * or weight (low | moderate | high) changes category. Description
   * text drift on a stable status + weight is not material — themes
   * move slowly and the structured fields capture genuine movement.
   */
  protected isMaterialShift(
    prior: { acknowledged: ThemeReading | null; expressed: ThemeReading | null },
    candidate: ThemeReading,
  ): boolean {
    const ref = prior.acknowledged ?? prior.expressed;
    if (!ref) return true;
    if (ref.status !== candidate.status) return true;
    if (ref.weight !== candidate.weight) return true;
    return false;
  }
}
