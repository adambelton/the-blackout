"use client";

import type { ReactNode } from "react";
import { brand as C } from "../lib/palette";

/**
 * Thin brand footer used across every The Blackout surface — studio,
 * moderator, inspector (light theme) and matchroom (dark theme).
 * Fixed at 50px total height with a single border rule at the top.
 * Callers pass a `left` slot for page-specific status (save state,
 * connection pip, etc.); the right-hand mark identifies the concept.
 */

export type FooterTheme = "light" | "dark";

export function AdminFooter({
  left,
  theme = "light",
  background,
}: {
  /** Optional status content on the left — save state, connection,
   * whatever the host page wants to surface. Leave empty for a
   * mark-only footer. */
  left?: ReactNode;
  /** Light is the default for admin / writer surfaces. Dark is the
   * matchroom, where the border drops to 10% opacity so it doesn't
   * glow against the umber background. */
  theme?: FooterTheme;
  /** Override to paint the footer onto the host page's background —
   * useful when the host isn't the brand ivory (e.g. a dialog). */
  background?: string;
}) {
  // Dark-theme rule is low-opacity celadon so it reads as a soft
  // divider rather than a hard line against umber. Light stays at
  // full celadon for the crisp admin feel.
  const borderColor = theme === "dark" ? `${C.celadon}1A` : C.celadon;
  return (
    <footer
      style={{
        display: "flex",
        justifyContent: "space-between",
        // Top-align the labels so they sit just below the border rather
        // than centring in the 50px strip.
        alignItems: "flex-start",
        // border-box so the paddingTop is *inside* the 50px envelope,
        // not added on top. Default content-box would make the footer
        // 60px tall once paddingTop lands.
        boxSizing: "border-box",
        paddingTop: 10,
        height: 50,
        borderTop: `0.5px solid ${borderColor}`,
        fontSize: 11,
        letterSpacing: "0.04em",
        color: C.stone,
        background: background ?? "transparent",
        // Never collapse below natural content height in a flex parent.
        flexShrink: 0,
      }}
    >
      <div style={{ color: C.driftwood }}>{left ?? null}</div>
      <div>The Blackout</div>
    </footer>
  );
}
