"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import type {
  Broadcast,
  BroadcastHealth,
  PipelineCycleSummary,
  PipelineCycleDetail,
  PipelineGeneration,
} from "@blackout/shared";
import { AdminFooter } from "../../components/AdminFooter";
import { brand as C } from "../../lib/palette";
import { routes } from "@/lib/routes";
import type { NarrativeMedia } from "./components/types";
import { fetchJson, joinContent } from "./components/utils";
import { Header } from "./components/Header";
import { Toolbar } from "./components/Toolbar";
import { ScrubStrip } from "./components/ScrubStrip";
import { Panels } from "./components/Panels";

/**
 * Pipeline inspector for completed broadcasts. Each view is one flush
 * cycle across four panels: Assembly (feed chunk), Enrichment
 * (per-subject annotations), Curation (decisions + conflicts), Output
 * (generated prose + covers + token usage).
 *
 * Re-skinned in the brand-consistent round — same structural primitives,
 * now on the ivory/umber palette with DM Sans. Monospace retained for
 * IDs and JSON bodies where it carries meaning; everything else is DM
 * Sans per the brand guide.
 */
export default function InspectorPage() {
  const params = useParams<{ broadcastId: string }>();
  const broadcastId = params.broadcastId;

  const [broadcast, setBroadcast] = useState<Broadcast | null>(null);
  const [voice, setVoice] = useState<string>("");
  const [context, setContext] = useState<string>("");
  const [cycles, setCycles] = useState<PipelineCycleSummary[]>([]);
  const [cycleIndex, setCycleIndex] = useState<number>(0);
  const [detail, setDetail] = useState<PipelineCycleDetail | null>(null);
  const [generation, setGeneration] = useState<PipelineGeneration | null>(null);
  const [media, setMedia] = useState<NarrativeMedia | null>(null);
  const [health, setHealth] = useState<BroadcastHealth | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    async function loadMeta() {
      try {
        const [b, v, ctx] = await Promise.all([
          fetchJson<Broadcast>(routes.broadcasts.item(broadcastId)),
          fetchJson<{ entries: Array<{ data: { content?: unknown } }> }>(
            routes.broadcasts.entries(broadcastId, { source: "narrative_voice" }),
          ),
          fetchJson<{ entries: Array<{ data: { content?: unknown } }> }>(
            routes.broadcasts.entries(broadcastId, { source: "narrative_context" }),
          ),
        ]);
        setBroadcast(b);
        setVoice(joinContent(v.entries));
        setContext(joinContent(ctx.entries));
      } catch (err) {
        setLoadError(`Failed to load broadcast metadata: ${(err as Error).message}`);
      }
    }
    loadMeta();
  }, [broadcastId]);

  // Live poll: while the broadcast is anything other than `complete`,
  // refresh the cycle list every 4s so the inspector tracks the
  // pipeline as new cycles land. The selection follows the user:
  //   - viewing index 0 (head) → stay at 0, which is now the newest cycle
  //   - viewing anything else → look the previously-selected cycle up
  //     by id in the refreshed list and pin to its new position
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    async function loadHealth() {
      try {
        const h = await fetchJson<BroadcastHealth>(
          routes.broadcasts.health(broadcastId),
        );
        if (!cancelled) setHealth(h);
      } catch {
        // Health is a debug surface — failure shouldn't block the
        // inspector. Older broadcasts without the new fields may
        // also return partial data.
      }
    }

    async function loadCycles() {
      try {
        const { cycles: rows } = await fetchJson<{ cycles: PipelineCycleSummary[] }>(
          routes.broadcasts.cycles(broadcastId, { limit: 200 }),
        );
        if (cancelled) return;
        setCycles((prev) => {
          // First load — select the newest cycle.
          if (prev.length === 0) {
            setCycleIndex(0);
            return rows;
          }
          // Re-anchor the selection. If we were at the head, stay at
          // the head (now pointing at whatever new cycle landed).
          // Otherwise pin to the same cycle id; if it scrolled out
          // of the window, fall back to the head.
          setCycleIndex((idx) => {
            if (idx === 0) return 0;
            const selectedId = prev[idx]?.id;
            if (!selectedId) return 0;
            const next = rows.findIndex((r) => r.id === selectedId);
            return next === -1 ? 0 : next;
          });
          return rows;
        });
      } catch (err) {
        if (!cancelled) setLoadError(`Failed to load cycles: ${(err as Error).message}`);
      }
    }

    function schedule() {
      if (cancelled) return;
      // Stop polling once the broadcast wraps up.
      if (broadcast?.status === "complete") return;
      timer = setTimeout(async () => {
        await Promise.all([loadCycles(), loadHealth()]);
        schedule();
      }, 4_000);
    }

    Promise.all([loadCycles(), loadHealth()]).then(schedule);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [broadcastId, broadcast?.status]);

  const currentSummary: PipelineCycleSummary | undefined = cycles[cycleIndex];

  useEffect(() => {
    if (!currentSummary) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    fetchJson<PipelineCycleDetail>(
      routes.broadcasts.cycle(broadcastId, currentSummary.id),
    )
      .then((d) => { if (!cancelled) setDetail(d); })
      .catch((err) => {
        if (!cancelled) setLoadError(`Failed to load cycle: ${(err as Error).message}`);
      });
    return () => { cancelled = true; };
  }, [broadcastId, currentSummary?.id]);

  useEffect(() => {
    if (!detail?.generationId) {
      setGeneration(null);
      setMedia(null);
      return;
    }
    let cancelled = false;
    const generationId = detail.generationId;
    fetchJson<PipelineGeneration>(
      routes.broadcasts.generation(broadcastId, generationId),
    )
      .then((g) => { if (!cancelled) setGeneration(g); })
      .catch((err) => {
        if (!cancelled) console.warn(`Failed to load generation: ${(err as Error).message}`);
      });
    // Illustration + narration media live on the Blackout side (not
    // Kairos), keyed by the Kairos narrativeId. Fetched in parallel
    // with the generation itself so the output panel can render
    // thumbnail + audio without a serial round-trip.
    fetchJson<NarrativeMedia>(
      routes.broadcasts.narrationMedia(broadcastId, generationId),
    )
      .then((m) => { if (!cancelled) setMedia(m); })
      .catch((err) => {
        if (!cancelled) console.warn(`Failed to load media: ${(err as Error).message}`);
      });
    return () => { cancelled = true; };
  }, [broadcastId, detail?.generationId]);

  if (loadError) {
    return (
      <div
        style={{
          padding: 40,
          background: C.ivory,
          color: C.crimson,
          minHeight: "100vh",
          fontSize: 13,
        }}
      >
        {loadError}
      </div>
    );
  }

  return (
    <div
      style={{
        background: C.ivory,
        color: C.umber,
        // Cap at viewport (not `minHeight`) so the grid cells below —
        // each with their own internal scrolling — stop growing the
        // page when their content overflows. Without this, a cycle
        // with hundreds of annotations pushes the whole document past
        // 100vh and the columns stretch with it.
        height: "100vh",
        display: "flex",
        flexDirection: "column",
      }}
    >
      <Header broadcast={broadcast} voice={voice} context={context} broadcastId={broadcastId} health={health} />
      <Toolbar
        cycles={cycles}
        cycleIndex={cycleIndex}
        onChange={setCycleIndex}
        detail={detail}
        generation={generation}
      />
      <div
        style={{
          flex: 1,
          display: "flex",
          minHeight: 0,
        }}
      >
        <ScrubStrip cycles={cycles} cycleIndex={cycleIndex} onChange={setCycleIndex} />
        <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
          <Panels detail={detail} generation={generation} media={media} />
        </div>
      </div>

      {/* Idle-hidden scrollbars for each Panel body. Thumb is invisible
          by default and appears while the pointer is over the column or
          while focus is inside it. Same treatment as the moderator's
          combined-feed + narratives panels. */}
      <style>{`
        .idle-hidden-scroll { scrollbar-width: thin; scrollbar-color: transparent transparent; }
        .idle-hidden-scroll:hover, .idle-hidden-scroll:focus-within { scrollbar-color: ${C.driftwood}66 transparent; }
        .idle-hidden-scroll::-webkit-scrollbar { width: 8px; }
        .idle-hidden-scroll::-webkit-scrollbar-track { background: transparent; }
        .idle-hidden-scroll::-webkit-scrollbar-thumb { background: transparent; border-radius: 4px; transition: background 180ms ease; }
        .idle-hidden-scroll:hover::-webkit-scrollbar-thumb,
        .idle-hidden-scroll:focus-within::-webkit-scrollbar-thumb,
        .idle-hidden-scroll:active::-webkit-scrollbar-thumb { background: ${C.driftwood}66; }
      `}</style>
      <div style={{ padding: "0 20px", flexShrink: 0 }}>
        <AdminFooter left="Inspector" />
      </div>
    </div>
  );
}
