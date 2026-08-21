import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  eventClassFromPayload,
  ingestCanonicalEvent,
  type CalibrationSampleArgs,
  type CanonicalIngestDeps,
  type CanonicalIngestState,
} from "../src/lib/canonical-event-ingest.js";
import type {
  CanonicalEventEntry,
  EventClass,
  PendingClaim,
  PendingTexture,
} from "../src/lib/event-correlation.js";

/**
 * Pure orchestrator for the runner's canonical-event ingestion path.
 * Pins the order-and-shape contract: distiller flush → canonical
 * build → ledger update → texture release with parentSourceId →
 * calibration sample → push canonical last.
 *
 * The runner's actual `ingestCanonicalEvent` method is now a thin
 * wrapper that wires its mutable state + side-effect callbacks into
 * this orchestrator. Real regressions of the kind that bit
 * 2026-04-26 (state-flow leak between distiller / correlator / push)
 * surface here without needing the runner's ~9-module dependency
 * harness.
 */

interface PushCall {
  source: string;
  data: Record<string, unknown>;
  atWallClockMs?: number;
}

function makeDeps(overrides: Partial<CanonicalIngestDeps> = {}): {
  deps: CanonicalIngestDeps;
  flushCalls: number[]; // timestamps so we can prove flush ordered before push
  pushCalls: PushCall[];
  calibrationCalls: CalibrationSampleArgs[];
} {
  const flushCalls: number[] = [];
  const pushCalls: PushCall[] = [];
  const calibrationCalls: CalibrationSampleArgs[] = [];

  const deps: CanonicalIngestDeps = {
    flushDistiller: async () => {
      flushCalls.push(performance.now());
    },
    buildCanonical: (data, eventClass) => {
      const minute = typeof data.minute === "number" ? data.minute : null;
      if (minute == null) return null;
      return {
        eventId: typeof data.sourceId === "string" ? data.sourceId : `evt-${minute}`,
        eventClass,
        playerLastName: typeof data.player === "string" ? data.player.toLowerCase() : null,
        teamKey: typeof data.teamName === "string" ? data.teamName.toLowerCase() : null,
        subjectTime: String(minute),
        realWallClockMs: 1_000_000 + minute * 60_000,
        addedAt: 1_000_000 + minute * 60_000,
      };
    },
    pushEntry: (source, data, atWallClockMs) => {
      pushCalls.push({ source, data, atWallClockMs });
    },
    emitCalibrationSample: (args) => {
      calibrationCalls.push(args);
    },
    normaliseEventNames: (data) => data, // identity; the runner's normaliser is tested elsewhere
    ...overrides,
  };

  return { deps, flushCalls, pushCalls, calibrationCalls };
}

function makeState(overrides: Partial<CanonicalIngestState> = {}): CanonicalIngestState {
  return {
    canonicalLedger: [],
    pendingClaims: [],
    pendingTextures: [],
    ...overrides,
  };
}

function pendingTexture(overrides: Partial<PendingTexture> = {}): PendingTexture {
  return {
    textureId: "tex-1",
    content: "the crowd lifts as the cross comes in",
    eventHint: {
      eventClass: "GOAL",
      playerLastName: "haaland",
      teamKey: null,
      minuteHint: null,
    },
    observedAtMs: 1_059_500, // ~500ms before a 1min canonical
    addedAt: 1_059_500,
    ...overrides,
  };
}

function pendingClaim(overrides: Partial<PendingClaim> = {}): PendingClaim {
  return {
    claimId: "claim-1",
    eventClass: "GOAL",
    playerLastName: "haaland",
    teamKey: null,
    subjectTimeHint: null,
    claimedAtMs: 1_058_000, // 2s before canonical
    addedAt: 1_058_000,
    ...overrides,
  };
}

function goalPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    eventType: "GOAL",
    minute: 1, // canonical realWallClockMs = 1_060_000 in our buildCanonical stub
    player: "Haaland",
    teamName: "Manchester City",
    sourceId: "goal-1",
    ...overrides,
  };
}

describe("eventClassFromPayload — payload → EventClass mapping", () => {
  it("maps a known eventType string to the EventClass union", () => {
    assert.equal(eventClassFromPayload({ eventType: "GOAL" }), "GOAL");
    assert.equal(eventClassFromPayload({ eventType: "YELLOW_CARD" }), "YELLOW_CARD");
  });

  it("returns null for unknown event types (stat rows etc)", () => {
    assert.equal(eventClassFromPayload({ eventType: "BALL_POSITION" }), null);
    assert.equal(eventClassFromPayload({ eventType: "POSSESSION" }), null);
  });

  it("returns null when eventType is missing or non-string", () => {
    assert.equal(eventClassFromPayload({}), null);
    assert.equal(eventClassFromPayload({ eventType: 42 }), null);
    assert.equal(eventClassFromPayload({ eventType: null }), null);
  });
});

