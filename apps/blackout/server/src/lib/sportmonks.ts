import type { MatchEventType, UpcomingFixture } from "@blackout/shared";

/** Sportmonks state_id for fixtures that haven't started yet. */
const STATE_NOT_STARTED = 1;
/** How many days ahead to scan when listing upcoming fixtures. */
const DEFAULT_UPCOMING_DAYS_AHEAD = 8;

const SPORTMONKS_BASE = "https://api.sportmonks.com/v3/football";

// Sportmonks type_id → MatchEventType mapping. Source: /v3/core/types where
// model_type = "event". Reviewed 2026-04-18 against the full types table.
const EVENT_TYPE_MAP: Record<number, MatchEventType> = {
  10: "VAR",
  14: "GOAL",
  15: "OWN_GOAL",
  16: "PENALTY",
  17: "PENALTY_MISS",
  18: "SUBSTITUTION",
  19: "YELLOW_CARD",
  20: "RED_CARD",
  21: "SECOND_YELLOW",
  22: "PENALTY_SHOOTOUT_MISS",
  23: "PENALTY_SHOOTOUT_GOAL",
  1697: "VAR_CARD",
};

// Fixture states where the match clock is actively ticking. Source:
// /v3/football/states. Sportmonks' own example code incorrectly includes
// HT (3), BREAK (4), EXTRA_TIME_BREAK (21) and 7/AET (finished). The real
// in-play set is 1st half, extra time, penalty shootout, 2nd half.
const LIVE_STATE_IDS = [2, 6, 9, 22];
const LIVE_STATE_NAMES = LIVE_STATE_IDS.join(",");

// Include list for live-feed polling of a single fixture. Nested `.type`
// includes intentionally omitted — resolve type_ids locally from the cached
// types table (see sportmonks-types.ts).
//
// Not included (and why):
//   xGFixture, pressure         — require the xG + Pressure add-on, which
//                                 we evaluated on trial 2026-04-17 and
//                                 chose not to purchase. Restoreable from
//                                 git history if we buy the add-on at
//                                 beta per the live-test summary doc.
const FIXTURE_INCLUDES = [
  "events.player",
  "events.subType",
  "timeline.subType",
  "trends",
  "ballCoordinates",
  "participants",
  "periods",
  "state",
  "scores",
].join(";");

// --- Internal response types (Sportmonks API shape) ---

interface SportmonksResponse<T> {
  data: T;
  rate_limit?: { remaining: number; resets_in_seconds: number };
  pagination?: {
    count: number;
    per_page: number;
    current_page: number;
    next_page: string | null;
    has_more: boolean;
  };
}

export interface SportmonksFixture {
  id: number;
  name: string;
  state_id: number;
  starting_at: string;
  participants?: SportmonksParticipant[];
  periods?: SportmonksPeriod[];
  state?: { id: number; state: string; name: string; short_name?: string };
  events?: SportmonksRawEvent[];
  timeline?: SportmonksTimelineEntry[];
  trends?: SportmonksTrendEntry[];
  ballcoordinates?: SportmonksBallCoordinate[];
  scores?: SportmonksScore[];
  league_id?: number;
  league?: { id: number; name: string } | null;
}

export interface SportmonksParticipant {
  id: number;
  name: string;
  short_code: string;
  meta: { location: "home" | "away"; winner: boolean | null };
}

export interface SportmonksPeriod {
  id: number;
  fixture_id: number;
  type_id: number;
  started: number | null;
  ended: number | null;
  counts_from: number;
  ticking: boolean;
  sort_order: number;
  description: string;
  time_added: number | null;
  period_length: number;
  minutes: number | null;
  seconds: number | null;
  has_timer: boolean;
}

export interface SportmonksTypeRef {
  id: number;
  name: string;
  code: string;
  developer_name: string;
  model_type: string;
  stat_group?: string | null;
}

export interface SportmonksRawEvent {
  id: number;
  type_id: number;
  participant_id: number;
  player_id?: number | null;
  player_name: string | null;
  related_player_name: string | null;
  minute: number;
  extra_minute: number | null;
  result: string | null;
  info: string | null;
  addition: string | null;
  sort_order: number;
  type?: SportmonksTypeRef;
  subtype?: SportmonksTypeRef | null;
  player?: Record<string, unknown> | null;
}

export interface SportmonksTimelineEntry {
  id: number;
  type_id: number;
  participant_id: number;
  player_id: number | null;
  player_name: string | null;
  minute: number;
  extra_minute: number | null;
  addition: string | null;
  period_id: number | null;
  sort_order: number;
  type?: SportmonksTypeRef;
  subtype?: SportmonksTypeRef | null;
}

export interface SportmonksTrendEntry {
  id: number;
  fixture_id: number;
  participant_id: number;
  period_id: number;
  type_id: number;
  minute: number;
  value: number;
  type?: SportmonksTypeRef;
}

export interface SportmonksBallCoordinate {
  id: number;
  fixture_id: number;
  period_id: number;
  timer: string; // "MM:SS"
  x: string; // 0-1 as string
  y: string; // 0-1 as string
}

