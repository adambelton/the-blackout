# Subject-time batching — design + status

*Status: cadence + phase-boundary triggers + consumer-prompt sequencing + drift instrumentation shipped. Empirical DELAY tuning awaits dashboard data from a few live broadcasts.*

*Vocabulary note: this doc was originally titled "Content-time batching" and is referenced as such in older audit / status writeups. The concept is *subject time* under the three-domain vocabulary formalised in `docs/vocabulary.md` § Time — the time of source material going IN to Kairos. The text below uses the new vocabulary; the code identifiers it references (`subjectTime`, `subjectOrdinalForEntry`, `delayMs`, etc.) still use legacy names and are renamed in a separate refactor pass.*

---

## The problem

Kairos batched on wall-clock intervals (30–45 seconds). Sources arrive with heterogeneous latencies relative to subject time (the match minute being commentated on):

- **Sportmonks events** — ~15–30 second delay from real subject time.
- **Distilled commentary** — Deepgram transcription carries 3–5 second ASR latency, but the audio stream itself is 20–40 seconds behind real subject time via HLS/DASH. The calibrated offset approximates subject time but drifts.
- **Pressure signals** — derived from Sportmonks trends, similar latency to events.
- **Moderator notes** — wall-clock arrival, describing events seen on a delayed stream.

The result: a single Kairos batch typically contained sources spanning 2–3 minutes of subject time, not a coherent 30–45 second subject-time window. Sources within a batch describing earlier events arrived after sources describing later events. Kairos's enrichment and curation treated each batch as a coherent temporal unit; the narrator wove together temporally incoherent material as though it were simultaneous.

The 2026-05-02 broadcast audit confirmed the magnitude: 18% of normal cycles spanned ≥2 subject minutes; 38% spanned more than one minute; the median match_action span within a cycle was 0–3 minutes. The dominant cause of "passages that feel slightly out of phase with the match."

---

## The shape of the solution (agreed)

**Responsibility split.** The Blackout owns subject-time *stamping* — every source entry carries an accurate `phase` + `phaseSecond` before it reaches Kairos. Kairos owns subject-time *batching* — the cadence trigger drains entries by subject ordinal, not arrival time.

**Waiting room model.** Entries arrive in an in-memory holding buffer keyed by subject ordinal. A flush trigger drains entries up to a boundary; the rest stay in the waiting room. Single-dispatch — entries leave the waiting room once drained, never re-read from the DB.

**DELAY trades narrative lag for completeness.** The cadence drain criterion is `ordinal ≤ (highest observed - DELAY_seconds)`. Entries arriving after their window has flushed are discarded with telemetry. Default DELAY = 60s — covers the long tail of source arrival latency with margin. Configurable per-pipeline so live tests can tune once the late-discard counter has data.

**Two clocks, two knobs.** `flushIntervalMs` (45s default) controls *cadence* — how often a flush is attempted. `delayMs` (60s default) controls *boundary lag* — how far behind the highest observed subject ordinal the drain criterion sits. Independent. Both static defaults today; design admits future per-broadcast tuning ("intense moments → shorter cycles") without changing the trigger surface.

**Phase-boundary triggers (planned).** When the consumer pushes a phase-transition entry (KICKOFF / HALFTIME / SECOND_HALF_KICKOFF / FULL_TIME), the pipeline schedules an early flush at `T_observed + delayMs (+15s of subject time for HALFTIME / FULL_TIME)`. The +15s extension captures reactive moments around the whistle ("and Salah drops to his knees") into the closing-of-prior-phase cycle rather than splitting them across the phase boundary. Cadence ticks during the wait window are deferred so the phase cycle dispatches as a single coherent unit. KICKOFF / SECOND_HALF_KICKOFF don't get the extension — pre-kickoff content is warming-lifecycle, not match-relevant. The conductor's existing `triggerExplicitGeneration` for HT/closing reflection runs after the phase flush completes, providing the empty-input reflective beat.

**Late-arrival policy: discard with telemetry.** Bias upward on uncertainty about DELAY — dropping a legitimate event costs a real moment for the listener; adding 15s of pipeline lag costs 15s of "behind the action," which the literary voice spec absorbs invisibly.

---

## What shipped

