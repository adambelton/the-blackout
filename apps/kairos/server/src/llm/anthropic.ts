import Anthropic from "@anthropic-ai/sdk";
import type { LLMClient, LLMRequest, LLMResponse, SystemSegment, ToolCall } from "./types.js";
import { LLMRateLimitError } from "./types.js";
import { DEFAULT_ANTHROPIC_MODEL, DEFAULT_MAX_TOKENS, DEFAULT_MAX_RETRIES } from "./defaults.js";

export interface AnthropicLLMClientOptions {
  apiKey?: string;
  defaultModel?: string;
  defaultMaxTokens?: number;
  maxRetries?: number;
}

function parseRetryAfterMs(headers: Headers | undefined): number | null {
  if (!headers) return null;
  const ms = headers.get("retry-after-ms");
  if (ms) {
    const n = parseFloat(ms);
    if (!Number.isNaN(n)) return n;
  }
  const sec = headers.get("retry-after");
  if (sec) {
    const n = parseFloat(sec);
    if (!Number.isNaN(n)) return n * 1000;
    const date = Date.parse(sec);
    if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  }
  return null;
}

export class AnthropicLLMClient implements LLMClient {
  private client: Anthropic;
  private defaultModel: string;
  private defaultMaxTokens: number;

  constructor(options: AnthropicLLMClientOptions = {}) {
    const apiKey = options.apiKey ?? process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error("ANTHROPIC_API_KEY is not set");
    }
    // The SDK's built-in retry respects retry-after and retry-after-ms
    // headers. Bumping maxRetries above the default 2 gives the Starter
    // plan's 60s TPM window time to reset before we surface the failure.
    this.client = new Anthropic({
      apiKey,
      maxRetries: options.maxRetries ?? DEFAULT_MAX_RETRIES,
    });
    this.defaultModel = options.defaultModel ?? DEFAULT_ANTHROPIC_MODEL;
    this.defaultMaxTokens = options.defaultMaxTokens ?? DEFAULT_MAX_TOKENS;
  }

  async generate(request: LLMRequest): Promise<LLMResponse> {
    try {
      const response = await this.client.messages.create({
        model: request.model ?? this.defaultModel,
        max_tokens: request.maxTokens ?? this.defaultMaxTokens,
        ...(request.system != null ? { system: translateSystem(request.system) } : {}),
        messages: request.messages,
        ...(request.tools ? { tools: translateTools(request.tools, request.cacheTools) } : {}),
        ...(request.toolChoice ? { tool_choice: translateToolChoice(request.toolChoice) } : {}),
      });

      const text = response.content
        .filter((block): block is Anthropic.TextBlock => block.type === "text")
        .map((block) => block.text)
        .join("\n\n");

      const toolCalls: ToolCall[] = response.content
        .filter((block): block is Anthropic.ToolUseBlock => block.type === "tool_use")
        .map((block) => ({ name: block.name, input: block.input }));

      // `cache_creation_input_tokens` / `cache_read_input_tokens` are only
      // present when a cache_control block was included in the request.
      const usage = response.usage as Anthropic.Usage & {
        cache_creation_input_tokens?: number;
        cache_read_input_tokens?: number;
      };

      return {
        text,
        usage: {
          inputTokens: usage.input_tokens,
          outputTokens: usage.output_tokens,
          ...(usage.cache_creation_input_tokens
            ? { cacheCreationInputTokens: usage.cache_creation_input_tokens }
            : {}),
          ...(usage.cache_read_input_tokens
            ? { cacheReadInputTokens: usage.cache_read_input_tokens }
            : {}),
        },
        ...(toolCalls.length > 0 ? { toolCalls } : {}),
      };
    } catch (err) {
      if (err instanceof Anthropic.RateLimitError) {
        throw new LLMRateLimitError(parseRetryAfterMs(err.headers), err.message);
      }
      throw err;
    }
  }
}

/**
 * Translate our provider-neutral system shape into Anthropic's. A plain
 * string goes through unchanged; a `SystemSegment[]` maps to text
 * blocks, with `cache: true` emitting a `cache_control: ephemeral`
 * marker. Anthropic caches everything in the request up to and
 * including each cache-control breakpoint.
 */
function translateSystem(system: NonNullable<LLMRequest["system"]>): Anthropic.MessageCreateParams["system"] {
  if (typeof system === "string") return system;
  return (system as SystemSegment[]).map((seg) => ({
    type: "text" as const,
    text: seg.text,
    ...(seg.cache ? { cache_control: { type: "ephemeral" as const } } : {}),
  }));
}

/**
 * When `cache` is true, mark the last tool with `cache_control`. That
 * caches the tool block (plus any system-cache content preceding it) as
 * a stable prefix, so subsequent calls pay the cheap read rate.
 */
function translateTools(tools: NonNullable<LLMRequest["tools"]>, cache?: boolean): Anthropic.Tool[] {
  const lastIdx = tools.length - 1;
  return tools.map((tool, i) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema as Anthropic.Tool.InputSchema,
    ...(cache && i === lastIdx ? { cache_control: { type: "ephemeral" as const } } : {}),
  }));
}

function translateToolChoice(choice: NonNullable<LLMRequest["toolChoice"]>): Anthropic.MessageCreateParams["tool_choice"] {
  switch (choice.type) {
    case "auto":
      return { type: "auto" };
    case "any":
      return { type: "any" };
    case "tool":
      return { type: "tool", name: choice.name };
  }
}
