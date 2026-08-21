import { readFileSync } from "node:fs";
import type { LLMClient, ToolCall } from "../llm/types.js";
import type { GenerationContext } from "./types.js";
import type { CurationMode } from "../curation/types.js";
import type { ContentPoolItem } from "../db/content-pool.js";
import { UTILITY_ANTHROPIC_MODEL, UTILITY_MAX_TOKENS } from "../llm/defaults.js";
import {
  assembleSectionedPrompt,
  type ImagerySpecContent,
} from "./spec-types.js";

/**
 * Imagery selector — decides what image accompanies each narrative
 * passage. Runs as a small, cheap LLM call (Haiku) IN PARALLEL with
 * the main narrative generation (Sonnet), sharing the same curated
 * context. Three architectural wins from this split:
 *
 *   1. Selection is judgment over meaning — exactly Haiku's lane. No
 *      need to burn Sonnet on pattern-matching against a pool or
 *      writing prompts.
 *   2. When the decision is "generate fresh", the consumer's image
 *      pipeline (Replicate on the Blackout side) gets a head start
 *      — the decision is emitted as an early WS message the moment
 *      this call returns, ahead of the Sonnet narrative.
 *   3. When the consumer has pre-prepared content (via the content
 *      pool endpoints), the selector reasons over pool item tags +
 *      prompts and either picks one (instant, no generation cost) or
 *      writes a fresh-generate decision.
 *
 * Consumer-metadata is opaque to Kairos — we thread it back through
 * the selection result unchanged so the consumer can resolve its own
 * content bytes.
 */

const IMAGERY_TOOL_NAME = "select_imagery";

const IMAGERY_TOOL = {
  name: IMAGERY_TOOL_NAME,
  description:
    "Articulate the image requirement for this passage, then either pick from the content pool or write a fresh-generate prompt.",
  inputSchema: {
    type: "object",
    properties: {
      image_requirement: {
        type: "string",
        description:
          "REQUIRED. One or two sentences describing what the image should depict for this passage — the visual brief, before deciding pool vs generate. Concrete: scene, mood, light, the moment being shown. Independent of what the pool happens to contain.",
      },
      decision: {
        type: "string",
        enum: ["pool", "generate"],
        description:
          "`pool` to pick a pre-prepared item (requires pool_item_id). `generate` to write a new prompt (requires prompt).",
      },
      pool_item_id: {
        type: "string",
        description:
          "Required when decision is `pool`. The id of the chosen pool item from the list provided.",
      },
      prompt: {
        type: "string",
        description:
          "Required when decision is `generate`. A short art-directed prompt that captures the mood, scene, and feel of the passage. Not a summary — a visual intent.",
      },
      rationale: {
        type: "string",
        description:
          "Optional short explanation of why this choice satisfies the requirement. Persisted for editorial review; never shown to the listener.",
      },
    },
    required: ["image_requirement", "decision"],
    additionalProperties: false,
  },
} as const;

/**
 * Profile-agnostic baseline for the imagery selector's instructions.
 * The structural concepts — the two-step process (articulate-then-decide),
 * the pool-vs-generate split, the no-spoilers / anti-repetition / tool
 * rules — live here. Per-consumer-category elaborations (the scene /
 * mood / light vocabulary, the specific exclusions like club badges)
 * live in the `imagery` service-spec's `imageryInstructions` and are
 * interleaved by matching `## Section` headers at assembly time.
 * See `docs/prompts-as-content-design.md`.
 */
export const IMAGERY_INSTRUCTIONS_BASELINE = readFileSync(
  new URL("./imagery.baseline.md", import.meta.url),
  "utf8",
).trimEnd();

/** Compose the imagery selector's system prompt from the in-code
 * baseline and the resolved profile content. Exported so the merge
 * contract can be unit-tested without invoking the LLM. */
export function buildImagerySystemPrompt(
  imagerySpec?: ImagerySpecContent | null,
): string {
  return assembleSectionedPrompt(
    IMAGERY_INSTRUCTIONS_BASELINE,
    imagerySpec?.imageryInstructions,
  );
}

