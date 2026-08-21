import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateArchive, validateDelete } from "../src/lib/broadcast-transitions.js";
import type { BroadcastStatus } from "@blackout/shared";

// ----------------------------------------------------------------------------
// validateArchive — complete → archived is the only permitted transition.
// Any other source status is a 422. The guard exists to prevent an admin
// from accidentally hiding a broadcast that hasn't finished a full run.
// ----------------------------------------------------------------------------

describe("validateArchive", () => {
  it("allows archiving a completed broadcast", () => {
    assert.equal(validateArchive("complete"), null);
  });

  const blocked: BroadcastStatus[] = ["draft", "scheduled", "live", "archived"];
  for (const status of blocked) {
    it(`rejects archiving a ${status} broadcast`, () => {
      const err = validateArchive(status);
      assert.ok(err, `expected an error for status "${status}"`);
      assert.equal(err.statusCode, 422);
      assert.match(err.message, /only completed/i);
    });
  }
});

// ----------------------------------------------------------------------------
// validateDelete — live broadcasts cannot be deleted; every other status
// is safe to remove. Deleting live would pull the room out from under
// active members mid-match.
// ----------------------------------------------------------------------------

describe("validateDelete", () => {
  it("blocks deletion of a live broadcast", () => {
    const err = validateDelete("live");
    assert.ok(err);
    assert.equal(err.statusCode, 422);
    assert.match(err.message, /live/i);
  });

  const allowed: BroadcastStatus[] = ["draft", "scheduled", "complete", "archived"];
  for (const status of allowed) {
    it(`allows deleting a ${status} broadcast`, () => {
      assert.equal(validateDelete(status), null);
    });
  }
});
