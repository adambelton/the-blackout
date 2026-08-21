"use client";

import { useEffect, useRef } from "react";
import type { PipelineCycleSummary } from "@blackout/shared";
import { brand as C } from "../../../lib/palette";
import { ScrubRow } from "./ScrubRow";

/** Left rail listing every cycle as a small clickable row showing
 * the drift band as a coloured bar plus a trigger marker. Lets
 * admins scan 100+ cycles at once for patterns ("every cycle around
 * HT is slipping", "phase-flushes spike", "drift climbs after
 * minute 60") without click-through-Prev. Newest at top to match
 * the existing list ordering. The selected cycle scrolls into view
 * automatically on selection change. */
export function ScrubStrip({
  cycles,
  cycleIndex,
  onChange,
}: {
  cycles: PipelineCycleSummary[];
  cycleIndex: number;
  onChange: (i: number) => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const selectedRowRef = useRef<HTMLButtonElement | null>(null);

  // Auto-scroll the selected row into view when navigation moves
  // past the visible window. `nearest` keeps incremental Prev/Next
  // navigation from jerking the scroll position; jumps from the
  // toolbar buttons or scrub clicks land where the user can see them.
  useEffect(() => {
    selectedRowRef.current?.scrollIntoView({ block: "nearest" });
  }, [cycleIndex]);

  if (cycles.length === 0) return null;

  return (
    <aside
      ref={containerRef}
      className="idle-hidden-scroll"
      style={{
        width: 96,
        flexShrink: 0,
        borderRight: `0.5px solid ${C.celadon}`,
        overflowY: "auto",
        overflowX: "hidden",
        padding: "8px 0",
        background: C.ivory,
      }}
      title="Scrub strip — drift per cycle, newest at top. Click to jump."
    >
      {cycles.map((c, idx) => (
        <ScrubRow
          key={c.id}
          ref={idx === cycleIndex ? selectedRowRef : null}
          cycle={c}
          selected={idx === cycleIndex}
          onClick={() => onChange(idx)}
        />
      ))}
    </aside>
  );
}
