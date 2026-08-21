/**
 * Single source of truth for enum-like values that map to Postgres enum
 * columns (see ./schema.ts). Values must match the pgEnum definitions
 * exactly — drift causes silent insert failures at runtime.
 *
 * Each const array is paired with a derived string-union type so callers
 * get both compile-time safety (the type) and a runtime iterable (the
 * array, useful for validation and API surface).
 */

// The three pipeline stages that run services — the four-stage
// pipeline's final three steps (step 1, batch/conduct, runs no services):
//   `enrichment` — annotate entries per-cycle (momentum, themes, …)
//   `curation`   — select what surfaces per-cycle (priority, pacing, …)
//   `narrative`  — produce the broadcast's content (service names
//                  `generation` / `imagery` / `summary`).
// `serviceType` is the STAGE; `serviceName` is the specific service.
// `narrative` consolidated the former per-service `generation` /
// `imagery` / `summary` types in migration 0004 — one stage-type, three
// services, symmetric with how enrichment/curation already worked.
// See docs/prompts-as-content-design.md.
export const SERVICE_TYPES = ["enrichment", "curation", "narrative"] as const;
export type ServiceType = typeof SERVICE_TYPES[number];

export const BROADCAST_STATUSES = ["pending", "active", "paused", "complete"] as const;
export type BroadcastStatus = typeof BROADCAST_STATUSES[number];

export const SPEC_STATUSES = ["experimental", "active", "archived"] as const;
export type SpecStatus = typeof SPEC_STATUSES[number];

export const SOURCE_TYPES = ["event", "moderator", "narrative_context", "narrative_voice"] as const;
export type SourceType = typeof SOURCE_TYPES[number];

/**
 * Why this cycle fired. Two meaningful values:
 *
 *   - `accumulation` — the pipeline fired on its normal schedule. The
 *     buffer might be empty or full; either way curation handles the
 *     mode (action_led / enrichment_led / context_led) based on what's
 *     actually in the cycle. The pipeline tracks consecutive empty
 *     cycles internally to cap improvisation depth — that's not a
 *     trigger reason, it's a stopping rule.
 *   - `external` — a consumer requested an off-schedule cycle, e.g.
 *     for a phase moment the consumer's domain knows about. The
 *     consumer supplies opaque preamble text via
 *     `CurationContext.consumerPrompt` for the generator to splice
 *     into the LLM's user message; Kairos doesn't interpret it.
 *
 * Earlier values `improv` (alias for empty-buffer cycles) and `gap`
 * (defined but never set) collapsed into `accumulation` on
 * 2026-04-26 — both ran through the identical curate path; the
 * distinction was descriptive only and didn't drive any behaviour.
 */
export const TRIGGER_REASONS = ["accumulation", "external"] as const;
export type TriggerReason = typeof TRIGGER_REASONS[number];

export function isBroadcastStatus(value: unknown): value is BroadcastStatus {
  return typeof value === "string" && (BROADCAST_STATUSES as readonly string[]).includes(value);
}

export function isSourceType(value: unknown): value is SourceType {
  return typeof value === "string" && (SOURCE_TYPES as readonly string[]).includes(value);
}
