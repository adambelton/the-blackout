"use client";

import type { RadioSource } from "@blackout/shared";
import type { LatencySample } from "./types";
import { RadioSourcePanel } from "./RadioSourcePanel";

export function LeftColumn({
  availableSources,
  streamUrl,
  onStreamUrlChange,
  isListeningLocally,
  onStartListening,
  onStopListening,
  latencySamples,
}: {
  availableSources: RadioSource[];
  streamUrl: string;
  onStreamUrlChange: (v: string) => void;
  isListeningLocally: boolean;
  onStartListening: () => void;
  onStopListening: () => void;
  latencySamples: LatencySample[];
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <RadioSourcePanel
        availableSources={availableSources}
        streamUrl={streamUrl}
        onStreamUrlChange={onStreamUrlChange}
        isListeningLocally={isListeningLocally}
        onStartListening={onStartListening}
        onStopListening={onStopListening}
        latencySamples={latencySamples}
      />
    </div>
  );
}
