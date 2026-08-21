# The Blackout

Every Premier League match is broadcast internationally, but UK fans are blacked out from all 3pm Saturday fixtures — the most traditional slot in English football. Fans can listen to radio commentary, but there is no visual or social experience designed for this moment.

The Blackout is built specifically for it.

Each weekend, a single match is featured. Users join a live room and experience the game together as a real-time authored narrative — match events and live commentary are transformed into literary prose in a chosen author's voice, read aloud by a narrator, and accompanied by illustrations. Everyone in the room receives the same experience simultaneously. It's closer to a live literary event than a football app.

## How it works

A moderator picks a radio source from the studio catalogue. Their UK-resident browser fetches the audio (Web Audio + AudioWorklet → linear16 PCM frames over WebSocket), streams it to the server's Deepgram pipeline. Structured match events arrive from a football events API. The Blackout-side distiller (Haiku) classifies commentary into structured atmosphere + event_texture, and pushes those alongside Sportmonks events into Kairos:

```
Match event arrives
  → Event + distilled commentary + broadcast research pushed to Kairos
  → Kairos generates authored prose + an imagery decision
  → TTS (ElevenLabs) converts prose to audio
  → Replicate generates an illustration (or a pre-prepared pool image is selected)
  → Room conductor schedules timing cues — one server-side clock, every client follows
  → All clients receive cues simultaneously over a direct WebSocket
```

Between events, atmospheric illustrations hold the room's attention while the next passage is generated. The gaps carry the depth — club history, player arcs, rivalry mythology — drawn from research briefs prepared before the match.

The backend server is the single authoritative conductor. It manages room state, schedules timing cues, and fans them to all connected clients via direct WebSocket. The matchroom UI walks per-passage canonical bundles (`revealedCanonical` + `revealingCanonical` with charOffset markers) so reveals fire in lock-step with the narrator's voice — no spoilers, no clock drift across browser tabs.

## A guided tour of the repository

The documentation is intentionally arranged like the code. Each meaningful boundary has a README that answers four questions at that level:

1. What does this part own?
2. How does it communicate with its neighbours?
3. What contract does it provide and depend on?
4. What does healthy behaviour look like?

This was also a way to manage AI-assisted development. An assistant working inside a pipeline stage could load the README beside that code and learn the local invariants, public contract, and upstream/downstream assumptions without guessing about the rest of the system. Detailed facts live at the deepest relevant boundary; parent READMEs carry a shorter summary and a link downward. When a fact changes, its summary is checked on the way back up.

For a quick architectural review, follow this path:

| Read | What it establishes |
|---|---|
| [`apps/README.md`](apps/README.md) | The Blackout/Kairos split and the one-way service seam. |
| [`apps/blackout/README.md`](apps/blackout/README.md) | Why the client renders while the server owns time, state, and fan-out. |
| [`apps/blackout/server/src/conductor/README.md`](apps/blackout/server/src/conductor/README.md) | The no-spoilers playback contract and authoritative room clock. |
| [`apps/kairos/server/src/README.md`](apps/kairos/server/src/README.md) | The four-stage ingest → enrich → curate → generate pipeline. |
| [`apps/kairos/server/src/curation/README.md`](apps/kairos/server/src/curation/README.md) | Why curation is the only stage allowed to discard information. |
| [`packages/README.md`](packages/README.md) | Compile-time contracts inside each service and the deliberate HTTP/WS boundary between services. |
| [`docs/documentation-system.md`](docs/documentation-system.md) | The complete layered-README and “document deep, bubble up” method. |

That path is designed to be read progressively: stop when you have enough resolution, or follow a child README to inspect a particular decision.

## Development discipline

The Blackout is a working concept and technical prototype. Writers provide the creative perspective; AI supports the real-time delivery of that perspective rather than replacing it. The reasoning behind each decision stays visible so the repository shows what was tried, what worked, and what changed.

