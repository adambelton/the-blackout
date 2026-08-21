# Kairos — pipeline diagram

> **⚠️ Stale (2026-05-11).** This diagram shows "Curation (sequential)" (it's tier-parallel now) and the old `accumulation · gap · improv` trigger enum (collapsed to `accumulation · external`). The current architecture is in [`apps/kairos/server/src/README.md`](../apps/kairos/server/src/README.md). This file will be refreshed or retired with the rest of the Kairos doc decomposition.

The four-stage Kairos pipeline at a glance: ingest+batch → enrichment (parallel) → curation (sequential) → generation, with the curator-feedback loop and supporting state. Renders natively on GitHub, VSCode (with the Mermaid extension), and Cursor. The companion narrative doc is [`kairos-architecture.md`](./kairos-architecture.md).

```mermaid
flowchart TD
    %% Inputs from consumer
    Consumer[("Consumer\n(e.g. The Blackout)")]
    Consumer -->|"POST /broadcasts/:id/entries"| Ingest

    %% Stage 1
    subgraph S1["Stage 1 — Ingest + batch"]
        Ingest["onEntry\n(filter ambient, append to feed log)"]
        Buffer["Cycle buffer\n(timer + accumulation triggers)"]
        Ingest --> Feed[("Feed log\n(broadcast-wide)")]
        Ingest --> Buffer
        Buffer -->|"flush → FeedChunk"| S2
    end

    %% Stage 2
    subgraph S2["Stage 2 — Enrichment (parallel, additive)"]
        Arcs["character-arcs"]
        Rels["character-relationships"]
        Mom["momentum"]
        Pat["patterns-echoes"]
        Tens["tension-conflict"]
        Themes["themes"]
    end
    S2 -->|"EnrichedPayload\n(chunk + annotations)"| S3

    %% Stage 3
    subgraph S3["Stage 3 — Curation (tier-parallel, subtractive)"]
        T1["Tier 1 (parallel):\nnarrative_arc · narrative_gap\nsaturation_resolver · context_curator"]
        T2["Tier 2 (parallel):\npriority · pacing"]
        T3["Tier 3:\nconflict_resolver"]
        T4["Tier 4:\nbroadcast_summary"]
        Budget["reconcileBudget\n(token ceiling, last)"]
        T1 --> T2 --> T3 --> T4 --> Budget
    end
    S3 -->|"CuratedPayload"| S4

    %% Stage 4
    subgraph S4["Stage 4 — Generation"]
        Sonnet["Sonnet\n(deliver_narrative tool)"]
        Haiku1["Haiku — imagery\n(pool / generate / hold)"]
        Haiku2["Haiku — narrative summary block"]
        Sonnet -. parallel .- Haiku1
        Sonnet -. parallel .- Haiku2
    end
    S4 -->|"WS: narrative + imagery_decision\n+ generation_skipped + cycle_complete"| Consumer

    %% Feedback loop
    S3 -->|"CuratorFeedback\n(per annotation outcome)"| S2

    %% Supporting state
    State[("BroadcastStateTracker\n(elapsed, WPM, prior gens, summary)")]
    Recent[("RecentCyclesBuffer\n(anti-repetition)")]
    State -.- S3
    State -.- S4
    Recent -.- S3
    Feed -.->|"voice / context / canonical scans"| S4

    %% Cycle triggers (margin)
    Triggers["Cycle triggers:\naccumulation · gap · improv\n(timer-driven only)"]
    Triggers -.- Buffer

    classDef external fill:#fde,stroke:#a44,color:#222;
    classDef store fill:#eef,stroke:#447,color:#222;
    class Consumer external;
    class Feed,State,Recent store;
```
