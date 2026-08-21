"use client";

import { Panel } from "../../../components/Panel";

export function InspectorPanel({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  // Panel body is edge-to-edge (bodyPadding: 0) so the scroller below
  // extends to the card's corners. Inspector always wants scrollable
  // content — hence the fixed inner scroll container rather than
  // letting the Panel manage it.
  return (
    <Panel label={title} grow bodyPadding={0}>
      <div
        className="idle-hidden-scroll"
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: "auto",
          padding: 16,
        }}
      >
        {children}
      </div>
    </Panel>
  );
}
