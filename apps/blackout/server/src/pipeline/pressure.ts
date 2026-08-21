/**
 * Pressure pipeline
 *
 * Consumes raw Sportmonks ball_position and trend updates and derives a
 * per-team "pressure" signal — what's happening during each team's current
 * attacking push. Raw rows fire too often and at too low a semantic level
 * for either a human moderator or Kairos to do anything useful with them;
 * this module reshapes them into meaningful moments.
 *
 * Model:
 *   - Each team has its own running counters (attacks, shots, corners,
 *     dangerous_attacks) plus accumulated attacking-third time.
 *   - When a team's ball position crosses into that team's attacking
 *     third, the module emits a `zone_entry` signal *and resets that
 *     team's counters* — pressure is measured relative to the most
 *     recent attacking push.
 *   - Every `emitIntervalMs` (default 15s), any team whose counters are
 *     non-zero produces a `pressure_update` signal with the accumulated
 *     numbers since its last reset.
 *
 * Zone direction is derived from the active Sportmonks period:
 *   - 1H (counts_from == 0): home attacks right (x > 0.5).
 *   - 2H (counts_from == 45): home attacks left  (x < 0.5).
 * The attacking-third threshold is 1/3 pitch length (0.33 / 0.67).
 *
 * This module is transport-agnostic — it emits signals to a callback.
 * The caller decides where they go (moderator WS, Kairos, logs).
 */

import type { TeamSide as Side } from "@blackout/shared";
type Zone = "home_attacking" | "middle" | "away_attacking";

const ATTACKING_THIRD_FAR = 2 / 3; // x > 0.667 is the far attacking third
const ATTACKING_THIRD_NEAR = 1 / 3; // x < 0.333 is the near attacking third
const DEFAULT_EMIT_INTERVAL_MS = 15_000;
const DEFAULT_ZONE_COMMIT_SAMPLES = 2; // consecutive same-zone samples required to commit
const DEFAULT_PHASE_STALE_MS = 120_000; // phase is silenced if its team hasn't been in attacking third for this long

const RELEVANT_STATS = ["attacks", "dangerous_attacks", "shots_total", "corners"] as const;
type RelevantStat = (typeof RELEVANT_STATS)[number];

function normaliseStatName(name: string | null | undefined): RelevantStat | null {
  if (!name) return null;
  const slug = name.toLowerCase().replace(/[\s-]+/g, "_");
  if (slug === "attacks") return "attacks";
  if (slug === "dangerous_attacks") return "dangerous_attacks";
  if (slug === "shots_total" || slug === "total_shots" || slug === "shots") return "shots_total";
  if (slug === "corners") return "corners";
  return null;
}

export interface TeamRef {
  side: Side;
  name?: string;
}

export interface BallPositionInput {
  x: number;
  y: number;
  minute?: number | null;
  subjectTime?: string | null;
  wallClockMs: number;
}

export interface TrendInput {
  team: TeamRef;
  statName: string;
  value: number;
  minute?: number | null;
  subjectTime?: string | null;
}

export interface PeriodInput {
  /** `counts_from` of the currently ticking period. 0 => 1H, 45 => 2H, etc. */
  countsFrom: number | null;
}

export type PressureSignal =
  | {
      type: "zone_entry";
      team: Side;
      teamName: string | null;
      subjectTime: string | null;
      wallClockMs: number;
    }
  | {
      type: "zone_middle";
      /** Team that just left their attacking third — ball is now in the middle third. */
      fromTeam: Side | null;
      fromTeamName: string | null;
      subjectTime: string | null;
      wallClockMs: number;
    }
  | {
      type: "pressure_update";
      team: Side;
      teamName: string | null;
      subjectTime: string | null;
      wallClockMs: number;
      /** Seconds since this team's counters were last reset. */
      phaseDurationSeconds: number;
      attacks: number;
      dangerousAttacks: number;
      shots: number;
      corners: number;
      /** Fraction of phase duration the ball has been in this team's attacking third. */
      attackingThirdShare: number;
    };

