/**
 * Audio→canonical effective-offset state helpers.
 *
 * The "offset" is how many seconds we subtract from an audio LINE's
 * wall-clock to recover the real match moment the audio is describing.
 * Seeded per-radio-source from `defaultOffsetSeconds`; refined during
 * a broadcast by the calibration loop in `broadcast-runner.ts` —
 * each event_claim that matches a Sportmonks canonical produces a
 * `rawDeltaSeconds` (`canonical_wall_clock − claim_observedAtMs`),
 * which feeds this helper to nudge the offset closer to its true
 * value for this stream.
 *
 * Lives in its own file so the unit tests can import the formula
 * without dragging in the runner's DB / Kairos / conductor graph.
 */

/** EWMA weight applied to each calibration sample. New observations
 * pull the effective offset by `α × Δ`; α=0.3 means roughly the most
 * recent 5–7 samples dominate. Tune by watching offset stability over
 * a broadcast — too high and one outlier shifts the offset visibly,
 * too low and convergence lags real changes in the radio's delay. */
export const OFFSET_EWMA_ALPHA = 0.3;

/** Sane bounds on the effective audio→canonical offset. The radio's
 * broadcast delay is positive (audio is behind real time) and bounded
 * below ~2 minutes for any realistic stream. Clamping protects against
 * a pathological calibration sample (e.g. a misclassified claim that
 * matches the wrong canonical event) shifting the offset out of band. */
export const OFFSET_MIN_SECONDS = 0;
export const OFFSET_MAX_SECONDS = 120;

/** Pure update for the effective audio→canonical offset given a new
 * calibration sample. Δ > 0 means canonical arrived after the claim
 * (offset too large — shrink); Δ < 0 means canonical arrived before
 * (offset too small — grow). Result clamped to
 * `[OFFSET_MIN_SECONDS, OFFSET_MAX_SECONDS]`.
 *
 * Single canonical update — anything that mutates the effective offset
 * must go through this function. The dead-loop bug (calibration
 * samples recorded but never read) was structurally possible because
 * the read side and write side weren't tied together; routing all
 * mutations through this helper makes the next regression noisy. */
export function applyCalibrationSample(
  currentOffsetSeconds: number,
  rawDeltaSeconds: number,
): number {
  return Math.max(
    OFFSET_MIN_SECONDS,
    Math.min(
      OFFSET_MAX_SECONDS,
      currentOffsetSeconds - OFFSET_EWMA_ALPHA * rawDeltaSeconds,
    ),
  );
}
