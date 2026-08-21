/**
 * Per-broadcast roster cache. Populated at activation from Sportmonks
 * lineups (see kairos-bridge.activateBroadcast), read by:
 *   - the transcript normaliser before every transcription push
 *     (uses the flat `roster` form via `getRoster`)
 *   - the distiller (uses the per-team form via `getRosterDetails`)
 * In-memory only — cleared on broadcast completion and on server
 * restart. Rehydration on restart would re-fetch lineups; not wired
 * today, and acceptable for a prototype since broadcasts re-activate
 * explicitly.
 */
export interface RosterDetails {
  /** Flat list of canonical player names (both teams), used by the
   * transcript name-normaliser. */
  roster: string[];
  /** Home-side canonical names. */
  homeRoster: string[];
  /** Away-side canonical names. */
  awayRoster: string[];
  /** Display names for prompt-side labelling. */
  homeTeamName?: string;
  awayTeamName?: string;
}

const rosters = new Map<string, RosterDetails>();

export function setRoster(broadcastId: string, details: RosterDetails): void {
  rosters.set(broadcastId, details);
  console.log(
    `[roster] loaded ${details.roster.length} names for ${broadcastId} (home ${details.homeRoster.length}, away ${details.awayRoster.length})`,
  );
}

/** Returns the flat roster array (both teams combined). Backwards-
 * compatible with the transcript normaliser, which doesn't need
 * home/away partitioning. */
export function getRoster(broadcastId: string): string[] {
  return rosters.get(broadcastId)?.roster ?? [];
}

/** Returns the structured form. The distiller needs home/away
 * partitioning to apply roster discipline with team context. Returns
 * undefined when no roster has been loaded for the broadcast. */
export function getRosterDetails(broadcastId: string): RosterDetails | undefined {
  return rosters.get(broadcastId);
}

export function clearRoster(broadcastId: string): void {
  rosters.delete(broadcastId);
}
