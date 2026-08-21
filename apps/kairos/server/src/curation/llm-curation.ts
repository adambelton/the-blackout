import type { LLMClient, SystemSegment, ToolCall } from "../llm/types.js";
import type { FeedEntry } from "../types.js";
import type { CurationContext } from "./types.js";
import { UTILITY_ANTHROPIC_MODEL, ENRICHMENT_MAX_TOKENS } from "../llm/defaults.js";

/**
 * Standard "I noticed nothing / I bailed" decision tag attached to a
 * service's slot in the curation context. Used by every curation
 * service for short-circuit and error paths so failure modes are
 * uniform across the registry.
 */
export function withDecision(
  prior: CurationContext,
  serviceName: string,
  action: string,
): CurationContext {
  return {
    ...prior,
    decisions: {
      ...prior.decisions,
      [serviceName]: {
        serviceName,
        action,
        entriesRemoved: [],
        entriesEmphasized: [],
      },
    },
  };
}

/**
 * Shared helper for curation services. Each service owns its own
 * `concept`, `taskGuidance`, `toolName`, `readingSchema`, and builds
 * its own user message from the current CurationContext + enriched
 * payload; the helper takes care of prompt assembly, the LLM round-trip,
 * tool-call parsing, and error handling.
 *
 * Curation services run sequentially (each sees the output of the
 * previous one), so the helper doesn't fan out or batch — one LLM call
 * per service per cycle.
 */
export interface CurationLLMInputs<T> {
  client: LLMClient;
  /**
   * The full, pre-assembled system prompt for this service's call.
   * Caller composes it via `assembleCurationSystemPrompt`. Cached.
   */
  systemPrompt: string;
  /** Tool name the model must call. */
  toolName: string;
  /** JSON Schema for the tool's input payload. */
  readingSchema: Record<string, unknown>;
  /** The service's per-cycle user message (annotations, prior decisions, etc.). */
  userMessage: string;
  /** Runtime validator for the parsed tool input. Returns parsed value or null. */
  parseInput: (input: unknown) => T | null;
  /**
   * Standing narrative_context for the broadcast. When provided and
   * non-empty, the runner emits the brief content as a separate
   * uncached system segment. Caller passes `hasBrief: true` to
   * `assembleCurationSystemPrompt` so the cached prompt includes
   * extraction guidance for it.
   */
  narrativeContext?: FeedEntry[];
  /** Model override; defaults to Haiku. */
  model?: string;
  maxTokens?: number;
}

/**
 * Returns the parsed tool-call payload, or `null` if the LLM failed to
 * return a valid tool call. Callers decide what "null" means (usually:
 * leave the CurationContext unchanged, log, continue).
 */
export async function runCurationLLM<T>(inputs: CurationLLMInputs<T>): Promise<T | null> {
  const system: SystemSegment[] = [{ text: inputs.systemPrompt, cache: true }];
  const briefSegment = renderBriefContentSegment(inputs.narrativeContext);
  if (briefSegment) system.push({ text: briefSegment, cache: false });

  const response = await inputs.client.generate({
    system,
    messages: [{ role: "user", content: inputs.userMessage }],
    tools: [
      {
        name: inputs.toolName,
        description: `Report the ${inputs.toolName.replace(/^report_/, "")} decision.`,
        inputSchema: inputs.readingSchema,
      },
    ],
    toolChoice: { type: "tool", name: inputs.toolName },
    cacheTools: true,
    model: inputs.model ?? UTILITY_ANTHROPIC_MODEL,
    maxTokens: inputs.maxTokens ?? ENRICHMENT_MAX_TOKENS,
  });

  const toolCall = response.toolCalls?.[0];
  return parseToolCall(toolCall, inputs.toolName, inputs.parseInput);
}

/**
 * Render the brief content as a separate uncached system segment.
 * The cached `systemPrompt` carries the extraction guidance + lens-
 * not-gate reminder; this carries just the entries themselves.
 * Returns null when the brief has no useful content.
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
  return ["## Brief — content", "", fragments.join("\n\n")].join("\n");
}

function readContent(data: Record<string, unknown>): string {
  const content = data.content;
  if (typeof content === "string") return content;
  return JSON.stringify(data);
}

function parseToolCall<T>(
  toolCall: ToolCall | undefined,
  expectedName: string,
  parseInput: (input: unknown) => T | null,
): T | null {
  if (!toolCall || toolCall.name !== expectedName) return null;
  return parseInput(toolCall.input);
}
