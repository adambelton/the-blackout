import type { MatchEvent, TeamSide } from "@blackout/shared";
import {
  createSportmonksClient,
  mapEventType,
  type SportmonksParticipant,
  type SportmonksFixture,
  type SportmonksPeriod,
} from "../lib/sportmonks.js";
import { getTypeRef } from "../lib/sportmonks-types.js";
import {
  formatSubjectTime,
  computeLiveSubjectTime,
  computeSubjectPhaseAnchor,
  broadcastTimeForSubjectMinute,
  type SubjectPhaseAnchor,
} from "../lib/subject-time.js";

export interface SportmonksEmitters {
  /** Discrete match events + timeline entries — triggers the narrative loop. */
  onEvent: (data: Record<string, unknown>) => void;
  /** Continuous match telemetry — trends, ball position. */
  onStat: (data: Record<string, unknown>) => void;
  /** Non-fatal polling error surfaced to the moderator console. */
  onError?: (message: string) => void;
  /** Fired on first in-play observation so the consumer knows the clock is running. */
  onKickoff?: () => void;
  /** Live → halftime transition (Sportmonks state → HT). */
  onHalftime?: () => void;
  /** Halftime → live transition (Sportmonks state HT → 2H / ET). */
  onSecondHalfKickoff?: () => void;
  /** Live/halftime → fulltime transition (state → FT / AET / PEN / AP). */
  onFulltime?: () => void;
}

/** Phase category — coarser than Sportmonks state; what the phase FSM
 * cares about. `null` means not yet observed. */
export type SportmonksPhaseCategory =
  | "pre"
  | "live"
  | "halftime"
  | "fulltime";

interface TeamInfo {
  side: TeamSide;
  name: string;
  shortCode: string;
}
type TeamMap = Record<number, TeamInfo>;

function buildTeamMap(participants: SportmonksParticipant[]): TeamMap {
  const map: TeamMap = {};
  for (const p of participants) {
    map[p.id] = { side: p.meta.location, name: p.name, shortCode: p.short_code };
  }
  return map;
}

function formatEvent(event: MatchEvent, teamName: string | null): string {
  const parts: string[] = [event.type];
  if (event.player) parts.push(`— ${event.player}`);
  if (event.relatedPlayer) parts.push(`(${event.relatedPlayer})`);
  if (teamName) parts.push(`(${teamName})`);
  else if (event.team) parts.push(`(${event.team})`);
  if (event.result) parts.push(event.result);
  return parts.join(" ");
}

// Sportmonks state IDs for in-play states
const INPLAY_STATES = new Set([2, 3, 4, 6, 9, 21, 22, 23]);

/**
 * Categorise a Sportmonks fixture state into the coarse phase the
 * conductor cares about. Falls back to state_id when the label is
 * missing. Live = any ticking period (1H, 2H, ET, PEN); halftime =
 * HT / BREAK; fulltime = FT / AET / AP / PEN-after; pre = NS /
 * postponed / cancelled / unknown.
 */
function categorisePhase(
  state: { short_name?: string | null; name?: string | null } | null | undefined,
  stateId: number,
): SportmonksPhaseCategory {
  const label = (state?.short_name || state?.name || "").toUpperCase();
  if (label) {
    if (label === "HT" || (label.includes("HALF") && label.includes("TIME"))) return "halftime";
    if (
      label === "FT" ||
      label === "AET" ||
      label === "AP" ||
      (label.includes("FULL") && label.includes("TIME"))
    ) {
      return "fulltime";
    }
    if (label === "NS" || label.includes("NOT STARTED")) return "pre";
    if (label.includes("POSTPONE") || label.includes("CANCEL")) return "pre";
  }
  // Fall back to state_id. 2/6/22 are 1H/ET/2H — live. 3/4/21 are
  // HT/BREAK/EXTRA_TIME_BREAK — halftime-ish. 5/7/8 are FT/AET/PEN
  // terminal. Everything else → pre.
  if (stateId === 3 || stateId === 4 || stateId === 21) return "halftime";
  if (stateId === 5 || stateId === 7 || stateId === 8) return "fulltime";
  if (INPLAY_STATES.has(stateId)) return "live";
  return "pre";
}

