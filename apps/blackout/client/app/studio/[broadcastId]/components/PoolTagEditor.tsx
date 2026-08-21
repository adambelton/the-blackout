"use client";

import { useState } from "react";
import { brand as C } from "../../../lib/palette";
import { Field } from "../../../components/Field";
import { PillButton } from "../../../components/PillButton";
import { TextInput } from "../../../components/TextInput";

export function PoolTagEditor({
  poolItemId,
  initialTags,
  onSave,
}: {
  poolItemId: string;
  initialTags: string[];
  onSave: (poolItemId: string, tags: string[]) => Promise<boolean>;
}) {
  const [value, setValue] = useState(initialTags.join(", "));
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  const parsed = value
    .split(",")
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t.length > 0);
  const normalizedInitial = initialTags.map((t) => t.trim().toLowerCase());
  const dirty =
    parsed.length !== normalizedInitial.length ||
    parsed.some((t, i) => t !== normalizedInitial[i]);

  const save = async () => {
    setSaving(true);
    setErr(null);
    const ok = await onSave(poolItemId, parsed);
    setSaving(false);
    if (ok) {
      setSavedAt(Date.now());
    } else {
      setErr("Save failed");
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <Field label="Tags" hint="Comma-separated, lowercased on save">
        <TextInput
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="comma, separated, tags"
        />
      </Field>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <PillButton
          variant="primary"
          onClick={save}
          disabled={!dirty || saving}
        >
          {saving ? "Saving…" : "Save tags"}
        </PillButton>
        <span
          style={{
            fontSize: 11,
            color: err ? C.crimson : savedAt ? C.forest : C.stone,
          }}
        >
          {err ? err : savedAt ? "Saved" : dirty ? "Unsaved changes" : ""}
        </span>
      </div>
    </div>
  );
}
