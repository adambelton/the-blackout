"use client";

import type { BroadcastStatus } from "@blackout/shared";
import { brand as C } from "../../../lib/palette";
import { SectionHeader } from "./SectionHeader";

export function BriefsColumn({
  status,
  editable,
  matchBrief,
  onMatchBriefChange,
  canSave,
  saving,
  savedAt,
  saveError,
  onSave,
  matchEmpty,
  dirty,
}: {
  status: BroadcastStatus;
  editable: boolean;
  matchBrief: string;
  onMatchBriefChange: (v: string) => void;
  canSave: boolean;
  saving: boolean;
  savedAt: number | null;
  saveError: string | null;
  onSave: () => void;
  matchEmpty: boolean;
  dirty: boolean;
}) {
  const savedLabel = savedAt
    ? `saved · ${new Date(savedAt).toLocaleTimeString("en-GB", {
        hour: "2-digit",
        minute: "2-digit",
      })}`
    : undefined;

  return (
    <section style={{ display: "flex", flexDirection: "column", minWidth: 0, minHeight: 0, overflow: "hidden" }}>
      <SectionHeader label="Match brief" meta={editable ? savedLabel : "Locked"} />

      {editable ? (
        <textarea
          className="idle-hidden-scroll"
          value={matchBrief}
          onChange={(e) => onMatchBriefChange(e.target.value)}
          placeholder="What we know: teams, history, form, lineups, anything the narrator should carry into the broadcast."
          style={{
            width: "100%",
            resize: "none",
            padding: "12px 14px",
            fontSize: 13,
            fontFamily: "inherit",
            lineHeight: 1.55,
            color: C.umber,
            background: C.ivory,
            border: `0.5px solid ${C.celadon}`,
            borderRadius: 8,
            outline: "none",
            boxSizing: "border-box",
            flex: 1,
            minHeight: 0,
            overflowY: "auto",
          }}
        />
      ) : (
        <div
          className="idle-hidden-scroll"
          style={{
            padding: "12px 14px",
            fontSize: 13,
            lineHeight: 1.55,
            color: C.umber,
            background: `${C.celadon}30`,
            border: `0.5px solid ${C.celadon}`,
            borderRadius: 8,
            whiteSpace: "pre-wrap",
            flex: 1,
            overflow: "auto",
          }}
        >
          {matchBrief || (
            <span style={{ color: C.stone }}>(no brief)</span>
          )}
        </div>
      )}

      {editable ? (
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 16 }}>
          <button
            type="button"
            onClick={onSave}
            disabled={saving || !canSave}
            style={{
              padding: "10px 20px",
              fontSize: 13,
              fontFamily: "inherit",
              background: canSave && !saving ? C.forest : C.celadon,
              color: canSave && !saving ? C.ivory : C.stone,
              border: "none",
              borderRadius: 999,
              cursor: canSave && !saving ? "pointer" : "default",
            }}
          >
            {saving ? "Saving…" : "Save brief"}
          </button>
          <span style={{ fontSize: 11, color: saveError ? C.crimson : C.stone }}>
            {saveError
              ? saveError
              : matchEmpty
                ? "Brief must have content"
                : dirty
                  ? "Unsaved changes"
                  : "Up to date"}
          </span>
        </div>
      ) : (
        <div style={{ fontSize: 11, color: C.stone, marginTop: 16 }}>
          Brief locks when the broadcast goes live. Status: {status}.
        </div>
      )}
    </section>
  );
}
