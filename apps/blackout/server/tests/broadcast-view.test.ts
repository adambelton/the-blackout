import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  computeGuardedEntryIds,
  inferPhaseFromStatus,
  parseMatchTime,
} from "../src/lib/broadcast-view-logic.js";
import type { Broadcast } from "@blackout/shared";

// Tests for the pure-logic slices of buildBroadcastView. The I/O
// orchestration (DB read, Kairos fetch, storage signed URL) is
// exercised end-to-end via the live broadcast path — here we nail
// down the reveal contract, content-time parsing, and phase
// inference.

function narration(overrides: {
  playbackStartedAt: Date | null;
  durationMs?: number;
  covers?: { entryId: string }[];
}) {
  return {
    playbackStartedAt: overrides.playbackStartedAt,
    durationMs: overrides.durationMs ?? 30_000,
    covers: overrides.covers ?? [],
  };
}

describe("computeGuardedEntryIds", () => {
  // The reveal contract — see docs/matchroom-state-model.md (TODO).
  // Events are visible by default; the only reason an event card
  // stays hidden is that a narration currently playing has it in
  // its covers list. Once the narration's audio ends (or no
  // currently-playing narration covers it), the card is revealed.
  const now = 10_000;

  it("returns empty when there are no narrations", () => {
    const ids = computeGuardedEntryIds([], now);
    assert.equal(ids.size, 0);
  });

  it("ignores narrations that haven't started playback", () => {
    const ids = computeGuardedEntryIds(
      [
        narration({
          playbackStartedAt: null,
          covers: [{ entryId: "e1" }, { entryId: "e2" }],
        }),
      ],
      now,
    );
    assert.equal(ids.size, 0);
  });

  it("guards covers of an in-flight narration", () => {
    // Started 5s ago, 30s duration → ends 25s in the future.
    const startedAt = new Date(now - 5_000);
    const ids = computeGuardedEntryIds(
      [
        narration({
          playbackStartedAt: startedAt,
          durationMs: 30_000,
          covers: [{ entryId: "g1" }, { entryId: "g2" }],
        }),
      ],
      now,
    );
    assert.deepEqual([...ids].sort(), ["g1", "g2"]);
  });

  it("releases covers once a narration's audio has ended", () => {
    // Started 60s ago, 30s duration → ended 30s in the past.
    const startedAt = new Date(now - 60_000);
    const ids = computeGuardedEntryIds(
      [
        narration({
          playbackStartedAt: startedAt,
          durationMs: 30_000,
          covers: [{ entryId: "old1" }],
        }),
      ],
      now,
    );
    assert.equal(ids.size, 0);
  });

  it("guards covers from multiple in-flight narrations simultaneously", () => {
    const a = new Date(now - 1_000);
    const b = new Date(now - 2_000);
    const ids = computeGuardedEntryIds(
      [
        narration({ playbackStartedAt: a, durationMs: 30_000, covers: [{ entryId: "a1" }] }),
        narration({ playbackStartedAt: b, durationMs: 30_000, covers: [{ entryId: "b1" }] }),
      ],
      now,
    );
    assert.deepEqual([...ids].sort(), ["a1", "b1"]);
  });

  it("guards only the in-flight narration when one has ended and one is playing", () => {
    const finished = new Date(now - 60_000);
    const inFlight = new Date(now - 1_000);
    const ids = computeGuardedEntryIds(
      [
        narration({ playbackStartedAt: finished, durationMs: 30_000, covers: [{ entryId: "old" }] }),
        narration({ playbackStartedAt: inFlight, durationMs: 30_000, covers: [{ entryId: "new" }] }),
      ],
      now,
    );
    assert.deepEqual([...ids], ["new"]);
  });

  it("treats endedMs === nowMs as just-finished (releases the cover)", () => {
    // Boundary case: startedAt 30s ago, durationMs 30_000 → endedMs
    // === nowMs. The guard is `endedMs > nowMs`, so equality means
    // the audio is landing right now and the cover is released —
    // matches the live audio-end reveal moment.
    const startedAt = new Date(now - 30_000);
    const ids = computeGuardedEntryIds(
      [narration({ playbackStartedAt: startedAt, durationMs: 30_000, covers: [{ entryId: "x" }] })],
      now,
    );
    assert.equal(ids.size, 0);
  });

  it("dedupes entry ids when multiple in-flight narrations cover the same entry", () => {
    // Theoretical edge case — same canonical event referenced by
    // two overlapping narrations. The guard set is a Set, so the
    // entry id appears once.
    const a = new Date(now - 1_000);
    const b = new Date(now - 2_000);
    const ids = computeGuardedEntryIds(
      [
        narration({ playbackStartedAt: a, durationMs: 30_000, covers: [{ entryId: "shared" }] }),
        narration({ playbackStartedAt: b, durationMs: 30_000, covers: [{ entryId: "shared" }] }),
      ],
      now,
    );
    assert.equal(ids.size, 1);
    assert.equal(ids.has("shared"), true);
  });
});

