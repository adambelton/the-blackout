import type { EnrichedPayload, ServiceSpec } from "../../enrichment/types.js";
import type { LLMClient } from "../../llm/types.js";
import type { CurationService, CurationContext } from "../types.js";
import { runCurationLLM, withDecision } from "../llm-curation.js";
import { assembleCurationSystemPrompt } from "../prompt-assembly.js";
import {
  loadBaselineSections,
  mergeBaselineWithSpec,
  readCurationSpec,
  type CurationBaselineSections,
} from "../baseline-loader.js";

interface UrgentSubject {
  serviceName: string;
  subjectId: string;
  reason: string;
}

interface GapReport {
  urgentSubjects: UrgentSubject[];
}

const BASELINE = loadBaselineSections(
  new URL("./narrative-gap.baseline.md", import.meta.url),
);

const READING_SCHEMA = {
  type: "object",
  properties: {
    urgentSubjects: {
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
  },
  required: ["urgentSubjects"],
  additionalProperties: false,
};

export class NarrativeGapService implements CurationService {
  readonly name = "narrative_gap";

  private readonly merged: CurationBaselineSections;

  constructor(readonly spec: ServiceSpec, private llm: LLMClient) {
    this.merged = mergeBaselineWithSpec(BASELINE, readCurationSpec(spec.spec));
  }

  async curate(payload: EnrichedPayload, prior: CurationContext): Promise<CurationContext> {
    const now = Date.now();
    const lastSurfacedLines = Object.entries(prior.serviceLastSurfacedAt)
      .map(([name, ts]) => {
        if (ts == null) return `  ${name}: never surfaced`;
        const ago = Math.round((now - ts) / 1000);
        return `  ${name}: ${ago}s ago`;
      })
      .join("\n");

    const userMessage = [
      "## Time context",
      `broadcast elapsedMs: ${prior.elapsedMs}`,
      "",
      "## Last surfaced (by service)",
      lastSurfacedLines || "(no services initialised)",
      "",
      "## Annotations this cycle (candidates to flag as urgent)",
      payload.annotations.length === 0
        ? "(none)"
        : payload.annotations
            .map(
              (a) =>
                `- ${a.serviceName}/${a.subjectId} (${a.subjectLabel}): ${a.meaning?.basis ?? ""}`,
            )
            .join("\n"),
    ].join("\n");

    try {
      const result = await runCurationLLM<GapReport>({
        client: this.llm,
        systemPrompt: assembleCurationSystemPrompt({
          concept: this.merged.concept,
          taskGuidance: this.merged.taskGuidance,
          hasBrief: false,
        }),
        toolName: "report_urgent_subjects",
        readingSchema: READING_SCHEMA,
        userMessage,
        parseInput: (input) => {
          if (!input || typeof input !== "object") return null;
          const r = input as Record<string, unknown>;
          if (!Array.isArray(r.urgentSubjects)) return null;
          const urgent: UrgentSubject[] = [];
          for (const raw of r.urgentSubjects) {
            if (!raw || typeof raw !== "object") continue;
            const o = raw as Record<string, unknown>;
            if (
              typeof o.serviceName !== "string" ||
              typeof o.subjectId !== "string" ||
              typeof o.reason !== "string"
            ) continue;
            urgent.push({
              serviceName: o.serviceName,
              subjectId: o.subjectId,
              reason: o.reason,
            });
          }
          return { urgentSubjects: urgent };
        },
      });

      if (!result) {
        return withDecision(prior, this.name, "no report");
      }

      return {
        ...prior,
        urgentSubjects: result.urgentSubjects,
        decisions: {
          ...prior.decisions,
          [this.name]: {
            serviceName: this.name,
            action: `${result.urgentSubjects.length} urgent subject${result.urgentSubjects.length === 1 ? "" : "s"}`,
            entriesRemoved: [],
            entriesEmphasized: [],
            meta: { urgentSubjects: result.urgentSubjects },
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