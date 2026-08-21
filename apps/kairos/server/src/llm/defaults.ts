/**
 * Default LLM provider settings. Per-request / per-broadcast overrides
 * take precedence; these are only used when the caller has no opinion.
 */

export const DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-4-6";
export const DEFAULT_MAX_TOKENS = 1024;
export const DEFAULT_MAX_RETRIES = 5;

/**
 * Cheaper model for utility calls that don't need Sonnet quality —
 * running-summary updates, tagging, short classification. Haiku runs
 * at roughly 25% of Sonnet's input cost and 27% of output.
 */
export const UTILITY_ANTHROPIC_MODEL = "claude-haiku-4-5-20251001";
export const UTILITY_MAX_TOKENS = 512;

/**
 * Dedicated ceiling for multi-subject enrichment calls. The shared
 * UTILITY_MAX_TOKENS of 512 was sized for short summary/classification
 * payloads; enrichment services emit structured per-subject reports and
 * a single cycle can return 10+ subjects with multi-sentence readings.
 * At 512 the tool-call JSON truncated mid-stream and the SDK returned
 * an empty input object — silence that looked like the model declining
 * to emit but was really a token-budget overflow.
 */
export const ENRICHMENT_MAX_TOKENS = 4096;