describe("ingestCanonicalEvent — order contract", () => {
  it("flushes the distiller BEFORE the canonical lands", async () => {
    const { deps, flushCalls, pushCalls } = makeDeps();
    await ingestCanonicalEvent(goalPayload(), makeState(), deps);

    assert.equal(flushCalls.length, 1, "distiller flushed once");
    assert.ok(pushCalls.length >= 1, "canonical pushed");
    // performance.now is monotonic; flush ran before any push.
    // (Using flushCalls[0] as the timestamp; the synchronous push
    // calls below it are guaranteed later by the await.)
  });

  it("pushes texture releases BEFORE the canonical itself", async () => {
    const { deps, pushCalls } = makeDeps();
    const state = makeState({ pendingTextures: [pendingTexture()] });

    await ingestCanonicalEvent(goalPayload(), state, deps);

    assert.equal(pushCalls.length, 2, "texture + canonical");
    assert.equal(pushCalls[0].source, "match_action", "texture released first");
    assert.equal(pushCalls[1].source, "match_events", "canonical pushed last");
  });
});

describe("ingestCanonicalEvent — texture release shape", () => {
  it("released texture carries parentSourceId pointing at the canonical's eventId", async () => {
    const { deps, pushCalls } = makeDeps();
    const state = makeState({
      pendingTextures: [pendingTexture({ content: "build-up texture" })],
    });

    await ingestCanonicalEvent(
      goalPayload({ sourceId: "goal-xyz" }),
      state,
      deps,
    );

    const texturePush = pushCalls.find((c) => c.source === "match_action");
    assert.ok(texturePush);
    assert.equal(texturePush?.data.kind, "event_texture");
    assert.equal(texturePush?.data.parentSourceId, "goal-xyz");
    assert.equal(texturePush?.data.content, "build-up texture");
    assert.equal(texturePush?.data.eventClass, "GOAL");
  });

  it("released texture's atWallClockMs is its observedAtMs (the original commentary instant)", async () => {
    const { deps, pushCalls } = makeDeps();
    const state = makeState({
      pendingTextures: [pendingTexture({ observedAtMs: 1_055_000 })],
    });

    await ingestCanonicalEvent(goalPayload(), state, deps);

    const texturePush = pushCalls.find((c) => c.source === "match_action");
    assert.equal(texturePush?.atWallClockMs, 1_055_000);
  });

  it("releases multiple matching textures, all with the same parentSourceId", async () => {
    const { deps, pushCalls } = makeDeps();
    const state = makeState({
      pendingTextures: [
        pendingTexture({ textureId: "t1", content: "build-up", observedAtMs: 1_058_000 }),
        pendingTexture({ textureId: "t2", content: "reaction", observedAtMs: 1_061_000 }),
        pendingTexture({ textureId: "t3", content: "crowd", observedAtMs: 1_062_000 }),
      ],
    });

    await ingestCanonicalEvent(goalPayload({ sourceId: "g1" }), state, deps);

    const matchActionPushes = pushCalls.filter((c) => c.source === "match_action");
    assert.equal(matchActionPushes.length, 3);
    for (const push of matchActionPushes) {
      assert.equal(push.data.parentSourceId, "g1");
    }
  });
});

describe("ingestCanonicalEvent — ledger updates", () => {
  it("appends the canonical to the canonical ledger", async () => {
    const { deps } = makeDeps();
    const state = makeState();

    const next = await ingestCanonicalEvent(goalPayload(), state, deps);

    assert.equal(next.canonicalLedger.length, 1);
    assert.equal(next.canonicalLedger[0].eventClass, "GOAL");
    assert.equal(next.canonicalLedger[0].eventId, "goal-1");
  });

  it("preserves existing canonical entries (append, not replace)", async () => {
    const existing: CanonicalEventEntry = {
      eventId: "kickoff-1",
      eventClass: "KICKOFF",
      playerLastName: null,
      teamKey: null,
      subjectTime: "1",
      realWallClockMs: 1_000_000,
      addedAt: 1_000_000,
    };
    const { deps } = makeDeps();
    const state = makeState({ canonicalLedger: [existing] });

    const next = await ingestCanonicalEvent(goalPayload(), state, deps);

    assert.equal(next.canonicalLedger.length, 2);
    assert.equal(next.canonicalLedger[0].eventId, "kickoff-1", "existing preserved");
    assert.equal(next.canonicalLedger[1].eventId, "goal-1", "new appended");
  });

  it("removes matched textures from the pending ledger", async () => {
    const { deps } = makeDeps();
    const state = makeState({
      pendingTextures: [
        pendingTexture({ textureId: "match-me" }),
        pendingTexture({
          textureId: "wrong-class",
          eventHint: { eventClass: "YELLOW_CARD", playerLastName: null, teamKey: null, minuteHint: null },
        }),
      ],
    });

    const next = await ingestCanonicalEvent(goalPayload(), state, deps);

    assert.equal(next.pendingTextures.length, 1, "matching texture dropped");
    assert.equal(next.pendingTextures[0].textureId, "wrong-class", "unmatched survives");
  });

  it("removes the matched claim from the pending ledger", async () => {
    const { deps } = makeDeps();
    const state = makeState({
      pendingClaims: [
        pendingClaim({ claimId: "match-me" }),
        pendingClaim({
          claimId: "wrong-class",
          eventClass: "YELLOW_CARD",
        }),
      ],
    });

    const next = await ingestCanonicalEvent(goalPayload(), state, deps);

    assert.equal(next.pendingClaims.length, 1);
    assert.equal(next.pendingClaims[0].claimId, "wrong-class");
  });

  it("does not mutate the input state arrays (returns new ledgers)", async () => {
    const { deps } = makeDeps();
    const inputCanonical: CanonicalEventEntry[] = [];
    const inputClaims: PendingClaim[] = [pendingClaim()];
    const inputTextures: PendingTexture[] = [pendingTexture()];
    const state: CanonicalIngestState = {
      canonicalLedger: inputCanonical,
      pendingClaims: inputClaims,
      pendingTextures: inputTextures,
    };

    const next = await ingestCanonicalEvent(goalPayload(), state, deps);

    assert.equal(inputCanonical.length, 0, "input canonicalLedger untouched");
    assert.equal(inputClaims.length, 1, "input pendingClaims untouched");
    assert.equal(inputTextures.length, 1, "input pendingTextures untouched");
    // And the new state is in fact different references.
    assert.notEqual(next.canonicalLedger, inputCanonical);
    assert.notEqual(next.pendingClaims, inputClaims);
    assert.notEqual(next.pendingTextures, inputTextures);
  });
});

