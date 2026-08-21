"use client";

import { brand as C } from "../../../lib/palette";
import { pillStyles } from "./utils";

export function ModeratorComposer({
  value,
  onChange,
  onSend,
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  onSend: () => void;
  disabled: boolean;
}) {
  const canSend = !disabled && value.trim().length > 0;
  return (
    <div style={{ display: "flex", gap: 8, padding: "12px 18px", alignItems: "center" }}>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && canSend) {
            e.preventDefault();
            onSend();
          }
        }}
        placeholder={
          disabled
            ? "Broadcast complete — composer locked."
            : "Add a moderator note — colour, context, a name…"
        }
        disabled={disabled}
        style={{
          flex: 1,
          fontFamily: "inherit",
          fontSize: 13,
          color: C.umber,
          padding: "9px 12px",
          borderRadius: 8,
          border: `0.5px solid ${C.celadon}`,
          background: C.ivory,
          outline: "none",
          transition: "border-color 160ms ease",
          opacity: disabled ? 0.5 : 1,
        }}
        onFocus={(e) => { e.currentTarget.style.borderColor = C.driftwood; }}
        onBlur={(e) => { e.currentTarget.style.borderColor = C.celadon; }}
      />
      <button
        type="button"
        onClick={onSend}
        disabled={!canSend}
        style={{
          ...pillStyles(canSend ? "primary" : "ghostDisabled"),
          fontSize: 12,
          padding: "8px 18px",
          background: canSend ? C.forest : undefined,
        }}
      >
        Send
      </button>
    </div>
  );
}
