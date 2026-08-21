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

interface SummaryReport {
  summary: string;
}

const BASELINE = loadBaselineSections(
  new URL("./broadcast-summary.baseline.md", import.meta.url),
);

const READING_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string" },
  },
  required: ["summary"],
  additionalProperties: false,
};

export class BroadcastSummaryService implements CurationService {
  readonly name = "broadcast_summary";

  private readonly merged: CurationBaselineSections;

  constructor(readonly spec: ServiceSpec, private llm: LLMClient) {
    this.merged = mergeBaselineWithSpec(BASELINE, readCurationSpec(spec.spec));
  }

  async curate(payload: EnrichedPayload, prior: CurationContext): Promise<CurationContext> {
    const priorityDecision = prior.decisions.priority;
    const emphasisedEntryIds = new Set(priorityDecision?.entriesEmphasized ?? []);
    const emphasisedContent = payload.entries
      .filter((e) => emphasisedEntryIds.has(e.id))
      .map((e) => (typeof e.data?.content === "string" ? (e.data.content as string) : ""))
      .filter(Boolean);

    const userMessage = [
      `## Arc phase`,
      prior.arcPhase ?? "(not identified)",
      "",
      `## Urgent subjects`,
      prior.urgentSubjects && prior.urgentSubjects.length > 0
        ? prior.urgentSubjects.map((u) => `  ${u.serviceName}/${u.subjectId}: ${u.reason}`).join("\n")
        : "(none)",
      "",
      `## Conflicts resolved this cycle`,
      prior.conflicts.length > 0
        ? prior.conflicts
            .map((c) => `  ${c.winner.serviceName}/${c.winner.subjectId} over ${c.loser.serviceName}/${c.loser.subjectId}: ${c.reason}`)
            .join("\n")
        : "(none)",
      "",
      `## Emphasised entries (content)`,
      emphasisedContent.length > 0
        ? emphasisedContent.map((c) => `  - ${c.slice(0, 120)}`).join("\n")
        : "(none)",
      "",
      `## Annotations this cycle`,
      payload.annotations.length === 0
        ? "(none)"
        : payload.annotations
            .map((a) => `- ${a.serviceName}/${a.subjectId}: ${a.meaning?.basis ?? ""}`)
            .join("\n"),
      "",
      `## Pacing`,
      `${prior.pacing.recommendedWordCount}w / ${prior.pacing.cadenceMs}ms`,
    ].join("\n");

    try {
      const result = await runCurationLLM<SummaryReport>({
        client: this.llm,
        systemPrompt: assembleCurationSystemPrompt({
          concept: this.merged.concept,
          taskGuidance: this.merged.taskGuidance,
          hasBrief: (payload.narrativeContext?.length ?? 0) > 0,
          briefExtractionGuidance: this.merged.briefExtractionGuidance,
        }),
        toolName: "report_summary",
        readingSchema: READING_SCHEMA,
        userMessage,
        narrativeContext: payload.narrativeContext,
        parseInput: (input) => {
          if (!input || typeof input !== "object") return null;
          const r = input as Record<string, unknown>;
          if (typeof r.summary !== "string") return null;
          return { summary: r.summary };
        },
      });

      if (!result) {
        return withDecision(prior, this.name, "no summary reported");
      }

      return {
        ...prior,
        summary: result.summary,
        decisions: {
          ...prior.decisions,
          [this.name]: {
            serviceName: this.name,
            action: `summary: ${result.summary.slice(0, 60)}${result.summary.length > 60 ? "…" : ""}`,
            entriesRemoved: [],
            entriesEmphasized: [],
            meta: { summary: result.summary },
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