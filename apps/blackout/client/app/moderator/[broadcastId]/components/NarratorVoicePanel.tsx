"use client";

import { useEffect, useMemo, useRef } from "react";
import { brand as C } from "../../../lib/palette";
import { Dialog } from "../../../components/Dialog";
import {
  BROADCAST_TTS_PROVIDERS,
  BROADCAST_TTS_PROVIDER_LABELS,
} from "@blackout/shared";
import type { BroadcastTtsProvider } from "@blackout/shared";
import { Panel } from "../../../components/Panel";
import type { TtsVoice } from "./types";
import { Toggle } from "./Toggle";
import { VoiceCard } from "./VoiceCard";
import { VoiceRow } from "./VoiceRow";

export function NarratorVoicePanel({
  voices,
  selectedVoiceId,
  selectedVoiceName,
  selectedProvider,
  onSelectVoice,
  voicePickerOpen,
  onOpenVoicePicker,
  onCloseVoicePicker,
  expandedProviders,
  onToggleProviderExpanded,
  previewLoadingId,
  previewPlayingId,
  onPreviewVoice,
  ttsEnabled,
  onTtsEnabledChange,
  consoleAutoplay,
  onConsoleAutoplayChange,
}: {
  voices: TtsVoice[];
  selectedVoiceId: string;
  selectedVoiceName: string;
  selectedProvider: BroadcastTtsProvider;
  onSelectVoice: (id: string, name: string, provider: BroadcastTtsProvider) => void;
  voicePickerOpen: boolean;
  onOpenVoicePicker: () => void;
  onCloseVoicePicker: () => void;
  expandedProviders: Set<BroadcastTtsProvider>;
  onToggleProviderExpanded: (p: BroadcastTtsProvider) => void;
  previewLoadingId: string | null;
  previewPlayingId: string | null;
  onPreviewVoice: (voiceId: string, provider: BroadcastTtsProvider) => void;
  ttsEnabled: boolean;
  onTtsEnabledChange: (v: boolean) => Promise<void> | void;
  consoleAutoplay: boolean;
  onConsoleAutoplayChange: (v: boolean) => void;
}) {
  const selected = voices.find((v) => v.id === selectedVoiceId);
  const selectedRowRef = useRef<HTMLDivElement | null>(null);

  // When TTS flips off, force-close the picker so we don't leave stale
  // expanded state behind a dimmed surface.
  useEffect(() => {
    if (!ttsEnabled && voicePickerOpen) onCloseVoicePicker();
  }, [ttsEnabled, voicePickerOpen, onCloseVoicePicker]);

  // When the picker opens, scroll the selected voice into view. The
  // dialog's open-state gating ensures the provider containing the
  // selected voice is already expanded (see openVoicePicker in the
  // main component), so the row is mounted by the time this runs.
  // `requestAnimationFrame` lets the browser complete layout first —
  // without it, the scroll fires against pre-layout positions and
  // lands at the top.
  useEffect(() => {
    if (!voicePickerOpen) return;
    const id = requestAnimationFrame(() => {
      selectedRowRef.current?.scrollIntoView({ block: "center" });
    });
    return () => cancelAnimationFrame(id);
  }, [voicePickerOpen]);

  const voicesByProvider = useMemo(() => {
    const map = new Map<BroadcastTtsProvider, TtsVoice[]>();
    for (const v of voices) {
      const bucket = map.get(v.provider) ?? [];
      bucket.push(v);
      map.set(v.provider, bucket);
    }
    return map;
  }, [voices]);

  return (
    <Panel label="Narrator voice" meta={selectedVoiceId ? BROADCAST_TTS_PROVIDER_LABELS[selectedProvider] : undefined}>
      <div
        style={{
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "space-between",
          gap: 10,
          marginBottom: 14,
          padding: "10px 12px",
          borderRadius: 8,
          background: ttsEnabled ? `${C.forest}0C` : `${C.celadon}59`,
          border: `0.5px solid ${ttsEnabled ? `${C.forest}40` : C.celadon}`,
        }}
      >
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              fontSize: 12,
              fontWeight: 500,
              color: ttsEnabled ? C.forest : C.umber,
            }}
          >
            Pipeline TTS · {ttsEnabled ? "ON" : "OFF"}
          </div>
          <div style={{ fontSize: 11, color: C.stone, marginTop: 2, lineHeight: 1.45 }}>
            Kill switch for every audio surface — matchroom tune-in, moderator
            auto-play, voice previews. Off during narrative-quality testing to
            avoid synthesis cost.
          </div>
        </div>
        <Toggle value={ttsEnabled} onChange={(v) => void onTtsEnabledChange(v)} />
      </div>

      <VoiceCard
        name={selected?.name || selectedVoiceName || selectedVoiceId || "—"}
        description={selected?.description ?? null}
        provider={selectedVoiceId ? selectedProvider : undefined}
        expanded={voicePickerOpen}
        disabled={!ttsEnabled}
        previewDisabled={!ttsEnabled || !selectedVoiceId}
        onToggle={voicePickerOpen ? onCloseVoicePicker : onOpenVoicePicker}
        onPreview={() => onPreviewVoice(selectedVoiceId, selectedProvider)}
        previewLoading={previewLoadingId === selectedVoiceId}
        previewPlaying={previewPlayingId === selectedVoiceId}
      />

      <Dialog
        open={voicePickerOpen && ttsEnabled}
        onClose={onCloseVoicePicker}
        title="Select a voice"
        subtitle={selectedVoiceId ? `Current: ${selectedVoiceName || selectedVoiceId} · ${BROADCAST_TTS_PROVIDER_LABELS[selectedProvider]}` : "No voice selected"}
        width={520}
      >
        <div>
          {BROADCAST_TTS_PROVIDERS.map((provider) => {
            const providerVoices = voicesByProvider.get(provider) ?? [];
            if (providerVoices.length === 0) return null;
            const isExpanded = expandedProviders.has(provider);
            return (
              <div key={provider}>
                <button
                  type="button"
                  onClick={() => onToggleProviderExpanded(provider)}
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
                      · {providerVoices.length}
                    </span>
                  </span>
                  <span style={{ color: C.stone, fontSize: 10 }}>{isExpanded ? "–" : "+"}</span>
                </button>
                {isExpanded ? (
                  <div style={{ background: `${C.celadon}22` }}>
                    {providerVoices.map((v) => (
                      <VoiceRow
                        key={v.id}
                        voice={v}
                        selected={v.id === selectedVoiceId}
                        rowRef={v.id === selectedVoiceId ? selectedRowRef : undefined}
                        onSelect={() => onSelectVoice(v.id, v.name, v.provider)}
                        onPreview={() => onPreviewVoice(v.id, v.provider)}
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
      </Dialog>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginTop: 14,
          paddingTop: 14,
          borderTop: `0.5px solid ${C.celadon}`,
          fontSize: 12,
          color: ttsEnabled ? C.umber : C.stone,
          opacity: ttsEnabled ? 1 : 0.6,
        }}
      >
        <div>
          Autoplay in this console
          <div style={{ fontSize: 11, color: C.stone, marginTop: 2 }}>
            {ttsEnabled
              ? "Only affects this browser — matchroom audio is independent."
              : "Disabled while pipeline TTS is off."}
          </div>
        </div>
        <Toggle
          value={consoleAutoplay && ttsEnabled}
          onChange={(v) => {
            if (!ttsEnabled) return;
            onConsoleAutoplayChange(v);
          }}
        />
      </div>
    </Panel>
  );
}
