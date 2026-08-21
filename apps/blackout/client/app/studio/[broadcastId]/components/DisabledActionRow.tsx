"use client";

import { CardAction } from "./CardAction";

export function DisabledActionRow() {
  return (
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
      <CardAction primary disabled>
        Generate
      </CardAction>
      <CardAction disabled>Edit</CardAction>
      <CardAction subdued disabled>
        Discard
      </CardAction>
    </div>
  );
}