export type ImageryDecision = "pool" | "generate" | "hold";

/** Snapshot of the matched pool item denormalised at decision time.
 * Captures truth at that moment — survives later edits or deletions
 * of the pool item, so editorial review of historical broadcasts
 * stays grounded. Always set when `decision === "pool"`. */
export interface MatchedPoolItemSnapshot {
  id: string;
  prompt: string;
  tags: string[];
}

export interface ImagerySelection {
  decision: ImageryDecision;
  /** The image brief Haiku articulated BEFORE choosing pool vs
   * generate. The standard the decision is measured against. May
   * be missing on legacy generations or when the model degraded
   * to `hold`. Audit signal: compare against the prose to see if
   * the requirement was relevant to the passage. */
  requirement?: string;
  /** Set when decision is `generate`. */
  prompt?: string;
  /** Set when decision is `pool`. The id of the chosen pool item. */
  poolItemId?: string;
  /** Set when decision is `pool`. Denormalised snapshot of the
   * matched pool item — prompt + tags as they were at decision
   * time. Audit signal: compare against the requirement to see
   * if the pool match satisfies the brief. */
  matchedPoolItem?: MatchedPoolItemSnapshot;
  /** Set when decision is `pool`. Opaque consumer_metadata threaded
   * back from the pool item (the consumer uses it to resolve its
   * content bytes). */
  consumerMetadata?: Record<string, unknown> | null;
  /** Optional one-line Haiku rationale — persisted for editorial
   * review, never shown to listeners. */
  rationale?: string;
}

export interface ImagerySelectorOptions {
  client: LLMClient;
  ctx: GenerationContext;
  mode: CurationMode;
  /** Summary available to the narrator — same material used for their
   * prompt, so imagery and narrative stay in conceptual sync. */
  summary: string;
  /** A short description of the previous passage's visual, if known —
   * helps Haiku decide whether to hold or change. Pass empty string
   * on cold start. */
  previousImageryRationale: string;
  /** Pool items currently available for this broadcast. Empty array
   * = pool isn't populated; decision must be `generate`. */
  poolItems: ContentPoolItem[];
  /** Resolved `imagery` service spec for the broadcast's event
   * profile. When present, its profile content interleaves with the
   * baseline at `## Section` boundaries. Null / undefined =
   * baseline-only assembly. */
  imagerySpec?: ImagerySpecContent | null;
  /** `BroadcastConfig.imagery.enabled` (default true). When false,
   * the selector short-circuits to `hold` without a Haiku call —
   * useful for cost-gating during testing or for consumers who don't
   * want imagery on a given broadcast. */
  imageryEnabled?: boolean;
}

