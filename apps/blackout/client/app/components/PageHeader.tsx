"use client";

import type { ReactNode } from "react";
import type { Broadcast } from "@blackout/shared";
import { BackLink } from "./BackLink";
import { FixtureMeta } from "./FixtureMeta";
import { brand } from "../lib/palette";

/**
 * Header shape shared by the admin / writer surfaces — studio,
 * moderator, inspector. Left column is always: back link → h1 →
 * FixtureMeta. Right column is a render child so each consumer
 * picks its own actions (status pill, quick links, transition
 * buttons) without fighting a prop-based API.
 *
 * Layout: flex row, wraps on narrow viewports, baseline-aligned at
 * the bottom so the h1 and right-side action bar share a baseline.
 */

export interface PageHeaderBack {
  href: string;
  label: string;
}

export function PageHeader({
  back,
  title,
  broadcast,
  children,
  /** Bottom padding of the header itself. Studio + inspector use 16;
   * moderator composes inside a flex-column with its own spacing so
   * passes `marginBottom: 24` via wrapping the header differently. */
  paddingBottom = 16,
  /** Whether to render a bottom border rule. Default on — matches
   * the inspector + studio headers. */
  border = true,
}: {
  back: PageHeaderBack;
  title: string;
  broadcast: Broadcast | null;
  children?: ReactNode;
  paddingBottom?: number;
  border?: boolean;
}) {
  return (
    <header
      style={{
        paddingBottom,
        borderBottom: border ? `0.5px solid ${brand.celadon}` : undefined,
        display: "flex",
        gap: 24,
        alignItems: "flex-end",
        justifyContent: "space-between",
        flexWrap: "wrap",
      }}
    >
      <div>
        <BackLink href={back.href} label={back.label} />
        <h1
          style={{
            fontSize: 28,
            fontWeight: 300,
            letterSpacing: "-0.03em",
            margin: "6px 0 4px",
            color: brand.umber,
          }}
        >
          {title}
        </h1>
        <FixtureMeta broadcast={broadcast} />
      </div>
      {children ? (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 16,
            fontSize: 12,
            flexWrap: "wrap",
          }}
        >
          {children}
        </div>
      ) : null}
    </header>
  );
}
