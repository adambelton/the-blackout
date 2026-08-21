import type { EnrichedPayload, EnrichmentAnnotation, ServiceSpec } from "../../enrichment/types.js";
import type { LLMClient } from "../../llm/types.js";
import type { CurationService, CurationContext, ConflictResolution } from "../types.js";
import { runCurationLLM, withDecision } from "../llm-curation.js";
import { assembleCurationSystemPrompt } from "../prompt-assembly.js";
import {
  loadBaselineSections,
  mergeBaselineWithSpec,
  readCurationSpec,
  type CurationBaselineSections,
} from "../baseline-loader.js";

interface SaturationReport {
  saturated: Array<{
    serviceName: string;
    subjectId: string;
    reason: string;
  }>;
  forceContextLed: boolean;
  rationale: string;
}

const BASELINE = loadBaselineSections(
  new URL("./saturation-resolver.baseline.md", import.meta.url),
);

const READING_SCHEMA = {
  type: "object",
  properties: {
    saturated: {
      type: "array",
      items: {
        type: "object",
        properties: {
          serviceName: { type: "string" },
          subjectId: { type: "string" },
          reason: { type: "string" },
        },
        required: ["serviceName", "subjectId", "reason"],
        additionalProperties: false,
      },
    },
    forceContextLed: { type: "boolean" },
    rationale: { type: "string" },
  },
  required: ["saturated", "forceContextLed", "rationale"],
  additionalProperties: false,
};

export class SaturationResolver implements CurationService {
  readonly name = "saturation_resolver";

  private readonly merged: CurationBaselineSections;

  constructor(readonly spec: ServiceSpec, private llm: LLMClient) {
    this.merged = mergeBaselineWithSpec(BASELINE, readCurationSpec(spec.spec));
  }

  async curate(payload: EnrichedPayload, prior: CurationContext): Promise<CurationContext> {
    // Nothing to adjudicate without annotations OR without history.
    // First few cycles of a broadcast naturally have no recent window
    // and saturation can't apply.
    if (prior.selectedAnnotations.length === 0 || prior.recentCycles.length === 0) {
      return withDecision(prior, this.name, "no candidates or no history");
    }

    // SaturationResolver works on a short window — the prior 5 cycles.
    // The shared buffer is sized larger for ContextCurator's stale-echo
    // suppression; we slice here to keep the saturation prompt focused on
    // tight restatement rather than long-distance recurrence.
    const window = prior.recentCycles.slice(-5);
    const userMessage = buildUserMessage(prior, window);

    try {
      const result = await runCurationLLM<SaturationReport>({
        client: this.llm,
        systemPrompt: assembleCurationSystemPrompt({
          concept: this.merged.concept,
          taskGuidance: this.merged.taskGuidance,
          hasBrief: (payload.narrativeContext?.length ?? 0) > 0,
          briefExtractionGuidance: this.merged.briefExtractionGuidance,
        }),
        toolName: "report_saturation",
        readingSchema: READING_SCHEMA,
        userMessage,
        narrativeContext: payload.narrativeContext,
        parseInput: (input) => parseInput(input),
      });

      if (!result) {
        return withDecision(prior, this.name, "no saturation report");
      }

      // Build synthetic conflicts for each saturated (service, subject).
      // Replacement reading = current expressed (lock the state so the
      // service's own isMaterialShift returns false on the next cycle
      // until evidence genuinely moves the reading).
      const annotationByKey = new Map<string, EnrichmentAnnotation>();
      for (const ann of prior.selectedAnnotations) {
        annotationByKey.set(`${ann.serviceName}::${ann.subjectId}`, ann);
      }

      const newConflicts: ConflictResolution[] = [];
      for (const sat of result.saturated) {
        const key = `${sat.serviceName}::${sat.subjectId}`;
        const ann = annotationByKey.get(key);
        if (!ann) continue;
        // Lock state to current reading. expressed if present, else
        // unexpressed (the reading the LLM just produced) — either
        // way, the next cycle's isMaterialShift will compare the
        // service's next candidate against this locked reference and
        // return false unless the reading actually moves.
        const replacement = ann.meaning.expressed ?? ann.meaning.unexpressed;
        newConflicts.push({
          winner: { serviceName: this.name, subjectId: sat.subjectId },
          loser: { serviceName: sat.serviceName, subjectId: sat.subjectId },
          reason: `[saturation] ${sat.reason}`,
          replacementReading: replacement,
        });
      }

      const action = result.forceContextLed
        ? `${newConflicts.length} saturated, pivoting to context_led`
        : `${newConflicts.length} saturated`;

      return {
        ...prior,
        conflicts: [...prior.conflicts, ...newConflicts],
        forceContextLed: result.forceContextLed || prior.forceContextLed,
        decisions: {
          ...prior.decisions,
          [this.name]: {
            serviceName: this.name,
            action,
            entriesRemoved: [],
            entriesEmphasized: [],
            meta: {
              saturated: result.saturated,
              forceContextLed: result.forceContextLed,
              rationale: result.rationale,
            },
          },
        },
      };
    } catch (err) {
      console.error(`[curator] ${this.name} failed:`, (err as Error).message);
      return withDecision(prior, this.name, `error: ${(err as Error).message.slice(0, 80)}`);
    }
  }

  isReady(): boolean { return true; }
  reset(): void {}
}

function buildUserMessage(prior: CurationContext, window: CurationContext["recentCycles"]): string {
  const parts: string[] = [];

  parts.push("## Current cycle annotations (candidates for saturation check)");
  for (const a of prior.selectedAnnotations) {
    parts.push(
      `- ${a.serviceName}/${a.subjectId} (${a.subjectLabel})\n    reading: ${JSON.stringify(a.meaning?.unexpressed ?? {})}\n    basis: ${a.meaning?.basis ?? ""}`,
    );
  }
  parts.push("");

  parts.push(`## Recent ${window.length} cycles (oldest first)`);
  for (const cycle of window) {
    parts.push(`### Cycle ${cycle.cycleId ?? "?"} — ${new Date(cycle.triggeredAt).toISOString()}`);
    if (cycle.annotations.length === 0) {
      parts.push("  annotations: (none)");
    } else {
      parts.push("  annotations:");
      for (const a of cycle.annotations) {
        parts.push(`    - ${a.serviceName}/${a.subjectId}: ${a.meaning?.basis ?? ""}`);
      }
    }
    if (cycle.prose) {
      parts.push(`  prose: ${cycle.prose.slice(0, 300)}${cycle.prose.length > 300 ? "…" : ""}`);
    } else {
      parts.push("  prose: (no generation)");
    }
    parts.push("");
  }

  return parts.join("\n");
}

function parseInput(input: unknown): SaturationReport | null {
  if (!input || typeof input !== "object") return null;
  const r = input as Record<string, unknown>;

  if (!Array.isArray(r.saturated)) return null;
  if (typeof r.forceContextLed !== "boolean") return null;
  if (typeof r.rationale !== "string") return null;

  const saturated: SaturationReport["saturated"] = [];
  for (const raw of r.saturated) {
    if (!raw || typeof raw !== "object") continue;
    const s = raw as Record<string, unknown>;
    if (typeof s.serviceName !== "string") continue;
    if (typeof s.subjectId !== "string") continue;
    if (typeof s.reason !== "string") continue;
    saturated.push({ serviceName: s.serviceName, subjectId: s.subjectId, reason: s.reason });
  }

  return {
    saturated,
    forceContextLed: r.forceContextLed,
    rationale: r.rationale,
  };
}