/**
 * Match-time helpers shared between the Blackout server and the
 * matchroom client. The two MUST agree on parsing + ordering — the
 * server uses these in `buildBroadcastView` to compute canonical
 * state; the matchroom uses them to render the event ribbon. Any
 * drift between the two yields a subtle UI bug where the matchroom
 * orders events differently from what the server thinks the
 * canonical state is.
 *
 * Both server and client are Blackout-side, where subject time (the
 * real-life football match) and content time (the story we broadcast
 * about that match) collapse to the same value: "the match minute."
 * See `docs/vocabulary.md` § Time. The filename and function names
 * reflect that shared Blackout vocabulary — the subject/content
 * distinction is Kairos's concern, not the matchroom's.
 */

/**
 * Parse a match-time string into a numeric minute for sorting. Plain
 * numerics ("3", "47") become themselves; stoppage forms ("45+2",
 * "90+5") add a fractional bump so they sort after regular minutes;
 * phase labels ("pre_match", "HT", "FT") fall back to phase ordering.
 * Unparseable / missing values land at -Infinity.
 */
export function parseMatchTime(value: string | undefined | null): number {
  if (!value) return -Infinity;
  const stoppage = /^(\d+)\+(\d+)$/.exec(value);
  if (stoppage) return parseInt(stoppage[1], 10) + parseInt(stoppage[2], 10) / 100;
  const plain = /^\d+$/.exec(value);
  if (plain) return parseInt(value, 10);
  switch (value) {
    case "pre_match":
      return -1;
    case "HT":
      return 45.5;
    case "FT":
      return 9999;
    default:
      return -Infinity;
  }
}

/** Minimal shape needed for chronological ordering by match time. */
export interface MatchTimedEvent {
  contentTime?: string;
  timestamp: number;
}

/**
 * Compare two events by parsed `contentTime` ascending, with `timestamp`
 * (push wall-clock) as the tiebreaker. Used everywhere the matchroom
 * renders the event ribbon and everywhere the server reduces the
 * canonical revealed-events list.
 */
export function compareEventsByMatchTime(a: MatchTimedEvent, b: MatchTimedEvent): number {
  const am = parseMatchTime(a.contentTime);
  const bm = parseMatchTime(b.contentTime);
  if (am !== bm) return am - bm;
  return a.timestamp - b.timestamp;
}
