/**
 * Shared eval-criteria parsing for the prompts-as-content spec model.
 *
 * Per `docs/prompts-as-content-design.md` § *Eval criteria as spec content*:
 * the contract a spec edit must hold is itself content. It lives in
 * `## Eval — hard invariants` / `## Eval — soft notes` sections inside the
 * same markdown as the prompt prose — `<service>.baseline.md` for the
 * profile-agnostic machine invariants, the service spec for the
 * profile-specific ones. The prompt assemblers (the enrichment / curation /
 * narrative loaders) recognise these headers and **exclude them from the
 * assembled prompt** — they are assertions about output, not prompt text.
 *
 * This module is the single place that knows the eval header names + the
 * hard-invariant line grammar. The assemblers import {@link isEvalHeader}
 * to skip eval sections (without treating them as header drift); the eval
 * runners import {@link extractEvalCriteria} to execute them.
 *
 * Hard-invariant grammar — one `-` bullet per line under the hard section:
 *
 *     - prose-must-not-match: /regex/flags      (optional trailing prose, ignored)
 *     - prose-must-match: /regex/flags
 *     - tool-was-called
 *
 * Malformed lines throw — the same loud-failure discipline as header drift.
 * Per-fixture expectations (e.g. "this input's prose must cover evt-goal-1")
 * are NOT invariants — they stay with the fixture inputs in code.
 */

export const EVAL_HEADERS = {
  hard: "Eval — hard invariants",
  soft: "Eval — soft notes",
} as const;

const EVAL_HEADER_SET: ReadonlySet<string> = new Set(Object.values(EVAL_HEADERS));

/** True for the two eval section headers — assemblers skip these. */
export function isEvalHeader(header: string): boolean {
  return EVAL_HEADER_SET.has(header.trim());
}

/** A machine-checkable assertion about a service's output. */
export type HardInvariant =
  | { kind: "prose-must-not-match"; pattern: RegExp; source: string }
  | { kind: "prose-must-match"; pattern: RegExp; source: string }
  | { kind: "tool-was-called"; source: string };

export interface EvalCriteria {
  /** Executed by the eval runner against live output. */
  hardInvariants: HardInvariant[];
  /** Reviewer guidance — surfaced alongside output, not executed. */
  softNotes: string[];
}

const REGEX_DIRECTIVES = new Set(["prose-must-not-match", "prose-must-match"]);
const NOARG_DIRECTIVES = new Set(["tool-was-called"]);

/**
 * Parse one hard-invariant bullet body (the text after `- `). Throws on a
 * malformed line — an unknown directive, or a regex directive whose argument
 * isn't a `/regex/flags` literal.
 */
export function parseHardInvariantLine(line: string): HardInvariant {
  const colon = line.indexOf(":");
  const directive = (colon === -1 ? line : line.slice(0, colon)).trim();
  const arg = colon === -1 ? "" : line.slice(colon + 1).trim();

  if (REGEX_DIRECTIVES.has(directive)) {
    // Leading `/regex/flags`; escaped slashes allowed in the body; any
    // trailing prose (a human-readable gloss) is ignored.
    const match = /^\/((?:\\.|[^/])*)\/([gimsuy]*)/.exec(arg);
    if (!match) {
      throw new Error(
        `Eval hard-invariant "${line}": "${directive}" expects a \`/regex/flags\` argument`,
      );
    }
    let pattern: RegExp;
    try {
      pattern = new RegExp(match[1], match[2]);
    } catch (err) {
      throw new Error(`Eval hard-invariant "${line}": invalid regex — ${(err as Error).message}`);
    }
    return { kind: directive as "prose-must-not-match" | "prose-must-match", pattern, source: line };
  }

  if (NOARG_DIRECTIVES.has(directive)) {
    return { kind: "tool-was-called", source: line };
  }

  throw new Error(`Eval hard-invariant "${line}": unknown directive "${directive}"`);
}

/**
 * Extract + merge the eval criteria from a baseline blob and an optional
 * profile (spec) blob. Baseline invariants (profile-agnostic) come first,
 * then profile invariants — the same baseline-then-profile order the prompt
 * assembly uses. A blob with no eval sections contributes nothing.
 */
export function extractEvalCriteria(baselineBlob: string, profileBlob?: string): EvalCriteria {
  const hardInvariants: HardInvariant[] = [];
  const softNotes: string[] = [];

  for (const blob of [baselineBlob, profileBlob ?? ""]) {
    for (const line of bulletBodies(sectionBody(blob, EVAL_HEADERS.hard))) {
      hardInvariants.push(parseHardInvariantLine(line));
    }
    for (const line of bulletBodies(sectionBody(blob, EVAL_HEADERS.soft))) {
      softNotes.push(line);
    }
  }

  return { hardInvariants, softNotes };
}

/**
 * Run the text-matching hard invariants against a piece of output (the
 * generated passage, the imagery prompt, or the summary note). Returns one
 * failure string per violation; an empty array means all passed.
 *
 * `tool-was-called` is about the call, not the text — the runner asserts it
 * by checking the service returned output at all, so it's skipped here.
 */
export function checkProseInvariants(invariants: HardInvariant[], text: string): string[] {
  const failures: string[] = [];
  for (const inv of invariants) {
    if (inv.kind === "prose-must-not-match" && inv.pattern.test(text)) {
      failures.push(`output matched forbidden pattern (${inv.source})`);
    } else if (inv.kind === "prose-must-match" && !inv.pattern.test(text)) {
      failures.push(`output did not match required pattern (${inv.source})`);
    }
  }
  return failures;
}

/** Lines of a `## <header>` section's body (up to the next `##`), or []. */
function sectionBody(blob: string, header: string): string[] {
  const out: string[] = [];
  let inSection = false;
  for (const line of blob.split("\n")) {
    const match = /^##\s+(.+?)\s*$/.exec(line);
    if (match) {
      inSection = match[1].trim() === header;
      continue;
    }
    if (inSection) out.push(line);
  }
  return out;
}

/** `- ` bullet bodies, trimmed, blanks dropped. */
function bulletBodies(lines: string[]): string[] {
  return lines
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "))
    .map((line) => line.slice(2).trim())
    .filter((line) => line.length > 0);
}
