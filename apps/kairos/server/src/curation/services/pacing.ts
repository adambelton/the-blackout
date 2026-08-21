import type { EnrichedPayload, ServiceSpec } from "../../enrichment/types.js";
import type { LLMClient } from "../../llm/types.js";
import type { CurationService, CurationContext } from "../types.js";

/**
 * Pacing — deterministic compute, not a judgement call.
 *
 * Word count is a function of three knowns: the consumer's measured
 * TTS words-per-minute, the pipeline's cycle interval (the window the
 * narrator's audio has to fill before the next passage arrives), and a
 * small arc-phase modifier that lets climax breathe denser and quiet
 * stretches breathe lighter.
 *
 *     words = (wpm / 60) * (cycleMs / 1000) * phaseModifier
 *
 * Replacing the previous LLM-judged version (Haiku call, ~1.5s of cycle
 * latency) with arithmetic both removes a cost-per-cycle and fixes a
 * structural bug where the prompt's hardcoded 30-second cycle was out
 * of sync with the actual 45-second flush interval — narrations
 * underfilled the window and inter-passage gaps appeared. The formula
 * always tracks the actual cadence the curator is running at.
 *
 * The `LLMClient` constructor argument is preserved so the service
 * registry's `(spec, llm) => new PacingService(spec, llm)` factory keeps
 * working without a registry change. The client is unused.
 */

/** Multiplier applied to the base `wpm × cycleMs` calculation per arc
 * phase. Climax leans denser (the audience is leaning in); openings
 * and resolutions get a touch of breathing room. Other shapes
 * (rising / falling) sit at 1.0 — natural cadence. */
const PHASE_MODIFIERS: Record<string, number> = {
  opening: 0.85,
  rising: 1.0,
  climax: 1.2,
  falling: 1.0,
  resolution: 0.85,
};

/** Default wpm before the consumer has reported a single signal.
 * Sized for the Hume / ElevenLabs / OpenAI band that drives the
 * default broadcast voice. After the first `recordPacingSignal`, the
 * EMA in `BroadcastStateTracker` takes over. */
const FALLBACK_WPM = 150;

/** Safety bounds. The math should land in 80–280w on realistic inputs;
 * these clamp pathological cases (consumer reports a stuck wpm, an
 * unmodelled arc phase string drives modifier into the void). */
const MIN_WORDS = 60;
const MAX_WORDS = 380;

export class PacingService implements CurationService {
  readonly name = "pacing";

  constructor(readonly spec: ServiceSpec, _llm: LLMClient) {
    void _llm;
  }

  async curate(_payload: EnrichedPayload, prior: CurationContext): Promise<CurationContext> {
    void _payload;

    const wpm = prior.estimatedWpm ?? FALLBACK_WPM;
    const cycleMs = prior.cycleIntervalMs;
    const arcPhase = prior.arcPhase;
    const modifier = arcPhase != null ? PHASE_MODIFIERS[arcPhase] ?? 1.0 : 1.0;

    const baseWords = (wpm / 60) * (cycleMs / 1000) * modifier;
    const recommendedWordCount = Math.max(
      MIN_WORDS,
      Math.min(MAX_WORDS, Math.round(baseWords)),
    );

    const wpmSource = prior.estimatedWpm == null ? "fallback" : "measured";
    const phaseLabel = arcPhase ?? "default";
    const rationale = `wpm=${Math.round(wpm)}(${wpmSource}) × ${cycleMs / 1000}s × ${phaseLabel}(${modifier.toFixed(2)}) → ${recommendedWordCount}w`;

    return {
      ...prior,
      pacing: {
        recommendedWordCount,
        cadenceMs: cycleMs,
      },
      decisions: {
        ...prior.decisions,
        [this.name]: {
          serviceName: this.name,
          action: `${recommendedWordCount}w / ${cycleMs}ms`,
          entriesRemoved: [],
          entriesEmphasized: [],
          meta: { rationale, wpm, cycleMs, modifier, arcPhase: arcPhase ?? null },
        },
      },
    };
  }

  isReady(): boolean { return true; }
  reset(): void {}
}