/**
 * Football feed source backed by the Sportmonks API.
 *
 * Polls the fixture feed (events, timeline, trends, ballCoordinates),
 * deduplicates by row id, and splits emission into two streams: discrete
 * events that should trigger narrative cycles, and ambient stats that
 * should enrich context.
 *
 * All football-specific logic stays here. Downstream consumers receive
 * tagged entries with no knowledge of Sportmonks shapes.
 */
export class SportmonksEventSource {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private _kickoffTime: number | null = null;
  private emitters: SportmonksEmitters | null = null;

  private fixtureId: number | null = null;
  private teamMap: TeamMap | null = null;

  // Latest fixture snapshot used to compute live content-time for entries
  // that don't carry their own minute (transcription, moderator messages).
  private latestPeriods: SportmonksPeriod[] | null = null;
  private latestState: SportmonksFixture["state"] | null = null;
  // Last observed phase category — used to detect transitions into
  // halftime / second-half-kickoff / fulltime. `null` until the first
  // fixture poll lands.
  private lastPhaseCategory: SportmonksPhaseCategory | null = null;

  // Dedupe state — stable-id rows. Reseeded across runner restarts
  // by `seedFromExistingEntries`, which the runner calls at start
  // with whatever Kairos already has for this broadcast. Without
  // reseeding, every restart re-pushes every event the source has
  // ever seen — bit Ipswich-QPR (2026-05-02) when 4 restarts produced
  // 38 GOAL entries for a 2-goal match.
  private seenEventIds = new Set<number>();
  private seenTimelineIds = new Set<number>();
  private seenTrendIds = new Set<number>();
  private seenBallIds = new Set<number>();
  // Secondary event dedup by semantic tuple — catches the case where
  // Sportmonks reissues the same event with a different `raw.id`
  // across polls (confirmed 2026-04-22 Burnley-City: Haaland's goal
  // arrived twice, 3 seconds apart, as two distinct rows). Tuple:
  // `${type}|${minute}|${extraMinute||""}|${participantId}|${playerName}|${result||""}`.
  private seenEventFingerprints = new Set<string>();

  get kickoffTime(): number | null {
    return this._kickoffTime;
  }

  /**
   * `counts_from` of the currently ticking period (0 for 1H, 45 for 2H,
   * etc). Used by downstream consumers that need to know which half we're
   * in without grovelling through the periods snapshot themselves. Returns
   * null before the first poll or between periods.
   */
  getCountsFrom(): number | null {
    const ticking = this.latestPeriods?.find((p) => p.ticking && p.has_timer);
    return ticking ? ticking.counts_from : null;
  }

  /**
   * Live content-time label for entries that don't carry a per-row minute.
   * Anchored on the currently ticking period's `started` epoch — so a late
   * kickoff, half-time break, and second-half resume are all handled
   * correctly without relying on wall-clock against the scheduled time.
   *
   * Pass `atWallClockMs` when stamping historic moments (e.g. a Deepgram
   * utterance that ended N seconds ago, corrected by the radio-stream
   * offset). Defaults to `Date.now()`.
   */
  getSubjectTime(atWallClockMs?: number): string {
    return computeLiveSubjectTime(this.latestPeriods, this.latestState, atWallClockMs);
  }

  /**
   * Structured phase anchor for a given wall-clock instant — phase enum
   * + phase-start wall-clock + elapsed seconds. Used to stamp every
   * entry the Blackout pushes to Kairos so the narrator sees a single
   * chronological timeline with sub-minute resolution.
   *
   * Pass `atWallClockMs` when stamping historic moments (Deepgram
   * utterance end-time, corrected by radio offset); defaults to now.
   */
  getSubjectPhaseAnchor(atWallClockMs?: number): SubjectPhaseAnchor {
    return computeSubjectPhaseAnchor(this.latestPeriods, this.latestState, atWallClockMs);
  }

