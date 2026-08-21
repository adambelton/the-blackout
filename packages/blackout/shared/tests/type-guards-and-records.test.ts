import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  BROADCAST_PHASES,
  BROADCAST_STATUSES,
  BROADCAST_TTS_PROVIDERS,
  BROADCAST_TTS_PROVIDER_LABELS,
  KAIROS_SOURCE_NAMES,
  TEAM_SIDES,
  USER_ROLES,
  isAdmin,
  isBroadcastPhase,
  isBroadcastStatus,
  isBroadcastTtsProvider,
  isKairosSourceName,
  isTeamSide,
  isUserRole,
  type BroadcastTtsProvider,
} from "../types/index.js";

/**
 * Shared type-guard / record-pairing contracts.
 *
 * Two regression classes the audit flagged:
 *
 *   1. Type guards untested at boundary inputs — `isBroadcastStatus`,
 *      `isUserRole`, etc. They run on user-supplied values (URL params,
 *      WS payloads, DB reads). A regression in any of them would let
 *      malformed values cross the boundary.
 *
 *   2. `*_STATUSES` / `*_PROVIDERS` Record pairings (e.g.
 *      `BROADCAST_TTS_PROVIDER_LABELS: Record<BroadcastTtsProvider,
 *      string>`) rely on TypeScript's exhaustiveness check at compile
 *      time. Adding a value to the array without adding a label would
 *      fail tsc — but only if someone runs tsc. These tests confirm
 *      the runtime shape matches the array, so a runtime read of any
 *      label is safe.
 */

describe("isBroadcastStatus", () => {
  it("accepts every value in BROADCAST_STATUSES", () => {
    for (const status of BROADCAST_STATUSES) assert.equal(isBroadcastStatus(status), true);
  });
  it("rejects unknown strings, numbers, null, undefined, objects", () => {
    for (const v of ["DRAFT", "Live", "", "active", 0, 1, null, undefined, {}, []]) {
      assert.equal(isBroadcastStatus(v), false, `should reject ${JSON.stringify(v)}`);
    }
  });
});

describe("isBroadcastTtsProvider", () => {
  it("accepts every value in BROADCAST_TTS_PROVIDERS", () => {
    for (const p of BROADCAST_TTS_PROVIDERS) assert.equal(isBroadcastTtsProvider(p), true);
  });
  it("rejects case variants, partial matches, non-strings", () => {
    for (const v of ["OpenAI", "openai ", "11labs", "deepgram", null, undefined, 0]) {
      assert.equal(isBroadcastTtsProvider(v), false);
    }
  });
});

describe("isTeamSide", () => {
  it("accepts every value in TEAM_SIDES", () => {
    for (const s of TEAM_SIDES) assert.equal(isTeamSide(s), true);
  });
  it("rejects null, undefined, neutral / draw, casing", () => {
    for (const v of [null, undefined, "Home", "AWAY", "draw", "neutral", "", 0, true]) {
      assert.equal(isTeamSide(v), false);
    }
  });
});

describe("isBroadcastPhase", () => {
  it("accepts every value in BROADCAST_PHASES", () => {
    for (const p of BROADCAST_PHASES) assert.equal(isBroadcastPhase(p), true);
  });
  it("rejects similar but invalid phase strings", () => {
    for (const v of ["live", "first_half", "second_half", "FT", "HT", "live_warmup", null]) {
      assert.equal(isBroadcastPhase(v), false);
    }
  });
});

describe("isKairosSourceName", () => {
  it("accepts every value in KAIROS_SOURCE_NAMES", () => {
    for (const n of KAIROS_SOURCE_NAMES) assert.equal(isKairosSourceName(n), true);
  });
  it("rejects close-but-wrong source names", () => {
    for (const v of [
      "MATCH_EVENTS",
      "match-events",
      "match_event",
      "narrative",
      "moderator_notes",
      null,
      undefined,
    ]) {
      assert.equal(isKairosSourceName(v), false);
    }
  });
});

describe("isUserRole", () => {
  it("accepts every value in USER_ROLES", () => {
    for (const r of USER_ROLES) assert.equal(isUserRole(r), true);
  });
  it("rejects member-default (undefined) and unknown roles", () => {
    for (const v of [undefined, null, "", "user", "member", "Admin", "ADMIN", "moderator"]) {
      assert.equal(isUserRole(v), false);
    }
  });
});

describe("isAdmin", () => {
  it("returns true only for the literal string 'admin'", () => {
    assert.equal(isAdmin("admin"), true);
  });
  it("rejects everything else, including 'writer' and member-default null/undefined", () => {
    for (const v of ["writer", "Admin", "ADMIN", "user", "", null, undefined]) {
      assert.equal(isAdmin(v as string | null | undefined), false);
    }
  });
});

describe("BROADCAST_TTS_PROVIDER_LABELS — exhaustive Record pairing", () => {
  it("has a label for every BROADCAST_TTS_PROVIDERS entry", () => {
    for (const p of BROADCAST_TTS_PROVIDERS) {
      assert.ok(
        BROADCAST_TTS_PROVIDER_LABELS[p],
        `missing label for provider ${p}`,
      );
      assert.equal(typeof BROADCAST_TTS_PROVIDER_LABELS[p], "string");
      assert.ok(
        BROADCAST_TTS_PROVIDER_LABELS[p].length > 0,
        `empty label for provider ${p}`,
      );
    }
  });

  it("has no labels for unknown providers (no leftover keys)", () => {
    const labelKeys = Object.keys(BROADCAST_TTS_PROVIDER_LABELS) as BroadcastTtsProvider[];
    const validKeys = new Set<string>(BROADCAST_TTS_PROVIDERS);
    for (const k of labelKeys) {
      assert.ok(
        validKeys.has(k),
        `label for unknown provider ${k} — leftover from a removed provider?`,
      );
    }
    assert.equal(
      labelKeys.length,
      BROADCAST_TTS_PROVIDERS.length,
      "label count must match provider count",
    );
  });
});
