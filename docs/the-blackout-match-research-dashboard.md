# Match research dashboard — plan

**Status:** Plan, not implemented. Intended for post-prototype + demo work.

A studio-side feature that pre-loads structured match context for a writer when they open a scheduled broadcast, so they can spend their research time on interpretation and voice rather than retyping facts.

## The problem

The writer needs to produce two briefs before a broadcast goes live:

- **Match brief** — the world/research context for this specific fixture (seeded into Kairos as `narrative_context`).
- **Author brief** — voice instructions for the narrator (seeded as `narrative_voice`).

Both live as editable textareas on the moderator console today. The author brief is reusable across broadcasts — write it once, tweak per match. The match brief is not — it needs fresh facts every time: each team's recent form, head-to-head history, league position, who's injured, who's on good form, what's at stake.

Tonight, the match brief for Blackburn vs Coventry was written from scratch by hand. That's the problem:

1. **Repetitive manual work** — the same 10–15 data points (form, H2H, standings, absentees, top scorers) need to be gathered for every match, every week.
2. **Easy to get wrong** — scores, positions, dates are error-prone when typed from memory.
3. **Pulls the writer's time away from the bit that matters** — the angle, the interpretation, the voice cues. The prose the writer actually adds value to.

Sportmonks holds most of the factual layer. We should let the writer write *on top* of it, not gather it themselves.

## The principle

**Sportmonks provides the factual floor. The writer's prose is the ceiling. Humans own cultural, tactical, and narrative interpretation.**

The dashboard's job is to surface facts cleanly; it never tries to *be* the brief. The writer reviews the facts in ~2 minutes, then writes the interpretive brief on top.

## UX

