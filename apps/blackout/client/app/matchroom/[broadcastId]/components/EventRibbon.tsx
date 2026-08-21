"use client";

import { brand as C } from "../../../lib/palette";
import { isShowableEvent } from "../derivations";
import type { ViewerEvent } from "../derivations";
import { EventRow } from "./EventRow";

export function EventRibbon({ events }: { events: ViewerEvent[] }) {
  const shown = [...events].filter((e) => isShowableEvent(e)).reverse();

  return (
    <aside
      className="mr-event-ribbon idle-hidden-scroll"
      style={{
        position: "fixed",
        top: 225,
        left: 14,
        width: 280,
        maxHeight: "calc(100vh - 260px)",
        overflowY: "auto",
        zIndex: 10,
        display: "flex",
        flexDirection: "column",
        gap: 6,
      }}
    >
      {shown.length === 0 ? (
        <div
          style={{
            color: C.driftwood,
            fontSize: 11,
            opacity: 0.5,
            paddingLeft: 14,
            letterSpacing: "0.04em",
          }}
        >
          Events will appear here.
        </div>
      ) : (
        shown.map((e) => <EventRow key={e.id} event={e} />)
      )}
      <style>{`
        @keyframes matchroom-card-entrance {
          0%   { opacity: 0; transform: translateY(6px); }
          100% { opacity: 1; transform: translateY(0); }
        }
        .idle-hidden-scroll { scrollbar-width: thin; scrollbar-color: transparent transparent; }
        .idle-hidden-scroll:hover, .idle-hidden-scroll:focus-within { scrollbar-color: ${C.driftwood}66 transparent; }
        .idle-hidden-scroll::-webkit-scrollbar { width: 8px; }
        .idle-hidden-scroll::-webkit-scrollbar-track { background: transparent; }
        .idle-hidden-scroll::-webkit-scrollbar-thumb { background: transparent; border-radius: 4px; transition: background 180ms ease; }
        .idle-hidden-scroll:hover::-webkit-scrollbar-thumb,
        .idle-hidden-scroll:focus-within::-webkit-scrollbar-thumb,
        .idle-hidden-scroll:active::-webkit-scrollbar-thumb { background: ${C.driftwood}66; }
      `}</style>
    </aside>
  );
}
