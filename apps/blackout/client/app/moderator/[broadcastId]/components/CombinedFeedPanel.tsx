"use client";

import { brand as C } from "../../../lib/palette";
import { Panel } from "../../../components/Panel";
import type { ModeratorFeedEntry } from "@blackout/shared";
import { FeedEntryRow } from "./FeedEntryRow";
import { ModeratorComposer } from "./ModeratorComposer";

export function CombinedFeedPanel(props: {
  feedEntries: ModeratorFeedEntry[];
  coveredEntryIds: Set<string>;
  scrollRef: React.RefObject<HTMLDivElement | null>;
  moderatorInput: string;
  onModeratorInputChange: (v: string) => void;
  onSendModeratorNote: () => void;
  disabled: boolean;
}) {
  return (
    <Panel
      label={`Combined feed · ${props.feedEntries.length}`}
      grow
      footer={
        <ModeratorComposer
          value={props.moderatorInput}
          onChange={props.onModeratorInputChange}
          onSend={props.onSendModeratorNote}
          disabled={props.disabled}
        />
      }
    >
      <div
        ref={props.scrollRef}
        className="idle-hidden-scroll"
        // Scroll container fills the panel's growing body; the panel
        // itself stretches to match the tallest column. Empty state
        // centres in whatever space the column gives us.
        style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "4px 0" }}
      >
        {props.feedEntries.length === 0 ? (
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
            Entries will appear here as they land.
          </div>
        ) : (
          props.feedEntries.map((e) => (
            <FeedEntryRow
              key={e.id}
              entry={e}
              covered={props.coveredEntryIds.has(e.id)}
            />
          ))
        )}
      </div>
    </Panel>
  );
}