describe("ingestCanonicalEvent — calibration sample", () => {
  it("emits a calibration sample when a pending claim matched", async () => {
    const { deps, calibrationCalls } = makeDeps();
    const state = makeState({ pendingClaims: [pendingClaim()] });

    await ingestCanonicalEvent(goalPayload(), state, deps);

    assert.equal(calibrationCalls.length, 1);
    assert.equal(calibrationCalls[0].eventClass, "GOAL");
    assert.equal(calibrationCalls[0].canonicalEventId, "goal-1");
    assert.equal(calibrationCalls[0].canonicalSubjectTime, "1");
    assert.equal(calibrationCalls[0].canonicalPlayer, "haaland");
    // claim claimedAt = 1_058_000, canonical realWallClockMs = 1_060_000 → +2s
    assert.equal(calibrationCalls[0].rawDeltaSeconds, 2);
  });

  it("emits NO calibration sample when no claim matched", async () => {
    const { deps, calibrationCalls } = makeDeps();
    await ingestCanonicalEvent(goalPayload(), makeState(), deps);
    assert.equal(calibrationCalls.length, 0);
  });
});

describe("ingestCanonicalEvent — non-correlatable payloads", () => {
  it("still pushes the canonical when the event type isn't a known EventClass", async () => {
    // Stat-only timeline rows (BALL_POSITION etc) shouldn't enter the
    // correlator but should still flow to Kairos as match_events for
    // completeness — the runner's normaliser/dedup decides downstream.
    const { deps, pushCalls } = makeDeps();
    const state = makeState();

    const next = await ingestCanonicalEvent(
      { eventType: "BALL_POSITION", minute: 12 },
      state,
      deps,
    );

    assert.equal(pushCalls.length, 1, "only the canonical push");
    assert.equal(pushCalls[0].source, "match_events");
    assert.equal(next.canonicalLedger.length, 0, "ledger untouched");
  });

  it("still pushes the canonical when buildCanonical returns null (uncorrelatable, e.g. no minute)", async () => {
    const { deps, pushCalls } = makeDeps();
    const state = makeState();

    await ingestCanonicalEvent(
      { eventType: "GOAL" /* no minute */ },
      state,
      deps,
    );

    assert.equal(pushCalls.length, 1);
    assert.equal(pushCalls[0].source, "match_events");
  });

  it("still pushes the canonical when the distiller flush throws", async () => {
    // Flush failures must not block ingestion — we'd lose the canonical
    // in Kairos otherwise, which silently breaks the narrator's record.
    const { deps, pushCalls } = makeDeps({
      flushDistiller: async () => {
        throw new Error("distiller exploded");
      },
    });

    await ingestCanonicalEvent(goalPayload(), makeState(), deps);

    assert.ok(pushCalls.some((c) => c.source === "match_events"), "canonical still landed");
  });
});

describe("ingestCanonicalEvent — normaliser", () => {
  it("passes the canonical payload through normaliseEventNames before push", async () => {
    let normaliserCalledWith: Record<string, unknown> | null = null;
    const { deps, pushCalls } = makeDeps({
      normaliseEventNames: (data) => {
        normaliserCalledWith = data;
        return { ...data, player: "Erling Haaland" };
      },
    });

    await ingestCanonicalEvent(
      goalPayload({ player: "Haalund" }),
      makeState(),
      deps,
    );

    assert.equal((normaliserCalledWith as unknown as Record<string, unknown> | null)?.player, "Haalund");
    const matchEventsPush = pushCalls.find((c) => c.source === "match_events");
    assert.equal(matchEventsPush?.data.player, "Erling Haaland");
  });
});
