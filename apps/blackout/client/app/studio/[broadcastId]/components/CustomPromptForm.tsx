"use client";

import { brand as C } from "../../../lib/palette";

export function CustomPromptForm({
  value,
  onChange,
  onSubmit,
}: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
}) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 8,
        padding: 16,
        border: `0.5px dashed ${C.celadon}`,
        borderRadius: 10,
      }}
    >
      <div
        style={{
          fontSize: 11,
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          color: C.driftwood,
        }}
      >
        Custom prompt
      </div>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Describe a scene the suggestions didn't reach — a specific moment or atmosphere you want in the pool."
        rows={2}
        style={{
          width: "100%",
          resize: "vertical",
          padding: "8px 10px",
          fontSize: 12.5,
          fontFamily: "inherit",
          lineHeight: 1.5,
          color: C.umber,
          background: C.ivory,
          border: `0.5px solid ${C.celadon}`,
          borderRadius: 6,
          outline: "none",
          boxSizing: "border-box",
        }}
      />
      <div>
        <button
          type="button"
          onClick={onSubmit}
          disabled={!value.trim()}
          style={{
            padding: "8px 16px",
            fontSize: 12,
            fontFamily: "inherit",
            background: value.trim() ? C.forest : C.celadon,
            color: value.trim() ? C.ivory : C.stone,
            border: "none",
            borderRadius: 999,
            cursor: value.trim() ? "pointer" : "default",
          }}
        >
          Add to review
        </button>
      </div>
    </div>
  );
}
