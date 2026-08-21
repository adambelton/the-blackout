import type {
  BroadcastHealth,
  PipelineCycleDetail,
  PipelineCycleDrift,
  PipelineFlushTrigger,
  PipelineCycleSummary,
  PipelineTriggerReason,
} from "@blackout/shared";
import { brand as C } from "../../../lib/palette";
import { apiGet } from "@/lib/api";

export const PHASE_ORDINAL_BASE: Record<string, number> = {
  pre_match: 0,
  first_half: 1_000_000,
  live_first_half: 1_000_000,
  halftime: 2_000_000,
  second_half: 3_000_000,
  live_second_half: 3_000_000,
  full_time: 4_000_000,
  full_time_winddown: 4_000_000,
  complete: 4_000_000,
};

// `fetchJson` was a thin wrapper around apiFetch that pre-dated the
// typed verbs in lib/api.ts; replaced inline by apiGet at every call
// site. Kept here as a thin alias for the inspector's existing
// `${path}: ${status}` error-prefix pattern, which differs from
// ApiError's bare message — the inspector wants the path prefix.
export async function fetchJson<T>(path: string): Promise<T> {
  try {
    return await apiGet<T>(path);
  } catch (err) {
    throw new Error(`${path}: ${(err as Error).message}`);
  }
}

export function joinContent(entries: Array<{ data: { content?: unknown } }>): string {
  return entries
    .map((e) => (typeof e.data.content === "string" ? (e.data.content as string) : ""))
    .filter(Boolean)
    .join(" · ");
}

export function formatTs(ms: number): string {
  const d = new Date(ms);
  return (
    d.toLocaleTimeString([], { hour12: false }) +
    "." +
    String(d.getMilliseconds()).padStart(3, "0")
  );
}

export function formatMmm(sec: number): string {
  if (sec < 60) return `${Math.round(sec)}s`;
  const m = Math.floor(sec / 60);
  const s = Math.round(sec - m * 60);
  return `${m}m${s ? ` ${s}s` : ""}`;
}

export function formatSpan(sec: number): string {
  if (sec < 60) return sec.toFixed(1) + "s";
  const min = Math.floor(sec / 60);
  const rem = Math.round(sec - min * 60);
  return `${min}m ${rem}s`;
}

