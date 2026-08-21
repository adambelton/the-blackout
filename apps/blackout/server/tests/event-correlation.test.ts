import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  CORRELATION_WINDOW_MS,
  VAR_CORRELATION_WINDOW_MS,
  isEventClass,
  windowForClass,
  claimMatchesCanonical,
  textureMatchesCanonical,
  resolveCanonical,
  pruneExpired,
  findCanonicalForLateArrival,
  surnameKey,
  teamKey,
  type CanonicalEventEntry,
  type EventClass,
  type PendingClaim,
  type PendingTexture,
} from "../src/lib/event-correlation.js";

/**
 * Pure correlation rules. The runner owns the ledgers + I/O; this
 * module decides what matches what. Tests cover every public function
 * and the contract every caller depends on:
 *   - phase whistles match on class alone (unique per match)
 *   - player-bearing classes prefer surname identity, fall back to
 *     class-only when neither side has a name, refuse mixed
 *   - calibration samples emit only the OLDEST matching pending claim
 *   - multiple textures can release on a single canonical
 *   - prune respects per-class windows (VAR is wider)
 */

const NOW = 1_000_000_000_000;

function canonical(overrides: Partial<CanonicalEventEntry> = {}): CanonicalEventEntry {
  return {
    eventId: "c1",
    eventClass: "GOAL",
    playerLastName: "haaland",
    teamKey: null,
    subjectTime: "12",
    realWallClockMs: NOW,
    addedAt: NOW,
    ...overrides,
  };
}

function claim(overrides: Partial<PendingClaim> = {}): PendingClaim {
  return {
    claimId: "claim-1",
    eventClass: "GOAL",
    playerLastName: "haaland",
    teamKey: null,
    subjectTimeHint: "12",
    claimedAtMs: NOW,
    addedAt: NOW,
    ...overrides,
  };
}

function texture(overrides: Partial<PendingTexture> = {}): PendingTexture {
  return {
    textureId: "tex-1",
    content: "the keeper got a hand to it",
    eventHint: {
      eventClass: "GOAL",
      playerLastName: "haaland",
      teamKey: null,
      minuteHint: "12",
    },
    observedAtMs: NOW,
    addedAt: NOW,
    ...overrides,
  };
}

// --- isEventClass ---------------------------------------------------

describe("isEventClass", () => {
  it("recognises every member of the EventClass union", () => {
    const classes: EventClass[] = [
      "KICKOFF", "HALFTIME", "SECOND_HALF_KICKOFF", "FULL_TIME",
      "GOAL", "YELLOW_CARD", "RED_CARD", "SUBSTITUTION", "VAR_CHECK", "PENALTY_AWARDED",
    ];
    for (const c of classes) assert.equal(isEventClass(c), true);
  });

  it("rejects strings outside the union", () => {
    assert.equal(isEventClass("OWN_GOAL"), false);
    assert.equal(isEventClass("goal"), false); // case-sensitive
    assert.equal(isEventClass(""), false);
  });

  it("rejects non-string values", () => {
    assert.equal(isEventClass(undefined), false);
    assert.equal(isEventClass(null), false);
    assert.equal(isEventClass(14), false);
  });
});

// --- windowForClass -------------------------------------------------

describe("windowForClass", () => {
  it("returns the wider VAR window for VAR_CHECK", () => {
    assert.equal(windowForClass("VAR_CHECK"), VAR_CORRELATION_WINDOW_MS);
    assert.equal(VAR_CORRELATION_WINDOW_MS, 120_000);
  });

  it("returns the standard window for every other class", () => {
    const classes: EventClass[] = [
      "KICKOFF", "HALFTIME", "SECOND_HALF_KICKOFF", "FULL_TIME",
      "GOAL", "YELLOW_CARD", "RED_CARD", "SUBSTITUTION", "PENALTY_AWARDED",
    ];
    for (const c of classes) assert.equal(windowForClass(c), CORRELATION_WINDOW_MS);
    assert.equal(CORRELATION_WINDOW_MS, 90_000);
  });
});

// --- claimMatchesCanonical -----------------------------------------

describe("claimMatchesCanonical — phase whistles", () => {
  for (const cls of ["KICKOFF", "HALFTIME", "SECOND_HALF_KICKOFF", "FULL_TIME", "VAR_CHECK"] as EventClass[]) {
    it(`matches ${cls} on class alone (player/team irrelevant)`, () => {
      const m = claimMatchesCanonical(
        claim({ eventClass: cls, playerLastName: null }),
        canonical({ eventClass: cls, playerLastName: null }),
      );
      assert.equal(m, true);
    });
  }
});

