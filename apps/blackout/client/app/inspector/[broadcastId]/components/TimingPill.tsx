"use client";

import type { PipelineCycleTimingMs } from "@blackout/shared";
import { brand as C } from "../../../lib/palette";
import { MONO } from "./types";
import { pickSlowest } from "./utils";

/** Total flush-time pill — shows totalMs with a colour cue based on
 * how close the cycle came to saturating the cadence window. Hover
 * for the per-stage breakdown and the slowest enrichment / curation
 * service if there's one to highlight. */
export function TimingPill({ timing }: { timing: PipelineCycleTimingMs | null }) {
  if (!timing) return null;
  const slowestEnrich = pickSlowest(timing.perServiceEnrichmentMs);
  const slowestCure = pickSlowest(timing.perServiceCurationMs);
  const tooltipLines = [
    `total: ${timing.totalMs}ms`,
    `enrichment: ${timing.enrichmentMs}ms (parallel — max of services)`,
    `curation services: ${timing.curationServicesMs}ms`,
    `handler (LLM + persist): ${timing.handlerMs}ms`,
    slowestEnrich ? `slowest enrich: ${slowestEnrich.name} ${slowestEnrich.ms}ms` : null,
    slowestCure ? `slowest cure: ${slowestCure.name} ${slowestCure.ms}ms` : null,
  ].filter(Boolean);

  // Colour by how close totalMs is to the 45s cadence window. Green
  // <30s (comfortable headroom), warn 30-45s (at risk of queueing
  // the next tick), crimson >45s (already cost the next tick).
  let bg: string = `${C.forest}14`;
  let fg: string = C.forest;
  if (timing.totalMs > 45_000) {
    bg = `${C.crimson}14`;
    fg = C.crimson;
  } else if (timing.totalMs > 30_000) {
    bg = `${C.warn}14`;
    fg = C.warn;
  }

  return (
    <span
      title={tooltipLines.join("\n")}
      style={{
        fontSize: 11,
        color: fg,
        fontFamily: MONO,
        padding: "2px 10px",
        borderRadius: 100,
        background: bg,
      }}
    >
      {`${timing.totalMs}ms · e${timing.enrichmentMs} c${timing.curationServicesMs} h${timing.handlerMs}`}
    </span>
  );
}
