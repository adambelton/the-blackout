# The Blackout — system diagram

> **⚠️ Predates the Design-A matchroom-reveal bundle architecture (2026-05-11).** For the current consumer-side architecture see [`apps/blackout/server/README.md`](../apps/blackout/server/README.md) (which carries the source-capture + Kairos-feed pipeline diagrams) and the `apps/blackout/server/src/<module>/README.md` files. This file will be refreshed or retired with the rest of the consumer-side doc decomposition.

The consumer-side system at a glance: source capture → Kairos → conductor → web clients, plus the pacing feedback loop and auth gate. Renders natively on GitHub, VSCode (with the Mermaid extension), and Cursor. The companion narrative doc is [`the-blackout-architecture.md`](./the-blackout-architecture.md).

```mermaid
flowchart LR
    %% Sources (top — what the world is doing)
    subgraph Sources["Source capture"]
        SM["Sportmonks API\n(events / trends / coords)"]
        Radio["Live radio stream\n(MP3 / HLS)"]
        Mod["Moderator console\n(notes, control, audio capture)"]
    end

    %% Server-side ingest
    subgraph Server["apps/blackout/server (Hono :4000)"]
        BR["BroadcastRunner\n(per broadcast — owns sources)"]
        Pressure["PressurePipeline\n(trends → zone / pressure signals)"]
        Trans["TranscriptionPipeline\n(Deepgram WS — receives audio chunks)"]
        Bridge["Kairos client\n(lib/kairos.ts + kairos-bridge.ts)"]

        Conductor["RoomConductor\n(per broadcast)"]
        SynQueue["Synthesis queue → TTS provider\n(OpenAI / ElevenLabs / Hume / Deepgram)"]
        ImgQueue["Illustration handler\n(Replicate or pool lookup)"]
        Storage["Storage\n(R2 — blackout-prod / blackout-dev,\npublic-domain URLs via Cloudflare edge)"]

        ModWS["/ws/moderator"]
        MatchWS["/ws/matchroom"]
    end

    %% External engine
    Kairos[("Kairos\n(:5050)")]

    %% Web
    subgraph Web["apps/blackout/client (Next.js :3000)"]
        Matchroom["/matchroom/[id]\n(member viewer)"]
        ModUI["/moderator/[id]\n(writer/admin)"]
        Studio["/studio/[id]\n(brief + imagery prep)"]
        Auth["proxy.ts + Better Auth\n(email/password, role gates)"]
    end

    %% Source flow
    SM --> BR
    Radio -->|"fetched in moderator's UK browser\n(Web Audio + MediaRecorder)"| Mod
    Mod -->|"audio chunks (binary frames)\n+ notes / control (JSON)"| ModWS
    ModWS -->|"binary → pushAudioChunkToRunner"| Trans
    BR --> Pressure
    BR --> Trans
    BR --> Bridge
    Trans --> Bridge
    ModWS --> Bridge
    Bridge -->|"POST /broadcasts/:id/entries"| Kairos

    %% Engine output
    Kairos -->|"WS narrative + feed_entry + imagery_decision"| Conductor
    Conductor --> SynQueue
    Conductor --> ImgQueue
    SynQueue --> Storage
    ImgQueue --> Storage

    %% Fan-out
    Conductor --> ModWS
    Conductor --> MatchWS
    MatchWS --> Matchroom
    ModWS --> ModUI
    Studio -.->|"REST: briefs, pool"| Server

    %% Pacing feedback
    Conductor -.->|"POST /broadcasts/:id/feedback (wpm)"| Kairos

    %% Auth gating
    Auth -.->|"role: admin / writer / member"| Web

    classDef external fill:#fde,stroke:#a44,color:#222;
    classDef storage fill:#eef,stroke:#447,color:#222;
    class Kairos,SM,Radio external;
    class Storage storage;
```
