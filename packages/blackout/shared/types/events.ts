import type { TeamSide } from "./broadcast.js";

/** Structured event types from the Sportmonks football API. */
export type MatchEventType =
  | "GOAL"
  | "OWN_GOAL"
  | "PENALTY"
  | "PENALTY_MISS"
  | "SUBSTITUTION"
  | "YELLOW_CARD"
  | "RED_CARD"
  | "SECOND_YELLOW"
  | "VAR"
  | "VAR_CARD"
  | "PENALTY_SHOOTOUT_GOAL"
  | "PENALTY_SHOOTOUT_MISS";

/**
 * Synthetic phase-transition event types. Pushed by the runner as
 * `match_events` entries on each Sportmonks lifecycle callback so the
 * narrator and matchroom see them as priority state-changing events
 * (same category as goals and red cards). Live in shared because the
 * matchroom renders them in the event ribbon — the conductor owns
 * runtime semantics in `apps/blackout/server/src/conductor/`.
 */
export type GameplayTransitionEventType =
  | "KICKOFF"
  | "HALFTIME"
  | "SECOND_HALF_KICKOFF"
  | "FULL_TIME";

/**
 * Every event type the canonical-state contract recognises — the
 * union of Sportmonks-derived match events and synthetic
 * gameplay-transition entries. Used as `CanonicalEvent.eventType`.
 */
export type CanonicalEventType = MatchEventType | GameplayTransitionEventType;

/** A confirmed match event from the football events API. */
export interface MatchEvent {
  id: number;
  type: MatchEventType;
  minute: number;
  extraMinute: number | null;
  team: TeamSide | null;
  player: string | null;
  relatedPlayer: string | null;
  info: string | null;
  result: string | null;
  timestamp: number;
}
