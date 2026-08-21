import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { checkGenerationInvariants } from "../src/invariants.js";

let warnings: string[] = [];
let errors: string[] = [];
const origWarn = console.warn;
const origError = console.error;

beforeEach(() => {
  warnings = [];
  errors = [];
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map((a) => String(a)).join(" "));
  };
  console.error = (...args: unknown[]) => {
    errors.push(args.map((a) => String(a)).join(" "));
  };
});
afterEach(() => {
  console.warn = origWarn;
  console.error = origError;
});

const baseArgs = {
  broadcastId: "b1",
  narrativeId: "n1",
  covers: [],
  includedEntryIds: Array.from({ length: 7 }, (_, i) => `e${i}`),
  phantomCoverCount: 0,
  toolCallFailed: false,
};

describe("checkGenerationInvariants", () => {
  it("fires nothing for a clean generation", () => {
    checkGenerationInvariants(baseArgs);
    assert.equal(warnings.length, 0);
    assert.equal(errors.length, 0);
  });

  it("fires phantom_covers when phantoms were filtered", () => {
    checkGenerationInvariants({ ...baseArgs, phantomCoverCount: 2 });
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /\[invariant:phantom_covers\]/);
    assert.match(warnings[0], /2 entry id/);
  });

  it("fires tool_call_failed when the generator went off-tool", () => {
    checkGenerationInvariants({ ...baseArgs, toolCallFailed: true });
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /\[invariant:tool_call_failed\]/);
  });

  it("fires multiple invariants simultaneously when relevant", () => {
    checkGenerationInvariants({
      ...baseArgs,
      phantomCoverCount: 3,
      toolCallFailed: true,
    });
    assert.equal(warnings.length, 2);
    assert.ok(warnings.some((w) => /phantom_covers/.test(w)));
    assert.ok(warnings.some((w) => /tool_call_failed/.test(w)));
  });
});
