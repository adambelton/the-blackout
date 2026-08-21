"use client";

import type { PipelineCycleDrift } from "@blackout/shared";
import { FlowPill } from "./FlowPill";
import { driftBandLabel } from "./utils";

/** Render the four flow numbers + drift band for the selected
 * cycle. All values come from the server's per-cycle drift block
 * (`PipelineCycleDrift`) so the pills here use the same arithmetic
 * as the scrub strip. */
export function CycleFlowPills({ drift }: { drift: PipelineCycleDrift | null }) {
  if (!drift) return null;
  const pills: React.ReactNode[] = [];
  if (drift.cadenceSeconds !== null) {
    pills.push(
      <FlowPill key="cad" label="cad" value={`${Math.round(drift.cadenceSeconds)}s`} tone="neutral" title="Cadence — wall-clock between this cycle's flush and the previous one." />,
    );
  }
  if (drift.contentSeconds !== null) {
    pills.push(
      <FlowPill key="content" label="content" value={`${Math.round(drift.contentSeconds)}s`} tone="neutral" title="Content time covered within this cycle (max − min phaseSecond, when entries share a phase)." />,
    );
  }
  if (drift.proseSeconds > 0) {
    pills.push(
      <FlowPill key="prose" label="prose" value={`${Math.round(drift.proseSeconds)}s`} tone="neutral" title="Prose duration produced (wordCount × 60 / WPM)." />,
    );
  }
  if (drift.targetSeconds !== null) {
    pills.push(
      <FlowPill key="target" label="target" value={`${Math.round(drift.targetSeconds)}s`} tone="neutral" title="Curator's word-budget target for this cycle (recommendedWordCount × 60 / WPM)." />,
    );
  }
  if (pills.length === 0) return null;
  return (
    <>
      {pills}
      <FlowPill
        label="drift"
        value={driftBandLabel(drift.driftBand)}
        tone={drift.driftBand === "ok" || drift.driftBand === "unknown" ? "neutral" : "warn"}
        title="Largest divergence among cadence, content, and prose. ≥10s → warn, ≥30s → bad."
      />
    </>
  );
}
