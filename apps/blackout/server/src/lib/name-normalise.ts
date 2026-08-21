/**
 * Name normaliser — canonicalises player-name references before entries
 * reach Kairos.
 *
 * Two sources of drift:
 * - ASR garbles from Deepgram ("Fabon" for Azon, "Aeling" for Ayling)
 *   on transcription.
 * - Registered-vs-common name mismatches from Sportmonks ("Daniel
 *   Welbeck" on events vs "Danny Welbeck" on the lineups roster).
 *
 * Two functions, same roster lookup:
 * - `normaliseTranscript(text, roster)` — runs over free text
 *   (transcription, moderator notes, event summaries), rewriting
 *   surname-shaped tokens to the canonical spelling.
 * - `normalisePlayerName(fullName, roster)` — runs over structured
 *   player fields from Sportmonks, matching on surname and returning
 *   the canonical full-name form from the roster.
 *
 * Conservative on purpose — the cost of a false positive (wrong name
 * substituted) is higher than the cost of a miss (narrator figures it
 * out from context anyway). Match thresholds favour precision: short
 * words and common English words are never rewritten even if the edit
 * distance would allow it.
 */

// Common English words that might fuzzy-match short surnames. Kept
// tight — false positives here are catastrophic ("the" → "Thé").
const STOPWORDS = new Set([
  "the", "and", "but", "for", "nor", "yet", "with", "from", "into",
  "over", "under", "again", "back", "down", "through", "after",
  "before", "during", "about", "around", "this", "that", "these",
  "those", "some", "such", "when", "where", "while", "what", "which",
  "here", "there", "then", "than", "now", "how", "why", "who", "him",
  "his", "her", "hers", "she", "they", "them", "their", "theirs",
  "you", "your", "yours", "our", "ours", "its", "it's", "we", "was",
  "were", "has", "had", "have", "been", "being", "are", "isn't",
  "wasn't", "aren't", "weren't", "don't", "doesn't", "didn't",
  "won't", "wouldn't", "couldn't", "shouldn't", "can", "cannot",
  "could", "should", "would", "might", "must", "shall", "will",
  "does", "did", "does", "doing", "been", "goal", "ball", "game",
  "half", "time", "into", "out", "one", "two", "three", "four",
  "five", "side", "left", "right", "home", "away", "team", "match",
  "play", "player", "goalkeeper",
]);

/**
 * Compute the Levenshtein distance between two strings. O(m*n) time,
 * O(min(m,n)) space using a two-row buffer. Input strings are
 * expected to be short (player surnames ≤ 20 chars) so the constants
 * don't matter.
 */
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  // Ensure a is the shorter string to use less memory
  if (a.length > b.length) [a, b] = [b, a];

  let prev = new Array(a.length + 1);
  let curr = new Array(a.length + 1);
  for (let i = 0; i <= a.length; i++) prev[i] = i;

  for (let j = 1; j <= b.length; j++) {
    curr[0] = j;
    for (let i = 1; i <= a.length; i++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[i] = Math.min(
        curr[i - 1] + 1,      // insertion
        prev[i] + 1,          // deletion
        prev[i - 1] + cost,   // substitution
      );
    }
    [prev, curr] = [curr, prev];
  }
  return prev[a.length];
}

/**
 * Pick the best canonical match for a token from the roster, or null
 * if nothing matches tightly enough. Uses a length-scaled edit-distance
 * threshold so longer names tolerate more variance.
 */
function findCanonical(word: string, rosterLower: Map<string, string>): string | null {
  if (word.length < 4) return null; // too short — false-positive prone
  const lower = word.toLowerCase();
  if (STOPWORDS.has(lower)) return null;

  // Exact match first — case-insensitive.
  const exact = rosterLower.get(lower);
  if (exact) return exact;

  // Fuzzy: allow 1 edit for ≤6 chars, 2 edits for longer. Capped at 2.
  const maxDistance = word.length <= 6 ? 1 : 2;
  let best: { canonical: string; distance: number } | null = null;
  for (const [rosterLowerName, canonical] of rosterLower) {
    // Skip names whose length differs by more than the threshold — no
    // single transformation could close the gap.
    if (Math.abs(rosterLowerName.length - lower.length) > maxDistance) continue;
    const d = levenshtein(lower, rosterLowerName);
    if (d <= maxDistance && (!best || d < best.distance)) {
      best = { canonical, distance: d };
    }
  }
  return best?.canonical ?? null;
}

