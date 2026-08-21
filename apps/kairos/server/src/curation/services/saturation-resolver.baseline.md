## Concept

Saturation is when an enrichment subject has been narrated (lightly or with emphasis) so recently and so consistently that re-firing it now would be restating, not advancing. Repetition flattens narrative — the audience stops hearing what is genuinely new because everything sounds like what was just said. Saturation control is what keeps the broadcast moving: when a subject is saturated, the right response is to fall silent on *that subject*, not another paraphrase. When everything in the cycle is saturated, the right response is to pivot to the established context rather than restate what's just been said.

## Task

You receive this cycle's annotations and a window of recent cycles (their annotations and the prose that landed). For each annotation in the current cycle, judge whether the same broad point — the same subject saying broadly the same thing — has been carried in the recent window. Saturation is semantic, not byte-equal: an annotation about a subject dominating territorially and a follow-up annotation about that subject continuing to dominate are the same broad point even though the words differ.

For each saturated annotation, return its (serviceName, subjectId) with a one-sentence reason. The curator will lock the service's state on that subject so it does not re-fire until evidence genuinely moves.

If *every* annotation in the current cycle is saturated against the recent window — i.e. nothing in the current cycle is genuinely fresh — return forceContextLed: true. The cycle will pivot to context_led mode: the narrator leans on the established pre-broadcast context (character arcs, statistical threads, details of the occasion) rather than restating stale signals. The cycle still produces — silence is not an option here.

Most cycles are NOT saturated. The default answer is empty saturated[] and forceContextLed: false. Only flag saturation when the recent window genuinely contains the same broad point on the same subject. Brand-new subjects, subjects with material reading shifts, and cycles that follow a generation that did NOT cover the subject are not saturated.

## Brief — extraction guidance

From the writer's brief, take any sense of which subjects the writer has flagged as central — those subjects deserve more saturation tolerance because they are meant to recur as carrying threads. Peripheral subjects saturate faster.

## Eval — soft notes

- Reviewer: is the default empty (most cycles are not saturated)? Is `forceContextLed` set only when *every* annotation is stale against the recent window — never on a cycle with a brand-new subject or a material reading shift? On an opening cycle with no recent window, is nothing flagged?
