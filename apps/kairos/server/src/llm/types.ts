/**
 * Provider-neutral contract for calling a large language model.
 * Kairos speaks LLMRequest/LLMResponse internally; provider-specific
 * translation lives inside each implementation.
 */

export interface LLMMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ToolDefinition {
  name: string;
  description?: string;
  /** JSON Schema for the tool's input. */
  inputSchema: Record<string, unknown>;
}

export type ToolChoice =
  | { type: "auto" }
  | { type: "any" }
  | { type: "tool"; name: string };

export interface ToolCall {
  name: string;
  input: unknown;
}

/**
 * A segment of the system prompt. Setting `cache: true` asks the provider
 * to cache everything up to and including this segment. Anthropic's
 * ephemeral cache gives ~90% off on reads at the cost of ~25% on writes;
 * the stable voice/context/task blocks pay back on the second cycle.
 */
export interface SystemSegment {
  text: string;
  cache?: boolean;
}

export interface LLMRequest {
  system?: string | SystemSegment[];
  messages: LLMMessage[];
  maxTokens?: number;
  model?: string;
  tools?: ToolDefinition[];
  toolChoice?: ToolChoice;
  /**
   * When true, the provider is asked to cache the tools definition
   * block. Tools are stable across a broadcast; caching them trims
   * ~200 tokens of uncached input per cycle.
   */
  cacheTools?: boolean;
}

export interface LLMUsage {
  /** Uncached input tokens — charged at full rate. */
  inputTokens: number;
  outputTokens: number;
  /** Tokens written into the cache this call — charged at a ~25% premium. */
  cacheCreationInputTokens?: number;
  /** Tokens read from the cache this call — charged at ~10% of full rate. */
  cacheReadInputTokens?: number;
}

export interface LLMResponse {
  text: string;
  usage?: LLMUsage;
  toolCalls?: ToolCall[];
}

export interface LLMClient {
  generate(request: LLMRequest): Promise<LLMResponse>;
}

/**
 * Provider-neutral rate-limit signal. Wraps the SDK's 429 so the engine
 * can react (emit `generation_skipped`, skip persistence) without
 * coupling to any provider's error taxonomy. `retryAfterMs` is the
 * earliest moment a retry could succeed, when the provider tells us.
 */
export class LLMRateLimitError extends Error {
  readonly retryAfterMs: number | null;

  constructor(retryAfterMs: number | null, message = "Rate limited") {
    super(message);
    this.name = "LLMRateLimitError";
    this.retryAfterMs = retryAfterMs;
  }
}
