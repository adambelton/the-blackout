import type { EnrichedPayload, ServiceSpec } from "../../enrichment/types.js";
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

interface ConflictReport {
  conflicts: ConflictResolution[];
}

const BASELINE = loadBaselineSections(
  new URL("./conflict-resolver.baseline.md", import.meta.url),
);

const READING_SCHEMA = {
  type: "object",
  properties: {
    conflicts: {
      type: "array",
      items: {
        type: "object",
        properties: {
          winner: {
            type: "object",
            properties: {
              serviceName: { type: "string" },
              subjectId: { type: "string" },
            },
            required: ["serviceName", "subjectId"],
            additionalProperties: false,
          },
          loser: {
            type: "object",
            properties: {
              serviceName: { type: "string" },
              subjectId: { type: "string" },
            },
            required: ["serviceName", "subjectId"],
            additionalProperties: false,
          },
          reason: { type: "string" },
          replacementReading: {
            type: "object",
            additionalProperties: true,
          },
        },
        required: ["winner", "loser", "reason"],
        additionalProperties: false,
      },
    },
  },
  required: ["conflicts"],
  additionalProperties: false,
};

export class ConflictResolver implements CurationService {
  readonly name = "conflict_resolver";

  private readonly merged: CurationBaselineSections;

  constructor(readonly spec: ServiceSpec, private llm: LLMClient) {
    this.merged = mergeBaselineWithSpec(BASELINE, readCurationSpec(spec.spec));
  }

  async curate(payload: EnrichedPayload, prior: CurationContext): Promise<CurationContext> {
    const emphasised = new Set(prior.decisions.priority?.entriesEmphasized ?? []);
    const userMessage = [
      "## Arc phase",
      prior.arcPhase ?? "(not identified)",
      "",
      "## Annotations this cycle",
      payload.annotations.length === 0
        ? "(none)"
        : payload.annotations
            .map((a) => {
              const onEmphasised = (a.informedBy ?? []).some((id) => emphasised.has(id));
              const tag = onEmphasised ? " [on emphasised evidence]" : "";
              return `- ${a.serviceName}/${a.subjectId} (${a.subjectLabel})${tag}\n    reading: ${JSON.stringify(a.meaning?.unexpressed ?? {})}\n    basis: ${a.meaning?.basis ?? ""}`;
            })
            .join("\n"),
    ].join("\n");

    try {
      const result = await runCurationLLM<ConflictReport>({
        client: this.llm,
        systemPrompt: assembleCurationSystemPrompt({
          concept: this.merged.concept,
          taskGuidance: this.merged.taskGuidance,
          hasBrief: false,
        }),
        toolName: "report_conflicts",
        readingSchema: READING_SCHEMA,
        userMessage,
        parseInput: (input) => {
          if (!input || typeof input !== "object") return null;
          const r = input as Record<string, unknown>;
          if (!Array.isArray(r.conflicts)) return null;
          const conflicts: ConflictResolution[] = [];
          for (const raw of r.conflicts) {
            if (!raw || typeof raw !== "object") continue;
            const c = raw as Record<string, unknown>;
            const w = c.winner as Record<string, unknown> | undefined;
            const l = c.loser as Record<string, unknown> | undefined;
            if (!w || !l || typeof c.reason !== "string") continue;
            if (typeof w.serviceName !== "string" || typeof w.subjectId !== "string") continue;
            if (typeof l.serviceName !== "string" || typeof l.subjectId !== "string") continue;
            const conflict: ConflictResolution = {
              winner: { serviceName: w.serviceName, subjectId: w.subjectId },
              loser: { serviceName: l.serviceName, subjectId: l.subjectId },
              reason: c.reason,
            };
            if (c.replacementReading && typeof c.replacementReading === "object") {
              conflict.replacementReading = c.replacementReading as Record<string, unknown>;
            }
            conflicts.push(conflict);
          }
          return { conflicts };
        },
      });

      if (!result) {
        return withDecision(prior, this.name, "no conflicts report");
      }

      return {
        ...prior,
        conflicts: [...prior.conflicts, ...result.conflicts],
        decisions: {
          ...prior.decisions,
          [this.name]: {
            serviceName: this.name,
            action: `${result.conflicts.length} conflict${result.conflicts.length === 1 ? "" : "s"}`,
            entriesRemoved: [],
            entriesEmphasized: [],
            meta: { conflicts: result.conflicts },
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