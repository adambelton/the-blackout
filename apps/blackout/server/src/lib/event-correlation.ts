/**
 * Event-correlation primitives.
 *
 * Holds the rules behind matching the distiller's `event_claim` and
 * `event_texture` outputs against canonical Sportmonks events as they
 * arrive. Generalises what the deleted goal-only correlator did —
 * any canonical event class can now contribute calibration samples,
 * not just goals.
 *
 * Three ledgers, owned by the broadcast-runner:
 *   - canonical events seen recently (the matchable targets)
 *   - pending claims from commentary (waiting for canonical to land)
 *   - pending texture from commentary (waiting to link to canonical)
 *
 * Pure rules, no I/O. The runner owns mutable state and side-effects
 * (push to Kairos, update radio offset, emit telemetry); this module
 * decides what matches what.
 */

export const CORRELATION_WINDOW_MS = 90_000;
/** VAR signals in commentary frequently lead the structured row by a
 * lot (officials confer, players gather, the ref puts a hand to ear).
 * Wider window reduces false-misses for VAR specifically. */
export const VAR_CORRELATION_WINDOW_MS = 120_000;

export type EventClass =
  | "KICKOFF"
  | "HALFTIME"
  | "SECOND_HALF_KICKOFF"
  | "FULL_TIME"
  | "GOAL"
  | "YELLOW_CARD"
  | "RED_CARD"
  | "SUBSTITUTION"
  | "VAR_CHECK"
  | "PENALTY_AWARDED";

const EVENT_CLASSES: ReadonlySet<EventClass> = new Set<EventClass>([
  "KICKOFF",
  "HALFTIME",
  "SECOND_HALF_KICKOFF",
  "FULL_TIME",
  "GOAL",
  "YELLOW_CARD",
  "RED_CARD",
  "SUBSTITUTION",
  "VAR_CHECK",
  "PENALTY_AWARDED",
]);

/** Phase-whistle classes are unique per match — match on class alone,
 * player/team aren't relevant. */
const PHASE_CLASSES: ReadonlySet<EventClass> = new Set<EventClass>([
  "KICKOFF",
  "HALFTIME",
  "SECOND_HALF_KICKOFF",
  "FULL_TIME",
  "VAR_CHECK",
]);

export function isEventClass(value: unknown): value is EventClass {
  return typeof value === "string" && EVENT_CLASSES.has(value as EventClass);
}

/** Canonical event observed from the structured source (Sportmonks).
 * Stays in the buffer for `CORRELATION_WINDOW_MS` so late-arriving
 * commentary claims/texture for the same event can still match. */
export interface CanonicalEventEntry {
  eventId: string;
  eventClass: EventClass;
  /** Lowercased surname when we have one we trust (≥3 chars), null
   * otherwise. Same shape as the legacy goal correlator. */
  playerLastName: string | null;
  /** Lowercased team name / short code when relevant for matching
   * (currently used for PENALTY_AWARDED; null for others). */
  teamKey: string | null;
  subjectTime: string;
  realWallClockMs: number;
  addedAt: number;
}

/** Commentary's structured assertion that a canonical event happened.
 * Held in the claim ledger until either a canonical event matches it
 * (calibration sample fires) or the window expires (no-match telemetry). */
export interface PendingClaim {
  /** Internal id assigned by the runner — used for cancellation /
   * de-duplication if the distiller re-emits across overlapping
   * chunks. */
  claimId: string;
  eventClass: EventClass;
  playerLastName: string | null;
  teamKey: string | null;
  subjectTimeHint: string | null;
  /** Wall-clock instant the commentary asserted the claim. Computed by
   * the runner from the originating Deepgram utterance + the radio
   * stream's current offset estimate, so claimedAtMs is in the same
   * frame as canonical events' realWallClockMs. */
  claimedAtMs: number;
  addedAt: number;
}

/** Texture entry waiting for its parent canonical event to arrive.
 * Released when (a) a matching canonical event lands within the
 * window, with `parentSourceId` set; or (b) the window expires, as
 * standalone match_action with no parent. */
export interface PendingTexture {
  textureId: string;
  content: string;
  eventHint: {
    eventClass: EventClass;
    playerLastName: string | null;
    teamKey: string | null;
    minuteHint: string | null;
  };
  /** Wall-clock instant of the originating commentary line. Used by
   * Kairos's content-time stamping when the entry is finally pushed. */
  observedAtMs: number;
  addedAt: number;
}

/** A single calibration sample emitted on a successful claim ↔ event
 * match. The runner consumes these to update radio-offset tracking. */
