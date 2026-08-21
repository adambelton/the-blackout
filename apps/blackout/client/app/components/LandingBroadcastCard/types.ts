export interface Broadcast {
  id: string;
  homeTeam: string;
  awayTeam: string;
  competition: string;
  matchDate: string; // ISO
  status: "draft" | "scheduled" | "live" | "complete";
}
