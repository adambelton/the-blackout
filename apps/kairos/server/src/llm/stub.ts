import type { LLMClient, LLMRequest, LLMResponse } from "./types.js";

export type ScriptedOutcome = LLMResponse | Error;

/**
 * Convenience builder for a `deliver_narrative` tool-use response.
 * Tests usually want "generator got prose back with these covers" —
 * writing the full LLMResponse shape by hand is noisy.
 */
export function toolUseResponse(opts: {
  prose: string;
  covers?: Array<{ entryId: string; subjectTime?: string }>;
  usage?: LLMResponse["usage"];
}): LLMResponse {
  return {
    text: "",
    usage: opts.usage,
    toolCalls: [
      {
        name: "deliver_narrative",
        input: { prose: opts.prose, covers: opts.covers ?? [] },
      },
    ],
  };
}

/**
 * Test double. Returns pre-scripted responses in order, records every
 * call for assertions. Scripted items may be either a response object
 * or an Error — an Error is thrown when reached, letting tests drive
 * error-path behaviour (e.g. rate limiting). Throws if asked for more
 * responses than scripted.
 *
 * Narrator-call routing: the curator now runs many LLM-driven services
 * before the generator, so `narrative/generate` drives a variable number
 * of LLM calls per cycle (enrichment + curator services + narrator).
 * Tests that want to assert on the *narrator's* response specifically
 * use `setNarratorResponse(...)` — when set, requests carrying the
 * `deliver_narrative` tool are answered with that response (or error)
 * directly, while every other call drains from the regular queue. This
 * keeps the test's intent local without forcing it to count cycle
 * internals.
 */
export class StubLLMClient implements LLMClient {
  readonly calls: LLMRequest[] = [];
  private responses: ScriptedOutcome[];
  private narratorResponse: ScriptedOutcome | null = null;

  constructor(responses: ScriptedOutcome[]) {
    this.responses = [...responses];
  }

  /** Clear recorded calls and replace the scripted responses. Also
   * clears any narrator-specific response from a previous test. */
  reset(responses: ScriptedOutcome[]): void {
    this.calls.length = 0;
    this.responses = [...responses];
    this.narratorResponse = null;
  }

  /** Register a response (or error) that will be returned for any LLM
   * request carrying the `deliver_narrative` tool. Persists across
   * calls until cleared by `reset` or by passing `null`. */
  setNarratorResponse(outcome: ScriptedOutcome | null): void {
    this.narratorResponse = outcome;
  }

  /** Clear recorded calls without touching the scripted-response queue.
   * Use after a setup step that fires LLM calls the test isn't trying
   * to assert on (e.g. the brief initialisation pass during
   * activation) — so subsequent `calls.length`/`calls[0]` assertions
   * see only the calls the test cares about. */
  clearCalls(): void {
    this.calls.length = 0;
  }

  async generate(request: LLMRequest): Promise<LLMResponse> {
    // Auto-respond to imagery tool calls with a benign `hold` decision
    // so tests focused on narrative behaviour don't have to script a
    // response for every cycle's imagery side-call. Not recorded in
    // `calls` — keeps `calls` a view of the scripted interactions the
    // test actually cares about. Tests asserting imagery behaviour
    // should hit the imagery module directly.
    if (isImageryRequest(request)) {
      return {
        text: "",
        toolCalls: [
          {
            name: "select_imagery",
            input: { decision: "hold", rationale: "stub default" },
          },
        ],
      };
    }

    this.calls.push(request);

    if (this.narratorResponse !== null && isNarratorRequest(request)) {
      if (this.narratorResponse instanceof Error) throw this.narratorResponse;
      return this.narratorResponse;
    }

    const next = this.responses.shift();
    if (!next) {
      throw new Error(`StubLLMClient exhausted after ${this.calls.length} call(s)`);
    }
    if (next instanceof Error) {
      throw next;
    }
    return next;
  }
}

function isImageryRequest(request: LLMRequest): boolean {
  const choice = request.toolChoice;
  if (choice && choice.type === "tool" && choice.name === "select_imagery") {
    return true;
  }
  return (request.tools ?? []).some((t) => t.name === "select_imagery");
}

function isNarratorRequest(request: LLMRequest): boolean {
  return (request.tools ?? []).some((t) => t.name === "deliver_narrative");
}
