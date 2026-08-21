import { describe, it, expect } from "vitest";
import {
  computeCoverRevealSchedule,
  computeContentMinuteLabel,
  deriveScore,
  eventLabel,
  eventText,
  formatMinute,
  isShowableEvent,
  latestContentMinute,
  type ViewerEvent,
} from "./derivations";

/**
 * Characterization tests for the matchroom's reveal contract today
 * (pre-bundle, pre-Design-A). These pin the visible behaviour the
 * matchroom produces from cue inputs so the Sub-piece 4 refactor —
 * which moves canonical state authoring to the conductor and
 * replaces these helpers with a unified visible-state projection —
 * doesn't accidentally regress what's already shipped.
 *
 * `deriveScore`, `latestContentMinute`, and `computeContentMinuteLabel` are
 * the most exposed: they retire when the bundle becomes the source
 * of truth. The tests for them lock today's rule precisely so we can
 * compare new-vs-old behaviour during the migration.
 */

// Test factory — keeps each test focused on what differs.
function event(partial: Partial<ViewerEvent> & { id: string }): ViewerEvent {
  return {
    id: partial.id,
    eventType: partial.eventType ?? "GOAL",
    content: partial.content ?? "",
    minute: partial.minute ?? null,
    extraMinute: partial.extraMinute ?? null,
    contentTime: partial.contentTime,
    timestamp: partial.timestamp ?? 0,
    player: partial.player ?? null,
    relatedPlayer: partial.relatedPlayer ?? null,
    team: partial.team ?? null,
    teamName: partial.teamName ?? null,
    isGoal: partial.isGoal ?? partial.eventType === "GOAL",
  };
}

describe("deriveScore", () => {
  it("returns 0-0 with no events", () => {
    expect(deriveScore([])).toEqual({ home: 0, away: 0 });
  });

  it("counts only goals, scoped to the team that scored", () => {
    const events = [
      event({ id: "1", eventType: "GOAL", team: "home", isGoal: true }),
      event({ id: "2", eventType: "YELLOW_CARD", team: "away", isGoal: false }),
      event({ id: "3", eventType: "GOAL", team: "away", isGoal: true }),
      event({ id: "4", eventType: "GOAL", team: "home", isGoal: true }),
    ];
    expect(deriveScore(events)).toEqual({ home: 2, away: 1 });
  });

  it("ignores goals with no team (defensive — server should always set team)", () => {
    const events = [
      event({ id: "1", eventType: "GOAL", team: null, isGoal: true }),
      event({ id: "2", eventType: "GOAL", team: "home", isGoal: true }),
    ];
    expect(deriveScore(events)).toEqual({ home: 1, away: 0 });
  });

  it("isGoal=false suppresses the count even when eventType is GOAL", () => {
    // VAR-disallowed goals could plausibly be modelled this way.
    const events = [
      event({ id: "1", eventType: "GOAL", team: "home", isGoal: false }),
      event({ id: "2", eventType: "GOAL", team: "away", isGoal: true }),
    ];
    expect(deriveScore(events)).toEqual({ home: 0, away: 1 });
  });
});

describe("latestContentMinute", () => {
  it("returns null on an empty list", () => {
    expect(latestContentMinute([])).toBeNull();
  });

  it("ranks by parsed contentTime, not push timestamp", () => {
    // Critical case: a re-pushed early-minute event arrives last but
    // shouldn't surface as the 'latest' minute. Locks the bug fix
    // documented in the inline comment.
    const events = [
      event({ id: "early-rush", contentTime: "3", timestamp: 9999 }),
      event({ id: "late", contentTime: "67", timestamp: 5000 }),
    ];
    expect(latestContentMinute(events)).toBe("67'");
  });

  it("formats stoppage-time minutes with the +N marker", () => {
    const events = [
      event({ id: "1", contentTime: "45+2" }),
      event({ id: "2", contentTime: "45" }),
    ];
    expect(latestContentMinute(events)).toBe("45+2'");
  });

  it("returns null when no event carries a parseable contentTime — minute/extraMinute fallback is unreachable from this path", () => {
    // Latent quirk worth pinning: `latestContentMinute` ranks by
    // parseMatchTime, which returns -Infinity for missing contentTime.
    // Such events never win the ranking, so the formatMinute
    // minute/extraMinute branch never fires from here. Server-side
    // contentTime stamping ensures real events have it; this is a
    // safety characterisation.
    const events = [
      event({ id: "1", minute: 47, extraMinute: 0, contentTime: undefined }),
    ];
    expect(latestContentMinute(events)).toBeNull();
  });

  it("ignores no-contentTime events when others do have contentTime", () => {
    const events = [
      event({ id: "early", contentTime: "12" }),
      event({ id: "no-time", minute: 80, contentTime: undefined }),
    ];
    expect(latestContentMinute(events)).toBe("12'");
  });
});

