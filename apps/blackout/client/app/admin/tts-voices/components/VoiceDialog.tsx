"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { TtsVoiceRecord } from "@blackout/shared";
import { BROADCAST_TTS_PROVIDERS, BROADCAST_TTS_PROVIDER_LABELS } from "@blackout/shared";
import type { BroadcastTtsProvider } from "@blackout/shared";
import { brand as C } from "../../../lib/palette";
import { Dialog } from "../../../components/Dialog";
import { DialogBody } from "../../../components/DialogBody";
import { DialogFooter } from "../../../components/DialogFooter";
import { Field } from "../../../components/Field";
import { FieldError } from "../../../components/FieldError";
import { PillButton } from "../../../components/PillButton";
import { TextInput } from "../../../components/TextInput";
import { VoiceRow } from "../../../moderator/[broadcastId]/components/VoiceRow";
import { apiGet, apiFetch } from "@/lib/api";
import { routes } from "@/lib/routes";

interface ProviderVoice {
  id: string;
  provider: BroadcastTtsProvider;
  name: string;
  description?: string | null;
  accent?: string | null;
  gender?: string | null;
}

interface BrowseSelection {
  providerVoiceId: string;
  provider: BroadcastTtsProvider;
  providerName: string;
  providerDescription?: string;
}

const SPEED_HINTS: Record<BroadcastTtsProvider, string> = {
  elevenlabs: "0.7 – 1.2",
  openai: "0.25 – 4.0",
  hume: "0.75 – 1.5",
};