  /**
   * Real-world wall-clock (ms) at which the given match minute occurred.
   * Used by the radio-latency evaluation loop. Returns null if we haven't
   * seen enough of the fixture to resolve the minute's containing period.
   */
  getBroadcastTimeForSubjectMinute(minute: number, extraMinute?: number | null): number | null {
    return broadcastTimeForSubjectMinute(this.latestPeriods, minute, extraMinute ?? 0);
  }

  start(emitters: SportmonksEmitters): void {
    this.emitters = emitters;
    this.stopped = false;
  }

  /**
   * Reseed the dedup state from entries already pushed to Kairos for
   * this broadcast. Each entry's `data.sourceId` is the Sportmonks
   * raw id; `data.kind` distinguishes events from timeline rows.
   * Without this, every fresh runner re-pushes everything Sportmonks
   * has ever returned.
   *
   * Tolerates partial / unexpected shapes — anything we can't read as
   * a numeric id is skipped silently. The downside of an under-seeded
   * set is one duplicate; the downside of a thrown error here is the
   * runner failing to start at all, so we err toward permissive.
   */
  seedFromExistingEntries(entries: Array<Record<string, unknown>>): void {
    let eventCount = 0;
    let timelineCount = 0;
    for (const entry of entries) {
      const data = (entry?.data ?? null) as Record<string, unknown> | null;
      if (!data) continue;
      const sourceId = typeof data.sourceId === "number" ? data.sourceId : null;
      if (sourceId == null) continue;
      const kind = data.kind;
      if (kind === "timeline") {
        this.seenTimelineIds.add(sourceId);
        timelineCount++;
      } else if (kind === "event") {
        this.seenEventIds.add(sourceId);
        eventCount++;
        // Also seed the fingerprint set so a re-issued event with a
        // fresh `raw.id` (Sportmonks does this occasionally) doesn't
        // get re-pushed under a new id.
        const fingerprint = [
          typeof data.eventType === "string" ? data.eventType : "",
          typeof data.minute === "number" ? data.minute : (data.minute ?? ""),
          typeof data.extraMinute === "number" ? data.extraMinute : (data.extraMinute ?? ""),
          // participant id isn't preserved in the pushed entry; team name acts as a coarse stand-in
          typeof data.teamName === "string" ? data.teamName : "",
          typeof data.player === "string" ? data.player.trim().toLowerCase() : "",
          typeof data.result === "string" ? data.result : "",
        ].join("|");
        this.seenEventFingerprints.add(fingerprint);
      }
    }
    console.log(
      `[feed] dedup state seeded from ${entries.length} existing entries (${eventCount} events, ${timelineCount} timeline rows)`,
    );
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.emitters = null;
    console.log("[feed] capture stopped");
  }

  /**
   * Begin polling for a specific fixture. Calls `start()` must precede this.
   */
  async startPolling(fixtureId: number): Promise<TeamMap> {
    if (!this.emitters) throw new Error("Call start() before startPolling()");

    const client = createSportmonksClient();
    const fixture = await client.getFixtureFeed(fixtureId);

    if (!fixture.participants?.length) {
      throw new Error("Fixture has no participant data");
    }

    this.fixtureId = fixtureId;
    this.teamMap = buildTeamMap(fixture.participants);

    console.log(`[feed] starting capture for fixture ${fixtureId}`);
    this.poll(client);

    return this.teamMap;
  }

  private poll(client: ReturnType<typeof createSportmonksClient>): void {
    if (this.stopped || !this.fixtureId || !this.teamMap || !this.emitters) return;

    const fixtureId = this.fixtureId;

    client
      .getFixtureFeed(fixtureId)
      .then((fixture) => this.handleFixtureFeed(fixture))
      .catch((err: Error) => {
        console.error("[feed] fixture poll failed:", err.message);
        this.emitters?.onError?.(`Fixture poll error: ${err.message}`);
      })
      .finally(() => {
        if (!this.stopped) {
          this.timer = setTimeout(() => this.poll(client), 15_000);
        }
      });
  }