describe("claimMatchesCanonical — different class never matches", () => {
  it("GOAL claim doesn't match KICKOFF canonical", () => {
    assert.equal(
      claimMatchesCanonical(claim({ eventClass: "GOAL" }), canonical({ eventClass: "KICKOFF" })),
      false,
    );
  });
});

describe("claimMatchesCanonical — player-bearing classes", () => {
  it("matches when both sides have the same surname", () => {
    assert.equal(
      claimMatchesCanonical(
        claim({ playerLastName: "haaland" }),
        canonical({ playerLastName: "haaland" }),
      ),
      true,
    );
  });

  it("rejects when both sides have surnames that differ", () => {
    assert.equal(
      claimMatchesCanonical(
        claim({ playerLastName: "haaland" }),
        canonical({ playerLastName: "rashford" }),
      ),
      false,
    );
  });

  it("falls through to class-only when NEITHER side has a surname", () => {
    assert.equal(
      claimMatchesCanonical(
        claim({ playerLastName: null }),
        canonical({ playerLastName: null }),
      ),
      true,
    );
  });

  it("refuses when only the claim has a surname (mixed)", () => {
    assert.equal(
      claimMatchesCanonical(
        claim({ playerLastName: "haaland" }),
        canonical({ playerLastName: null }),
      ),
      false,
    );
  });

  it("refuses when only the canonical has a surname (mixed)", () => {
    assert.equal(
      claimMatchesCanonical(
        claim({ playerLastName: null }),
        canonical({ playerLastName: "haaland" }),
      ),
      false,
    );
  });
});

// --- textureMatchesCanonical ---------------------------------------

describe("textureMatchesCanonical — same rules as claimMatchesCanonical", () => {
  it("matches on class + surname", () => {
    assert.equal(
      textureMatchesCanonical(
        texture({ eventHint: { eventClass: "GOAL", playerLastName: "haaland", teamKey: null, minuteHint: "12" } }),
        canonical({ eventClass: "GOAL", playerLastName: "haaland" }),
      ),
      true,
    );
  });

  it("phase whistle textures match on class alone", () => {
    assert.equal(
      textureMatchesCanonical(
        texture({ eventHint: { eventClass: "HALFTIME", playerLastName: null, teamKey: null, minuteHint: "45" } }),
        canonical({ eventClass: "HALFTIME", playerLastName: null }),
      ),
      true,
    );
  });

  it("rejects mixed surname presence", () => {
    assert.equal(
      textureMatchesCanonical(
        texture({ eventHint: { eventClass: "GOAL", playerLastName: "haaland", teamKey: null, minuteHint: "12" } }),
        canonical({ playerLastName: null }),
      ),
      false,
    );
  });
});

// --- resolveCanonical ----------------------------------------------

describe("resolveCanonical — single claim + canonical", () => {
  it("emits a calibration sample for a matching claim within the window", () => {
    const result = resolveCanonical(canonical(), [claim()], []);
    assert.ok(result.sample);
    assert.equal(result.sample.eventClass, "GOAL");
    assert.equal(result.sample.matchedClaimId, "claim-1");
    assert.equal(result.matchedClaimId, "claim-1");
  });

  it("computes rawDeltaSeconds as canonical - claim, in seconds", () => {
    // Claim landed 5s before canonical → positive delta (commentary led).
    const result = resolveCanonical(
      canonical({ realWallClockMs: NOW }),
      [claim({ claimedAtMs: NOW - 5_000 })],
      [],
    );
    assert.equal(result.sample?.rawDeltaSeconds, 5);
  });

  it("negative delta when canonical lands before commentary", () => {
    const result = resolveCanonical(
      canonical({ realWallClockMs: NOW }),
      [claim({ claimedAtMs: NOW + 3_000 })],
      [],
    );
    assert.equal(result.sample?.rawDeltaSeconds, -3);
  });

  it("returns null sample when no claim matches", () => {
    const result = resolveCanonical(canonical(), [], []);
    assert.equal(result.sample, null);
    assert.equal(result.matchedClaimId, null);
  });

  it("ignores claims outside the correlation window", () => {
    const result = resolveCanonical(
      canonical({ realWallClockMs: NOW }),
      [claim({ claimedAtMs: NOW - CORRELATION_WINDOW_MS - 1 })],
      [],
    );
    assert.equal(result.sample, null);
  });

  it("VAR_CHECK uses the wider window (120s)", () => {
    // Commentary fired ~100s before canonical — outside the standard
    // 90s window but inside the 120s VAR window.
    const result = resolveCanonical(
      canonical({ eventClass: "VAR_CHECK", playerLastName: null, realWallClockMs: NOW }),
      [claim({ eventClass: "VAR_CHECK", playerLastName: null, claimedAtMs: NOW - 100_000 })],
      [],
    );
    assert.ok(result.sample, "VAR's wider window must accept the late claim");
  });
});

