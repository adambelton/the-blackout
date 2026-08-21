/**
 * Auto-tag derivation for accepted pool illustrations.
 *
 * Runs a short Haiku call on the accepted prompt and returns a small
 * set of free-text tags covering content (what's shown) and mood
 * (how it feels). The writer sees the tags in the studio and can
 * edit them before the accept commits; at runtime, Kairos's imagery
 * selector uses the tags to match pool images to passages.
 *
 * Free-text vocabulary on purpose — closed taxonomies are brittle at
 * this stage. If a pattern emerges across many broadcasts we'll
 * tighten it later.
 */
import type Anthropic from "@anthropic-ai/sdk";
import { getAnthropicClient } from "./anthropic.js";

const MODEL = "claude-haiku-4-5-20251001";
const MAX_TOKENS = 512;

const TOOL = {
  name: "tag_illustration",
  description: "Return a short list of free-text tags for the illustration.",
  input_schema: {
    type: "object" as const,
    properties: {
      tags: {
        type: "array" as const,
        description:
          "3 to 7 lowercase tags. Mix content (subject, setting) and mood (atmosphere, feeling). Single words or short phrases.",
        items: { type: "string" as const },
      },
    },
    required: ["tags"],
  },
};

const SYSTEM = [
  "You tag illustrations so a runtime selector can match them to narrative passages.",
  "Given a prompt describing a single illustration, return 3-7 short tags.",
  "Tags should cover what's shown (content: goalkeeper, stands, tunnel, rain, floodlights) and how it feels (mood: tense, quiet, exultant, deflated, anticipatory).",
  "Lowercase, short (single words or 2-word phrases). No punctuation.",
  "Return via the tag_illustration tool.",
].join("\n");

function getClient(): Anthropic {
  return getAnthropicClient("tag derivation");
}

export async function deriveTags(prompt: string): Promise<string[]> {
  const trimmed = prompt.trim();
  if (!trimmed) return [];

  const client = getClient();
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system: SYSTEM,
    messages: [{ role: "user", content: `Prompt: ${trimmed}` }],
    tools: [TOOL],
    tool_choice: { type: "tool", name: TOOL.name },
  });

  const toolUse = response.content.find(
    (block): block is Anthropic.ToolUseBlock => block.type === "tool_use",
  );
  if (!toolUse) return [];
  const parsed = toolUse.input as { tags?: unknown };
  if (!Array.isArray(parsed.tags)) return [];
  return parsed.tags
    .filter((t): t is string => typeof t === "string")
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t.length > 0);
}
