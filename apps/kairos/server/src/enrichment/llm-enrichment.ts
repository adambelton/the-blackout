import type { LLMClient, SystemSegment, ToolCall } from "../llm/types.js";
import type { FeedChunk, SubjectStateMap } from "./types.js";
import type { FeedEntry } from "../types.js";
import { UTILITY_ANTHROPIC_MODEL, ENRICHMENT_MAX_TOKENS } from "../llm/defaults.js";

/**
 * Render the brief content as a separate uncached system segment.
 * The cached `systemPrompt` carries the framing prose (extraction
 * guidance, lens-not-gate reminder, task instructions); this carries
 * just the entries themselves. Returns null when the brief has no
 * useful content — caller omits the segment in that case.
 */
function renderBriefContentSegment(narrativeContext: FeedEntry[] | undefined): string | null {
  if (!narrativeContext || narrativeContext.length === 0) return null;
  const fragments: string[] = [];
  for (const entry of narrativeContext) {
    const content = readContent(entry.data);
    if (!content) continue;
    fragments.push(`[id:${entry.id}] ${content}`);
  }
  if (fragments.length === 0) return null;
  return [
    "## Brief — content",
    "",
    fragments.join("\n\n"),
  ].join("\n");
}

export const REPORT_READINGS_TOOL = "report_readings";

/**
 * One subject's updated reading as returned by the LLM. `reading` is
 * whatever shape the calling service's JSON schema specifies.
 */
export interface SubjectReport {
  subjectId: string;
  label: string;
  reading: Record<string, unknown>;
  basis: string;
  informedBy: string[];
}

export interface EnrichmentLLMInputs {
  client: LLMClient;
  /**
   * The full, pre-assembled system prompt for this service's per-cycle
   * call. Caller (`BaseEnrichmentService`) composes it from the
   * service's baseline + resolved spec content. Cached.
   */
  systemPrompt: string;
  /** JSON Schema for the per-subject `reading` payload. */
  readingSchema: Record<string, unknown>;
  knownSubjects: Array<{ id: string; label: string }>;
  states: {
    expressed: SubjectStateMap;
    unexpressed: SubjectStateMap;
    acknowledged: SubjectStateMap;
  };
  chunk: FeedChunk;
  /** Override for testing; defaults to Haiku. */
  model?: string;
  maxTokens?: number;
}

/**
 * Call Haiku once and return the per-subject reports. The prompt
 * always instructs the model to reuse ids from `knownSubjects` when
 * the same subject reappears, and to mint clearly-labelled new ids
 * otherwise.
 */
export async function runEnrichmentLLM(inputs: EnrichmentLLMInputs): Promise<SubjectReport[]> {
  const system: SystemSegment[] = [{ text: inputs.systemPrompt, cache: true }];
  const briefSegment = renderBriefContentSegment(inputs.chunk.narrativeContext);
  if (briefSegment) system.push({ text: briefSegment, cache: false });

  const userMessage = buildUserMessage(inputs);

  const response = await inputs.client.generate({
    system,
    messages: [{ role: "user", content: userMessage }],
    tools: [buildTool(inputs.readingSchema)],
    toolChoice: { type: "tool", name: REPORT_READINGS_TOOL },
    cacheTools: true,
    model: inputs.model ?? UTILITY_ANTHROPIC_MODEL,
    maxTokens: inputs.maxTokens ?? ENRICHMENT_MAX_TOKENS,
  });

  return parseReports(response.toolCalls?.[0]);
}

function buildUserMessage(inputs: EnrichmentLLMInputs): string {
  const parts: string[] = [];

  parts.push("## Known subjects");
  if (inputs.knownSubjects.length === 0) {
    parts.push("(none yet — this is the first cycle with anything to read)");
  } else {
    for (const s of inputs.knownSubjects) {
      parts.push(`  ${s.id} — ${s.label}`);
    }
  }
  parts.push("");

  parts.push("## Prior readings");
  if (inputs.knownSubjects.length === 0) {
    parts.push("(none)");
  } else {
    for (const s of inputs.knownSubjects) {
      const exp = inputs.states.expressed[s.id]?.reading ?? null;
      const ack = inputs.states.acknowledged[s.id]?.reading ?? null;
      const unx = inputs.states.unexpressed[s.id]?.reading ?? null;
      parts.push(`  ${s.id} (${s.label}):`);
      parts.push(`    expressed:    ${formatReading(exp)}`);
      parts.push(`    acknowledged: ${formatReading(ack)}`);
      parts.push(`    unexpressed:  ${formatReading(unx)}`);
    }
  }
  parts.push("");

  parts.push("## New feed entries");
  if (inputs.chunk.entries.length === 0) {
    parts.push("(no new entries — should not happen; callers skip the LLM on empty chunks)");
  } else {
    for (const entry of inputs.chunk.entries) {
      const content = readContent(entry.data);
      parts.push(`  [id:${entry.id}] ${content}`);
    }
  }

  return parts.join("\n");
}

