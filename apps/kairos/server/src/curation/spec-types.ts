/**
 * Per-event-profile spec shape for the curation-service surface.
 *
 * The engine carries each curation service's profile-agnostic
 * *baseline* prompt in code (a `<service>.baseline.md` next to the
 * service class — lifted per service across K6.3). The DB carries
 * per-profile *profile content* — sport-flavoured elaborations,
 * the way each service's judgement applies to a particular
 * consumer's category. Assembly interleaves the two via matching
 * `## Section` headers, identical to the K6.2 narrative-path
 * pattern.
 *
 * Single string by design — uniform with `GenerationSpecContent` /
 * `ImagerySpecContent` / `SummarySpecContent` /
 * `EnrichmentSpecContent`. Editorial workflow is one document per
 * service per profile, not N fields.
 *
 * See `docs/prompts-as-content-design.md`.
 */
export interface CurationSpecContent {
  /**
   * Section-by-section elaborations on the curation service's
   * baseline instructions. Section headers (`## Foo`) MUST match
   * the baseline's section headers so the assembly walks them in
   * lockstep.
   */
  serviceInstructions: string;
}