- **Assumptions first.** Before building a feature, articulate the assumption being tested and what would count as success.
- **Outcomes defined up front.** Every significant piece of work has a success criterion written before code is written.
- **Retrospectives.** When a step is complete, record what the hypothesis was, what actually happened, and what that changes.
- **Conviction over vague instincts.** Develop real opinions about what the product should be, who it's for, and what makes it work. Test them. Revise them.
- **Decisions are logged.** Product and architectural decisions, assumptions, and outcomes live in [`docs/product-decisions.md`](docs/product-decisions.md).

## Architecture

A monorepo with clear domain separation. Four runnable applications and three shared packages.

```
apps/blackout/client/          → Next.js 16 / React frontend (matchroom + moderator + studio + admin)
apps/blackout/server/       → Hono + Node.js backend — stateful room conductor, source capture,
                     TTS + illustration synthesis, WS fan-out
apps/kairos/client/       → Next.js admin workbench for inspecting and editing engine content
apps/kairos/server/       → Hono + Node.js narrative orchestration engine — domain-agnostic,
                     own Postgres database, own lifecycle (port :5050)
packages/blackout/shared/   → Shared TypeScript types: cue payloads, broadcast types,
                              canonical-state bundle
packages/blackout/auth/     → Shared Better Auth factory consumed by web + server
packages/kairos/auth/       → Separate Better Auth factory for the Kairos workbench
```

Turborepo manages parallel dev, build, and caching. `pnpm run dev` from the repo root starts the four applications in lock-step.

**Server-side layers:**

- `src/sources/` — football-specific source adapters (Sportmonks events).
- `src/pipeline/` — transcription (Deepgram) and pressure derivation.
- `src/lib/distiller.ts`, `distillation-buffer.ts`, `event-correlation.ts` — Haiku-driven distillation of radio commentary into structured atmosphere + event_texture, plus per-class radio-offset calibration against canonical events.
- `src/lib/broadcast-runner.ts` — orchestrates source capture per broadcast.
- `src/conductor/` — `RoomConductor` (per broadcast: synthesis queue, playback clock, WS fan-out, canonical-state bundle authoring), `synthesiser.ts` (TTS + persistence), `phase-logic.ts` (FSM).
- `src/lib/kairos.ts` + `kairos-bridge.ts` — typed HTTP/WS client + lifecycle wrapper for Kairos.

**Key shared types:**

- `BroadcastContext` — club briefs, player context, illustrations, author brief loaded before a broadcast goes live.
- `Passage` + `CanonicalState` + `RevealingCanonical` — the per-passage bundle the matchroom walks against audio playback. One contract, two consumers (live mode = server-anchored; replay mode = client-owned).
- WS cue payloads (`passage_added`, `passage_started`, `passage_updated`, `broadcast_status_changed`, …) — defined once in `packages/blackout/shared/types/`, enforced at compile time across all apps.

## Stack

| Layer | Technology |
|---|---|
| Frontend | Next.js 16 / React |
| Backend | Hono on Node.js (stateful server) |
| Narrative engine | Kairos — `apps/kairos/server/`, runs on `:5050` |
| Text-to-speech | ElevenLabs, OpenAI, Hume, or Deepgram behind `TtsProvider` |
| Illustration generation | Replicate |
| Real-time delivery | Direct WebSocket from `apps/blackout/server` (`/ws/matchroom`, `/ws/moderator`) |
| Auth | Better Auth (self-hosted); separate Blackout and Kairos auth boundaries |
| Database | Postgres. Two separate DBs — one for Blackout, one for Kairos. Drizzle ORM. |
| Asset storage | Cloudflare R2 (`blackout-dev` for development); in-memory provider for tests and isolated fallback use |
| Hosting | Retired; this repository contains no deployment configuration |

## Getting started

### Prerequisites

- Node.js 22 LTS (pinned in `.nvmrc`)
- pnpm
- Local Postgres (Homebrew: `brew install postgresql@17 && brew services start postgresql@17`)

### Install