interface TeamState {
  teamName: string | null;
  // Cumulative trend values last observed (used to diff new samples).
  lastTrendValues: Record<RelevantStat, number | null>;
  // Accumulators since last reset.
  attacks: number;
  dangerousAttacks: number;
  shots: number;
  corners: number;
  // Zone tracking.
  inAttackingThird: boolean;
  attackingThirdMsAccumulated: number;
  lastAttackingThirdEnterWallClock: number | null;
  /**
   * Wall-clock of the most recent moment this team was in their attacking
   * third. Used to silence stale phases (a team that's been pinned in their
   * own half for minutes shouldn't keep emitting pressure updates).
   */
  lastSeenInAttackingThirdWallClock: number | null;
  // Phase markers.
  phaseStartWallClock: number;
  lastContentTime: string | null;
}

function emptyTeamState(nowMs: number): TeamState {
  return {
    teamName: null,
    lastTrendValues: {
      attacks: null,
      dangerous_attacks: null,
      shots_total: null,
      corners: null,
    },
    attacks: 0,
    dangerousAttacks: 0,
    shots: 0,
    corners: 0,
    inAttackingThird: false,
    attackingThirdMsAccumulated: 0,
    lastAttackingThirdEnterWallClock: null,
    lastSeenInAttackingThirdWallClock: null,
    phaseStartWallClock: nowMs,
    lastContentTime: null,
  };
}

export interface PressurePipelineOptions {
  emitIntervalMs?: number;
  /**
   * Duration after `start()` during which state updates are still applied
   * but signals are suppressed. This lets the initial Sportmonks poll
   * (which ships the full history of the match's ball coordinates) settle
   * without producing a storm of retroactive zone_entry signals. Default
   * is 5 seconds; set 0 to emit immediately.
   */
  warmupMs?: number;
  /**
   * Minimum number of consecutive same-zone samples required before the
   * candidate zone is committed. Two means a single-sample flicker at a
   * boundary gets absorbed; the second confirming sample commits the
   * transition. Sample-count rather than wall-clock because bulk polls
   * ship many rows with the same timestamp.
   */
  zoneCommitSamples?: number;
  /**
   * A team's pressure phase is considered stale once this much time has
   * passed since they were last in their attacking third. Stale phases
   * stop emitting `pressure_update` signals until a fresh entry resets.
   */
  phaseStaleMs?: number;
  now?: () => number;
}

export class PressurePipeline {
  private readonly emitIntervalMs: number;
  private readonly warmupMs: number;
  private readonly zoneCommitSamples: number;
  private readonly phaseStaleMs: number;
  private readonly now: () => number;
  private readonly state: Record<Side, TeamState>;
  private countsFrom: number | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private listener: ((signal: PressureSignal) => void) | null = null;
  private emitAfterMs: number = 0;
  /** The zone we've committed the ball to — stable against boundary flicker. */
  private committedZone: Zone = "middle";
  /** Candidate zone waiting to be confirmed by a subsequent sample. */
  private candidateZone: Zone | null = null;
  private candidateSampleCount: number = 0;

  constructor(options: PressurePipelineOptions = {}) {
    this.emitIntervalMs = options.emitIntervalMs ?? DEFAULT_EMIT_INTERVAL_MS;
    this.warmupMs = options.warmupMs ?? 5_000;
    this.zoneCommitSamples = options.zoneCommitSamples ?? DEFAULT_ZONE_COMMIT_SAMPLES;
    this.phaseStaleMs = options.phaseStaleMs ?? DEFAULT_PHASE_STALE_MS;
    this.now = options.now ?? (() => Date.now());
    const nowMs = this.now();
    this.state = {
      home: emptyTeamState(nowMs),
      away: emptyTeamState(nowMs),
    };
  }

