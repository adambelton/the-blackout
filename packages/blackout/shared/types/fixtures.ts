export interface UpcomingFixture {
  id: number;
  name: string;
  startingAt: string;
  leagueId: number;
  leagueName: string | null;
  homeTeam: string | null;
  awayTeam: string | null;
}

export interface LiveFixture {
  id: number;
  name: string;
  stateId: number;
}