export interface CalibrationSample {
  eventClass: EventClass;
  /** rawDeltaSeconds = canonicalRealWallClock - claimedAtMs (in
   * seconds). Positive → commentary led the canonical row by this many
   * seconds. Negative → canonical row landed before commentary, which
   * should be rare. */
  rawDeltaSeconds: number;
  canonicalEventId: string;
  matchedClaimId: string;
}

/** Parent-linked texture release: the runner pushes these to Kairos
 * with `parentSourceId` set on the entry data. */
export interface LinkedTextureRelease {
  textureId: string;
  content: string;
  parentSourceId: string;
  observedAtMs: number;
  eventClass: EventClass;
}

/** Standalone (no parent found within the window) texture release. */
export interface StandaloneTextureRelease {
  textureId: string;
  content: string;
  observedAtMs: number;
  eventClass: EventClass;
  /** True when the texture was released *because* its window expired
   * with no matching canonical event. False when released for any
   * other reason (currently unused; preserved for future paths). */
  fromWindowExpiry: true;
}

/** Choose the correlation window for a given class. */
export function windowForClass(eventClass: EventClass): number {
  return eventClass === "VAR_CHECK"
    ? VAR_CORRELATION_WINDOW_MS
    : CORRELATION_WINDOW_MS;
}

/**
 * Decide whether a pending claim matches a canonical event. Phase
 * whistles match on class alone (they're unique per match). Other
 * classes match on class + player surname when both have one;
 * fall back to class-only when neither side has a player.
 *
 * The runner caller is expected to have already filtered to canonical
 * events still inside the correlation window; this function doesn't
 * re-check timing, only identity.
 */
export function claimMatchesCanonical(
  claim: PendingClaim,
  canonical: CanonicalEventEntry,
): boolean {
  if (claim.eventClass !== canonical.eventClass) return false;
  if (PHASE_CLASSES.has(claim.eventClass)) return true;
  // Player-bearing classes: prefer an explicit name match. Allow
  // fallthrough when neither side carried a name.
  if (claim.playerLastName && canonical.playerLastName) {
    return claim.playerLastName === canonical.playerLastName;
  }
  if (!claim.playerLastName && !canonical.playerLastName) return true;
  // Mixed (one has a name, the other doesn't) — be conservative; don't
  // match. The downstream "no match in window" telemetry will catch
  // these cases for us to investigate.
  return false;
}

/**
 * Decide whether a pending texture's eventHint matches a canonical
 * event. Same rule shape as claim matching — texture inherits the
 * hint's identifying fields.
 */
export function textureMatchesCanonical(
  texture: PendingTexture,
  canonical: CanonicalEventEntry,
): boolean {
  const hint = texture.eventHint;
  if (hint.eventClass !== canonical.eventClass) return false;
  if (PHASE_CLASSES.has(hint.eventClass)) return true;
  if (hint.playerLastName && canonical.playerLastName) {
    return hint.playerLastName === canonical.playerLastName;
  }
  if (!hint.playerLastName && !canonical.playerLastName) return true;
  return false;
}

/**
 * Resolve a newly-arrived canonical event against the pending ledgers.
 * Returns the calibration sample (if a claim matched) and the texture
 * releases (one per matching texture). Caller mutates the ledgers
 * using the returned ids — this function is pure.
 *
 * Multiple textures can match a single canonical event (typical: a
 * goal has build-up texture, reaction texture, and crowd texture all
 * anchored on the same hint). All matches are released.
 *
 * At most one calibration sample per canonical event — the oldest
 * matching pending claim wins. Subsequent claims for the same canonical
 * event are dropped (typically the distiller emits one claim per event;
 * if there are duplicates from overlapping chunks we don't double-count).
 */
export function resolveCanonical(
  canonical: CanonicalEventEntry,
  pendingClaims: readonly PendingClaim[],
  pendingTextures: readonly PendingTexture[],
): {
  sample: CalibrationSample | null;
  matchedClaimId: string | null;
  textureReleases: LinkedTextureRelease[];
  matchedTextureIds: string[];
} {
  const window = windowForClass(canonical.eventClass);

  let matchedClaim: PendingClaim | null = null;
  for (const claim of pendingClaims) {
    if (Math.abs(canonical.realWallClockMs - claim.claimedAtMs) > window) continue;
    if (!claimMatchesCanonical(claim, canonical)) continue;
    if (matchedClaim === null || claim.addedAt < matchedClaim.addedAt) {
      matchedClaim = claim;
    }
  }

  const textureReleases: LinkedTextureRelease[] = [];
  const matchedTextureIds: string[] = [];
  for (const texture of pendingTextures) {
    if (Math.abs(canonical.realWallClockMs - texture.observedAtMs) > window) continue;
    if (!textureMatchesCanonical(texture, canonical)) continue;
    textureReleases.push({
      textureId: texture.textureId,
      content: texture.content,
      parentSourceId: canonical.eventId,
      observedAtMs: texture.observedAtMs,
      eventClass: canonical.eventClass,
    });
    matchedTextureIds.push(texture.textureId);
  }

  const sample: CalibrationSample | null = matchedClaim
    ? {
        eventClass: canonical.eventClass,
        rawDeltaSeconds: (canonical.realWallClockMs - matchedClaim.claimedAtMs) / 1000,
        canonicalEventId: canonical.eventId,
        matchedClaimId: matchedClaim.claimId,
      }
    : null;

  return {
    sample,
    matchedClaimId: matchedClaim?.claimId ?? null,
    textureReleases,
    matchedTextureIds,
  };
}

