import type { TeamSide } from "@blackout/shared";
import { createSportmonksClient, type SportmonksLineup, type SportmonksParticipant } from "./sportmonks.js";

// Sportmonks type_id values for lineup entries.
const TYPE_STARTING = 11;
const TYPE_BENCH = 12;

interface FormattedPlayer {
  name: string;
  jerseyNumber: number | null;
  position: number | null;
}

interface FormattedTeam {
  teamName: string;
  side: TeamSide;
  formation: string | null;
  starters: FormattedPlayer[];
  bench: FormattedPlayer[];
}

function pickName(lineup: SportmonksLineup): string {
  const player = lineup.player;
  const candidate =
    player?.display_name?.trim() ||
    player?.common_name?.trim() ||
    player?.name?.trim() ||
    lineup.player_name?.trim() ||
    (player?.firstname && player?.lastname
      ? `${player.firstname} ${player.lastname}`.trim()
      : null) ||
    (player?.lastname?.trim() ?? null);
  return candidate ?? "Unknown";
}

function formatPlayerLine(p: FormattedPlayer): string {
  return p.jerseyNumber != null ? `#${p.jerseyNumber} ${p.name}` : p.name;
}

function describeTeam(team: FormattedTeam): string {
  const header = team.formation
    ? `${team.teamName} (${team.formation})`
    : team.teamName;
  const starters = team.starters.length
    ? `Starting XI: ${team.starters.map(formatPlayerLine).join(", ")}`
    : "Starting XI: (not published)";
  const bench = team.bench.length
    ? `Bench: ${team.bench.map(formatPlayerLine).join(", ")}`
    : null;
  return [header, starters, bench].filter(Boolean).join("\n");
}

export interface LineupsData {
  /** Rendered Markdown block for appending to narrative_context. */
  block: string;
  /**
   * Flat list of canonical player names (display / common / last names,
   * whatever `pickName` resolved to per lineup). Used by the transcript
   * name-normaliser to fuzzy-match Deepgram output back to the
   * authoritative spelling before pushing to Kairos.
   */
  roster: string[];
  /** Home-side player names — the same canonical spellings as `roster`,
   * but partitioned by team so the distiller can apply home/away
   * roster discipline contextually. Empty when lineups didn't include
   * a home participant entry. */
  homeRoster: string[];
  /** Away-side player names. Same shape as `homeRoster`. */
  awayRoster: string[];
  /** Team names for downstream prompt labelling. */
  homeTeamName?: string;
  awayTeamName?: string;
}

/**
 * Fetch lineups for a fixture and render them as a text block suitable
 * for appending to narrative_context, plus the flat roster for the
 * transcript name-normaliser. Returns null when lineups aren't
 * published yet (common pre-kickoff window) — caller should degrade
 * gracefully rather than block activation.
 *
 * The text block exists so the generator has canonical spellings in
 * scope ("Fabon" → Azon, "Aeling" → Ayling). The roster exists so
 * transcription text can be normalised before it even reaches the
 * generator — closes the gap where the narrator gets an ASR-garbled
 * name and an authoritative Sportmonks name on the same passage.
 */
export async function fetchLineupsBlock(fixtureId: number): Promise<LineupsData | null> {
  const client = createSportmonksClient();
  let data: Awaited<ReturnType<ReturnType<typeof createSportmonksClient>["getFixtureLineups"]>>;
  try {
    data = await client.getFixtureLineups(fixtureId);
  } catch (err) {
    console.warn(`[lineups] fetch failed for fixture ${fixtureId}: ${(err as Error).message}`);
    return null;
  }
  if (data.lineups.length === 0) return null;

  const teamById = new Map<number, SportmonksParticipant>();
  for (const p of data.participants) teamById.set(p.id, p);

  const byTeam = new Map<number, FormattedTeam>();
  for (const lineup of data.lineups) {
    const participant = teamById.get(lineup.team_id);
    if (!participant) continue;
    const slot = byTeam.get(lineup.team_id) ?? {
      teamName: participant.name,
      side: participant.meta.location,
      formation: null,
      starters: [] as FormattedPlayer[],
      bench: [] as FormattedPlayer[],
    };
    if (!slot.formation && lineup.formation_field) slot.formation = lineup.formation_field;
    const player: FormattedPlayer = {
      name: pickName(lineup),
      jerseyNumber: lineup.jersey_number,
      position: lineup.position_id,
    };
    if (lineup.type_id === TYPE_STARTING) slot.starters.push(player);
    else if (lineup.type_id === TYPE_BENCH) slot.bench.push(player);
    byTeam.set(lineup.team_id, slot);
  }

  // Sort starters by formation-position when known, bench by jersey.
  for (const team of byTeam.values()) {
    team.starters.sort((a, b) => (a.position ?? 99) - (b.position ?? 99));
    team.bench.sort((a, b) => (a.jerseyNumber ?? 99) - (b.jerseyNumber ?? 99));
  }

  const teams = Array.from(byTeam.values()).sort((a, b) => (a.side === "home" ? -1 : 1));
  if (teams.length === 0) return null;

  const block = [
    "## Lineups (canonical spellings)",
    "",
    teams.map(describeTeam).join("\n\n"),
  ].join("\n");

  const rosterSet = new Set<string>();
  const homeSet = new Set<string>();
  const awaySet = new Set<string>();
  let homeTeamName: string | undefined;
  let awayTeamName: string | undefined;
  for (const team of teams) {
    const target = team.side === "home" ? homeSet : awaySet;
    if (team.side === "home") homeTeamName = team.teamName;
    if (team.side === "away") awayTeamName = team.teamName;
    for (const p of [...team.starters, ...team.bench]) {
      if (p.name && p.name !== "Unknown") {
        rosterSet.add(p.name);
        target.add(p.name);
      }
    }
  }

  return {
    block,
    roster: Array.from(rosterSet),
    homeRoster: Array.from(homeSet),
    awayRoster: Array.from(awaySet),
    homeTeamName,
    awayTeamName,
  };
}