export function VoiceDialog({
  mode,
  voice,
  onSave,
  onDelete,
  onClose,
}: {
  mode: "add" | "edit";
  voice?: TtsVoiceRecord;
  onSave: (voice: TtsVoiceRecord) => void;
  onDelete?: () => void;
  onClose: () => void;
}) {
  // Browse step state
  const [step, setStep] = useState<"browse" | "configure">(mode === "edit" ? "configure" : "browse");
  const [providerVoices, setProviderVoices] = useState<ProviderVoice[]>([]);
  const [voicesLoading, setVoicesLoading] = useState(false);
  const [expandedProviders, setExpandedProviders] = useState<Set<BroadcastTtsProvider>>(
    new Set(["elevenlabs"]),
  );
  const [browseSel, setBrowseSel] = useState<BrowseSelection | null>(null);

  // Configure step state
  const [name, setName] = useState(voice?.name ?? "");
  const [description, setDescription] = useState(voice?.description ?? "");
  const [speed, setSpeed] = useState(voice?.speed != null ? String(voice.speed) : "");
  const [isDefault, setIsDefault] = useState(voice?.isDefault ?? false);

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Preview audio
  const previewAudioRef = useRef<HTMLAudioElement | null>(null);
  const [previewLoadingId, setPreviewLoadingId] = useState<string | null>(null);
  const [previewPlayingId, setPreviewPlayingId] = useState<string | null>(null);

  useEffect(() => {
    previewAudioRef.current = new Audio();
    return () => {
      previewAudioRef.current?.pause();
    };
  }, []);

  // Load provider voices for browse step
  useEffect(() => {
    if (mode !== "add") return;
    setVoicesLoading(true);
    apiGet<{ voices?: ProviderVoice[] }>(routes.tts.voices())
      .then((data) => {
        setProviderVoices(data?.voices ?? []);
      })
      .catch(() => {})
      .finally(() => setVoicesLoading(false));
  }, [mode]);

  const toggleProvider = (p: BroadcastTtsProvider) => {
    setExpandedProviders((prev) => {
      const next = new Set(prev);
      if (next.has(p)) next.delete(p);
      else next.add(p);
      return next;
    });
  };

  const selectFromBrowse = (v: ProviderVoice) => {
    setBrowseSel({
      providerVoiceId: v.id,
      provider: v.provider,
      providerName: v.name,
      providerDescription: v.description ?? undefined,
    });
    setName(v.name);
    setDescription(v.description ?? "");
    setStep("configure");
    setError(null);
  };

  const previewVoice = useCallback(async (voiceId: string, provider: BroadcastTtsProvider, previewSpeed?: number) => {
    const audio = previewAudioRef.current;
    if (audio) { audio.pause(); audio.src = ""; }
    setPreviewLoadingId(voiceId);
    setPreviewPlayingId(null);

    try {
      const res = await apiFetch(routes.admin.ttsVoices.preview(), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: "The ball crossed the line with the inevitability of a sentence that had been forming since the first whistle. The crowd rose as one.",
          voiceId,
          provider,
          ...(previewSpeed != null && { speed: previewSpeed }),
        }),
      });

      if (!res.ok) { setPreviewLoadingId(null); return; }

      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      if (audio) {
        audio.src = url;
        setPreviewLoadingId(null);
        setPreviewPlayingId(voiceId);
        audio.onended = () => { URL.revokeObjectURL(url); setPreviewPlayingId(null); };
        audio.play().catch(() => { setPreviewLoadingId(null); setPreviewPlayingId(null); });
      }
    } catch {
      setPreviewLoadingId(null);
      setPreviewPlayingId(null);
    }
  }, []);

  const save = useCallback(async () => {
    const parsedSpeed = speed.trim() ? parseFloat(speed.trim()) : undefined;
    if (speed.trim() && (isNaN(parsedSpeed!) || parsedSpeed! <= 0)) {
      setError("Speed must be a positive number (e.g. 0.85, 1.0, 1.2).");
      return;
    }
    if (!name.trim()) {
      setError("Name is required.");
      return;
    }

    setSaving(true);
    setError(null);

    const payload = {
      name: name.trim(),
      description: description.trim() || null,
      speed: parsedSpeed ?? null,
      isDefault,
    };

    try {
      let result: TtsVoiceRecord;
      if (mode === "edit" && voice) {
        const res = await apiFetch(routes.admin.ttsVoices.item(voice.id), {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        if (!res.ok) {
          const body = await res.json().catch(() => null) as { error?: string } | null;
          throw new Error(body?.error ?? `HTTP ${res.status}`);
        }
        result = await res.json() as TtsVoiceRecord;
      } else {
        if (!browseSel) { setError("Select a voice first."); setSaving(false); return; }
        const res = await apiFetch(routes.admin.ttsVoices.list(), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            provider: browseSel.provider,
            providerVoiceId: browseSel.providerVoiceId,
            ...payload,
          }),
        });
        if (!res.ok) {
          const body = await res.json().catch(() => null) as { error?: string } | null;
          throw new Error(body?.error ?? `HTTP ${res.status}`);
        }
        result = await res.json() as TtsVoiceRecord;
      }
      onSave(result);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }, [mode, voice, browseSel, name, description, speed, isDefault, onSave]);

  // Derived values for the configure step preview
  const configureVoiceId = mode === "edit" ? voice?.providerVoiceId : browseSel?.providerVoiceId;
  const configureProvider = mode === "edit" ? voice?.provider : browseSel?.provider;
  const configureSpeed = speed.trim() ? parseFloat(speed.trim()) : undefined;

  const voicesByProvider = BROADCAST_TTS_PROVIDERS.map((p) => ({
    provider: p,
    voices: providerVoices.filter((v) => v.provider === p),
  })).filter((g) => g.voices.length > 0);

  return (
    <Dialog
      open
      onClose={onClose}
      title={mode === "edit" ? "Edit voice" : step === "browse" ? "Add voice" : "Configure voice"}
      subtitle={
        mode === "edit"
          ? `${BROADCAST_TTS_PROVIDER_LABELS[voice!.provider]} · ${voice!.providerVoiceId}`
          : step === "configure" && browseSel
          ? `${BROADCAST_TTS_PROVIDER_LABELS[browseSel.provider]} · ${browseSel.providerVoiceId}`
          : "Select from the provider library"
      }
      width={540}
    >
      {step === "browse" ? (
        <>
          <DialogBody>
            {voicesLoading ? (
              <p style={{ color: C.stone, fontSize: 13 }}>Loading voices…</p>
            ) : voicesByProvider.length === 0 ? (
              <p style={{ color: C.stone, fontSize: 13 }}>
                No voices available — check that at least one TTS provider is configured.
              </p>
            ) : (
              <div>
                {voicesByProvider.map(({ provider, voices }) => {
                  const isExpanded = expandedProviders.has(provider);
                  return (
                    <div key={provider}>
                      <button
                        type="button"
                        onClick={() => toggleProvider(provider)}
                        style={{
                          display: "flex",
                          width: "100%",
                          boxSizing: "border-box",
                          alignItems: "center",
                          justifyContent: "space-between",
                          padding: "14px 22px",
                          background: "transparent",
                          border: "none",
                          borderBottom: `0.5px solid ${C.celadon}`,
                          cursor: "pointer",
                          fontFamily: "inherit",
                          fontSize: 12,
                          color: C.umber,
                          fontWeight: 500,
                        }}
                      >
                        <span>
                          {BROADCAST_TTS_PROVIDER_LABELS[provider]}
                          <span style={{ marginLeft: 6, color: C.stone, fontWeight: 400 }}>
                            · {voices.length}
                          </span>
                        </span>
                        <span style={{ color: C.stone, fontSize: 10 }}>
                          {isExpanded ? "–" : "+"}
                        </span>
                      </button>
                      {isExpanded ? (
                        <div style={{ background: `${C.celadon}22` }}>
                          {voices.map((v) => (
                            <VoiceRow
                              key={v.id}
                              voice={v}
                              selected={false}
                              onSelect={() => selectFromBrowse(v)}
                              onPreview={() => previewVoice(v.id, v.provider)}
                              previewLoading={previewLoadingId === v.id}
                              previewPlaying={previewPlayingId === v.id}
                            />
                          ))}
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            )}
          </DialogBody>
          <DialogFooter>
            <PillButton variant="ghost" onClick={onClose}>Cancel</PillButton>
          </DialogFooter>
        </>
      ) : (
        <>
          <DialogBody>
            <FieldError>{error}</FieldError>

            {configureVoiceId && configureProvider ? (
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  padding: "10px 14px",
                  borderRadius: 8,
                  border: `0.5px solid ${C.celadon}`,
                  marginBottom: 20,
                  background: `${C.celadon}22`,
                }}
              >
                <div>
                  <div style={{ fontSize: 12, fontWeight: 500, color: C.umber }}>
                    {mode === "edit" ? voice!.name : browseSel!.providerName}
                  </div>
                  <div style={{ fontSize: 11, color: C.stone, marginTop: 1 }}>
                    {BROADCAST_TTS_PROVIDER_LABELS[configureProvider]} · {configureVoiceId}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() =>
                    previewVoice(
                      configureVoiceId,
                      configureProvider,
                      !isNaN(configureSpeed!) ? configureSpeed : undefined,
                    )
                  }
                  style={{
                    fontFamily: "inherit",
                    fontSize: 10,
                    fontWeight: 500,
                    letterSpacing: "0.14em",
                    textTransform: "uppercase",
                    color: C.stone,
                    padding: "5px 10px",
                    border: `0.5px solid ${C.celadon}`,
                    borderRadius: 100,
                    background: "transparent",
                    cursor: "pointer",
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.color = C.umber;
                    e.currentTarget.style.borderColor = C.driftwood;
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.color = C.stone;
                    e.currentTarget.style.borderColor = C.celadon;
                  }}
                >
                  {previewLoadingId === configureVoiceId
                    ? "…"
                    : previewPlayingId === configureVoiceId
                    ? "Playing"
                    : "▶ Preview"}
                </button>
              </div>
            ) : null}

            <Field label="Display name">
              <TextInput
                placeholder="Booming British Narrator"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </Field>

            <Field label="Description" hint="Shown to writers in the voice picker.">
              <TextInput
                placeholder="Deep, authoritative, British"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </Field>

            <Field
              label="Speed"
              hint={
                configureProvider
                  ? `Multiplier applied at synthesis. 1.0 = native speed. Recommended range for ${BROADCAST_TTS_PROVIDER_LABELS[configureProvider]}: ${SPEED_HINTS[configureProvider]}.`
                  : "Multiplier applied at synthesis. 1.0 = native speed. Leave blank to use the provider default."
              }
            >
              <TextInput
                placeholder="1.0"
                inputMode="decimal"
                value={speed}
                onChange={(e) => setSpeed(e.target.value)}
                style={{ fontFamily: "ui-monospace, Menlo, monospace" }}
              />
            </Field>

            <label
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                cursor: "pointer",
                fontSize: 13,
                color: C.umber,
              }}
            >
              <input
                type="checkbox"
                checked={isDefault}
                onChange={(e) => setIsDefault(e.target.checked)}
                style={{ width: 14, height: 14, accentColor: C.forest }}
              />
              <span>
                Set as default voice
                <span style={{ display: "block", fontSize: 11, color: C.stone, marginTop: 1 }}>
                  Used when no voice has been selected for a broadcast.
                </span>
              </span>
            </label>
          </DialogBody>
          <DialogFooter>
            {mode === "edit" && onDelete ? (
              <PillButton
                variant="destructive"
                onClick={onDelete}
                disabled={saving}
                style={{ marginRight: "auto" }}
              >
                Delete
              </PillButton>
            ) : null}
            {mode === "add" ? (
              <PillButton variant="ghost" onClick={() => setStep("browse")} disabled={saving}>
                ← Back
              </PillButton>
            ) : (
              <PillButton variant="ghost" onClick={onClose} disabled={saving}>
                Cancel
              </PillButton>
            )}
            <PillButton variant="primary" onClick={save} disabled={saving}>
              {saving ? "Saving…" : mode === "edit" ? "Save changes" : "Add voice"}
            </PillButton>
          </DialogFooter>
        </>
      )}
    </Dialog>
  );
}
