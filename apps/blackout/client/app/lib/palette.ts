/**
 * Canonical brand palette. Mirrors docs/the-blackout-brand-guide.md.
 * Every admin/writer surface + components pull from here so the hex
 * values live in one place. Consumers typically alias on import:
 *
 *   import { brand as C } from ".../lib/palette";
 *
 * keeping the existing inline `C.umber` / `C.celadon` references
 * working unchanged.
 */

export const brand = {
  umber: "#1F1A14",
  ivory: "#FDFAF4",
  forest: "#3A5432",
  sage: "#8FAE80",
  celadon: "#DDE4DC",
  driftwood: "#9E8468",
  stone: "#72726C",
  crimson: "#B0453A",
  warn: "#B38600",
} as const;

export type BrandColor = keyof typeof brand;
