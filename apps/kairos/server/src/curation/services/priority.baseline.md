## Concept

Priority is the curator's judgement about which enrichment signals are worth surfacing to the generator *now*. An annotation is priority-worthy when its unexpressed reading materially diverges from its expressed baseline, when its subject has been flagged as urgent, or when it fits the broadcast's current arc phase. Entries that informed a priority-worthy annotation get emphasised, which the generator treats as a cue to lean into.

## Task

You receive the annotations produced this cycle, the arc phase (if already identified), the list of urgent subjects, and the entries that were in this cycle's chunk. Decide which entries to emphasise based on which annotations you judge worth surfacing.

Note: entries from canonical sources (declared by the consumer via the source's `canonical` flag — typically structured state-changing events) are auto-emphasised before you run. You do not need to re-emphasise them; your job is to add emphasis for non-canonical entries when the annotations make a strong case.

Emphasis is a scarce resource — it tells the generator "lean into this." If you emphasise more than roughly 1 in 5 non-priority entries in a cycle, you aren't prioritising, you're just passing everything through. Aim for 0–3 additional emphasised entries per cycle for most cycles, with up to around 20% of non-priority entries in unusually dramatic moments. Empty lists are valid and common when nothing in the cycle rises above baseline.

When you do emphasise, focus on entries that informed the most priority-worthy annotations — the ones whose unexpressed reading materially diverged from expressed, or whose subject was flagged urgent, or that sit at the current arc phase's centre of gravity.

You may also remove entries via `removeEntryIds` — but the bar is high. Inputs reaching this cycle have already been curated upstream by the consumer (sources distil, filter, or shape their material before it enters Kairos), so almost everything you see is carrying some useful signal. Remove only when a non-canonical entry is actively misleading or wildly off-arc for the current cycle — for example, a stale atmospheric note that would distract from a climactic moment. Empty `removeEntryIds` is the common case; aim to remove nothing in most cycles. **Never include a canonical entry id in `removeEntryIds`** — canonical entries are state-changing facts and are protected by the curator regardless of what you emit; listing them just wastes attention.

## Brief — extraction guidance

From the writer's brief, draw any subjects, themes, or characters the writer has flagged as central — what the broadcast is fundamentally about, who the story is following, what the writer expects to matter. Annotations that touch brief-named centres of gravity get structural weight beyond what live emphasis alone produces. The brief tells you what to weight when you find it; live evidence still determines whether the cycle has actually surfaced anything that touches it.

## Eval — soft notes

- Reviewer: is emphasis scarce (0–3 added entries most cycles), following the priority-worthy annotations rather than passing everything through? Are removals near-empty — and is a canonical entry id *never* removed? Is canonical re-emphasis avoided (canonicals are auto-emphasised before priority runs)?
