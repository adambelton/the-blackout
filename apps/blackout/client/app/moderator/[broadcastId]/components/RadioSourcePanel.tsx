"use client";

import { brand as C } from "../../../lib/palette";
import { Panel } from "../../../components/Panel";
import type { RadioSource } from "@blackout/shared";
import type { LatencySample } from "./types";
import { FieldLabel } from "./FieldLabel";
import { pillStyles } from "./utils";

function selectStyle(disabled: boolean): React.CSSProperties {
  return {
    width: "100%",
    boxSizing: "border-box",
    fontFamily: "inherit",
    fontSize: 13,
    color: C.umber,
    padding: "9px 12px",
    borderRadius: 8,
    border: `0.5px solid ${C.celadon}`,
    background: C.ivory,
    fontWeight: 400,
    opacity: disabled ? 0.6 : 1,
  };
}

export function RadioSourcePanel({
  availableSources,
  streamUrl,
  onStreamUrlChange,
  isListeningLocally,
  onStartListening,
  onStopListening,
  latencySamples,
}: {
  availableSources: RadioSource[];
  streamUrl: string;
  onStreamUrlChange: (v: string) => void;
  isListeningLocally: boolean;
  onStartListening: () => void;
  onStopListening: () => void;
  latencySamples: LatencySample[];
}) {
  // Derived from the picked source — transcription is owned by the
  // BroadcastRunner now, so the moderator just displays which source is
  // configured and what offset it carries (alongside live latency
  // samples coming back through the conductor).
  const selectedSource = availableSources.find((s) => s.streamUrl === streamUrl) ?? null;
  const radioOffset = selectedSource
    ? { sourceName: selectedSource.name, offsetSeconds: selectedSource.defaultOffsetSeconds }
    : null;

  const meta = (
    <a
      href="/admin/radio-sources"
      target="_blank"
      rel="noreferrer"
      style={{
        // Inherit the meta slot's font-size (set in Panel) so the
        // panel header height stays identical to meta-less panels.
        color: C.driftwood,
        textDecoration: "none",
        transition: "color 160ms ease",
      }}
      onMouseEnter={(e) => { e.currentTarget.style.color = C.umber; }}
      onMouseLeave={(e) => { e.currentTarget.style.color = C.driftwood; }}
    >
      Manage sources ↗
    </a>
  );

  return (
    <Panel label="Radio commentary" meta={meta}>
      <FieldLabel>Source</FieldLabel>
      <select
        value={streamUrl}
        onChange={(e) => onStreamUrlChange(e.target.value)}
        disabled={isListeningLocally}
        style={selectStyle(isListeningLocally)}
      >
        {availableSources.length === 0 ? (
          <option value="">No sources catalogued</option>
        ) : (
          <>
            <option value="" disabled>— Select a source —</option>
            {availableSources.map((s) => (
              <option key={s.id} value={s.streamUrl}>
                {s.name} — offset {s.defaultOffsetSeconds}s
              </option>
            ))}
          </>
        )}
      </select>

      <div
        style={{
          display: "flex",
          gap: 8,
          alignItems: "center",
          marginTop: 10,
          flexWrap: "wrap",
        }}
      >
        {isListeningLocally ? (
          <button
            type="button"
            onClick={onStopListening}
            style={{ ...pillStyles("destructive"), fontSize: 12, padding: "7px 14px" }}
          >
            Stop listening
          </button>
        ) : (
          <button
            type="button"
            onClick={onStartListening}
            disabled={!streamUrl}
            style={{ ...pillStyles(streamUrl ? "ghost" : "ghostDisabled"), fontSize: 12, padding: "7px 14px" }}
          >
            Listen
          </button>
        )}
      </div>

      <div style={{ fontSize: 11, color: C.stone, marginTop: 8 }}>
        Listening is for the moderator&rsquo;s headphones only — the toggle
        controls speaker volume but does not affect what gets captured.
        Audio capture runs in this browser tab while the broadcast is
        live; defaults to muted so you can focus on the narrator.
      </div>

      {radioOffset ? (
        <div
          style={{
            marginTop: 12,
            paddingTop: 10,
            borderTop: `0.5px solid ${C.celadon}`,
            fontSize: 11,
            color: C.driftwood,
            fontVariantNumeric: "tabular-nums",
          }}
        >
          <strong style={{ color: C.umber, fontWeight: 500 }}>
            {radioOffset.sourceName ?? "Unmatched source"}
          </strong>
          {" · offset "}
          <strong style={{ color: C.umber, fontWeight: 500 }}>
            {radioOffset.offsetSeconds}s
          </strong>
          {latencySamples.length > 0 ? (
            <>
              <br />
              <span style={{ color: C.stone }}>Observed Δ:</span>{" "}
              {latencySamples.slice(-3).map((s, i) => {
                const drift = s.rawDeltaSeconds;
                const warn = Math.abs(drift - s.configuredOffsetSeconds) > 2;
                return (
                  <span key={s.receivedAt + i} style={{ marginRight: 10, color: C.stone }}>
                    @{s.goalContentTime}&rsquo;{" "}
                    <span style={{ color: warn ? C.warn : C.forest }}>
                      {drift.toFixed(1)}s
                    </span>
                  </span>
                );
              })}
            </>
          ) : null}
        </div>
      ) : null}
    </Panel>
  );
}