**Cadence trigger with subject-time drain** (`apps/kairos/server/src/pipeline/subject-time.ts`.ts`):
- Waiting room replaces the wall-clock buffer.
- `subjectOrdinalForEntry(entry)` extracts the subject ordinal from `(data.phase, data.phaseSecond)`. Renames to `subjectOrdinalForEntry`.
- Cadence flush drains entries with ordinal ≤ `highestObserved - delaySeconds`.
- Late arrivals discarded; `pipeline.getLateDiscardedCount()` exposes the counter.
- `delayMs` config knob (default 60_000) on `EnrichmentPipelineOptions`.
- Backwards compatible: null-ordinal entries (unstamped, ambient sources, test fixtures) pass through any cadence flush — they have no subject-time anchor to defer against.

**Phase-boundary trigger with the +15s extension** (`apps/kairos/server/src/pipeline/subject-time.ts::recognizePhaseTransition`, `apps/kairos/server/src/pipeline/pipeline.ts::schedulePhaseFlush`):
- A phase-transition entry (KICKOFF / HALFTIME / SECOND_HALF_KICKOFF / FULL_TIME) lands in the waiting room → schedules a one-shot flush at `T_observed + delayMs (+15s for HALFTIME / FULL_TIME)`.
- Cadence ticks during the wait window are deferred so one phase-flush absorbs the whole window into a single coherent cycle.
- HALFTIME / FULL_TIME extension catches reactive commentary around the whistle. KICKOFF / SECOND_HALF_KICKOFF don't extend (pre-kickoff is warming-lifecycle, post-kickoff lands in the new phase naturally).
- Override semantics: a second phase observation during a pending wait cancels the prior timer and reschedules — most recent boundary wins.
- The conductor's existing `triggerExplicitGeneration(HALFTIME_REFLECTION_PROMPT)` continues to fire for the reflective beat. The pipeline now defers the consumer-prompt cycle when a phase-flush is pending, so the closing cycle dispatches first and the reflection lands second. Most-recent-prompt-wins if multiple arrive during the wait window.

46 new Kairos tests pin the three halves of the subject-time contract — cadence + phase-boundary + consumer-prompt sequencing (197 → 243). Existing tests unchanged behaviour.

**Prerequisite that landed first — runner-restart canonical-ledger seed** (`apps/blackout/server/src/lib/canonical-ledger-seed.ts`, `apps/blackout/server/src/lib/broadcast-runner.ts`): without it, restart-hoover entries (60–90 minutes of historical events stamped with the *current* `phaseSecond` instead of their actual moment) would have been discarded as late on the new pipeline. The seed reseeds the runner's correlation ledger from existing Kairos entries on startup, eliminating the restart-hoover failure mode the audit surfaced as 24% of cycles.

**Calibration drift instrumentation** (`apps/blackout/server/src/lib/broadcast-runner.ts::emitCalibrationSample`): every successful claim↔canonical match emits a `calibration_sample` PostHog event carrying `rawDeltaSeconds` + `absDeltaSeconds` + `eventClass` + radio source. Aggregating across recent broadcasts gives the histogram needed to tune DELAY confidently — if 99th percentile is <40s we drop DELAY to 45s; if it's 60s we push to 75s. The 60s default stays in place pending the empirical signal.

---

## What's still open

**Per-broadcast / per-trigger DELAY tuning.** The design admits future tuning ("intense moments warrant shorter cycles") via a list of `FlushTrigger` predicates the pipeline evaluates. Today timer + phase. Adding entry-density or canonical-event-arrival triggers is cheap once the trigger surface is in place.

---

## Verified against codebase

The five "what needs validating" questions from the original problem doc:

1. **How does Kairos use `subjectTime`?** It's a first-class field on every entry — carrying subject time under the three-domain vocabulary (see `docs/vocabulary.md` § Time). The runner stamps `phase` + `phaseSecond` from its calibrated offset. The pipeline now reads them via `subjectOrdinalForEntry()` for the drain decision. ✓

2. **How are entries sorted within a batch?** Today: by waiting-room order (which is arrival order). The cycle's `entries` field hands them to enrichment + curation as-ordered. Services that care about temporal ordering can sort on the entry's subject time themselves; nothing in the pipeline currently re-sorts. The window-coherence guarantee is per-cycle, not per-entry-within-cycle.

3. **What does the flush trigger look like today?** Wall-clock timer (`setInterval` at `flushIntervalMs`), with a queued-tick mechanism so a tick during an in-flight flush isn't lost. Subject-time batching slotted into the existing trigger as a drain criterion change rather than a new trigger. ✓

4. **What is the calibration loop's current accuracy?** Not yet quantified. Today's data audit suggests it's good (median in-cycle commentary span = 0; max = 3 minutes), but the per-source histogram of arrival latency relative to stamped subject time hasn't been computed. The 60s default is comfortable margin; tuning awaits the histogram.

5. **Are there sources with no meaningful subject time?** Yes — moderator notes, ambient sources (voice/context), some test fixtures. Handled by the null-ordinal pass-through path: they drain on any cadence regardless of boundary. The Blackout's runner stamps `getSubjectTime(now - radio_offset)` on moderator notes, so in practice they DO have subject time in production; the pass-through is a safety net.
