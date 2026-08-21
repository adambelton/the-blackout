"use client";

import { useCallback, useEffect, useState } from "react";
import type { TtsVoiceRecord } from "@blackout/shared";
import { brand as C } from "../../lib/palette";
import { apiGet, apiFetch } from "@/lib/api";
import { routes } from "@/lib/routes";
import { Topbar } from "./components/Topbar";
import { VoiceRecord } from "./components/VoiceRecord";
import { VoiceDialog } from "./components/VoiceDialog";

export default function TtsVoicesPage() {
  const [voices, setVoices] = useState<TtsVoiceRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dialogMode, setDialogMode] = useState<"add" | "edit" | null>(null);
  const [editing, setEditing] = useState<TtsVoiceRecord | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await apiGet<TtsVoiceRecord[]>(routes.admin.ttsVoices.list());
      setVoices(data);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const openAdd = () => {
    setEditing(null);
    setDialogMode("add");
    setError(null);
  };

  const openEdit = (voice: TtsVoiceRecord) => {
    setEditing(voice);
    setDialogMode("edit");
    setError(null);
  };

  const closeDialog = () => {
    setDialogMode(null);
    setEditing(null);
  };

  const handleSave = (voice: TtsVoiceRecord) => {
    setVoices((prev) => {
      const idx = prev.findIndex((v) => v.id === voice.id);
      if (idx === -1) return [...prev, voice];
      const next = [...prev];
      next[idx] = voice;
      return next;
    });
    // If this voice is now the default, clear the flag from others locally
    if (voice.isDefault) {
      setVoices((prev) =>
        prev.map((v) => (v.id === voice.id ? voice : { ...v, isDefault: false })),
      );
    }
    closeDialog();
  };

  const handleDelete = async () => {
    if (!editing) return;
    if (!window.confirm(`Delete "${editing.name}"? This cannot be undone.`)) return;
    try {
      const res = await apiFetch(routes.admin.ttsVoices.item(editing.id), { method: "DELETE" });
      if (!res.ok) {
        const body = await res.json().catch(() => null) as { error?: string } | null;
        setError(body?.error ?? `HTTP ${res.status}`);
        return;
      }
      setVoices((prev) => prev.filter((v) => v.id !== editing.id));
      closeDialog();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <main
      style={{
        maxWidth: 800,
        margin: "0 auto",
        padding: "40px 32px 80px",
        color: C.umber,
      }}
    >
      <Topbar onAdd={openAdd} />

      {error && (
        <p style={{ color: C.crimson, fontSize: 13, marginBottom: 16 }}>{error}</p>
      )}

      {loading ? (
        <p style={{ color: C.stone, fontSize: 13 }}>Loading…</p>
      ) : voices.length === 0 ? (
        <p style={{ color: C.stone, fontSize: 13, marginTop: 32 }}>
          No voices yet. Add one to make it available in the moderator console.
        </p>
      ) : (
        <div style={{ marginTop: 32 }}>
          {voices.map((v) => (
            <VoiceRecord key={v.id} voice={v} onClick={() => openEdit(v)} />
          ))}
        </div>
      )}

      {dialogMode ? (
        <VoiceDialog
          mode={dialogMode}
          voice={editing ?? undefined}
          onSave={handleSave}
          onDelete={dialogMode === "edit" ? handleDelete : undefined}
          onClose={closeDialog}
        />
      ) : null}
    </main>
  );
}
