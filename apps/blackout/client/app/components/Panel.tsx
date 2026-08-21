"use client";

import type { ReactNode } from "react";
import { brand } from "../lib/palette";

/**
 * Titled card used across every admin / writer column. Ivory body,
 * 44px fixed-height header with an uppercase label + optional meta
 * slot, rounded border. Two modes:
 *
 * - Default (static): the card hugs its content. Good for inputs +
 *   small fixed-height panels.
 * - `grow`: the card becomes a flex column that fills its parent's
 *   row height. Body gets `flex: 1, minHeight: 0` so scrollable
 *   children can use `overflow: auto` cleanly. Good for the
 *   combined-feed / narratives / pipeline columns.
 *
 * Optional `footer` slot renders below the body with a top border.
 * Used for inline composers (moderator's combined-feed); panels that
 * just display content don't need one.
 *
 * The fixed 44px header height is authoritative: every Panel across
 * the moderator + inspector sits at the same mark regardless of
 * whether a meta slot is rendered.
 */
export function Panel({
  label,
  meta,
  footer,
  grow = false,
  /** Override the body padding — some callers want edge-to-edge
   * content (long lists with per-row padding). Default 16x18. */
  bodyPadding = "16px 18px",
  children,
}: {
  label: string;
  meta?: ReactNode;
  footer?: ReactNode;
  grow?: boolean;
  bodyPadding?: string | number;
  children: ReactNode;
}) {
  const header = (
    <header
      style={{
        height: 44,
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "0 18px",
        borderBottom: `0.5px solid ${brand.celadon}`,
        flexShrink: grow ? 0 : undefined,
      }}
    >
      <span
        style={{
          fontSize: 10,
          fontWeight: 500,
          letterSpacing: "0.14em",
          textTransform: "uppercase",
          color: brand.stone,
        }}
      >
        {label}
      </span>
      {meta ? (
        <span
          style={{
            fontSize: 10,
            letterSpacing: "0.06em",
            color: brand.driftwood,
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {meta}
        </span>
      ) : null}
    </header>
  );

  const body = (
    <div
      style={{
        padding: bodyPadding,
        ...(grow
          ? {
              flex: 1,
              minHeight: 0,
              display: "flex",
              flexDirection: "column",
            }
          : {}),
      }}
    >
      {children}
    </div>
  );

  const footerEl = footer ? (
    <div
      style={{
        borderTop: `0.5px solid ${brand.celadon}`,
        background: `${brand.celadon}2E`,
        flexShrink: grow ? 0 : undefined,
      }}
    >
      {footer}
    </div>
  ) : null;

  // Static panels: flow layout — their content sets their own height.
  if (!grow) {
    return (
      <section
        style={{
          border: `0.5px solid ${brand.celadon}`,
          borderRadius: 12,
          background: "#fff",
          overflow: "hidden",
        }}
      >
        {header}
        {body}
        {footerEl}
      </section>
    );
  }

  // Grow panels: the section must stretch to fill its row without its
  // own intrinsic content inflating that row. Chrome's auto grid-track
  // sizing uses cell content even with `overflow: hidden` + `minHeight:
  // 0` (a long-standing quirk), so we take content out of flow — the
  // section is `position: relative` and the header / body / footer
  // live inside a `position: absolute; inset: 0` flex column. The
  // section's intrinsic content height is now 0, and the inner flex
  // chain handles scrolling cleanly.
  return (
    <section
      style={{
        border: `0.5px solid ${brand.celadon}`,
        borderRadius: 12,
        background: "#fff",
        overflow: "hidden",
        position: "relative",
        // `flex: 1` matters when the section is a flex-child (moderator's
        // narratives card inside a flex column). Ignored when the section
        // is a direct grid cell (combined feed + inspector panels) — the
        // grid track sizing takes over there.
        flex: 1,
        minHeight: 0,
      }}
    >
      <div
        style={{
          position: "absolute",
          inset: 0,
          display: "flex",
          flexDirection: "column",
        }}
      >
        {header}
        {body}
        {footerEl}
      </div>
    </section>
  );
}