describe("parseMatchTime", () => {
  // Drives the matchroom event ribbon's match-minute ordering and
  // the buildBroadcastView's "latest revealed event" selection for
  // currentContentMinute. The full ordering contract:
  //   pre_match < numerics in order < HT < second-half numerics < FT

  it("parses plain numerics", () => {
    assert.equal(parseMatchTime("3"), 3);
    assert.equal(parseMatchTime("47"), 47);
    assert.equal(parseMatchTime("90"), 90);
  });

  it("places stoppage-time forms with a fractional bump", () => {
    // "45+2" should sort after "45" and before "46". Same for 90+N.
    assert.ok(parseMatchTime("45+2") > 45);
    assert.ok(parseMatchTime("45+2") < 46);
    assert.ok(parseMatchTime("90+5") > 90);
    assert.ok(parseMatchTime("90+5") < 91);
  });

  it("places phase labels in the correct slots", () => {
    assert.equal(parseMatchTime("pre_match"), -1);
    assert.equal(parseMatchTime("HT"), 45.5);
    assert.equal(parseMatchTime("FT"), 9999);
  });

  it("returns -Infinity for empty or unparseable values", () => {
    assert.equal(parseMatchTime(undefined), -Infinity);
    assert.equal(parseMatchTime(null), -Infinity);
    assert.equal(parseMatchTime(""), -Infinity);
    assert.equal(parseMatchTime("nonsense"), -Infinity);
  });

  it("orders pre_match < numerics < HT < second-half numerics < FT", () => {
    const labels = ["FT", "47", "HT", "3", "pre_match", "45+2", "90+5"];
    const sorted = [...labels].sort((a, b) => parseMatchTime(a) - parseMatchTime(b));
    assert.deepEqual(sorted, ["pre_match", "3", "45+2", "HT", "47", "90+5", "FT"]);
  });

  it("places HT after stoppage but before second-half regular minutes", () => {
    // "45+5" parses to 45.05 (stoppage), HT to 45.5, "46" to 46.
    // Important for the matchroom: HT card lands chronologically
    // after first-half stoppage events but before any 2H minute.
    assert.ok(parseMatchTime("45+5") < parseMatchTime("HT"));
    assert.ok(parseMatchTime("HT") < parseMatchTime("46"));
  });
});

describe("inferPhaseFromStatus", () => {
  function broadcast(status: Broadcast["status"]): Broadcast {
    return {
      id: "b1",
      homeTeam: "Home",
      awayTeam: "Away",
      competition: "League",
      matchDate: new Date().toISOString(),
      status,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }

  it("maps complete → complete", () => {
    assert.equal(inferPhaseFromStatus(broadcast("complete")), "complete");
  });

  it("maps live → warming (conductor phase overrides at runtime)", () => {
    // inferPhaseFromStatus is the fallback when no conductor exists.
    // At this seam we don't know which half of the match we're in —
    // the real phase comes from the conductor. `warming` is the safe
    // default it settles into on fresh construction.
    assert.equal(inferPhaseFromStatus(broadcast("live")), "warming");
  });

  it("maps draft → pre_ramp", () => {
    assert.equal(inferPhaseFromStatus(broadcast("draft")), "pre_ramp");
  });

  it("maps scheduled → pre_ramp", () => {
    assert.equal(inferPhaseFromStatus(broadcast("scheduled")), "pre_ramp");
  });
});