/**
 * Drop ledger entries whose age has exceeded the correlation window.
 * Returns the entries dropped so the caller can act on them
 * (release expired textures as standalone, log expired claims as
 * no-match telemetry). Mutates `claims` and `textures` in place to
 * remove the expired entries.
 */
export function pruneExpired(
  claims: PendingClaim[],
  textures: PendingTexture[],
  canonicals: CanonicalEventEntry[],
  now: number,
): {
  expiredClaims: PendingClaim[];
  expiredTextures: PendingTexture[];
} {
  const expiredClaims: PendingClaim[] = [];
  const expiredTextures: PendingTexture[] = [];

  // Claims are pruned per-class window (VAR is wider).
  for (let i = claims.length - 1; i >= 0; i--) {
    const c = claims[i];
    if (now - c.addedAt > windowForClass(c.eventClass)) {
      expiredClaims.push(c);
      claims.splice(i, 1);
    }
  }

  for (let i = textures.length - 1; i >= 0; i--) {
    const t = textures[i];
    if (now - t.addedAt > windowForClass(t.eventHint.eventClass)) {
      expiredTextures.push(t);
      textures.splice(i, 1);
    }
  }

  // Canonicals are kept until they're past the longest possible
  // window — once expired, any late-arriving claim or texture for them
  // is too far gone to be reliable.
  for (let i = canonicals.length - 1; i >= 0; i--) {
    const c = canonicals[i];
    if (now - c.addedAt > VAR_CORRELATION_WINDOW_MS) {
      canonicals.splice(i, 1);
    }
  }

  return { expiredClaims, expiredTextures };
}

/**
 * Resolve a newly-arrived claim or texture against the canonical
 * ledger. Used when commentary lags the structured event (Sportmonks
 * fired first; the distiller's claim/texture arrives after). Returns
 * the canonical match if one exists in the window, null otherwise.
 *
 * For a texture: caller pushes it with `parentSourceId` if matched,
 * else holds in the pending ledger.
 * For a claim: caller emits a calibration sample if matched, else
 * holds in the pending ledger.
 */
export function findCanonicalForLateArrival(
  payload: { eventClass: EventClass; playerLastName: string | null; teamKey: string | null; observedAtMs: number },
  canonicals: readonly CanonicalEventEntry[],
): CanonicalEventEntry | null {
  const window = windowForClass(payload.eventClass);
  let best: CanonicalEventEntry | null = null;
  for (const c of canonicals) {
    if (c.eventClass !== payload.eventClass) continue;
    if (Math.abs(c.realWallClockMs - payload.observedAtMs) > window) continue;
    if (PHASE_CLASSES.has(payload.eventClass)) {
      // First chronological match wins for phase whistles.
      if (best === null || c.realWallClockMs < best.realWallClockMs) best = c;
      continue;
    }
    if (payload.playerLastName && c.playerLastName) {
      if (payload.playerLastName !== c.playerLastName) continue;
      if (best === null || c.realWallClockMs < best.realWallClockMs) best = c;
      continue;
    }
    if (!payload.playerLastName && !c.playerLastName) {
      if (best === null || c.realWallClockMs < best.realWallClockMs) best = c;
    }
  }
  return best;
}

/** Lowercased surname extraction with the same ≥3-char confidence
 * filter the legacy goal correlator used. Returns null when the input
 * doesn't yield a surname we'd trust to match on. */
export function surnameKey(player: string | undefined | null): string | null {
  if (!player) return null;
  const trimmed = player.trim();
  if (!trimmed) return null;
  const last = trimmed.split(/\s+/).pop() ?? "";
  const lower = last.toLowerCase();
  return lower.length >= 3 ? lower : null;
}

/** Lowercased team-name key — used when matching events that key on
 * team rather than player (currently penalty_awarded). */
export function teamKey(team: string | undefined | null): string | null {
  if (!team) return null;
  const trimmed = team.trim();
  return trimmed.length > 0 ? trimmed.toLowerCase() : null;
}
