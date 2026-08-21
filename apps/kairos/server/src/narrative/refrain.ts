export interface RefrainBudget {
  phrase: string;
  /** Max occurrences per phase. */
  maxPerPhase?: number;
  /** Max total occurrences across the whole broadcast. */
  maxTotal?: number;
}

export interface PriorGeneration {
  output: string;
  /** Phase at the time of generation — read from contextPackage.currentSubjectPhase. */
  phase?: string | null;
}

interface RefrainCount {
  budget: RefrainBudget;
  totalUses: number;
  usesInCurrentPhase: number;
  currentSubjectPhase: string | null;
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  const h = haystack.toLowerCase();
  const n = needle.toLowerCase();
  let count = 0;
  let idx = h.indexOf(n);
  while (idx !== -1) {
    count++;
    idx = h.indexOf(n, idx + n.length);
  }
  return count;
}

function tallyRefrains(
  budgets: RefrainBudget[],
  priors: PriorGeneration[],
  currentSubjectPhase: string | null,
): RefrainCount[] {
  return budgets.map((budget) => {
    let totalUses = 0;
    let usesInCurrentPhase = 0;
    for (const prior of priors) {
      const occ = countOccurrences(prior.output, budget.phrase);
      totalUses += occ;
      if (prior.phase && prior.phase === currentSubjectPhase) {
        usesInCurrentPhase += occ;
      }
    }
    return { budget, totalUses, usesInCurrentPhase, currentSubjectPhase };
  });
}

/**
 * Render a compact usage line per designated refrain for the generator
 * prompt. When a phrase has a per-phase cap and the current phase is
 * known, the narrator sees both counts. When the cap is exceeded the
 * line reads as an explicit halt rather than a hint.
 *
 * Returns empty string if there are no refrains configured or if none
 * have been used yet — nothing to remind the narrator about until the
 * first motif lands.
 */
export function formatRefrainStatus(
  budgets: RefrainBudget[] | undefined,
  priors: PriorGeneration[],
  currentSubjectPhase: string | null,
): string {
  if (!budgets || budgets.length === 0) return "";
  const counts = tallyRefrains(budgets, priors, currentSubjectPhase);
  const lines: string[] = [];
  for (const c of counts) {
    const parts: string[] = [`"${c.budget.phrase}"`];
    if (c.budget.maxPerPhase != null && currentSubjectPhase) {
      const over = c.usesInCurrentPhase >= c.budget.maxPerPhase;
      parts.push(
        over
          ? `used ${c.usesInCurrentPhase}/${c.budget.maxPerPhase} this ${currentSubjectPhase} — do not use again this phase`
          : `used ${c.usesInCurrentPhase}/${c.budget.maxPerPhase} this ${currentSubjectPhase}`,
      );
    }
    if (c.budget.maxTotal != null) {
      const over = c.totalUses >= c.budget.maxTotal;
      parts.push(
        over
          ? `${c.totalUses}/${c.budget.maxTotal} total — do not use again in this broadcast`
          : `${c.totalUses}/${c.budget.maxTotal} total`,
      );
    }
    if (parts.length === 1) {
      // No budgets set — just report raw usage so the narrator is aware.
      parts.push(`used ${c.totalUses} so far`);
    }
    lines.push(parts.join(", "));
  }
  if (lines.every((l) => l.endsWith("used 0 so far") || l.includes("used 0/"))) {
    // Nothing used yet; don't clutter the prompt with a pre-emptive warning.
    return "";
  }
  return ["Refrain usage so far:", ...lines.map((l) => `- ${l}`), ""].join("\n");
}