/**
 * Build a lookup map keyed on the last name (lowercased) of each
 * roster entry. We match against surnames rather than full names
 * because (a) transcription typically uses just the surname, (b)
 * shorter keys are faster to compare, (c) the canonical full-name
 * value is what we substitute back in.
 *
 * For "Danny Welbeck" → map["welbeck"] = "Welbeck". Single-word
 * names like "Neymar" become their own key. Apostrophes and accents
 * are folded to their base forms so "O'Brien" and "Ayling"-style
 * names both participate.
 */
function buildRosterLookup(roster: string[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const fullName of roster) {
    const surname = extractSurname(fullName);
    if (!surname) continue;
    const key = foldAccents(surname).toLowerCase();
    if (key.length < 3) continue;
    // First writer wins — canonical name we substitute back is the
    // surname (what commentary uses). If two players share a surname,
    // the narrator has to disambiguate from context; we can't.
    if (!map.has(key)) map.set(key, surname);
  }
  return map;
}

function extractSurname(fullName: string): string {
  const parts = fullName.trim().split(/\s+/);
  return parts[parts.length - 1];
}

/** Normalise accented characters to their ASCII approximations. */
function foldAccents(s: string): string {
  return s.normalize("NFD").replace(/\p{Diacritic}/gu, "");
}

/**
 * Normalise a block of transcript text against a known roster. Tokens
 * that fuzzy-match a player's surname are rewritten to the canonical
 * spelling; everything else is preserved, including punctuation and
 * whitespace. Returns the original text unchanged if the roster is
 * empty (no normalisation possible).
 */
export function normaliseTranscript(text: string, roster: string[]): string {
  if (!text || roster.length === 0) return text;
  const lookup = buildRosterLookup(roster);
  if (lookup.size === 0) return text;

  return text.replace(/\S+/g, (token) => {
    // Strip leading/trailing punctuation for the match; preserve it on
    // output so "Mitoma," stays "Mitoma,".
    const match = token.match(/^(\W*)(.+?)(\W*)$/);
    if (!match) return token;
    const [, pre, core, post] = match;
    if (!core) return token;
    const folded = foldAccents(core);
    const canonical = findCanonical(folded, lookup);
    return canonical ? `${pre}${canonical}${post}` : token;
  });
}

/**
 * Build a surname → canonical full-name lookup. Used by
 * `normalisePlayerName` so structured Sportmonks player fields
 * ("Daniel Welbeck" from events) can be reconciled against the
 * roster's canonical full form ("Danny Welbeck" from lineups).
 */
function buildFullNameLookup(roster: string[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const fullName of roster) {
    const surname = extractSurname(fullName);
    if (!surname) continue;
    const key = foldAccents(surname).toLowerCase();
    if (key.length < 3) continue;
    // First writer wins. Shared-surname ambiguity is unresolvable
    // without context — the LLM has to handle it downstream.
    if (!map.has(key)) map.set(key, fullName);
  }
  return map;
}

/**
 * Normalise a structured player full-name against the roster. Matches
 * on surname (lower-cased, accent-folded, fuzzy within the same
 * edit-distance tolerance as text matching) and returns the canonical
 * full-name form from the roster. Returns the original if nothing
 * matches.
 *
 * Use this for Sportmonks event `player` / `relatedPlayer` fields —
 * the API occasionally returns a registered name that differs from
 * the common-name form the lineups endpoint surfaces, and enrichment
 * services need stable subject ids across both.
 */
export function normalisePlayerName(fullName: string, roster: string[]): string {
  if (!fullName || roster.length === 0) return fullName;
  const trimmed = fullName.trim();
  if (!trimmed) return fullName;
  // Already canonical — roster contains this exact spelling.
  if (roster.includes(trimmed)) return trimmed;

  const lookup = buildFullNameLookup(roster);
  if (lookup.size === 0) return fullName;

  const surname = extractSurname(trimmed);
  if (!surname) return fullName;
  const folded = foldAccents(surname);
  return findCanonical(folded, lookup) ?? fullName;
}