describe("resolveCanonical — multiple claims, oldest wins", () => {
  it("when multiple claims match, the OLDEST (earliest addedAt) wins", () => {
    const older = claim({ claimId: "older", addedAt: NOW - 10_000 });
    const newer = claim({ claimId: "newer", addedAt: NOW - 1_000 });
    const result = resolveCanonical(canonical(), [newer, older], []);
    assert.equal(result.matchedClaimId, "older");
  });

  it("ties on addedAt: the first iterated wins (deterministic by array order)", () => {
    const a = claim({ claimId: "a", addedAt: NOW });
    const b = claim({ claimId: "b", addedAt: NOW });
    const result = resolveCanonical(canonical(), [a, b], []);
    assert.equal(result.matchedClaimId, "a");
  });
});

describe("resolveCanonical — texture releases", () => {
  it("releases every matching texture, with parentSourceId set to the canonical's eventId", () => {
    const result = resolveCanonical(canonical({ eventId: "goal-9000" }), [], [
      texture({ textureId: "t1" }),
      texture({ textureId: "t2", content: "crowd erupts" }),
    ]);
    assert.equal(result.textureReleases.length, 2);
    assert.deepEqual(result.matchedTextureIds.sort(), ["t1", "t2"]);
    for (const release of result.textureReleases) {
      assert.equal(release.parentSourceId, "goal-9000");
      assert.equal(release.eventClass, "GOAL");
    }
  });

  it("ignores textures outside the correlation window", () => {
    const result = resolveCanonical(
      canonical({ realWallClockMs: NOW }),
      [],
      [texture({ observedAtMs: NOW - CORRELATION_WINDOW_MS - 1 })],
    );
    assert.equal(result.textureReleases.length, 0);
  });

  it("ignores textures whose hint class differs from the canonical", () => {
    const result = resolveCanonical(
      canonical({ eventClass: "GOAL" }),
      [],
      [texture({ eventHint: { eventClass: "YELLOW_CARD", playerLastName: "haaland", teamKey: null, minuteHint: "12" } })],
    );
    assert.equal(result.textureReleases.length, 0);
  });
});

// --- pruneExpired ---------------------------------------------------

describe("pruneExpired", () => {
  it("removes claims older than the per-class window, leaves fresh ones", () => {
    const fresh = claim({ claimId: "fresh", addedAt: NOW - 30_000 });
    const stale = claim({ claimId: "stale", addedAt: NOW - 100_000 });
    const claims = [fresh, stale];
    const { expiredClaims } = pruneExpired(claims, [], [], NOW);
    assert.equal(claims.length, 1);
    assert.equal(claims[0].claimId, "fresh");
    assert.equal(expiredClaims.length, 1);
    assert.equal(expiredClaims[0].claimId, "stale");
  });

  it("VAR_CHECK claims survive past the standard window (120s vs 90s)", () => {
    // 100s old is past the 90s window but inside the 120s VAR window.
    const claims = [
      claim({ claimId: "var-survives", eventClass: "VAR_CHECK", addedAt: NOW - 100_000 }),
      claim({ claimId: "goal-expires", eventClass: "GOAL", addedAt: NOW - 100_000 }),
    ];
    const { expiredClaims } = pruneExpired(claims, [], [], NOW);
    assert.equal(claims.length, 1);
    assert.equal(claims[0].claimId, "var-survives");
    assert.equal(expiredClaims.length, 1);
    assert.equal(expiredClaims[0].claimId, "goal-expires");
  });

  it("removes textures older than their hint class window", () => {
    const fresh = texture({ textureId: "fresh", addedAt: NOW - 30_000 });
    const stale = texture({ textureId: "stale", addedAt: NOW - 100_000 });
    const textures = [fresh, stale];
    const { expiredTextures } = pruneExpired([], textures, [], NOW);
    assert.equal(textures.length, 1);
    assert.equal(expiredTextures.length, 1);
    assert.equal(expiredTextures[0].textureId, "stale");
  });

  it("removes canonicals past the longest possible window (VAR's 120s)", () => {
    const canonicals: CanonicalEventEntry[] = [
      canonical({ eventId: "fresh", addedAt: NOW - 60_000 }),
      canonical({ eventId: "stale", addedAt: NOW - 130_000 }),
    ];
    pruneExpired([], [], canonicals, NOW);
    assert.equal(canonicals.length, 1);
    assert.equal(canonicals[0].eventId, "fresh");
  });

  it("treats now - addedAt === window as still in-window (strict greater-than expiry)", () => {
    const claims = [claim({ claimId: "boundary", addedAt: NOW - CORRELATION_WINDOW_MS })];
    pruneExpired(claims, [], [], NOW);
    assert.equal(claims.length, 1, "exactly at the window boundary stays");
  });
});