When a writer clicks into a scheduled broadcast from the studio (a path that doesn't exist yet — today they land directly on the moderator console), the dashboard opens as a side-panel or separate tab showing:

- **Fixture summary** — competition, round, venue, kickoff time, expected attendance
- **Form box** per team (home | away), last 5 fixtures: result, opponent, score, home/away, key event (e.g. "won 2-1 at Norwich, Saka 68' 82'")
- **Standings snapshot** — league position, points, gap above/below, form bar, stakes classification ("relegation fight", "top-half comfort", "play-off push")
- **Head-to-head** — last 5–10 meetings with date, venue, result. Highlight any notable ones (biggest wins, dramatic results).
- **Absentees** — injuries + suspensions per team, with how long out.
- **Starting XI preview** — from the `lineups` include on the fixture once published (normally ~60 min before kickoff). Position on a pitch diagram would be great; a list is fine.
- **Form players** — top 3 scorers per team this season, top assisters, anyone on a hot streak (3+ goals in last 5, or hat-trick last time out).
- **Referee dossier** — referee name, appearances this season, average cards per game, any notable history with either club.
- **Manager snapshot** — name, tenure, record with this club (W/D/L), any recent pressure storylines worth noting.
- **Player lookup affordance** — a search box that takes a player name (including partial / common-name forms) and returns the canonical profile with season stats. Writer can click to inline into the brief.

Beneath it, the match brief editor and author brief editor the moderator console already has (or a link to them).

Output: the writer reads the dashboard, writes the interpretive brief on top in the textarea, hits Save. The facts stay in the dashboard; only the writer's prose goes to Kairos as `narrative_context`.

### Stretch: facts → `narrative_context` auto-append

Once the dashboard is stable, consider appending a compact structured-facts block to the `narrative_context` entry alongside the writer's prose. Something like:

```
## Match facts
- Competition: Championship Play-Off Semi-Final (2nd leg)
- Venue: Ewood Park, Blackburn
- Standings: Blackburn 3rd (82pts), Coventry 5th (73pts)
- Last 5 Blackburn: W W D L W
- Last 5 Coventry: W L W W W
- H2H last 3: Blackburn 2-1 Coventry (04/2026), 1-1 (11/2025), Coventry 3-0 Blackburn (12/2024)
- Top Blackburn scorers: Gardner-Hickman 14, Ohashi 12
- Top Coventry scorers: Simms 15, Mason-Clark 9
- Referee: J Smith (avg 4.2 yellows, 0.3 reds)
- Blackburn absent: Nyambe (hamstring), Travis (suspended)
- Coventry absent: O'Hare (knee)
```

This gives the generator a clean factual substrate to draw from without the writer having to duplicate-transcribe it into the brief. Writer writes the interpretive layer; the facts flow in automatically.

## Data sources

### Endpoints (all on our plan unless noted)

| Endpoint | Purpose |
|---|---|
| `/fixtures/{id}?include=participants;venue;league;stage;round;state;periods;lineups.player;sidelined.player;referees.referee;formations.participant` | Fixture metadata + starting XI + absentees + referee |
| `/teams/{id}/latest` | Recent form per team (last N fixtures) |
| `/fixtures/between/{from}/{to}/{teamId}` | Date-range fixture history (fallback / season-specific form) |
| `/head2head/{id1}/{id2}` | Historical meetings |
| `/standings/seasons/{id}` | League table |
| `/topscorers/seasons/{id}` | Season top scorers (for identifying form players) |
| `/players/{id}` + `/players/{id}/statistics` | Player profile + career/season stats for any player lookup |
| `/players/search?name=...` | Player lookup by name (fuzzy) |
| `/coaches/{id}` + `/coaches/{id}/fixtures` | Manager snapshot |
| `/referees/{id}` + `/referees/{id}/statistics` | Referee dossier |
| `/sidelined?team_id=...` | Alternative route to absentees if not inline on fixture |
| `/transfers?team_id=...` | Recent transfer activity (for "new signing", "departed" notes) |

### Caching posture

Most of these are stable across a match window, so the dashboard can be a **static snapshot at load time** plus an optional refresh button. Nothing streams or polls. The only dynamic piece is the starting XI if the lineup is released less than an hour before kickoff; a manual refresh handles that.

Cache the results per fixture in Postgres under a new `broadcast_research` table keyed by `broadcast_id`. On first open, fetch + persist; on subsequent opens, serve from cache with a "refresh" affordance.

### Not in Sportmonks (don't build against)

- Club histories, founding stories, famous players, rivalry lore — writer supplies.
- Cultural / journalism context, tactical interpretation, season narratives that cross competitions.
- Anything behind paywalls we don't have (odds, news, predictions).

## Data model

New table `broadcast_research` in the Blackout Postgres (added to the Drizzle schema in `apps/blackout/server/src/db/schema.ts`):

| column | type | notes |
|---|---|---|
| `broadcast_id` | uuid | FK to broadcasts, primary key |
| `payload` | jsonb | Full dashboard snapshot (see shape below) |
| `fetched_at` | timestamptz | When we pulled from Sportmonks |
| `stale_after` | timestamptz | TTL; UI shows "Refresh" after |

Payload shape roughly:

```ts
interface ResearchPayload {
  fixture: { id, competition, round, venue, kickoffUTC, state }
  teams: { home: TeamSnapshot, away: TeamSnapshot }
  h2h: Meeting[]
  standings: { home: Position, away: Position, season: LeagueSnapshot }
  referee: RefereeDossier
  fetchedAt: string
}

interface TeamSnapshot {
  team: { id, name, shortCode, logoUrl }
  manager: CoachSnapshot
  form: Match[]               // last 5
  startingXI: Player[]        // or expected XI
  absentees: Absentee[]
  topScorers: ScorerRow[]
  recentTransfers: TransferRow[]
}
```

The `payload` column as jsonb keeps schema flexible while we learn what matters. When shapes stabilise, split into relational tables.

## Phasing

**P0 — data-layer proof** (~1–2 days)

Build a server-side endpoint `POST /broadcasts/:id/research/rebuild` that hits all the Sportmonks endpoints, composes the payload, persists to Postgres. No UI yet. Validate the payload shape against 2–3 real fixtures. This is the load-bearing work; the UI is cheap once this is solid.

**P1 — minimum viable dashboard** (~2–3 days)

Studio-side page at `/studio/broadcasts/:id/research` showing the form boxes, H2H, standings, starting XI, absentees, referee snapshot — read-only, no search affordance yet. Manual refresh button. Link to this page from the broadcasts list and the moderator console.

**P2 — player lookup + form players** (~1 day)

Add the `/players/search` affordance (a search box that disambiguates common names + returns season stats), plus a "form players" rail surfacing current-season standouts per team.

**P3 — facts auto-append to narrative_context** (~half day)

On broadcast activation, pull the cached research payload, format as a structured facts block, append to the `narrative_context` entry alongside the writer's prose.

**P4 — stretch** (backlog-forever)

- Pitch-diagram rendering of starting XI positions
- "Interesting angles" suggestions powered by simple heuristics ("first meeting since X year", "longest winning streak by home team in N games")
- Writer-curated notes that persist per club (so accumulated editorial knowledge compounds)

## Out of scope for this plan

- **Not tonight's work** — this is post-prototype + demo.
- **Not a live-pipeline feature** — all fetching happens ahead of kickoff. The only live touchpoint is the auto-append into `narrative_context` at activation.
- **Not a replacement for human research** — the writer still writes the interpretive brief. This just removes the copy-paste-from-wikipedia layer.

## Related: consumer-facing structural data

This plan is writer-facing. But the consumer (listener/viewer of the broadcast) also benefits from having structural match state alongside the narrative prose. Not a full research dashboard — that's a writer's tool — but minimum-viable structural context that anchors the listening experience in what's actually happening.

The Sportmonks factual layer we fetch for the writer's dashboard is largely reusable for the consumer. Same endpoints, different view.

**Minimum for consumer UI:**

- **Live scoreboard** — home team, away team, current score, match minute, state label (live / HT / FT / ET / pens)
- **Kickoff countdown** pre-match, full-time confirmation post-match

**Worth considering once the basics are in:**

- **Latest goal scorer strip** — "23' Saka (1-0)" updating with each goal
- **Basic stats rail** — possession, shots on target, corners. Pulled from `trends` or `statistics`. Gives the listener something to glance at during narrative lulls.
- **Starting XI or formation diagram** at broadcast start
- **Minor events ticker** — yellow cards, substitutions, without interrupting the narrative flow

**Not for consumer:**
- Referee dossier, manager records, season stats deep-dive — that's writer-facing research, not listener-facing texture.
- Ball coordinates, minute-by-minute stat timelines — too data-dense for a listener. Useful internally to Kairos, not visually to the listener.

**Latency posture:**

Consumer UI needs **live** timing — scoreboard updates within seconds of a goal. This is a different tier from the writer's research dashboard, which is fine being pre-match + occasional refresh. The consumer scoreboard rides on the existing fixture-poll cadence (events arrive within ~20s of real-time) plus the conductor's WebSocket fan-out (`/ws/matchroom`) that already carries `play` / `narrative` / `phase` cues. Add a `scoreboard_update` cue type alongside the existing ones; the conductor pushes on goal events + state transitions. (Subject to the matchroom no-spoilers contract — scoreboard reveals gate on the corresponding narration's audio-end like every other event reveal.)

**Infra reuse:**

The Sportmonks data-layer work in P0 of the research dashboard (endpoint aggregation into a cached payload) is most of what's needed for the consumer-side state too. Build once, project twice:

- `broadcast_research` table (writer-facing snapshot, stable) — fetched once, cached, served to the studio
- Live scoreboard state (consumer-facing, dynamic) — derived from the fixture poll, fanned to clients via the conductor's WebSocket cue stream (no-spoilers contract preserved)

Worth keeping the consumer UI in mind during the P0 data-layer work so the server-side primitives (fetch, cache, push) generalise cleanly. The consumer scoreboard itself is a small additional feature on top once the research dashboard is in place.

## Why this is worth doing

Two returns:

1. **Quality floor rises.** Factual errors in the narrative become structurally harder to produce, because the writer is reading accurate cached data rather than typing from memory.
2. **Writer time shifts to the high-value layer.** The 30–60 minutes of research-gathering per match collapses to ~10 minutes of reviewing + 20–30 minutes of interpretive brief writing. The output improves because the attention is in the right place.

At scale (weekly broadcasts + multiple writers), this compounds. At beta scope (one writer, one match a week), it still meaningfully reduces friction and reduces the rate of factual mistakes reaching the narrator.

---

*Plan drafted 2026-04-17 during live-test-debrief session. Implement after working prototype + product demo are complete.*