export interface SportmonksLineup {
  id: number;
  team_id: number;
  player_id: number | null;
  /** Sportmonks type_id — 11 = starting lineup, 12 = bench. */
  type_id: number;
  jersey_number: number | null;
  formation_field: string | null;
  formation_position: number | null;
  position_id: number | null;
  player_name: string | null;
  player?: {
    id: number;
    name?: string | null;
    common_name?: string | null;
    display_name?: string | null;
    firstname?: string | null;
    lastname?: string | null;
  } | null;
}

interface SportmonksFixtureWithLineups extends SportmonksFixture {
  lineups?: SportmonksLineup[];
}

interface SportmonksScore {
  participant_id: number;
  score: { goals: number; participant: string };
  description: string;
}

// --- Public API ---

export function mapEventType(typeId: number): MatchEventType | null {
  return EVENT_TYPE_MAP[typeId] ?? null;
}

export function createSportmonksClient() {
  const token = process.env.SPORTMONKS_API_TOKEN;
  if (!token) {
    throw new Error("SPORTMONKS_API_TOKEN is not set");
  }

  async function request<T>(path: string): Promise<SportmonksResponse<T>> {
    const separator = path.includes("?") ? "&" : "?";
    const url = `${SPORTMONKS_BASE}${path}${separator}api_token=${token}`;
    const res = await fetch(url);

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Sportmonks ${res.status}: ${body}`);
    }

    const json = (await res.json()) as SportmonksResponse<T> & { message?: string };
    if (json.data === undefined) {
      throw new Error(json.message ?? "No data returned");
    }
    return json;
  }

  return {
    /** Find live fixtures, optionally filtered by league ID. */
    async getLiveFixtures(leagueId?: number): Promise<SportmonksFixture[]> {
      const leagueFilter = leagueId ? `fixtureLeagues:${leagueId};` : "";
      const res = await request<SportmonksFixture[]>(
        `/fixtures?filters=${leagueFilter}fixtureStatuses:${LIVE_STATE_NAMES}&include=participants`,
      );
      return res.data;
    },

    /**
     * Fetch the full live-feed payload for a fixture — events, timeline,
     * xGFixture, pressure, trends, ballCoordinates, participants, periods,
     * state, scores — in a single call with nested type/participant/player
     * refs resolved inline.
     */
    async getFixtureFeed(fixtureId: number): Promise<SportmonksFixture> {
      const res = await request<SportmonksFixture>(
        `/fixtures/${fixtureId}?include=${FIXTURE_INCLUDES}`,
      );
      return res.data;
    },

    /**
     * Fetch the starting XI + bench for a fixture. Lineups publish ~1hr
     * before kickoff; returns an empty array when Sportmonks hasn't
     * released them yet. Includes participants so the caller can map
     * team_id to home/away + the canonical team name without a second
     * request.
     */
    async getFixtureLineups(fixtureId: number): Promise<{
      lineups: SportmonksLineup[];
      participants: SportmonksParticipant[];
    }> {
      const res = await request<SportmonksFixtureWithLineups>(
        `/fixtures/${fixtureId}?include=lineups.player;participants`,
      );
      return {
        lineups: res.data.lineups ?? [],
        participants: res.data.participants ?? [],
      };
    },

    /**
     * Fetch fixtures for a single ISO date (YYYY-MM-DD), with the league
     * + participants already resolved. Drives the broadcast picker.
     */
    async getFixturesByDate(date: string): Promise<SportmonksFixture[]> {
      const res = await request<SportmonksFixture[]>(
        `/fixtures/date/${date}?include=participants;league`,
      );
      return res.data ?? [];
    },

    /**
     * List upcoming (not-yet-started) fixtures across the next N days,
     * already shaped for the consumer (sorted by kick-off ascending).
     * Per-date fetches run in parallel — historically this loop ran
     * sequentially and ate ~8× round-trips on a cold picker open.
     * Failed dates are skipped silently so a single 5xx doesn't
     * empty the picker.
     */
    async getUpcomingFixtures(
      daysAhead: number = DEFAULT_UPCOMING_DAYS_AHEAD,
    ): Promise<UpcomingFixture[]> {
      const today = new Date();
      const dates = Array.from({ length: daysAhead }, (_, i) => {
        const d = new Date(today);
        d.setDate(d.getDate() + i);
        return d.toISOString().split("T")[0];
      });

      const results = await Promise.all(
        dates.map((date) =>
          this.getFixturesByDate(date).catch((err: Error) => {
            console.warn(`[sportmonks] fixtures/date/${date} failed: ${err.message}`);
            return [] as SportmonksFixture[];
          }),
        ),
      );

      const upcoming: UpcomingFixture[] = [];
      for (const fixtures of results) {
        for (const f of fixtures) {
          if (f.state_id !== STATE_NOT_STARTED) continue;
          const home = f.participants?.find((p) => p.meta?.location === "home");
          const away = f.participants?.find((p) => p.meta?.location === "away");
          upcoming.push({
            id: f.id,
            name: f.name,
            startingAt: f.starting_at.endsWith("Z")
              ? f.starting_at
              : f.starting_at + "Z",
            leagueId: f.league_id ?? f.league?.id ?? 0,
            leagueName: f.league?.name ?? null,
            homeTeam: home?.name ?? null,
            awayTeam: away?.name ?? null,
          });
        }
      }
      upcoming.sort(
        (a, b) =>
          new Date(a.startingAt).getTime() - new Date(b.startingAt).getTime(),
      );
      return upcoming;
    },
  };
}