  start(onSignal: (signal: PressureSignal) => void): void {
    this.stop();
    this.listener = onSignal;
    this.emitAfterMs = this.now() + this.warmupMs;
    this.timer = setInterval(() => this.tick(), this.emitIntervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.listener = null;
  }

  /** Called on every fixture poll so we know which half to map coords
   * against. A change in `countsFrom` between calls indicates a match-
   * phase boundary (1H → HT → 2H → ET, etc.); when that happens, reset
   * each team's phase clock so `attackingThirdShare` is freshly
   * normalised against the new phase.
   *
   * Without this hook the share gets dominated by lifetime accumulation
   * — late in a 2H, a team that pressed heavily in the 1H would keep
   * showing high share regardless of current play. */
  setPeriod(period: PeriodInput): void {
    const previousCountsFrom = this.countsFrom;
    this.countsFrom = period.countsFrom;
    if (
      previousCountsFrom != null &&
      period.countsFrom != null &&
      period.countsFrom !== previousCountsFrom
    ) {
      this.phaseChanged(this.now());
    }
  }

  ingestBallPosition(input: BallPositionInput): void {
    if (!Number.isFinite(input.x)) return;

    const sampleZone = this.zoneForX(input.x);

    // Accrue attacking-third time for whichever team is currently committed
    // to being in their attacking third. Done before any zone transition
    // so the final segment of the outgoing phase gets counted.
    for (const side of ["home", "away"] as const) {
      const ts = this.state[side];
      if (ts.inAttackingThird && ts.lastAttackingThirdEnterWallClock != null) {
        const delta = input.wallClockMs - ts.lastAttackingThirdEnterWallClock;
        if (delta > 0) {
          ts.attackingThirdMsAccumulated += delta;
          ts.lastAttackingThirdEnterWallClock = input.wallClockMs;
          ts.lastSeenInAttackingThirdWallClock = input.wallClockMs;
        }
      }
    }

    // Debounced zone commit: the candidate must appear in N consecutive
    // samples before we treat it as the ball's real position. Sample-count
    // rather than wall-clock because a bulk poll can ship many rows with
    // the same timestamp and a wall-clock debounce would never fire.
    if (sampleZone === this.committedZone) {
      this.candidateZone = null;
      this.candidateSampleCount = 0;
    } else if (sampleZone !== this.candidateZone) {
      this.candidateZone = sampleZone;
      this.candidateSampleCount = 1;
    } else {
      this.candidateSampleCount += 1;
      if (this.candidateSampleCount >= this.zoneCommitSamples) {
        this.commitZone(sampleZone, input);
      }
    }

    const activeSide = this.committedZone === "home_attacking"
      ? "home"
      : this.committedZone === "away_attacking"
        ? "away"
        : null;

    if (activeSide) {
      const ts = this.state[activeSide];
      if (input.subjectTime) ts.lastContentTime = input.subjectTime;
      ts.lastSeenInAttackingThirdWallClock = input.wallClockMs;
    }
  }

  private commitZone(newZone: Zone, input: BallPositionInput): void {
    const previousZone = this.committedZone;
    this.committedZone = newZone;
    this.candidateZone = null;
    this.candidateSampleCount = 0;

    // Flip every team out of its attacking third; then re-enter the one
    // whose attacking third just got committed to.
    for (const side of ["home", "away"] as const) {
      const ts = this.state[side];
      if (ts.inAttackingThird) {
        ts.inAttackingThird = false;
        ts.lastAttackingThirdEnterWallClock = null;
      }
    }

    if (newZone === "middle") {
      const fromTeam = previousZone === "home_attacking" ? "home" : previousZone === "away_attacking" ? "away" : null;
      const fromTeamName = fromTeam ? this.state[fromTeam].teamName : null;
      this.emit({
        type: "zone_middle",
        fromTeam,
        fromTeamName,
        subjectTime: input.subjectTime ?? null,
        wallClockMs: input.wallClockMs,
      });
      return;
    }

    const side: Side = newZone === "home_attacking" ? "home" : "away";
    const ts = this.state[side];
    // Reset the team's per-attack counters so each new zone-entry
    // starts a fresh "attacking phase" view. Crucially: do NOT reset
    // `phaseStartWallClock` or `attackingThirdMsAccumulated` here — those
    // anchor to the match phase (kickoff / HT / FT / SH-kickoff) and
    // are reset only via the public `phaseChanged()` hook the runner
    // calls on phase boundaries. Resetting them on every zone re-entry
    // (the original behaviour) caused `attackingThirdShare` to round
    // toward 1.0 immediately after entry — 75% of values during
    // 2026-04-26 FA Cup SF were stuck at 100%.
    this.resetCounters(side);
    if (input.subjectTime) ts.lastContentTime = input.subjectTime;
    ts.inAttackingThird = true;
    ts.lastAttackingThirdEnterWallClock = input.wallClockMs;
    ts.lastSeenInAttackingThirdWallClock = input.wallClockMs;
    this.emit({
      type: "zone_entry",
      team: side,
      teamName: ts.teamName,
      subjectTime: input.subjectTime ?? null,
      wallClockMs: input.wallClockMs,
    });
  }

  ingestTrend(input: TrendInput): void {
    const stat = normaliseStatName(input.statName);
    if (!stat) return;

    const ts = this.state[input.team.side];
    if (input.team.name) ts.teamName = input.team.name;

    const prev = ts.lastTrendValues[stat];
    ts.lastTrendValues[stat] = input.value;

    // First observation of this stat in this phase — treat as baseline,
    // no accrual. Subsequent observations accrue the positive delta.
    if (prev == null) return;
    const delta = input.value - prev;
    if (delta <= 0) return;

    if (stat === "attacks") ts.attacks += delta;
    else if (stat === "dangerous_attacks") ts.dangerousAttacks += delta;
    else if (stat === "shots_total") ts.shots += delta;
    else if (stat === "corners") ts.corners += delta;

    if (input.subjectTime) ts.lastContentTime = input.subjectTime;
  }

  private tick(): void {
    const nowMs = this.now();
    for (const side of ["home", "away"] as const) {
      const ts = this.state[side];
      // Close out any open attacking-third segment so the share is fresh.
      if (ts.inAttackingThird && ts.lastAttackingThirdEnterWallClock != null) {
        const delta = nowMs - ts.lastAttackingThirdEnterWallClock;
        if (delta > 0) {
          ts.attackingThirdMsAccumulated += delta;
          ts.lastAttackingThirdEnterWallClock = nowMs;
          ts.lastSeenInAttackingThirdWallClock = nowMs;
        }
      }

      // Silence stale phases: if the team hasn't been in their attacking
      // third for `phaseStaleMs`, their pressure is a faded tail — skip.
      if (!ts.inAttackingThird && ts.lastSeenInAttackingThirdWallClock != null) {
        const sinceLastInThird = nowMs - ts.lastSeenInAttackingThirdWallClock;
        if (sinceLastInThird > this.phaseStaleMs) continue;
      }
      // And if they've never been in their attacking third this phase,
      // there's nothing meaningful to report.
      if (ts.lastSeenInAttackingThirdWallClock == null) continue;

      const phaseDurationMs = nowMs - ts.phaseStartWallClock;
      const hasSignal =
        ts.attacks > 0 || ts.dangerousAttacks > 0 || ts.shots > 0 || ts.corners > 0 || ts.attackingThirdMsAccumulated > 0;
      if (!hasSignal || phaseDurationMs <= 0) continue;

      const share = Math.min(1, ts.attackingThirdMsAccumulated / phaseDurationMs);
      this.emit({
        type: "pressure_update",
        team: side,
        teamName: ts.teamName,
        // Always null on tick-emitted updates: the broadcast-runner
        // stamps `subjectTime` from the global `getSubjectTime()` at
        // emit time. Per-team `lastContentTime` is kept for staleness
        // diagnostics only — emitting it produced non-monotonic minute
        // sequences when ball coords arrived out of order across teams
        // (28 regressions during 2026-04-26 FA Cup SF).
        subjectTime: null,
        wallClockMs: nowMs,
        phaseDurationSeconds: Math.round(phaseDurationMs / 1000),
        attacks: ts.attacks,
        dangerousAttacks: ts.dangerousAttacks,
        shots: ts.shots,
        corners: ts.corners,
        attackingThirdShare: Number(share.toFixed(2)),
      });
    }
  }

  /**
   * Map a raw x coordinate to a zone, accounting for which half we're in.
   * 1H: home attacks right (x > 0.5); home's attacking third is x > 2/3.
   * 2H: home attacks left  (x < 0.5); home's attacking third is x < 1/3.
   * Other halves (ET etc) reuse the same parity.
   */
  private zoneForX(x: number): Zone {
    const homeAttacksRight = (this.countsFrom ?? 0) % 90 < 45;
    if (homeAttacksRight) {
      if (x > ATTACKING_THIRD_FAR) return "home_attacking";
      if (x < ATTACKING_THIRD_NEAR) return "away_attacking";
    } else {
      if (x < ATTACKING_THIRD_NEAR) return "home_attacking";
      if (x > ATTACKING_THIRD_FAR) return "away_attacking";
    }
    return "middle";
  }

  /** Force a synchronous emit cycle. Test-only seam — the production
   * path always reaches `tick` via the real `setInterval` started in
   * `start()`. Lets unit tests assert against the emitted signal stream
   * without depending on real-timer ordering. */
  _tickForTest(): void {
    this.tick();
  }

  /** Zero a team's per-attack counters. Called on zone re-entry — each
   * new attacking phase starts fresh for attacks/dangerous/shots/corners.
   * Does NOT reset the phase clock; that anchors to the match phase. */
  private resetCounters(side: Side): void {
    const ts = this.state[side];
    ts.attacks = 0;
    ts.dangerousAttacks = 0;
    ts.shots = 0;
    ts.corners = 0;
    // Trend baselines stay — deltas continue to accrue against last observed
    // values, so we don't double-count the next sample after reset.
  }

  /**
   * Reset every team's match-phase clock — both the
   * `attackingThirdMsAccumulated` accumulator and `phaseStartWallClock`
   * — so `attackingThirdShare` is freshly normalised against the new
   * phase. Without this, lifetime-of-broadcast accumulation would
   * drown out within-phase pressure shifts.
   *
   * Public hook, but in production today it's only fired internally
   * by `setPeriod` when Sportmonks's `countsFrom` changes (1H → 2H,
   * 2H → ET, etc.). Note: halftime entry doesn't trigger this — at
   * the HT whistle Sportmonks reports no period ticking (countsFrom
   * goes null), and the guard in `setPeriod` skips the null
   * transition. The reset only fires when 2H actually starts. So
   * pressure accumulation continues across HT, but the accumulator's
   * impact on share is trivial because halftime is silent on the
   * Sportmonks polling side anyway. The hook is exposed publicly so
   * a future caller can drive resets explicitly (e.g. on FT or HT
   * via the conductor's phase callbacks) if we decide we want that
   * shape.
   */
  phaseChanged(nowMs: number = this.now()): void {
    for (const side of ["home", "away"] as const) {
      const ts = this.state[side];
      ts.attackingThirdMsAccumulated = 0;
      ts.phaseStartWallClock = nowMs;
      ts.lastAttackingThirdEnterWallClock = ts.inAttackingThird ? nowMs : null;
    }
  }

  private emit(signal: PressureSignal): void {
    // Warm-up window: state updates keep happening, but we drop signals.
    // This prevents the initial Sportmonks poll — which replays the full
    // match history of ball coordinates — from producing a storm of
    // retroactive zone_entry firings.
    if (this.now() < this.emitAfterMs) return;
    this.listener?.(signal);
  }
}
