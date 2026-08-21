"use client";

import { useCallback, useEffect, useState } from "react";
import type { RadioSource } from "@blackout/shared";
import { Dialog } from "../../components/Dialog";
import { DialogBody } from "../../components/DialogBody";
import { DialogFooter } from "../../components/DialogFooter";
import { Field } from "../../components/Field";
import { FieldError } from "../../components/FieldError";
import { PillButton } from "../../components/PillButton";
import { TextInput } from "../../components/TextInput";
import { brand as C } from "../../lib/palette";
import { apiDelete, apiGet, apiPatch, apiPost } from "@/lib/api";
import { routes } from "@/lib/routes";
import { CaptureTester } from "../components/CaptureTester";
import { Topbar } from "./components/Topbar";
import { SourceRow } from "./components/SourceRow";
import { EmptyState } from "./components/EmptyState";

interface FormState {
  id: string | null;
  name: string;
  streamUrl: string;
  urlPattern: string;
  defaultOffsetSeconds: string;
}

const EMPTY_FORM: FormState = {
  id: null,
  name: "",
  streamUrl: "",
  urlPattern: "",
  defaultOffsetSeconds: "",
};

export default function RadioSourcesPage() {
  const [sources, setSources] = useState<RadioSource[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setSources(await apiGet<RadioSource[]>(routes.radioSources.list()));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const openNew = () => {
    setForm(EMPTY_FORM);
    setError(null);
    setDialogOpen(true);
  };

  const openEdit = (source: RadioSource) => {
    setForm({
      id: source.id,
      name: source.name,
      streamUrl: source.streamUrl,
      urlPattern: source.urlPattern,
      defaultOffsetSeconds: String(source.defaultOffsetSeconds),
    });
    setError(null);
    setDialogOpen(true);
  };

  const closeDialog = () => {
    if (saving) return;
    setDialogOpen(false);
  };

  const save = useCallback(async () => {
    const payload = {
      name: form.name.trim(),
      streamUrl: form.streamUrl.trim(),
      urlPattern: form.urlPattern.trim(),
      defaultOffsetSeconds: parseInt(form.defaultOffsetSeconds, 10),
    };
    if (
      !payload.name ||
      !payload.streamUrl ||
      !payload.urlPattern ||
      Number.isNaN(payload.defaultOffsetSeconds)
    ) {
      setError("All fields are required; offset must be a number.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      if (form.id) {
        await apiPatch(routes.radioSources.item(form.id), payload);
      } else {
        await apiPost(routes.radioSources.list(), payload);
      }
      setDialogOpen(false);
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }, [form, load]);

  const remove = useCallback(async () => {
    if (!form.id) return;
    const name = form.name.trim() || "this source";
    if (!window.confirm(`Delete "${name}"? This cannot be undone.`)) return;
    setSaving(true);
    setError(null);
    try {
      await apiDelete(routes.radioSources.item(form.id));
      setDialogOpen(false);
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }, [form.id, form.name, load]);

  return (
    <main
      style={{
        maxWidth: 800,
        margin: "0 auto",
        padding: "40px 32px 80px",
        color: C.umber,
      }}
    >
      <Topbar onAdd={openNew} />

      {loading ? (
        <p style={{ color: C.stone, fontSize: 13 }}>Loading…</p>
      ) : sources.length === 0 ? (
        <EmptyState onAdd={openNew} />
      ) : (
        <div style={{ marginTop: 32 }}>
          {sources.map((s) => (
            <SourceRow key={s.id} source={s} onClick={() => openEdit(s)} />
          ))}
        </div>
      )}

      <Dialog
        open={dialogOpen}
        onClose={closeDialog}
        title={form.id ? "Edit radio source" : "Add radio source"}
        subtitle={form.id ? form.name : "Catalogue a new commentary stream"}
        width={560}
      >
        <DialogBody>
          <FieldError>{error}</FieldError>
          <Field label="Name">
            <TextInput
              placeholder="TalkSPORT"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          </Field>
          <Field label="Stream URL">
            <TextInput
              placeholder="https://…"
              value={form.streamUrl}
              onChange={(e) => setForm({ ...form, streamUrl: e.target.value })}
            />
          </Field>
          <Field
            label="URL pattern"
            hint="Substring used for legacy / free-text matching when a moderator enters a URL that isn't pre-catalogued here."
          >
            <TextInput
              placeholder="talksport"
              value={form.urlPattern}
              onChange={(e) => setForm({ ...form, urlPattern: e.target.value })}
            />
          </Field>
          <Field
            label="Default offset (seconds)"
            hint="Total radio-stream lag behind live match-time. Dominated by the stream's own live-edge buffering (~25–35s for radio CDNs); plus a few hundred ms of browser-capture overhead. Self-calibrates from live observations."
          >
            <TextInput
              placeholder="30"
              inputMode="numeric"
              value={form.defaultOffsetSeconds}
              onChange={(e) => setForm({ ...form, defaultOffsetSeconds: e.target.value })}
              style={{ fontFamily: "ui-monospace, Menlo, monospace" }}
            />
          </Field>

          <CaptureTester streamUrl={form.streamUrl.trim()} />
        </DialogBody>
        <DialogFooter>
          {form.id ? (
            <PillButton
              variant="destructive"
              onClick={remove}
              disabled={saving}
              style={{ marginRight: "auto" }}
            >
              Delete
            </PillButton>
          ) : null}
          <PillButton variant="ghost" onClick={closeDialog} disabled={saving}>
            Cancel
          </PillButton>
          <PillButton variant="primary" onClick={save} disabled={saving}>
            {saving ? "Saving…" : form.id ? "Save changes" : "Add source"}
          </PillButton>
        </DialogFooter>
      </Dialog>
    </main>
  );
}