describe("formatMinute", () => {
  it("renders contentTime with a trailing apostrophe and strips a leading +", () => {
    expect(formatMinute(45, 2, "45+2")).toBe("45+2'");
    expect(formatMinute(null, null, "+90+5")).toBe("90+5'");
  });

  it("uses minute/extraMinute when contentTime is empty", () => {
    expect(formatMinute(47, 0, undefined)).toBe("47'");
    expect(formatMinute(45, 3, undefined)).toBe("45+3'");
  });

  it("returns null pre-match (no minute, no contentTime)", () => {
    expect(formatMinute(null, null, undefined)).toBeNull();
    expect(formatMinute(null, null, "")).toBeNull();
  });
});

describe("isShowableEvent", () => {
  it("keeps the matchroom ribbon canon (goals, cards, subs, VAR, penalty, transitions)", () => {
    for (const t of [
      "GOAL", "OWN_GOAL", "YELLOW_CARD", "RED_CARD", "SUBSTITUTION",
      "VAR", "PENALTY",
      "KICKOFF", "HALFTIME", "SECOND_HALF_KICKOFF", "FULL_TIME",
    ]) {
      expect(isShowableEvent(event({ id: t, eventType: t }))).toBe(true);
    }
  });

  it("rejects pressure / zone signals and other operator-only types", () => {
    for (const t of [
      "PRESSURE_UPDATE", "ZONE_ENTRY", "ZONE_MIDDLE",
      "INJURY", "WEATHER", "",
    ]) {
      expect(isShowableEvent(event({ id: t, eventType: t }))).toBe(false);
    }
  });
});

describe("eventLabel", () => {
  it("produces the canonical UI label for known kinds", () => {
    expect(eventLabel("GOAL")).toBe("Goal");
    expect(eventLabel("OWN_GOAL")).toBe("Own goal");
    expect(eventLabel("YELLOW_CARD")).toBe("Yellow");
    expect(eventLabel("RED_CARD")).toBe("Red card");
    expect(eventLabel("SUBSTITUTION")).toBe("Substitution");
    expect(eventLabel("VAR")).toBe("VAR");
    expect(eventLabel("PENALTY")).toBe("Penalty");
    expect(eventLabel("KICKOFF")).toBe("Kickoff");
    expect(eventLabel("HALFTIME")).toBe("Half-time");
    expect(eventLabel("SECOND_HALF_KICKOFF")).toBe("Second half");
    expect(eventLabel("FULL_TIME")).toBe("Full-time");
  });

  it("falls back to a humanised form for unknown kinds", () => {
    expect(eventLabel("CORNER_KICK")).toBe("corner kick");
  });
});

describe("eventText", () => {
  it("substitutions render the off↓/on↑ pair with team", () => {
    expect(
      eventText(
        event({
          id: "1",
          eventType: "SUBSTITUTION",
          player: "Smith",
          relatedPlayer: "Jones",
          teamName: "Brighton",
        }),
      ),
    ).toBe("Jones ↓ Smith ↑ · Brighton");
  });

  it("substitution with only the incoming player + team falls back to player+team", () => {
    expect(
      eventText(
        event({
          id: "1",
          eventType: "SUBSTITUTION",
          player: "Smith",
          relatedPlayer: null,
          teamName: "Brighton",
        }),
      ),
    ).toBe("Smith, Brighton");
  });

  it("goal renders player + team", () => {
    expect(
      eventText(
        event({
          id: "1",
          eventType: "GOAL",
          isGoal: true,
          player: "Salah",
          teamName: "Liverpool",
        }),
      ),
    ).toBe("Salah, Liverpool");
  });

  it("strips the [TYPE] prefix from raw content fallback", () => {
    expect(
      eventText(
        event({
          id: "1",
          eventType: "VAR",
          content: "[VAR] Goal under review",
        }),
      ),
    ).toBe("Goal under review");
  });

  it("returns an em-dash when no info is available", () => {
    expect(
      eventText(event({ id: "1", eventType: "GOAL", content: "" })),
    ).toBe("—");
  });
});

describe("computeCoverRevealSchedule", () => {
  it("returns nothing for empty inputs", () => {
    expect(computeCoverRevealSchedule([], "abc", 1000)).toEqual([]);
    expect(computeCoverRevealSchedule([{ entryId: "a", charOffset: 50 }], "", 1000)).toEqual([]);
    expect(computeCoverRevealSchedule([{ entryId: "a", charOffset: 50 }], "abc", 0)).toEqual([]);
  });

  it("skips covers with no charOffset (audio-end fallback handles those)", () => {
    const covers = [
      { entryId: "anchored", charOffset: 50 },
      { entryId: "unanchored" },
    ];
    const schedule = computeCoverRevealSchedule(covers, "x".repeat(100), 1000);
    expect(schedule).toEqual([{ entryId: "anchored", delayMs: 500 }]);
  });

  it("computes delays as `(charOffset / textLength) * durationMs`", () => {
    const text = "x".repeat(200);
    const covers = [
      { entryId: "early", charOffset: 0 },
      { entryId: "quarter", charOffset: 50 },
      { entryId: "midway", charOffset: 100 },
      { entryId: "late", charOffset: 200 },
    ];
    const schedule = computeCoverRevealSchedule(covers, text, 4000);
    expect(schedule).toEqual([
      { entryId: "early", delayMs: 0 },
      { entryId: "quarter", delayMs: 1000 },
      { entryId: "midway", delayMs: 2000 },
      { entryId: "late", delayMs: 4000 },
    ]);
  });

  it("clamps charOffset > textLength to the audio-end (avoids negative or runaway delays)", () => {
    // The Kairos generator should not emit charOffsets past prose
    // length, but if it did, the clamp keeps the matchroom safe.
    const schedule = computeCoverRevealSchedule(
      [{ entryId: "runaway", charOffset: 999 }],
      "x".repeat(100),
      1000,
    );
    expect(schedule).toEqual([{ entryId: "runaway", delayMs: 1000 }]);
  });

  it("clamps negative charOffset to audio-start", () => {
    const schedule = computeCoverRevealSchedule(
      [{ entryId: "weird", charOffset: -10 }],
      "x".repeat(100),
      1000,
    );
    expect(schedule).toEqual([{ entryId: "weird", delayMs: 0 }]);
  });
});