  private handleFixtureFeed(fixture: SportmonksFixture): void {
    if (!this.teamMap || !this.emitters) return;
    const teamMap = this.teamMap;
    const { onEvent, onStat } = this.emitters;
    const now = Date.now();

    this.latestPeriods = fixture.periods ?? null;
    this.latestState = fixture.state ?? null;

    if (!this._kickoffTime) {
      if (INPLAY_STATES.has(fixture.state_id) || fixture.state_id === 5) {
        const startingAt = fixture.starting_at;
        this._kickoffTime = startingAt
          ? new Date(startingAt.endsWith("Z") ? startingAt : startingAt + "Z").getTime()
          : Date.now();
        if (INPLAY_STATES.has(fixture.state_id)) {
          console.log(
            `[feed] kickoff detected (state ${fixture.state_id}), time: ${new Date(this._kickoffTime).toISOString()}`,
          );
          this.emitters.onKickoff?.();
        }
      }
    }

    // Phase transition detection. The first poll establishes the
    // baseline (no transition fires); subsequent state-label changes
    // drive onHalftime / onSecondHalfKickoff / onFulltime so the
    // conductor can run the phase FSM.
    const currentCategory = categorisePhase(fixture.state, fixture.state_id);
    if (this.lastPhaseCategory !== null && currentCategory !== this.lastPhaseCategory) {
      const prev = this.lastPhaseCategory;
      console.log(`[feed] phase ${prev} → ${currentCategory}`);
      if (currentCategory === "halftime") {
        this.emitters.onHalftime?.();
      } else if (currentCategory === "live" && prev === "halftime") {
        this.emitters.onSecondHalfKickoff?.();
      } else if (currentCategory === "fulltime") {
        this.emitters.onFulltime?.();
      }
    }
    this.lastPhaseCategory = currentCategory;

    // --- Events (goals, cards, subs) ---
    for (const raw of fixture.events ?? []) {
      if (this.seenEventIds.has(raw.id)) continue;
      this.seenEventIds.add(raw.id);

      const type = mapEventType(raw.type_id);
      if (!type) {
        console.log(
          `[feed] unknown event type_id ${raw.type_id}: ${raw.player_name?.trim() ?? "?"} ${raw.minute}'`,
        );
        continue;
      }

      // Secondary dedup on the semantic tuple — catches reissued
      // events with fresh `raw.id`. Key everything that should be
      // stable across edits (type, minute, participant, player,
      // result). A genuine second goal at the same minute by the
      // same player against the same team would have a different
      // `result` (score changes), which keeps re-scoring legal.
      // Uses teamName (resolved via teamMap) rather than
      // participant_id so the fingerprint is reconstructible from
      // the round-tripped Kairos entry — `seedFromExistingEntries`
      // can rebuild the same key on runner restart.
      const teamInfo = teamMap[raw.participant_id] ?? null;
      const fingerprint = [
        type,
        raw.minute ?? "",
        raw.extra_minute ?? "",
        teamInfo?.name ?? "",
        (raw.player_name ?? "").trim().toLowerCase(),
        raw.result ?? "",
      ].join("|");
      if (this.seenEventFingerprints.has(fingerprint)) {
        console.log(`[feed] dropping duplicate event (fingerprint): ${fingerprint}`);
        continue;
      }
      this.seenEventFingerprints.add(fingerprint);
      const event: MatchEvent = {
        id: raw.id,
        type,
        minute: raw.minute,
        extraMinute: raw.extra_minute,
        team: teamInfo?.side ?? null,
        player: raw.player_name?.trim() || null,
        relatedPlayer: raw.related_player_name?.trim() || null,
        info: raw.info,
        result: raw.result,
        timestamp: now,
      };

      onEvent({
        kind: "event",
        sourceId: raw.id,
        content: formatEvent(event, teamInfo?.name ?? null),
        timestamp: now,
        minute: event.minute,
        extraMinute: event.extraMinute,
        subjectTime: formatSubjectTime(event.minute, event.extraMinute),
        eventType: event.type,
        player: event.player ?? undefined,
        relatedPlayer: event.relatedPlayer ?? undefined,
        team: event.team ?? undefined,
        teamName: teamInfo?.name ?? undefined,
        teamShortCode: teamInfo?.shortCode ?? undefined,
        result: event.result ?? undefined,
        info: event.info ?? undefined,
        subType: raw.subtype?.name ?? undefined,
      });

      const extra = event.extraMinute ? `+${event.extraMinute}` : "";
      console.log(
        `[feed] event ${event.type} ${event.minute}${extra}' ${event.player ?? "?"} (${teamInfo?.name ?? event.team ?? "?"}) ${event.result ?? ""}`,
      );
    }

    // --- Timeline (shots, corners, offsides — no player attribution) ---
    for (const raw of fixture.timeline ?? []) {
      if (this.seenTimelineIds.has(raw.id)) continue;
      this.seenTimelineIds.add(raw.id);

      const tlTeam = teamMap[raw.participant_id] ?? null;
      const tlType = getTypeRef(raw.type_id);
      onEvent({
        kind: "timeline",
        sourceId: raw.id,
        content: `${tlType?.name ?? `type_${raw.type_id}`}${tlTeam ? ` — ${tlTeam.name}` : ""}${raw.player_name ? `, ${raw.player_name}` : ""}`,
        timestamp: now,
        minute: raw.minute,
        extraMinute: raw.extra_minute,
        subjectTime: formatSubjectTime(raw.minute, raw.extra_minute),
        timelineType: tlType?.name ?? null,
        timelineCode: tlType?.code ?? null,
        team: teamMap[raw.participant_id] ?? null,
        player: raw.player_name?.trim() || null,
        addition: raw.addition ?? null,
      });
    }

    // --- Trends (per-minute per-team per-stat) ---
    for (const t of fixture.trends ?? []) {
      if (this.seenTrendIds.has(t.id)) continue;
      this.seenTrendIds.add(t.id);

      const trendType = getTypeRef(t.type_id);
      onStat({
        kind: "trend",
        sourceId: t.id,
        timestamp: now,
        minute: t.minute,
        subjectTime: formatSubjectTime(t.minute),
        team: teamMap[t.participant_id] ?? null,
        statName: trendType?.name ?? null,
        statCode: trendType?.code ?? null,
        statGroup: trendType?.stat_group ?? null,
        value: t.value,
      });
    }

    // --- Ball coordinates (every ~6s) ---
    for (const b of fixture.ballcoordinates ?? []) {
      if (this.seenBallIds.has(b.id)) continue;
      this.seenBallIds.add(b.id);

      // Derive subjectTime via `computeLiveSubjectTime`, not from
      // `b.timer` directly. The 2026-04-26 FA Cup SF surfaced a
      // Sportmonks publication-lag bug: ball-coord `timer` was pinned
      // at "0:XX" for the first 8 match-minutes after kickoff before
      // suddenly jumping to "8". Using `b.timer` directly would have
      // every entry from minutes 0–8 stamped `subjectTime: "1"`
      // (after the off-by-one fix) — visibly wrong, the matchroom
      // would parade "1'" while the actual minute climbed to 8. The
      // period-data path is the authoritative source: it derives the
      // minute from the ticking period's `started` epoch, so when
      // period data is published, the minute is real; when period
      // data is absent (the lag window), it returns a phase label
      // that downstream parses as null. Either we know the real
      // minute or we don't emit one — better than honest-looking
      // misinformation.
      const liveLabel = computeLiveSubjectTime(this.latestPeriods, this.latestState, now);
      const subjectTime = /^[0-9]/.test(liveLabel) ? liveLabel : undefined;

      onStat({
        kind: "ball_position",
        sourceId: b.id,
        timestamp: now,
        timer: b.timer,
        subjectTime,
        x: parseFloat(b.x),
        y: parseFloat(b.y),
      });
    }
  }
}
