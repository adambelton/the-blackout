"use client";

import { brand as C } from "../../../lib/palette";
import { pillStyles } from "./utils";

export function QuickLink({
  href,
  label,
  title,
}: {
  href: string | undefined;
  label: string;
  title: string;
}) {
  // Show-disabled-over-hide: while the broadcast hasn't loaded, render
  // the link in its disabled form so the moderator can see where the
  // affordance will live, rather than having it pop in.
  if (!href) {
    return (
      <span
        title={title}
        style={{
          ...pillStyles("ghostDisabled"),
          display: "inline-flex",
          alignItems: "center",
          textDecoration: "none",
        }}
      >
        {label}
      </span>
    );
  }
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      title={title}
      style={{
        ...pillStyles("ghost"),
        display: "inline-flex",
        alignItems: "center",
        textDecoration: "none",
      }}
    >
      {label}
    </a>
  );
}
