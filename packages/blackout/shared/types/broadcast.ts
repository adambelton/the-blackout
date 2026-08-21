/**
 * Broadcast lifecycle states. The transitions are
 * `draft → scheduled → live → complete` — owned by the conductor +
 * activation/completion flows in apps/blackout/server. Stored on
 * `broadcasts.status` and read everywhere a UI surfaces broadcast
 * state.
 */
export const BROADCAST_STATUSES = ["draft", "scheduled", "live", "complete", "archived"] as const;
export type BroadcastStatus = typeof BROADCAST_STATUSES[number];

export function isBroadcastStatus(value: unknown): value is BroadcastStatus {
  return typeof value === "string" && (BROADCAST_STATUSES as readonly string[]).includes(value);
}

/**
 * TTS provider catalogue. The synthesiser used for narrator audio is
 * resolved per-broadcast through the `ttsVoiceId` field on
 * `Broadcast` (FK into the `tts_voices` catalogue, which carries the
 * provider). The moderator console groups voices by provider for
 * selection; per-provider client wiring lives in
 * `apps/blackout/server/src/lib/tts/`. Array order is the canonical UI order
 * (moderator console renders provider tabs in this sequence).
 */
export const BROADCAST_TTS_PROVIDERS = ["openai", "elevenlabs", "hume"] as const;
export type BroadcastTtsProvider = typeof BROADCAST_TTS_PROVIDERS[number];

export function isBroadcastTtsProvider(value: unknown): value is BroadcastTtsProvider {
  return typeof value === "string" && (BROADCAST_TTS_PROVIDERS as readonly string[]).includes(value);
}

/** Human-readable provider names for UI surfaces. Lives next to
 * `BroadcastTtsProvider` so the type and its label stay paired —
 * adding a provider must add a label, enforced by the Record type. */
export const BROADCAST_TTS_PROVIDER_LABELS: Record<BroadcastTtsProvider, string> = {
  openai: "OpenAI",
  elevenlabs: "ElevenLabs",
  hume: "Hume Octave 2",
};

/**
 * Side of the pitch a player or event belongs to. Used across event
 * shapes, player context, and matchroom rendering.
 */
export const TEAM_SIDES = ["home", "away"] as const;
export type TeamSide = typeof TEAM_SIDES[number];

export function isTeamSide(value: unknown): value is TeamSide {
  return typeof value === "string" && (TEAM_SIDES as readonly string[]).includes(value);
}

export interface Broadcast {
  id: string;
  homeTeam: string;
  awayTeam: string;
  competition: string;
  matchDate: string;
  status: BroadcastStatus;
  fixtureId?: number;
  /** FK into the radio_sources catalogue. Resolve to a URL / offset by
   * looking up the corresponding RadioSource from `/radio-sources`. */
  radioSourceId?: string;
  /** UUID FK into the tts_voices catalogue. Resolve to provider +
   * providerVoiceId by looking up the TtsVoiceRecord from `/tts-voices`. */
  ttsVoiceId?: string;
  /**
   * Pipeline-wide TTS enablement for this broadcast. When false (or
   * absent — default treated as disabled), every TTS synthesis path
   * short-circuits: matchroom tune-in is hidden, console auto-play is
   * suppressed, `/tts` calls for this broadcast return 503. Intended as
   * a cost gate during testing; flipped on explicitly when a broadcast
   * is ready for real narrator audio.
   *
   * Persisted on the legacy `tts_autoplay` DB column to avoid a
   * migration — the column's semantics were redefined in the repetition
   * fix round (the previous "console autoplay default" meaning is
   * obsolete; console autoplay is now localStorage-scoped per browser).
   */
  ttsEnabled?: boolean;
  moderatorId?: string;
  kairosBroadcastId?: string;
  matchBrief?: string;
  createdAt: string;
  updatedAt: string;
}

/** An admin-curated TTS voice record. Admins add voices from the provider
 * library (with optional display-name and speed overrides); writers pick
 * from this catalogue in the moderator console. */