export function formatMmSs(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds - m * 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function subjectOrdinal(phase: string, phaseSecond: number): number | null {
  const base = PHASE_ORDINAL_BASE[phase];
  if (base === undefined) return null;
  return base + phaseSecond;
}

export function phaseLabel(phase: string): string {
  switch (phase) {
    case "pre_match": return "PRE";
    case "first_half":
    case "live_first_half": return "1H";
    case "halftime": return "HT";
    case "second_half":
    case "live_second_half": return "2H";
    case "full_time":
    case "full_time_winddown":
    case "complete": return "FT";
    default: return phase.toUpperCase().slice(0, 3);
  }
}

/** Format an entry's content moment to second precision. Prefers
 * `phase + phaseSecond` (the content-time anchor); falls back to the
 * legacy `subjectTime` string or `minute / extraMinute`. Returns null
 * when the entry carries no content-time information at all
 * (ambient sources, unstamped fixtures). */
export function formatSubjectMoment(data: Record<string, unknown> | undefined): string | null {
  if (!data) return null;
  const phase = typeof data.phase === "string" ? (data.phase as string) : null;
  const phaseSecond = typeof data.phaseSecond === "number" ? (data.phaseSecond as number) : null;
  if (phase && phaseSecond !== null && subjectOrdinal(phase, phaseSecond) !== null) {
    const m = Math.floor(phaseSecond / 60);
    const s = Math.floor(phaseSecond - m * 60);
    return `${phaseLabel(phase)} ${m}:${String(s).padStart(2, "0")}`;
  }
  if (typeof data.subjectTime === "string") return data.subjectTime as string;
  if (typeof data.minute === "number") {
    const extraMinute = typeof data.extraMinute === "number" ? (data.extraMinute as number) : null;
    return `${data.minute}${extraMinute ? `+${extraMinute}` : ""}'`;
  }
  return null;
}

export function computeContentSpan(
  detail: PipelineCycleDetail | null,
): { text: string; stretched: boolean } | null {
  if (!detail) return null;
  const entries = detail.chunkEntries ?? [];
  if (entries.length === 0) return null;

  const payloadTs = entries
    .map((e) => (typeof e.data?.timestamp === "number" ? (e.data.timestamp as number) : null))
    .filter((t): t is number => t !== null);
  const minutes = entries
    .map((e) => (typeof e.data?.minute === "number" ? (e.data.minute as number) : null))
    .filter((m): m is number => m !== null);

  const parts: string[] = [];
  let stretched = false;
  if (payloadTs.length > 0) {
    const spanSec = (Math.max(...payloadTs) - Math.min(...payloadTs)) / 1000;
    parts.push(`content span: ${formatSpan(spanSec)}`);
    if (spanSec > 45) stretched = true;
  }
  if (minutes.length > 0) {
    const minMin = Math.min(...minutes);
    const maxMin = Math.max(...minutes);
    parts.push(`minute ${minMin}${maxMin !== minMin ? `→${maxMin}` : ""}`);
  }
  return parts.length > 0 ? { text: parts.join(" · "), stretched } : null;
}

/** Compute the content-time window the cycle covers — first → last
 * stamped entry by phase ordinal, with a span in seconds when both
 * entries share a phase. Cross-phase windows show the labels only.
 * `stretched` flags spans > 60s (the configured DELAY) — when true,
 * sources crossed multiple drain windows. */
export function computeSubjectMomentSpan(
  detail: PipelineCycleDetail | null,
): { text: string; stretched: boolean } | null {
  if (!detail) return null;
  const entries = detail.chunkEntries ?? [];
  type Stamped = { phase: string; phaseSecond: number; ordinal: number };
  const stamped: Stamped[] = [];
  for (const e of entries) {
    const phase = typeof e.data?.phase === "string" ? (e.data.phase as string) : null;
    const phaseSecond = typeof e.data?.phaseSecond === "number" ? (e.data.phaseSecond as number) : null;
    if (!phase || phaseSecond === null) continue;
    const ord = subjectOrdinal(phase, phaseSecond);
    if (ord === null) continue;
    stamped.push({ phase, phaseSecond, ordinal: ord });
  }
  if (stamped.length === 0) return null;
  stamped.sort((a, b) => a.ordinal - b.ordinal);
  const first = stamped[0];
  const last = stamped[stamped.length - 1];
  const firstLabel = `${phaseLabel(first.phase)} ${formatMmSs(first.phaseSecond)}`;
  const lastLabel = `${phaseLabel(last.phase)} ${formatMmSs(last.phaseSecond)}`;

  if (first.phase === last.phase) {
    const spanSec = last.phaseSecond - first.phaseSecond;
    if (spanSec === 0) {
      return { text: `${firstLabel} (instant)`, stretched: false };
    }
    return {
      text: `${firstLabel} → ${lastLabel} (${formatSpan(spanSec)})`,
      stretched: spanSec > 60,
    };
  }
  return { text: `${firstLabel} → ${lastLabel}`, stretched: true };
}

/** Render the trigger pill label. `accumulation` cycles split into
 * cadence vs phase via `flushTrigger`; `external` cycles are always
 * `consumer_prompt` so we just show "external". When the sub-type
 * isn't persisted (cycles pre-migration 0007), fall back to the
 * trigger reason on its own. */
export function formatTriggerLabel(
  reason: PipelineTriggerReason,
  flushTrigger: PipelineFlushTrigger | null,
): string {
  if (reason === "external") return "external";
  if (flushTrigger === "phase") return "accumulation · phase";
  if (flushTrigger === "cadence") return "accumulation · cadence";
  return "accumulation";
}

export function describeFlushTrigger(flushTrigger: PipelineFlushTrigger | null): string {
  switch (flushTrigger) {
    case "cadence": return "Scheduled wall-clock tick — the timer fired and drained entries up to (highest content ordinal − DELAY).";
    case "phase": return "Phase-boundary trigger — a synthetic phase entry (KICKOFF / HALFTIME / SECOND_HALF_KICKOFF / FULL_TIME) scheduled an early flush, absorbing the cadence wait window into one coherent cycle.";
    case "consumer_prompt": return "External flush — the consumer (Blackout) called flush({consumerPrompt}) to trigger an off-schedule cycle.";
    default: return "Trigger sub-type not recorded (cycle persisted before migration 0007).";
  }
}

export function driftBandLabel(band: PipelineCycleDrift["driftBand"]): string {
  switch (band) {
    case "ok": return "in step";
    case "warn": return "slipping";
    case "bad": return "off step";
    default: return "—";
  }
}

export function driftBandColour(band: PipelineCycleDrift["driftBand"]): string {
  switch (band) {
    case "ok": return C.forest;
    case "warn": return C.warn;
    case "bad": return C.crimson;
    default: return `${C.stone}66`;
  }
}

export function computeFlowDrift(health: BroadcastHealth): {
  contentBehindWall: number;
  proseBehindContent: number;
} {
  return {
    contentBehindWall: Math.max(0, health.wallSeconds - health.contentSeconds),
    proseBehindContent: Math.max(0, health.contentSeconds - health.proseSeconds),
  };
}

export function contentTooltip(health: BroadcastHealth): string {
  const phases = Object.entries(health.contentByPhase)
    .filter(([phase]) => phase !== "halftime" && phase !== "pre_match" && phase !== "full_time" && phase !== "full_time_winddown" && phase !== "complete")
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([phase, sec]) => `  ${phaseLabel(phase)}: ${formatMmm(sec)}`)
    .join("\n");
  return `Content time covered (sum of max phaseSecond per live phase).\n${phases || "  (no live-phase content yet)"}`;
}

