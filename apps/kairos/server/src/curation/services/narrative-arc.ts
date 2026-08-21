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

/** Default expected broadcast duration when nothing else is configured. 90 min. */
const DEFAULT_EXPECTED_DURATION_MS = 90 * 60 * 1000;

const ARC_PHASES = ["opening", "rising", "climax", "falling", "resolution"] as const;
type ArcPhase = typeof ARC_PHASES[number];

interface ArcReport {
  phase: ArcPhase;
  changeStrength: "stable" | "tentative" | "strong";
  rationale: string;
}

const BASELINE = loadBaselineSections(
  new URL("./narrative-arc.baseline.md", import.meta.url),
);

const READING_SCHEMA = {
  type: "object",
  properties: {
    phase: { type: "string", enum: [...ARC_PHASES] as unknown as string[] },
    changeStrength: { type: "string", enum: ["stable", "tentative", "strong"] },
    rationale: { type: "string" },
  },
  required: ["phase", "changeStrength", "rationale"],
  additionalProperties: false,
};

export class NarrativeArcService implements CurationService {
  readonly name = "narrative_arc";

  /**
   * The phase the curator has committed to. `null` until the first
   * cycle reports anything. Persists across cycles in-instance —
   * survives cycle boundaries because the registry holds the service
   * for the broadcast's lifetime.
   */
  private committedPhase: ArcPhase | null = null;
  /**
   * The phase candidate from the previous cycle, regardless of
   * whether it was committed. Used to gate tentative changes
   * (a tentative change only commits when the previous candidate
   * was already this same new phase).
   */
  private previousCandidate: ArcPhase | null = null;
  private readonly merged: CurationBaselineSections;

  constructor(readonly spec: ServiceSpec, private llm: LLMClient) {
    this.merged = mergeBaselineWithSpec(BASELINE, readCurationSpec(spec.spec));
  }

  async curate(payload: EnrichedPayload, prior: CurationContext): Promise<CurationContext> {
    const expectedDurationMs =
      (this.spec.spec?.expectedDurationMs as number | undefined) ?? DEFAULT_EXPECTED_DURATION_MS;
    const progressPct = Math.min(100, Math.round((prior.elapsedMs / expectedDurationMs) * 100));

    const userMessage = [
      `## Broadcast progress`,
      `elapsedMs: ${prior.elapsedMs} (~${progressPct}% of ${expectedDurationMs}ms expected)`,
      `triggerReason: ${prior.triggerReason}`,
      "",
      `## Current committed phase`,
      this.committedPhase ?? "(not yet committed)",
      "",
      `## Previous cycle's candidate`,
      this.previousCandidate ?? "(none)",
      "",
      `## Annotations this cycle`,
      payload.annotations.length === 0
        ? "(none)"
        : payload.annotations
            .map((a) => `- ${a.serviceName}/${a.subjectId}: ${a.meaning?.basis ?? ""}`)
            .join("\n"),
    ].join("\n");

    try {
      const result = await runCurationLLM<ArcReport>({
        client: this.llm,
        systemPrompt: assembleCurationSystemPrompt({
          concept: this.merged.concept,
          taskGuidance: this.merged.taskGuidance,
          hasBrief: (payload.narrativeContext?.length ?? 0) > 0,
          briefExtractionGuidance: this.merged.briefExtractionGuidance,
        }),
        toolName: "report_arc",
        readingSchema: READING_SCHEMA,
        userMessage,
        narrativeContext: payload.narrativeContext,
        parseInput: (input) => {
          if (!input || typeof input !== "object") return null;
          const r = input as Record<string, unknown>;
          if (typeof r.phase !== "string" || !ARC_PHASES.includes(r.phase as ArcPhase)) return null;
          if (typeof r.changeStrength !== "string" || !["stable", "tentative", "strong"].includes(r.changeStrength)) return null;
          if (typeof r.rationale !== "string") return null;
          return {
            phase: r.phase as ArcPhase,
            changeStrength: r.changeStrength as ArcReport["changeStrength"],
            rationale: r.rationale,
          };
        },
      });

      if (!result) {
        return withDecision(prior, this.name, "no phase reported");
      }

      // Gate the phase change. A "stable" candidate or a candidate
      // matching the committed phase doesn't change anything. A
      // "strong" candidate commits immediately. A "tentative"
      // candidate only commits if the previous cycle's candidate
      // was the same new phase (≥ 2 consecutive supporting cycles).
      const candidate = result.phase;
      const previousCandidate = this.previousCandidate;
      let commit = false;
      let gateReason = "";

      if (this.committedPhase === null) {
        // First cycle ever: commit whatever the LLM reports.
        commit = true;
        gateReason = "first commit";
      } else if (candidate === this.committedPhase) {
        gateReason = "candidate matches committed";
      } else if (result.changeStrength === "strong") {
        commit = true;
        gateReason = "strong change";
      } else if (result.changeStrength === "tentative" && previousCandidate === candidate) {
        commit = true;
        gateReason = "tentative confirmed by prior cycle";
      } else {
        gateReason = `${result.changeStrength} change, awaiting confirmation`;
      }

      if (commit) {
        this.committedPhase = candidate;
      }
      this.previousCandidate = candidate;

      const effectivePhase = this.committedPhase ?? candidate;

      return {
        ...prior,
        arcPhase: effectivePhase,
        decisions: {
          ...prior.decisions,
          [this.name]: {
            serviceName: this.name,
            action: commit
              ? `phase: ${effectivePhase} (committed — ${gateReason})`
              : `phase: ${effectivePhase} (held — ${gateReason}; candidate was ${candidate}/${result.changeStrength})`,
            entriesRemoved: [],
            entriesEmphasized: [],
            meta: {
              phase: effectivePhase,
              candidatePhase: candidate,
              changeStrength: result.changeStrength,
              committed: commit,
              gateReason,
              rationale: result.rationale,
              progressPct,
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
  reset(): void {
    this.committedPhase = null;
    this.previousCandidate = null;
  }
}