describe("computeContentMinuteLabel", () => {
  const noEvents: ViewerEvent[] = [];

  it("phase=halftime always returns 'HT' regardless of other inputs", () => {
    expect(
      computeContentMinuteLabel({
        phase: "halftime",
        isReplay: false,
        currentContentMinute: "45",
        fallbackContentMinute: "45",
        events: noEvents,
      }),
    ).toBe("HT");
    // Even in replay — replay only matters for the FT case.
    expect(
      computeContentMinuteLabel({
        phase: "halftime",
        isReplay: true,
        currentContentMinute: null,
        fallbackContentMinute: null,
        events: noEvents,
      }),
    ).toBe("HT");
  });

  it("phase=full_time_winddown returns 'FT' for live, falls through for replay", () => {
    // Live: short-circuits to FT.
    expect(
      computeContentMinuteLabel({
        phase: "full_time_winddown",
        isReplay: false,
        currentContentMinute: "90",
        fallbackContentMinute: "90+3",
        events: noEvents,
      }),
    ).toBe("FT");
    // Replay: caller wants the listener's playback progress, NOT the
    // broadcast's terminal label. Falls through to currentContentMinute.
    expect(
      computeContentMinuteLabel({
        phase: "full_time_winddown",
        isReplay: true,
        currentContentMinute: "67",
        fallbackContentMinute: "90+3",
        events: noEvents,
      }),
    ).toBe("67'");
  });

  it("phase=complete behaves the same as full_time_winddown", () => {
    expect(
      computeContentMinuteLabel({
        phase: "complete",
        isReplay: false,
        currentContentMinute: null,
        fallbackContentMinute: null,
        events: noEvents,
      }),
    ).toBe("FT");
  });

  it("currentContentMinute wins over fallbackContentMinute and event fallback", () => {
    expect(
      computeContentMinuteLabel({
        phase: "live_first_half",
        isReplay: false,
        currentContentMinute: "23",
        fallbackContentMinute: "21",
        events: [event({ id: "1", contentTime: "5" })],
      }),
    ).toBe("23'");
  });

  it("preserves stoppage suffix in displayed label ('45+2' → '45+2'')", () => {
    // Sub-piece 4d — string state lets the stoppage form survive
    // end-to-end rather than being floored to the leading integer.
    expect(
      computeContentMinuteLabel({
        phase: "live_first_half",
        isReplay: false,
        currentContentMinute: "45+2",
        fallbackContentMinute: null,
        events: [],
      }),
    ).toBe("45+2'");
    expect(
      computeContentMinuteLabel({
        phase: "live_second_half",
        isReplay: false,
        currentContentMinute: "90+7",
        fallbackContentMinute: null,
        events: [],
      }),
    ).toBe("90+7'");
  });

  it("falls back to fallbackContentMinute when currentContentMinute is null (live only)", () => {
    expect(
      computeContentMinuteLabel({
        phase: "live_first_half",
        isReplay: false,
        currentContentMinute: null,
        fallbackContentMinute: "12'",
        events: noEvents,
      }),
    ).toBe("12'");
  });

  it("ignores fallbackContentMinute in replay (server reflects FINAL state, listener may be earlier)", () => {
    expect(
      computeContentMinuteLabel({
        phase: "live_second_half",
        isReplay: true,
        currentContentMinute: null,
        fallbackContentMinute: "FT",
        events: [event({ id: "1", contentTime: "12" })],
      }),
    ).toBe("12'");
  });

  it("falls back to latestContentMinute(events) when nothing else is set", () => {
    expect(
      computeContentMinuteLabel({
        phase: "live_first_half",
        isReplay: false,
        currentContentMinute: null,
        fallbackContentMinute: null,
        events: [
          event({ id: "1", contentTime: "5" }),
          event({ id: "2", contentTime: "12" }),
        ],
      }),
    ).toBe("12'");
  });

  it("returns null when no minute is available anywhere", () => {
    expect(
      computeContentMinuteLabel({
        phase: "warming",
        isReplay: false,
        currentContentMinute: null,
        fallbackContentMinute: null,
        events: [],
      }),
    ).toBeNull();
  });
});