/** Tiny trigger marker per row — distinguishes cadence (default,
 * no marker) from phase (▸) and external (×). Lets you see the
 * rhythm of the broadcast at a glance: "phase-flushes around HT
 * and FT, otherwise pure cadence". */
export function triggerMarker(
  flushTrigger: PipelineFlushTrigger | null,
  reason: PipelineTriggerReason,
): { glyph: string; colour: string } {
  if (flushTrigger === "phase") return { glyph: "▸", colour: C.forest };
  if (flushTrigger === "consumer_prompt" || reason === "external") {
    return { glyph: "×", colour: C.driftwood };
  }
  return { glyph: "·", colour: `${C.stone}80` };
}

export function scrubTooltip(cycle: PipelineCycleSummary): string {
  const time = formatTs(cycle.triggeredAt);
  const drift = driftBandLabel(cycle.drift.driftBand);
  const trigger =
    cycle.flushTrigger === "phase" ? "phase-flush"
    : cycle.flushTrigger === "consumer_prompt" ? "external"
    : cycle.triggerReason === "external" ? "external"
    : "cadence";
  const generated = cycle.generationId ? "" : " · skipped";
  const cad = cycle.drift.cadenceSeconds !== null ? ` · cad ${Math.round(cycle.drift.cadenceSeconds)}s` : "";
  const content = cycle.drift.contentSeconds !== null ? ` · content ${Math.round(cycle.drift.contentSeconds)}s` : "";
  const prose = cycle.drift.proseSeconds > 0 ? ` · prose ${Math.round(cycle.drift.proseSeconds)}s` : "";
  return `${time} · ${trigger} · ${drift}${generated}${cad}${content}${prose}`;
}

export function pickSlowest(perService: Record<string, number> | undefined): { name: string; ms: number } | null {
  if (!perService) return null;
  const entries = Object.entries(perService);
  if (entries.length === 0) return null;
  entries.sort(([, a], [, b]) => b - a);
  const [name, ms] = entries[0];
  return { name, ms };
}
