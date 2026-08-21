"use client";

import { brand as C } from "../../../lib/palette";
import { Panel } from "../../../components/Panel";
import type { NarrativeRecord } from "./types";

export function NarrativesPanel(props: {
  narratives: NarrativeRecord[];
  playingNarrativeId: string | null;
  engineStatus: string;
  countdown: number | null;
  onPlay: (id: string, text: string) => void;
  scrollRef: React.RefObject<HTMLDivElement | null>;
  isLive: boolean;
}) {
  return (
    <Panel label={`Narratives · Kairos · ${props.narratives.length}`} grow>
      <div
        ref={props.scrollRef}
        className="idle-hidden-scroll"
        style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "4px 0" }}
      >
        {props.narratives.length === 0 ? (
          <div
            style={{
              height: "100%",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: C.stone,
              fontSize: 13,
            }}
          >
            Narratives will stream here.
          </div>
        ) : (
          props.narratives.map((n) => (
            <div
              key={n.id}
              style={{
                padding: "14px 0",
                borderBottom: `0.5px solid ${C.celadon}70`,
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
                <span
                  style={{
                    fontSize: 10,
                    fontWeight: 500,
                    letterSpacing: "0.14em",
                    textTransform: "uppercase",
                    color: C.stone,
                  }}
                >
                  {new Date(n.generatedAt).toLocaleTimeString("en-GB", {
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </span>
                <button
                  type="button"
                  onClick={() => props.onPlay(n.id, n.text)}
                  style={{
                    fontFamily: "inherit",
                    fontSize: 11,
                    color: C.forest,
                    background: "none",
                    border: "none",
                    cursor: "pointer",
                    padding: 0,
                  }}
                >
                  {props.playingNarrativeId === n.id ? "Playing…" : "▶ Play"}
                </button>
              </div>
              <div style={{ fontSize: 14, fontWeight: 300, lineHeight: 1.7, color: C.umber }}>
                {n.text}
              </div>
            </div>
          ))
        )}
      </div>
    </Panel>
  );
}