// --- findCanonicalForLateArrival -----------------------------------

describe("findCanonicalForLateArrival", () => {
  it("finds a matching canonical within the window", () => {
    const canonicals = [canonical({ eventId: "goal-1" })];
    const found = findCanonicalForLateArrival(
      { eventClass: "GOAL", playerLastName: "haaland", teamKey: null, observedAtMs: NOW + 5_000 },
      canonicals,
    );
    assert.equal(found?.eventId, "goal-1");
  });

  it("returns null when nothing matches", () => {
    const found = findCanonicalForLateArrival(
      { eventClass: "GOAL", playerLastName: "haaland", teamKey: null, observedAtMs: NOW },
      [],
    );
    assert.equal(found, null);
  });

  it("for phase whistles, the chronologically earliest match wins", () => {
    const canonicals = [
      canonical({ eventId: "later", eventClass: "KICKOFF", playerLastName: null, realWallClockMs: NOW + 1_000 }),
      canonical({ eventId: "earlier", eventClass: "KICKOFF", playerLastName: null, realWallClockMs: NOW - 1_000 }),
    ];
    const found = findCanonicalForLateArrival(
      { eventClass: "KICKOFF", playerLastName: null, teamKey: null, observedAtMs: NOW },
      canonicals,
    );
    assert.equal(found?.eventId, "earlier");
  });

  it("for player-bearing classes, surname identity is required when both sides have one", () => {
    const canonicals = [
      canonical({ eventId: "wrong-player", playerLastName: "rashford", realWallClockMs: NOW }),
      canonical({ eventId: "right-player", playerLastName: "haaland", realWallClockMs: NOW + 2_000 }),
    ];
    const found = findCanonicalForLateArrival(
      { eventClass: "GOAL", playerLastName: "haaland", teamKey: null, observedAtMs: NOW },
      canonicals,
    );
    assert.equal(found?.eventId, "right-player");
  });

  it("uses the wider VAR window for VAR_CHECK lookups", () => {
    const canonicals = [
      canonical({ eventId: "var-1", eventClass: "VAR_CHECK", playerLastName: null, realWallClockMs: NOW - 100_000 }),
    ];
    const found = findCanonicalForLateArrival(
      { eventClass: "VAR_CHECK", playerLastName: null, teamKey: null, observedAtMs: NOW },
      canonicals,
    );
    assert.equal(found?.eventId, "var-1");
  });

  it("ignores canonicals outside the correlation window", () => {
    const canonicals = [
      canonical({ eventId: "too-old", realWallClockMs: NOW - CORRELATION_WINDOW_MS - 1 }),
    ];
    const found = findCanonicalForLateArrival(
      { eventClass: "GOAL", playerLastName: "haaland", teamKey: null, observedAtMs: NOW },
      canonicals,
    );
    assert.equal(found, null);
  });
});

// --- surnameKey -----------------------------------------------------

describe("surnameKey", () => {
  it("returns the lowercased last token", () => {
    assert.equal(surnameKey("Erling Haaland"), "haaland");
    assert.equal(surnameKey("Kevin De Bruyne"), "bruyne");
  });

  it("returns null for null/undefined/empty input", () => {
    assert.equal(surnameKey(null), null);
    assert.equal(surnameKey(undefined), null);
    assert.equal(surnameKey(""), null);
    assert.equal(surnameKey("   "), null);
  });

  it("returns null when the surname is shorter than 3 chars (low confidence)", () => {
    assert.equal(surnameKey("Joe Lo"), null);
    assert.equal(surnameKey("X"), null);
  });

  it("trims whitespace before splitting", () => {
    assert.equal(surnameKey("  Phil Foden  "), "foden");
  });

  it("handles multiple spaces between tokens", () => {
    assert.equal(surnameKey("Pep    Guardiola"), "guardiola");
  });
});

// --- teamKey --------------------------------------------------------

describe("teamKey", () => {
  it("returns the lowercased trimmed team name", () => {
    assert.equal(teamKey("Manchester City"), "manchester city");
    assert.equal(teamKey("  ARSENAL  "), "arsenal");
  });

  it("returns null for empty / nullish input", () => {
    assert.equal(teamKey(null), null);
    assert.equal(teamKey(undefined), null);
    assert.equal(teamKey(""), null);
    assert.equal(teamKey("   "), null);
  });
});
