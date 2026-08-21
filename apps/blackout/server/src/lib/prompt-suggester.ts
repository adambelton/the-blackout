/**
 * Illustration-prompt suggester.
 *
 * Haiku call that takes the match brief plus the writer's
 * accepted/discarded history and returns a batch of new prompt
 * suggestions for the studio. Prompts describe *scenes* — subject,
 * setting, light, mood. They never describe rendering style (that's
 * pinned by content/illustration-style.md and appended by the
 * Replicate client).
 *
 * Directional signal: accepted prompts shape what more the writer is
 * likely to want; discarded prompts steer away from themes they've
 * already rejected. Both lists arrive verbatim in the prompt context
 * — the LLM reads between the lines.
 */
import type Anthropic from "@anthropic-ai/sdk";
import { getAnthropicClient } from "./anthropic.js";

// Haiku is the right rung here: cheap, fast, good enough for
// scene-description prose. Same model Kairos uses for enrichment and
// curation.
const MODEL = "claude-haiku-4-5-20251001";
const MAX_TOKENS = 4096;

export interface SuggestPromptsInput {
  matchBrief: string;
  accepted: string[];
  discarded: string[];
  count: number;
}

export interface SuggestPromptsResult {
  prompts: string[];
  usage: {
    inputTokens: number;
    outputTokens: number;
  };
}

const TOOL = {
  name: "suggest_prompts",
  description:
    "Return the full batch of illustration-prompt suggestions as an array of strings.",
  input_schema: {
    type: "object" as const,
    properties: {
      prompts: {
        type: "array" as const,
        description:
          "Illustration prompts. Each string describes a scene (subject, setting, mood) — not a rendering style. 1-3 sentences, written as directions to an illustrator.",
        items: { type: "string" as const },
      },
    },
    required: ["prompts"],
  },
};

function buildSystem(): string {
  return [
    "You are an illustration-prompt assistant for The Blackout, a literary football broadcast.",
    "Your job is to suggest visual scene prompts a writer will pick from to build an illustration pool for a specific match.",
    "",
    "Each prompt describes a single illustration — a scene, a mood, a figure, an atmosphere. Prompts must be:",
    "- Illustrative and specific. Describe what to show (subject, setting, light, feeling). Never describe rendering style, medium, palette, or technique — that is pinned separately.",
    "- Rooted in the match brief you'll be given. Players, clubs, grounds, weather, moods from the brief are fair game; invent nothing that conflicts with it.",
    "- Free of in-scene text. No scoreboards, banners, chalkboards, letters, numbers, or typography in the render. Flux misses lettering and it breaks the image.",
    "- Varied across the batch. Mix wide scene-setters (pitch, stands, floodlights), close human moments (a glance, a held breath, hands on hips), and abstract atmospheres (rain, dusk, a goalkeeper alone in frame). Don't let the batch settle into one register.",
    "- Short — 1 to 3 sentences each. Written as direction to an illustrator, not captions for the audience.",
    "",
    "Return the batch via the suggest_prompts tool.",
  ].join("\n");
}

function buildUserMessage(input: SuggestPromptsInput): string {
  const parts: string[] = [];
  parts.push("## Match brief");
  parts.push(input.matchBrief.trim());
  parts.push("");

  if (input.accepted.length > 0) {
    parts.push("## Already accepted into the pool");
    parts.push(
      "The writer has accepted these prompts — generate new ones in a similar spirit, but never duplicate a theme or near-duplicate.",
    );
    parts.push("");
    for (const p of input.accepted) parts.push(`- ${p}`);
    parts.push("");
  }

  if (input.discarded.length > 0) {
    parts.push("## Already discarded");
    parts.push(
      "The writer rejected these — steer clear of the themes, subjects, or moods they represent.",
    );
    parts.push("");
    for (const p of input.discarded) parts.push(`- ${p}`);
    parts.push("");
  }

  parts.push(`## Task`);
  parts.push(
    `Produce exactly ${input.count} new illustration prompts. Return them via the suggest_prompts tool.`,
  );
  return parts.join("\n");
}

function getClient(): Anthropic {
  return getAnthropicClient("prompt suggestion");
}

export async function suggestPrompts(
  input: SuggestPromptsInput,
): Promise<SuggestPromptsResult> {
  if (!input.matchBrief.trim()) {
    throw new Error("Match brief is required to suggest prompts");
  }
  if (input.count < 1 || input.count > 100) {
    throw new Error(`Invalid count: ${input.count} (expected 1..100)`);
  }

  const client = getClient();
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system: buildSystem(),
    messages: [{ role: "user", content: buildUserMessage(input) }],
    tools: [TOOL],
    tool_choice: { type: "tool", name: TOOL.name },
  });

  const toolUse = response.content.find(
    (block): block is Anthropic.ToolUseBlock => block.type === "tool_use",
  );
  if (!toolUse) {
    throw new Error(
      "Haiku returned no tool call — cannot parse prompt suggestions",
    );
  }
  const parsed = toolUse.input as { prompts?: unknown };
  if (!Array.isArray(parsed.prompts)) {
    throw new Error("Tool call output missing a prompts array");
  }
  const prompts = parsed.prompts
    .filter((p): p is string => typeof p === "string")
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  return {
    prompts,
    usage: {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
    },
  };
}