export interface TtsVoiceRecord {
  id: string;
  provider: BroadcastTtsProvider;
  providerVoiceId: string;
  name: string;
  description?: string;
  speed?: number;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CreateBroadcastInput {
  homeTeam: string;
  awayTeam: string;
  competition: string;
  matchDate: string;
  fixtureId?: number;
  radioSourceId?: string;
  matchBrief?: string;
}

// `BroadcastContext` / `ClubBrief` / `PlayerContext` /
// `atmosphericIllustrations` were declared here but never imported
// from any consumer (audit 2026-05-10). Removed to stop the dead
// shape inviting future drift; the broadcast-prep work uses
// `narrative_voice` / `narrative_context` feed entries instead.

// ---------------------------------------------------------------------------
import type { Passage } from "./passage.js";

// BroadcastView — what a consumer gets when they tune in.
// ---------------------------------------------------------------------------
//
// The DB Broadcast row plus the runtime state needed to render the
// matchroom from scratch: the phase, the events the broadcast has
// revealed so far (score + minute derive from these), and the
// current narrative (whether still playing or just finished).
//
// Single source of truth for `GET /broadcasts/:id`. Same shape for
// every caller regardless of arrival timing — late joiners,
// refreshers, scheduled-broadcast watchers. Respects the reveal
// contract: `revealedEvents` is what the broadcast has already
// narrated, not the full Sportmonks history, so events staged but
// not yet covered stay hidden from everyone.

/**
 * Conductor phase FSM. The conductor (apps/blackout/server/src/conductor/) is
 * the runtime authority — this is the single declaration; the
 * conductor's types module re-exports it. Transitions:
 *
 *   pre_ramp → warming → live_first_half → halftime →
 *   live_second_half → full_time_winddown → complete
 *
 * `complete` is terminal. `pre_ramp` and `warming` are operational
 * (broadcast lifecycle, not match state).
 */
export const BROADCAST_PHASES = [
  "pre_ramp",
  "warming",
  "live_first_half",
  "halftime",
  "live_second_half",
  "full_time_winddown",
  "complete",
] as const;
export type BroadcastPhase = typeof BROADCAST_PHASES[number];

export function isBroadcastPhase(value: unknown): value is BroadcastPhase {
  return typeof value === "string" && (BROADCAST_PHASES as readonly string[]).includes(value);
}

/**
 * Phases in which the broadcast is "live to listeners" — narration
 * may be in flight, the matchroom shows the playback surface, the
 * conductor expects audio cues. Excludes the operational shoulders
 * (`pre_ramp`, `complete`) and the quiet breaks (`halftime`,
 * `full_time_winddown` — both render placeholders unless a passage
 * is mid-flight, which the caller checks separately).
 *
 * Hoisted from inline `phase === "live_first_half" || phase ===
 * "live_second_half" || phase === "warming"` disjunctions in the
 * matchroom (audit 2026-05-10).
 */
export const LIVE_PHASES: ReadonlySet<BroadcastPhase> = new Set([
  "warming",
  "live_first_half",
  "live_second_half",
]);

export function isLivePhase(phase: BroadcastPhase): boolean {
  return LIVE_PHASES.has(phase);
}

/** A match event rendered for matchroom display. Flattens the
 * relevant fields out of a raw feed entry so the matchroom doesn't
 * need to know about Kairos's entry shape. */
export interface BroadcastViewEvent {
  id: string;
  eventType: string;
  content: string;
  minute: number | null;
  extraMinute: number | null;
  /** Content-time anchor for this event (the match-minute the consumer
   * sees, e.g. `"45+2"`). On the Blackout side this is the football
   * match's minute — see `docs/vocabulary.md` § Time. */
  contentTime?: string;
  timestamp: number;
  player: string | null;
  /** Counterpart actor when the event is relational. For SUBSTITUTION
   * this is the player coming off (paired with `player` who is coming
   * on). Sportmonks emits both via `data.relatedPlayer`; the matchroom
   * surfaces both so the card reads "Off ↑ On" rather than just naming
   * the incoming player. Null when the event has no counterpart
   * (goals, cards, etc). */
  relatedPlayer: string | null;
  team: TeamSide | null;
  teamName: string | null;
  isGoal: boolean;
}

/** The current narration. "Current" means the one the matchroom
 * should render right now — regardless of whether its audio is
 * still playing or has already finished. It stays current until the
 * next one arrives. The client derives play-state from
 * `playbackStartedAt + durationMs` vs wall-clock now. */
export interface BroadcastViewNarrative {
  id: string;
  narrativeId: string;
  text: string;
  wordCount: number;
  audioUrl: string | null;
  durationMs: number;
  playbackStartedAt: string;
}

/** A single narration in the replay sequence — text, audio, and the
 * feed entries it cited (covers) plus the broader batch context.
 * The matchroom plays these in order during replay mode; reveal
 * gating mirrors the live contract — events are revealed when the
 * narration that covers them finishes (or its inline anchor
 * passes). */
export interface ArchiveNarration {
  id: string;
  narrativeId: string;
  text: string;
  wordCount: number;
  audioUrl: string | null;
  durationMs: number;
  batchEntryIds: string[];
  /** Entries the narrator EXPLICITLY referenced in this passage's
   * prose (subset of batchEntryIds). Drives per-passage reveal
   * timing in replay just as it does live. */
  covers: { entryId: string; charOffset?: number }[];
}

/** Full replay payload — populated only when `status === "complete"`.
 * Carries the entire narration sequence (in synthesis order) plus
 * every match event the broadcast surfaced. The client manages
 * playback + reveal state from this; the same no-spoilers contract
 * applies — events are revealed only as their citing narration
 * audio ends, mirroring the live experience. */
export interface BroadcastViewArchive {
  narrations: ArchiveNarration[];
  events: BroadcastViewEvent[];
}

export interface BroadcastView extends Broadcast {
  /** The broadcast's current phase. Reflects conductor state for live
   * broadcasts; inferred from status otherwise (scheduled/draft →
   * `pre_ramp`, complete → `complete`). */
  phase: BroadcastPhase;
  /** Events the broadcast has revealed — i.e. not currently in covers
   * of an in-flight narration. Server-deduped (by `data.sourceId` for
   * Sportmonks events; by `eventType` for synthetic phase entries) and
   * sorted by parsed content time ascending. */
  revealedEvents: BroadcastViewEvent[];
  /** Server-derived score from revealed GOAL events. The matchroom
   * renders this directly — no client-side counting. */
  score: { home: number; away: number };
  /** Server-derived current content minute label (e.g. "47'",
   * "45+2'", "HT", "FT"). Bootstrap fallback for the matchroom clock —
   * the latest revealed event's content time, formatted. Null when
   * no event has a parseable minute (pre-kickoff). See
   * `docs/vocabulary.md` § Time. */
  currentContentMinute: string | null;
  /** The current narrative, or `null` if the broadcast hasn't
   * produced one yet. */
  currentNarrative: BroadcastViewNarrative | null;
  /** Replay payload for completed broadcasts. `null` while live or
   * scheduled — matchroom reads this to decide between live WS mode
   * and replay-playback mode.
   *
   * @deprecated Sub-piece 5 introduces `revealedPassages` as the
   * canonical replay shape. Kept on the response during migration so
   * older clients keep working; new replay code reads
   * `revealedPassages` instead. */
  archive: BroadcastViewArchive | null;
  /** Bundle-driven replay payload — sequenced passages, each with its
   * own canonical bundle. Populated only for `complete` broadcasts.
   * Empty `[]` for live / scheduled / draft (live consumers read the
   * in-flight passage from `connected.currentPassage` over WS). */
  revealedPassages: Passage[];
}

// ---------------------------------------------------------------------------
// ModeratorView — what the moderator console gets on mount.
// ---------------------------------------------------------------------------
//
// Superset of BroadcastView. The moderator's working surface is broader
// than a viewer's: every feed entry from every source (transcription,
// moderator notes, system, events, pressure), every narrative ever
// generated. Refresh must not wipe any of it.
//
// Reveal-gating doesn't apply here — the moderator is the operator and
// sees everything in flight. `BroadcastView`'s `revealedEvents` and
// `currentNarrative` still travel along (used for scoreboard/playback)
// but are derived from the same data, not a separate truth.

/**
 * The Blackout's fixed source layout on Kairos. Each broadcast
 * registers exactly these sources at creation time. Source names are
 * the only identifier used when pushing entries.
 *
 * The runtime `SOURCE` constant below is the typed accessor that
 * consumer code imports — magic-string source names anywhere in the
 * codebase are an audit failure.
 */
export const KAIROS_SOURCE_NAMES = [
  "match_events",
  "match_pressure",
  "match_stats",
  "match_action",
  "moderator",
  "narrative_context",
  "narrative_voice",
] as const;
export type KairosSourceName = typeof KAIROS_SOURCE_NAMES[number];

export function isKairosSourceName(value: unknown): value is KairosSourceName {
  return typeof value === "string" && (KAIROS_SOURCE_NAMES as readonly string[]).includes(value);
}

/**
 * Typed accessor for the seven Kairos source names. Consumer code
 * MUST import `SOURCE` rather than hand-writing the source-name
 * string — a typo in `"match_events"` silently mis-routes a push to
 * Kairos with no compile-time signal. Adding a new source means
 * adding it both here and to `KAIROS_SOURCE_NAMES`.
 *
 *   match_events     — Sportmonks events (canonical).
 *   match_pressure   — Pressure / zone signals from PressurePipeline.
 *   match_stats      — Raw stat ingestion (currently feeds pressure).
 *   match_action     — Distillation outputs (atmosphere + texture).
 *   moderator        — Moderator-typed notes.
 *   narrative_context / narrative_voice — Activation seed material.
 */
export const SOURCE: Record<
  | "matchEvents"
  | "matchPressure"
  | "matchStats"
  | "matchAction"
  | "moderator"
  | "narrativeContext"
  | "narrativeVoice",
  KairosSourceName
> = {
  matchEvents: "match_events",
  matchPressure: "match_pressure",
  matchStats: "match_stats",
  matchAction: "match_action",
  moderator: "moderator",
  narrativeContext: "narrative_context",
  narrativeVoice: "narrative_voice",
};

/** A feed entry shaped for the moderator console. Mirrors the WS
 * `feed_entry.entry` payload exactly so bootstrap and live-stream
 * entries are interchangeable.
 *
 * The taxonomy mirrors what the runner pushes to Kairos — `source` is
 * the Kairos source name from `KAIROS_SOURCE_NAMES`, `subType` is the
 * data-level classification the runner stamps on the entry (`GOAL` /
 * `KICKOFF` for `match_events`, `atmosphere` / `event_texture` for
 * `match_action`, `PRESSURE_UPDATE` / `ZONE_ENTRY` for
 * `match_pressure`). Per-source `subType` discriminated unions are
 * planned but not yet promoted — see comment on KAIROS_SOURCE_NAMES.
 *
 * The `metadata` shape varies by source — event-bearing rows carry
 * `eventType`/`player`/`team`/etc., commentary rows carry the
 * distillation `kind`, ambient rows are bare. */
export interface ModeratorFeedEntry {
  id: string;
  /** Kairos source name as the runner pushed it. */
  source: KairosSourceName;
  /** Data-level classification — `data.eventType` for event sources,
   * `data.kind` for `match_action`, omitted for sources that don't
   * carry a sub-type (`moderator`, `narrative_context`,
   * `narrative_voice`). */
  subType?: string;
  content: string;
  minute: number | null;
  extraMinute: number | null;
  /** Content-time anchor for the entry — see `docs/vocabulary.md` § Time. */
  contentTime?: string;
  timestamp: number;
  metadata?: Record<string, unknown>;
}

/** A narrative for the moderator's narratives panel. Identity is the
 * Kairos generation id (matches the WS `narrative` cue's
 * `narrative.id`) so bootstrap-loaded and live-streamed narratives
 * dedupe cleanly. `covers` drives the ✓ indicator on covered feed
 * entries. */
export interface ModeratorNarrative {
  id: string;
  text: string;
  wordCount: number;
  generatedAt: string;
  covers?: Array<{ entryId: string; contentTime?: string }>;
}

export interface ModeratorView extends BroadcastView {
  /** Every feed entry from every source the moderator's UI renders.
   * Sorted by timestamp ascending. */
  allFeedEntries: ModeratorFeedEntry[];
  /** Every narrative generated for this broadcast. Sorted by
   * `generatedAt` ascending. */
  allNarratives: ModeratorNarrative[];
}