function formatReading(reading: Record<string, unknown> | null): string {
  if (!reading) return "—";
  return JSON.stringify(reading);
}

function readContent(data: Record<string, unknown>): string {
  const content = data.content;
  if (typeof content === "string") return content;
  return JSON.stringify(data);
}

function buildTool(readingSchema: Record<string, unknown>): {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
} {
  return {
    name: REPORT_READINGS_TOOL,
    description:
      "Report per-subject reading updates for subjects whose state materially advanced this cycle. Return an empty array if nothing moved.",
    inputSchema: {
      type: "object",
      properties: {
        reports: {
          type: "array",
          items: {
            type: "object",
            properties: {
              subjectId: {
                type: "string",
                description:
                  "Stable id for this subject. Reuse exactly when the subject is already in the known-subjects list.",
              },
              label: {
                type: "string",
                description: "Human-readable label for the subject. May refine across cycles.",
              },
              reading: readingSchema,
              basis: {
                type: "string",
                description: "One short sentence — what in the new entries moved the reading.",
              },
              informedBy: {
                type: "array",
                items: { type: "string" },
                description:
                  "Entry ids from the shown chunk that justified this update. Only ids from the new feed entries block.",
              },
            },
            required: ["subjectId", "label", "reading", "basis", "informedBy"],
            additionalProperties: false,
          },
        },
      },
      required: ["reports"],
      additionalProperties: false,
    },
  };
}

/**
 * Brief-initialisation inputs. Mirrors the per-cycle `EnrichmentLLMInputs`
 * shape but with no live entries — the call runs once at activation
 * with the brief alone and asks: "before any evidence arrives, what
 * subjects does this brief commit you to track, and what's the starting
 * reading for each?"
 *
 * The `initializationGuidance` is service-specific and authored
 * alongside the existing `briefExtractionGuidance` — same lens, different
 * timing. Where extraction guidance shapes how the per-cycle LLM
 * interprets live evidence against the brief, initialisation guidance
 * shapes what priors the LLM lifts from the brief alone.
 */
export interface BriefInitializationInputs {
  client: LLMClient;
  /**
   * The full, pre-assembled system prompt for this service's brief-
   * initialisation call. Caller (`BaseEnrichmentService`) composes it
   * from the service's baseline + resolved spec content. Cached.
   */
  systemPrompt: string;
  readingSchema: Record<string, unknown>;
  /** The brief, joined as a single text block. */
  brief: string;
  model?: string;
  maxTokens?: number;
}

/**
 * One-shot Haiku call that reads the brief through this service's lens
 * and returns the subject seeds to hydrate as `unexpressed` state at
 * activation. Same tool schema as the per-cycle path so reports plug
 * into `BaseEnrichmentService.upsertUnexpressed` unchanged.
 */
export async function runBriefInitialization(
  inputs: BriefInitializationInputs,
): Promise<SubjectReport[]> {
  if (!inputs.brief.trim()) return [];

  const system: SystemSegment[] = [
    { text: inputs.systemPrompt, cache: true },
    { text: `## Brief — content\n\n${inputs.brief.trim()}`, cache: false },
  ];

  const userMessage = "Extract the subject seeds for your domain from the brief above.";

  const response = await inputs.client.generate({
    system,
    messages: [{ role: "user", content: userMessage }],
    tools: [buildTool(inputs.readingSchema)],
    toolChoice: { type: "tool", name: REPORT_READINGS_TOOL },
    cacheTools: true,
    model: inputs.model ?? UTILITY_ANTHROPIC_MODEL,
    maxTokens: inputs.maxTokens ?? ENRICHMENT_MAX_TOKENS,
  });

  return parseReports(response.toolCalls?.[0]);
}

function parseReports(toolCall: ToolCall | undefined): SubjectReport[] {
  if (!toolCall || toolCall.name !== REPORT_READINGS_TOOL) return [];
  const input = toolCall.input as { reports?: unknown };
  if (!Array.isArray(input.reports)) return [];

  const out: SubjectReport[] = [];
  for (const raw of input.reports) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    if (typeof r.subjectId !== "string" || !r.subjectId.trim()) continue;
    if (typeof r.label !== "string" || !r.label.trim()) continue;
    if (typeof r.basis !== "string") continue;
    if (!r.reading || typeof r.reading !== "object") continue;
    const informedBy = Array.isArray(r.informedBy)
      ? r.informedBy.filter((x): x is string => typeof x === "string")
      : [];
    out.push({
      subjectId: r.subjectId,
      label: r.label,
      reading: r.reading as Record<string, unknown>,
      basis: r.basis,
      informedBy,
    });
  }
  return out;
}
