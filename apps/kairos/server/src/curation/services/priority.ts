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

interface PriorityReport {
  emphasisEntryIds: string[];
  removeEntryIds: string[];
  rationale: string;
}

const BASELINE = loadBaselineSections(
  new URL("./priority.baseline.md", import.meta.url),
);

const READING_SCHEMA = {
  type: "object",
  properties: {
    emphasisEntryIds: { type: "array", items: { type: "string" } },
    removeEntryIds: { type: "array", items: { type: "string" } },
    rationale: { type: "string" },
  },
  required: ["emphasisEntryIds", "removeEntryIds", "rationale"],
  additionalProperties: false,
};

export class PriorityService implements CurationService {
  readonly name = "priority";

  private readonly merged: CurationBaselineSections;

  constructor(readonly spec: ServiceSpec, private llm: LLMClient) {
    this.merged = mergeBaselineWithSpec(BASELINE, readCurationSpec(spec.spec));
  }

  async curate(payload: EnrichedPayload, prior: CurationContext): Promise<CurationContext> {
    const userMessage = [
      `## Arc phase`,
      prior.arcPhase ?? "(not yet identified)",
      "",
      `## Urgent subjects`,
      prior.urgentSubjects && prior.urgentSubjects.length > 0
        ? prior.urgentSubjects
            .map((u) => `  ${u.serviceName}/${u.subjectId}: ${u.reason}`)
            .join("\n")
        : "(none)",
      "",
      `## Annotations this cycle`,
      payload.annotations.length === 0
        ? "(none)"
        : payload.annotations
            .map(
              (a) =>
                `- ${a.serviceName}/${a.subjectId} (${a.subjectLabel}) — informedBy: [${(a.informedBy ?? []).join(", ")}]\n    basis: ${a.meaning?.basis ?? ""}`,
            )
            .join("\n"),
      "",
      `## Cycle entries`,
      payload.entries.length === 0
        ? "(none)"
        : payload.entries
            .map((e) => {
              const content = typeof e.data?.content === "string" ? (e.data.content as string) : "";
              return `  [${e.id}] ${e.sourceName ?? "?"} — ${content.slice(0, 100)}`;
            })
            .join("\n"),
    ].join("\n");

    try {
      const result = await runCurationLLM<PriorityReport>({
        client: this.llm,
        systemPrompt: assembleCurationSystemPrompt({
          concept: this.merged.concept,
          taskGuidance: this.merged.taskGuidance,
          hasBrief: (payload.narrativeContext?.length ?? 0) > 0,
          briefExtractionGuidance: this.merged.briefExtractionGuidance,
        }),
        toolName: "report_priority",
        readingSchema: READING_SCHEMA,
        userMessage,
        narrativeContext: payload.narrativeContext,
        parseInput: (input) => {
          if (!input || typeof input !== "object") return null;
          const r = input as Record<string, unknown>;
          const emp = Array.isArray(r.emphasisEntryIds)
            ? r.emphasisEntryIds.filter((x): x is string => typeof x === "string")
            : null;
          const rem = Array.isArray(r.removeEntryIds)
            ? r.removeEntryIds.filter((x): x is string => typeof x === "string")
            : null;
          if (!emp || !rem || typeof r.rationale !== "string") return null;
          return { emphasisEntryIds: emp, removeEntryIds: rem, rationale: r.rationale };
        },
      });

      if (!result) {
        return withDecision(prior, this.name, "no priority report");
      }

      // The service records its emphasis + removal *decision* only.
      // The curator's `applyRemovals` pass consolidates removal across
      // every service's `entriesRemoved` and applies it centrally —
      // that's where the canonical-never-evict guard lives, so a
      // canonical id leaking into `removeEntryIds` here can't bypass
      // the contract.
      const allowedEntryIds = new Set(payload.entries.map((e) => e.id));
      const emp = result.emphasisEntryIds.filter((id) => allowedEntryIds.has(id));
      const rem = result.removeEntryIds.filter((id) => allowedEntryIds.has(id));

      return {
        ...prior,
        decisions: {
          ...prior.decisions,
          [this.name]: {
            serviceName: this.name,
            action: `emphasised ${emp.length}, removed ${rem.length}`,
            entriesRemoved: rem,
            entriesEmphasized: emp,
            meta: { rationale: result.rationale },
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