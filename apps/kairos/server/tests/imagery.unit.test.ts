import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { selectImagery } from "../src/narrative/imagery.js";
import type {
  LLMClient,
  LLMRequest,
  LLMResponse,
  ToolCall,
} from "../src/llm/types.js";
import type { ContentPoolItem } from "../src/db/pool.js";
import type { GenerationContext } from "../src/narrative/types.js";

/**
 * Scripting-stub for the imagery path. The default StubLLMClient
 * short-circuits `select_imagery` to a `hold` response; here we
 * want to script real decisions to exercise the parser.
 */
class ScriptedClient implements LLMClient {
  constructor(private toolCall: ToolCall) {}
  async generate(_request: LLMRequest): Promise<LLMResponse> {
    return { text: "", toolCalls: [this.toolCall] };
  }
}

function emptyCtx(): GenerationContext {
  return { entries: [], currentSubjectMinute: null };
}

function poolItem(overrides: Partial<ContentPoolItem> = {}): ContentPoolItem {
  return {
    id: overrides.id ?? "p_1",
    broadcastId: overrides.broadcastId ?? "b_1",
    prompt: overrides.prompt ?? "A pencil sketch of the pitch at dusk.",
    tags: overrides.tags ?? ["dusk", "wide"],
    consumerMetadata: overrides.consumerMetadata ?? { illustrationId: "i_1" },
    createdAt: overrides.createdAt ?? 0,
  };
}

describe("selectImagery — decision parsing", () => {
  it("returns a pool decision with denormalised pool item snapshot when the id matches", async () => {
    const client = new ScriptedClient({
      name: "select_imagery",
      input: {
        image_requirement: "Pencil-sketch wide of the pitch at dusk, quiet.",
        decision: "pool",
        pool_item_id: "p_1",
        rationale: "matches mood",
      },
    });
    const result = await selectImagery({
      client,
      ctx: emptyCtx(),
      mode: "enrichment_led",
      summary: "",
      previousImageryRationale: "",
      poolItems: [poolItem({ id: "p_1" })],
    });
    assert.equal(result.decision, "pool");
    assert.equal(result.requirement, "Pencil-sketch wide of the pitch at dusk, quiet.");
    assert.equal(result.poolItemId, "p_1");
    assert.deepEqual(result.matchedPoolItem, {
      id: "p_1",
      prompt: "A pencil sketch of the pitch at dusk.",
      tags: ["dusk", "wide"],
    });
    assert.deepEqual(result.consumerMetadata, { illustrationId: "i_1" });
    assert.equal(result.rationale, "matches mood");
  });

  it("degrades to hold when the LLM returns pool without a pool_item_id — preserves requirement for audit", async () => {
    const client = new ScriptedClient({
      name: "select_imagery",
      input: {
        image_requirement: "Tight on the goalkeeper mid-dive.",
        decision: "pool",
      },
    });
    const result = await selectImagery({
      client,
      ctx: emptyCtx(),
      mode: "enrichment_led",
      summary: "",
      previousImageryRationale: "",
      poolItems: [poolItem()],
    });
    assert.equal(result.decision, "hold");
    assert.equal(result.requirement, "Tight on the goalkeeper mid-dive.");
    assert.match(result.rationale ?? "", /pool decision without id/);
  });

  it("degrades to hold when the LLM invents a pool_item_id not in the list", async () => {
    const client = new ScriptedClient({
      name: "select_imagery",
      input: {
        image_requirement: "Wide stadium, floodlit night.",
        decision: "pool",
        pool_item_id: "ghost",
      },
    });
    const result = await selectImagery({
      client,
      ctx: emptyCtx(),
      mode: "enrichment_led",
      summary: "",
      previousImageryRationale: "",
      poolItems: [poolItem()],
    });
    assert.equal(result.decision, "hold");
    assert.equal(result.requirement, "Wide stadium, floodlit night.");
    assert.match(result.rationale ?? "", /not in provided list/);
  });

  it("returns a generate decision carrying the requirement and the fresh-generate prompt", async () => {
    const client = new ScriptedClient({
      name: "select_imagery",
      input: {
        image_requirement:
          "A lone goalkeeper isolated in the box as the camera holds the moment of the wait.",
        decision: "generate",
        prompt: "A lone goalkeeper at dusk, floodlights.",
      },
    });
    const result = await selectImagery({
      client,
      ctx: emptyCtx(),
      mode: "enrichment_led",
      summary: "",
      previousImageryRationale: "",
      poolItems: [],
    });
    assert.equal(result.decision, "generate");
    assert.equal(
      result.requirement,
      "A lone goalkeeper isolated in the box as the camera holds the moment of the wait.",
    );
    assert.equal(result.prompt, "A lone goalkeeper at dusk, floodlights.");
  });

  it("degrades to hold when generate arrives without a prompt", async () => {
    const client = new ScriptedClient({
      name: "select_imagery",
      input: { decision: "generate" },
    });
    const result = await selectImagery({
      client,
      ctx: emptyCtx(),
      mode: "enrichment_led",
      summary: "",
      previousImageryRationale: "",
      poolItems: [],
    });
    assert.equal(result.decision, "hold");
    assert.match(result.rationale ?? "", /generate requested without a prompt/);
  });

  it("falls back to hold when no tool call is made", async () => {
    const client: LLMClient = {
      async generate() {
        return { text: "plain text fallback", toolCalls: [] };
      },
    };
    const result = await selectImagery({
      client,
      ctx: emptyCtx(),
      mode: "enrichment_led",
      summary: "",
      previousImageryRationale: "",
      poolItems: [],
    });
    assert.equal(result.decision, "hold");
    assert.match(result.rationale ?? "", /tool call failed/);
  });

  it("returns hold on malformed decision value", async () => {
    const client = new ScriptedClient({
      name: "select_imagery",
      input: { decision: "nope" },
    });
    const result = await selectImagery({
      client,
      ctx: emptyCtx(),
      mode: "enrichment_led",
      summary: "",
      previousImageryRationale: "",
      poolItems: [],
    });
    assert.equal(result.decision, "hold");
  });
});
