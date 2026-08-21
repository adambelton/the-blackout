/**
 * Product defaults loaded from the repo's top-level `content/` directory.
 *
 * Two files define the editorial identity of The Blackout — the voice
 * the narrator speaks in and the style every illustration takes. Both
 * live as markdown in-repo (not env vars, not DB) so edits are
 * PR-reviewable and version-controlled alongside the rest of the
 * product.
 *
 * Read once at module load; restart to pick up changes. A missing or
 * empty file is a deploy-time error — these aren't optional.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
// `apps/blackout/server/src/lib` → repo root is five levels up. Build layout
// mirrors source (`apps/blackout/server/dist/lib`) so the same relative climb
// works in dev (tsx) and prod (node dist).
const contentDir = resolve(here, "../../../../../content");

function loadRequired(filename: string): string {
  const path = resolve(contentDir, filename);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    throw new Error(
      `Required content file missing: ${path} (${(err as Error).message})`,
    );
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error(`Required content file is empty: ${path}`);
  }
  return trimmed;
}

/** Narrative voice — pushed to Kairos as the `narrative_voice` entry
 * at every broadcast activation. */
export const DEFAULT_NARRATIVE_VOICE = loadRequired("voice.md");

/** Illustration style prefix — prepended to every Replicate prompt so
 * Kairos describes the scene and the Blackout dictates the render. */
export const DEFAULT_ILLUSTRATION_STYLE = loadRequired("illustration-style.md");

/** Consumer-side prompt the conductor splices into the LLM user message
 * when the phase FSM crosses halftime. Kairos itself doesn't know about
 * football phases — wording lives on the Blackout side because it
 * encodes football-specific framing. */
export const HALFTIME_REFLECTION_PROMPT = loadRequired("halftime-prompt.md");

/** Consumer-side prompt the conductor splices in at the full-time
 * whistle. Same contract as the halftime prompt. */
export const CLOSING_PASSAGE_PROMPT = loadRequired("full-time-prompt.md");

/** Frames the closing cadence cycle — the cycle whose drain end is
 * pinned at the whistle (HT or FT) plus the post-whistle texture
 * extension. Stamped on the synthetic phase-transition entry's data
 * as `closingPrompt`; Kairos passes it through as the cycle's
 * consumer-prompt. Used for both halftime and full-time closings —
 * the structural framing is identical, the reflective beat that
 * follows uses HALFTIME_REFLECTION_PROMPT or CLOSING_PASSAGE_PROMPT. */
export const CLOSING_CYCLE_PROMPT = loadRequired("closing-cycle-prompt.md");