export async function selectImagery(
  opts: ImagerySelectorOptions,
): Promise<ImagerySelection> {
  const {
    client,
    ctx,
    mode,
    summary,
    previousImageryRationale,
    poolItems,
    imagerySpec,
    imageryEnabled = true,
  } = opts;

  // Cost-gate short-circuit. `BroadcastConfig.imagery.enabled` defaults
  // to true; setting it false skips the Haiku call and emits a hold
  // decision so the consumer keeps whatever's currently on screen.
  if (!imageryEnabled) {
    return { decision: "hold", rationale: "imagery disabled by broadcast config" };
  }

  const systemPrompt = buildImagerySystemPrompt(imagerySpec);

  const poolBlock =
    poolItems.length > 0
      ? [
          "## Content pool (pre-prepared; pick one only if it clearly fits)",
          ...poolItems.map((item) => {
            const tagLine = item.tags.length ? ` [${item.tags.join(", ")}]` : "";
            return `- id: ${item.id}${tagLine}\n  prompt: ${item.prompt}`;
          }),
        ].join("\n")
      : "## Content pool\n(empty — pick decision=generate with a fresh prompt)";

  const userMessage = [
    `## Curation mode\n${mode}`,
    "",
    summary.trim()
      ? `## Broadcast state so far\n${summary.trim()}`
      : "## Broadcast state so far\n(opening cycle — no prior state)",
    "",
    previousImageryRationale.trim()
      ? `## Previous image on screen\n${previousImageryRationale.trim()}`
      : "## Previous image on screen\n(none — this is the first image)",
    "",
    poolBlock,
    "",
    "## Curated context (what the narrator is about to work with)",
    ctx.entries.length === 0
      ? "(no new entries this cycle)"
      : ctx.entries
          .map((e) => {
            const time = e.subjectTime ? ` @${e.subjectTime}` : "";
            return `- [${e.source}${time}] ${e.content}`;
          })
          .join("\n"),
    "",
    "Call the select_imagery tool now.",
  ].join("\n");

  const response = await client.generate({
    model: UTILITY_ANTHROPIC_MODEL,
    maxTokens: UTILITY_MAX_TOKENS,
    system: [{ text: systemPrompt, cache: true }],
    messages: [{ role: "user", content: userMessage }],
    tools: [IMAGERY_TOOL],
    toolChoice: { type: "tool", name: IMAGERY_TOOL_NAME },
  });

  const parsed = parseImageryToolCall(response.toolCalls?.[0], poolItems);
  if (!parsed) {
    // Tool wasn't called or returned malformed input. Safe fallback:
    // hold the previous image. Audio keeps flowing; the visual just
    // doesn't change. No listener-visible failure.
    return {
      decision: "hold",
      rationale: "tool call failed or returned malformed input",
    };
  }
  return parsed;
}

function parseImageryToolCall(
  toolCall: ToolCall | undefined,
  poolItems: ContentPoolItem[],
): ImagerySelection | null {
  if (!toolCall || toolCall.name !== IMAGERY_TOOL_NAME) return null;
  const input = toolCall.input as {
    image_requirement?: unknown;
    decision?: unknown;
    pool_item_id?: unknown;
    prompt?: unknown;
    rationale?: unknown;
  };
  const decision = input.decision;
  const requirement =
    typeof input.image_requirement === "string"
      ? input.image_requirement.trim()
      : undefined;
  const prompt =
    typeof input.prompt === "string" ? input.prompt.trim() : undefined;
  const poolItemId =
    typeof input.pool_item_id === "string" ? input.pool_item_id.trim() : undefined;
  const rationale =
    typeof input.rationale === "string" ? input.rationale.trim() : undefined;

  // Common fields preserved across decision branches. Requirement
  // tags along even on degraded outcomes — if Haiku articulated a
  // brief but then mispicked, the brief is still useful audit signal.
  const baseRequirement = requirement ? { requirement } : {};

  if (decision === "pool") {
    if (!poolItemId) {
      // Pool decision without an id — degrade to hold rather than
      // guessing. Rare enough not to mask a real bug.
      return { decision: "hold", ...baseRequirement, rationale: "pool decision without id" };
    }
    const item = poolItems.find((p) => p.id === poolItemId);
    if (!item) {
      // Picked an id not in the list — treat as hold. The LLM is
      // occasionally creative with identifiers.
      return {
        decision: "hold",
        ...baseRequirement,
        rationale: `pool_item_id ${poolItemId} not in provided list`,
      };
    }
    return {
      decision: "pool",
      ...baseRequirement,
      poolItemId: item.id,
      matchedPoolItem: { id: item.id, prompt: item.prompt, tags: item.tags },
      consumerMetadata: item.consumerMetadata,
      ...(rationale ? { rationale } : {}),
    };
  }

  if (decision === "generate") {
    if (!prompt) {
      return {
        decision: "hold",
        ...baseRequirement,
        rationale: "generate requested without a prompt",
      };
    }
    return {
      decision: "generate",
      ...baseRequirement,
      prompt,
      ...(rationale ? { rationale } : {}),
    };
  }

  return null;
}
