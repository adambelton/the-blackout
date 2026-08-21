# llm/ — the provider-neutral LLM contract

Kairos speaks one internal shape — `LLMRequest` / `LLMResponse` — and provider-specific translation lives behind a single `LLMClient` interface. Every LLM call in the engine (the generator's Sonnet call, the enrichment/curation Haiku calls, the imagery and summary Haiku calls) goes through a client constructed once per broadcast runtime and threaded down. Swapping providers, or stubbing for tests, is a constructor change — nothing else moves.

## What's here

- **`types.ts`** — the contract. `LLMClient { generate(LLMRequest): Promise<LLMResponse> }`. `LLMRequest` = `{ system?: string | SystemSegment[], messages: LLMMessage[], maxTokens?, model?, tools?: ToolDefinition[], toolChoice?, cacheTools? }`. `SystemSegment` = `{ text, cache? }` — `cache: true` asks the provider to cache everything up to and including that segment (Anthropic's ephemeral cache: ~90% off reads, ~25% premium on writes; the stable voice/context/task block pays back from cycle 2). `ToolChoice` = `auto | any | { tool, name }`. `LLMResponse` = `{ text, usage?: { inputTokens, outputTokens, cacheCreationInputTokens?, cacheReadInputTokens? }, toolCalls?: { name, input }[] }`. `LLMRateLimitError` — the provider-neutral 429 wrapper, carrying `retryAfterMs | null`; the narrative engine catches *this* (→ `generation_skipped`); other errors propagate.
- **`anthropic.ts`** — `AnthropicLLMClient` (the only real implementation): wraps `@anthropic-ai/sdk`, translates the neutral shape (`SystemSegment[]` → text blocks with `cache_control: ephemeral` markers; tools → marks the *last* tool with `cache_control` when `cacheTools` so the tool block + preceding system cache form a stable prefix; tool-choice maps straight through), pulls cache token figures off the usage when a cache-control block was present, and maps `Anthropic.RateLimitError` → `LLMRateLimitError` (parsing `retry-after-ms` / `retry-after`). Bumps the SDK's `maxRetries` to `DEFAULT_MAX_RETRIES` (5) so the plan's 60s TPM window can reset before a failure surfaces.
- **`defaults.ts`** — model + token defaults. `DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-4-6"` / `DEFAULT_MAX_TOKENS = 1024` / `DEFAULT_MAX_RETRIES = 5` (the generator's Sonnet call). `UTILITY_ANTHROPIC_MODEL = "claude-haiku-4-5-20251001"` / `UTILITY_MAX_TOKENS = 512` (the cheap calls — summary refresh, imagery). `ENRICHMENT_MAX_TOKENS = 4096` (the multi-subject enrichment + curation calls — bumped from 512 after multi-subject tool-call JSON truncated mid-stream and the SDK returned an empty `reports` array that looked like the model declining but was a token-budget overflow).
- **`stub.ts`** — `StubLLMClient`: returns pre-scripted responses in order, records every call for assertions, throws scripted `Error`s when reached (drives error-path tests). Auto-answers imagery tool calls with a benign `hold` (not recorded — keeps `calls` a view of what the test cares about). `setNarratorResponse(...)` answers any request carrying the `deliver_narrative` tool directly (so a test can assert on the *narrator's* response without counting how many enrichment/curation calls a cycle made). `toolUseResponse({ prose, covers })` — a convenience builder for a `deliver_narrative` tool-use response.
- **`index.ts`** — barrel: `LLMClient` + the request/response types + `AnthropicLLMClient` + `StubLLMClient`.

## How it fits

`broadcast.ts`'s `buildLLMClient(config)` constructs an `AnthropicLLMClient` per runtime (model/max-tokens overridable via `broadcast.config.generator`) — unless `setRuntimeDependencies({ llm })` injected one (the test harness, the replay harness). That single client is passed into the `ServiceRegistry` (which hands it to every enrichment + curation service), the `Curator`, and the `NarrativeEngine`. Each caller picks its model per request (`UTILITY_ANTHROPIC_MODEL` for the Haiku calls, the client's default Sonnet for `generate`). Cache markers are set by the callers (`buildSystemSegments` marks the voice+context+task block; the enrichment/curation helpers mark their cached concept blocks; `cacheTools: true` is set on the structured-output calls). **Working looks like:** `[cache: N read / M write]` figures in the `[narrative] generated …` log line, with reads dominating after cycle 1; `LLMRateLimitError` surfacing only as a `generation_skipped` WS message + telemetry event, never an unhandled throw.

## Contract

### Provided
- `LLMClient.generate(LLMRequest): Promise<LLMResponse>` — the one method. Implementations must: honour `model` / `maxTokens` (falling back to their own defaults); translate `system` (string passes through; `SystemSegment[]` becomes provider cache-aware blocks); surface tool calls in `toolCalls`; populate cache usage figures when a cache-control block was sent; throw `LLMRateLimitError` on a 429 and let everything else propagate.
- `AnthropicLLMClient` (production), `StubLLMClient` (tests), constructed and injected via `broadcast.ts` / `setRuntimeDependencies`.
- The model defaults in `defaults.ts` — Sonnet for generation, Haiku (`UTILITY_*`) for the cheap calls, `ENRICHMENT_MAX_TOKENS` for multi-subject structured output. Callers reference these constants, not literal model strings.

### Depended on
- From the consumer/runtime: `ANTHROPIC_API_KEY` env (or an injected client). `broadcast.config.generator.model` / `.max_tokens` for the per-broadcast Sonnet override.
- From the SDK: the `@anthropic-ai/sdk` shapes (`MessageCreateParams`, `Usage`, `RateLimitError`, the content-block discriminants) — the translation in `anthropic.ts` is the one place that knows them; `skipLibCheck` in `tsconfig` means SDK type drift won't fail the build, so the translation is the thing to re-check on an SDK bump.

## Open work

- Only one provider implementation today. The contract is built for more (the neutral shape, the rate-limit wrapper) but there's no second client to validate it against — fine for now (one consumer, one provider).

## See also

- [`../README.md`](../README.md) — the internal architecture; where each LLM call sits in the pipeline.
- [`../narrative/README.md`](../narrative/README.md) — the generator's Sonnet call + the imagery/summary Haiku calls + the `LLMRateLimitError` handling.
- [`../enrichment/README.md`](../enrichment/README.md), [`../curation/README.md`](../curation/README.md) — the Haiku call assembly for the per-cycle and brief-init paths.
- `apps/blackout/server` uses a separate `apps/blackout/server/src/lib/anthropic.ts` for its own Haiku calls (the distiller, prompt-suggester) — same idea, different process; not shared code (Kairos has no published-package consumer).
