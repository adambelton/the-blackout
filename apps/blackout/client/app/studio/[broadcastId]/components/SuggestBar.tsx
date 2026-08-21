"use client";

import { brand as C } from "../../../lib/palette";

export function SuggestBar({
  onRequestSuggestions,
  suggesting,
  suggestError,
  queueRemaining,
  cardsCount,
  matchEmpty,
}: {
  onRequestSuggestions: () => void;
  suggesting: boolean;
  suggestError: string | null;
  queueRemaining: number;
  cardsCount: number;
  matchEmpty: boolean;
}) {
  const batchActive = cardsCount > 0 || queueRemaining > 0;
  const disabled = suggesting || matchEmpty || batchActive;
  const label = suggesting
    ? "Asking Haiku…"
    : batchActive
      ? "More suggestions"
      : "Suggest prompts";

  const hint = suggestError
    ? suggestError
    : matchEmpty
      ? "Match brief must have content first"
      : batchActive
        ? queueRemaining > 0
          ? `Review the current batch to unlock — ${queueRemaining} still queued`
          : "Resolve the active cards to unlock"
        : "A batch of 25 prompts, steered by what you've accepted and discarded";

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
      <button
        type="button"
        onClick={disabled ? undefined : onRequestSuggestions}
        disabled={disabled}
        style={{
          padding: "10px 20px",
          fontSize: 13,
          fontFamily: "inherit",
          background: disabled ? C.celadon : C.forest,
          color: disabled ? C.stone : C.ivory,
          border: "none",
          borderRadius: 999,
          cursor: disabled ? "default" : "pointer",
        }}
      >
        {label}
      </button>
      <span style={{ fontSize: 11, color: suggestError ? C.crimson : C.stone }}>
        {hint}
      </span>
    </div>
  );
}
