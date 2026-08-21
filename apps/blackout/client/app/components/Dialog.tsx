"use client";

import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { brand as C } from "../lib/palette";

interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  /** Optional secondary line under the title — useful for context (fixture name, etc.). */
  subtitle?: string;
  /** Max width for the dialog card. Defaults to 520px; forms with wider content can set larger. */
  width?: number;
  children: React.ReactNode;
}

/**
 * Shared modal dialog. Brand-consistent: ivory card with 0.5px celadon
 * border, umber title, close affordance top-right. Escape closes;
 * clicking the backdrop closes; body scroll locks while open. Rendered
 * into `document.body` via a portal so stacking isn't affected by the
 * calling component's layout.
 */
export function Dialog({ open, onClose, title, subtitle, width = 520, children }: DialogProps) {
  const cardRef = useRef<HTMLDivElement | null>(null);

  // ESC to close + body scroll lock, both only while the dialog is open.
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, onClose]);

  // Autofocus the first focusable element on open. Small nicety so users
  // can tab-navigate the form without first clicking into it.
  useEffect(() => {
    if (!open) return;
    const card = cardRef.current;
    if (!card) return;
    const first = card.querySelector<HTMLElement>(
      'input, select, textarea, button, [tabindex]:not([tabindex="-1"])',
    );
    first?.focus();
  }, [open]);

  if (!open) return null;
  if (typeof document === "undefined") return null;

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onMouseDown={(e) => {
        // Close on mousedown against the backdrop, not on a click that
        // started inside the card and ended on the backdrop (e.g. a
        // slightly-off text-selection gesture in a textarea).
        if (e.target === e.currentTarget) onClose();
      }}
      style={{
        position: "fixed",
        inset: 0,
        background: `${C.umber}80`,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
        zIndex: 100,
        // Fade in so the dialog doesn't pop into existence hard.
        animation: "blackout-dialog-backdrop 160ms ease",
      }}
    >
      <div
        ref={cardRef}
        style={{
          width: "100%",
          maxWidth: width,
          // Fixed height — the dialog size doesn't change between
          // invocations or when content expands/collapses inside. The
          // card itself is the scroll container; content taller than
          // the card scrolls internally under a sticky header / sticky
          // footer. Short-content dialogs have empty space below the
          // content, which is the intended tradeoff for consistency.
          height: 600,
          overflowY: "auto",
          overflowX: "hidden",
          background: C.ivory,
          border: `0.5px solid ${C.celadon}`,
          borderRadius: 12,
          animation: "blackout-dialog-card 200ms ease",
        }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header
          style={{
            display: "flex",
            alignItems: "flex-start",
            justifyContent: "space-between",
            padding: "18px 22px 14px",
            borderBottom: `0.5px solid ${C.celadon}`,
            // Sticky so the title/close stay accessible as the card
            // scrolls. Ivory background covers content passing under.
            position: "sticky",
            top: 0,
            background: C.ivory,
            zIndex: 1,
          }}
        >
          <div style={{ flex: 1, minWidth: 0 }}>
            <h2
              style={{
                margin: 0,
                fontSize: 18,
                fontWeight: 300,
                letterSpacing: "-0.02em",
                color: C.umber,
                lineHeight: 1.3,
              }}
            >
              {title}
            </h2>
            {subtitle ? (
              <div style={{ fontSize: 12, color: C.driftwood, marginTop: 4 }}>{subtitle}</div>
            ) : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            style={{
              background: "transparent",
              border: "none",
              color: C.stone,
              cursor: "pointer",
              padding: 4,
              marginRight: -4,
              marginTop: -2,
              fontFamily: "inherit",
              lineHeight: 1,
              transition: "color 160ms ease",
            }}
            onMouseEnter={(e) => { e.currentTarget.style.color = C.umber; }}
            onMouseLeave={(e) => { e.currentTarget.style.color = C.stone; }}
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
              <line x1="3.5" y1="3.5" x2="12.5" y2="12.5" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
              <line x1="12.5" y1="3.5" x2="3.5" y2="12.5" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
            </svg>
          </button>
        </header>
        {/* Body is plain block content — the card itself handles
            scroll and clipping via its own overflow. No flex gymnastics. */}
        <div>{children}</div>
      </div>
      <style>{`
        @keyframes blackout-dialog-backdrop {
          from { opacity: 0; } to { opacity: 1; }
        }
        @keyframes blackout-dialog-card {
          from { opacity: 0; transform: translateY(6px); }
          to   { opacity: 1; transform: translateY(0); }
        }
      `}</style>
    </div>,
    document.body,
  );
}

