/**
 * Inline-anchor extraction for narrative prose.
 *
 * The generator is instructed to place `{{ref:<entryId>}}` tokens
 * inside prose at the point where each covered feed entry is
 * materially referenced. The listener never sees them — we strip
 * them before anything leaves the engine — but their position in
 * the pre-strip text tells the consumer when to reveal content tied
 * to that entry (event card, scoreline update, illustration beat).
 *
 * LLMs can't reliably count characters, but they can place inline
 * tokens at natural positions. This module does the counting and
 * returns char offsets in the stripped prose that the consumer can
 * translate into time offsets once audio duration is known.
 */

// Anchor syntax: `{{ref:<id>}}`. The id is captured greedily up to the
// closing braces. We accept UUIDs and any run of non-whitespace,
// non-brace characters to stay permissive on id format — Kairos
// doesn't assume UUID shape in its public surface.
const ANCHOR_RE = /\{\{ref:([^}\s]+)\}\}/g;

export interface Anchor {
  entryId: string;
  /** Position in the stripped text where the anchor was placed —
   * i.e. the char offset at the beginning of the content that
   * follows the anchor. */
  charOffset: number;
}

export interface AnchorExtractionResult {
  /** Prose with anchors removed. Normalised for surrounding
   * whitespace so an anchor placed between tokens doesn't leave a
   * double space. */
  stripped: string;
  /** Anchors found, in order of appearance. The same entryId can
   * appear more than once if the LLM references an entry in
   * multiple places; consumers pick the first or whichever
   * policy fits. */
  anchors: Anchor[];
}

/**
 * Extract all anchors from a passage and return the cleaned prose
 * plus anchor positions. Whitespace adjacent to a stripped anchor
 * is collapsed — "{{ref:X}} Welbeck" and "Welbeck {{ref:X}}" both
 * yield a single space at the anchor point, not a double space.
 */
export function extractAnchors(text: string): AnchorExtractionResult {
  const anchors: Anchor[] = [];

  // Walk matches in order; build stripped string incrementally so
  // the char offset we record is relative to the stripped output,
  // not the original. `consumed` tracks how many characters of the
  // original we've emitted into stripped.
  let stripped = "";
  let lastIndex = 0;

  ANCHOR_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = ANCHOR_RE.exec(text)) !== null) {
    const [full, entryId] = match;
    const startInOriginal = match.index;

    // Emit the slice between the previous anchor (or string start)
    // and this anchor.
    stripped += text.slice(lastIndex, startInOriginal);

    // Record the anchor's position in the CURRENT stripped length —
    // that's the char offset "where the anchor sat" in the output.
    anchors.push({ entryId, charOffset: stripped.length });

    lastIndex = startInOriginal + full.length;
  }

  // Tail.
  stripped += text.slice(lastIndex);

  // Collapse runs of whitespace that opened up around the stripped
  // anchors — e.g. "word {{ref:X}} word" becomes "word  word" after
  // naive slicing, which we flatten to "word word". Preserves a
  // single space so adjacent tokens don't mash together.
  if (anchors.length > 0) {
    const before = stripped;
    stripped = stripped.replace(/[ \t]{2,}/g, " ");
    // Offsets have to be recomputed since collapsing whitespace
    // shifts everything after the collapse point.
    if (stripped !== before) {
      rescaleOffsets(anchors, before, stripped);
    }
  }

  return { stripped, anchors };
}

/**
 * After whitespace collapse, the anchor offsets point into the
 * pre-collapse string. Re-map them into the post-collapse string by
 * counting the characters that were removed before each anchor.
 * Simple O(n·m) — n = anchors, m = collapses. Anchor counts are
 * low (~5 per passage) so this is fine.
 */
function rescaleOffsets(anchors: Anchor[], before: string, after: string): void {
  // Build a mapping from original-index → post-collapse-index by
  // walking both strings in lockstep.
  let beforeIdx = 0;
  let afterIdx = 0;
  const map = new Array<number>(before.length + 1);
  while (beforeIdx < before.length) {
    map[beforeIdx] = afterIdx;
    // If we hit a run of 2+ whitespace chars in `before`, `after`
    // consumed just one.
    if (
      (before[beforeIdx] === " " || before[beforeIdx] === "\t") &&
      (before[beforeIdx + 1] === " " || before[beforeIdx + 1] === "\t")
    ) {
      // advance beforeIdx past the run; afterIdx advances once
      let j = beforeIdx;
      while (j < before.length && (before[j] === " " || before[j] === "\t")) {
        map[j] = afterIdx;
        j++;
      }
      beforeIdx = j;
      afterIdx += 1;
    } else {
      beforeIdx++;
      afterIdx++;
    }
  }
  map[before.length] = after.length;

  for (const a of anchors) {
    const remapped = map[Math.min(a.charOffset, before.length)];
    a.charOffset = remapped;
  }
}