```bash
nvm install    # Installs the Node version pinned in .nvmrc
pnpm install
```

**Optional: auto-switch Node version.** To have nvm automatically switch to the correct version whenever you enter the project directory, add this to your `~/.zshrc` (after nvm is sourced):

```bash
autoload -U add-zsh-hook
load-nvmrc() {
  local nvmrc_path="$(nvm_find_nvmrc)"
  if [ -n "$nvmrc_path" ]; then
    local nvmrc_node_version=$(nvm version "$(cat "${nvmrc_path}")")
    if [ "$nvmrc_node_version" = "N/A" ]; then
      nvm install
    elif [ "$nvmrc_node_version" != "$(nvm version)" ]; then
      nvm use
    fi
  fi
}
add-zsh-hook chpwd load-nvmrc
load-nvmrc
```

### Configure environment

Each app has its own env. Copy from `.env.example` per app:

```bash
cp apps/blackout/server/.env.example apps/blackout/server/.env
cp apps/kairos/server/.env.example apps/kairos/server/.env
cp apps/blackout/client/.env.example apps/blackout/client/.env.local
```

Fill in API keys for the services you need.

### Run

From the repo root:

```bash
pnpm run dev     # Starts both clients (:3000/:3001) and both servers (:4000/:5050)
pnpm run build   # Builds all packages
pnpm run test    # Runs every app's suite (web, server, kairos, shared) — the same set CI runs
```

CI (`.github/workflows/ci.yml`) runs `build` + all four suites on every PR to `main`; `CI / build-and-test` is a required status check on the `main` ruleset, so a red suite blocks merge. The real-LLM distiller golden set is deliberately *out* of `pnpm test` / CI — run it with `pnpm --filter @blackout/server eval:distiller` before shipping a distiller-prompt change (see [`apps/blackout/server/README.md`](apps/blackout/server/README.md)).

Migrations apply automatically in local development through `predev`; the test harness applies them on bootstrap. The former hosted release path has been retired.

Health checks:
- Server: `GET http://localhost:4000/health`
- Kairos: `GET http://localhost:5050/health`

WebSocket endpoints:
- Matchroom (member viewer): `ws://localhost:4000/ws/matchroom?broadcastId=…`
- Moderator (writer/admin): `ws://localhost:4000/ws/moderator?broadcastId=…`

## Docs

The guided tour above is the shortest route through the layered README tree. The documents below are project-level artefacts that do not belong to one code boundary, plus older architecture references that are being decomposed into that tree:

- **[Documentation system](docs/documentation-system.md)** — how this codebase documents itself: the layered-README model, the README template, the bubble-up protocol, README.md vs CLAUDE.md
- **[apps/README.md](apps/README.md)** — the four runnable applications, their service seams, and what a working system looks like (the top of the README tree)
- **[Prototype status](docs/prototype-status.md)** — what the completed prototype established and what was learned
- **[The Blackout architecture](docs/the-blackout-architecture.md)** — canonical consumer-side shape: source capture, conductor, cue vocabulary, web surfaces, anti-patterns ([diagram](docs/the-blackout-architecture-diagram.md))
- **[Kairos architecture](docs/kairos-architecture.md)** — canonical engine shape: enrichment, curation, generation, supporting systems, anti-patterns ([diagram](docs/kairos-architecture-diagram.md))
- **[Product brief](docs/product-brief.md)** — what The Blackout is and what the concept demonstrates
- **[Product decisions](docs/product-decisions.md)** — running log of decisions, assumptions, and outcomes
- **[CLAUDE.md](CLAUDE.md)** — development conventions for AI-assisted development (root + `apps/kairos/server/CLAUDE.md` for engine-specific)

## Status

**Concept prototype complete; active development is paused indefinitely.**

The end-to-end pipeline was validated through several full live-broadcast experiments. The repository is retained as a record of the product thinking, system design, creative collaboration model, and technical lessons behind the concept.

## Licence

Released under the [MIT License](LICENSE).
