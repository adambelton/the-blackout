"use client";

import { brand as C } from "../../../lib/palette";

export function BrandMark({ size }: { size: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 128 128"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden
    >
      <rect width="128" height="128" rx="28" fill={C.umber} stroke={C.driftwood} strokeOpacity="0.25" strokeWidth="1" />
      <rect x="28" y="34" width="72" height="14" rx="3" fill={C.ivory} />
      <rect x="28" y="80" width="72" height="14" rx="3" fill={C.ivory} />
      <rect x="28" y="57" width="72" height="14" rx="3" fill={C.ivory} opacity="0.35" />
    </svg>
  );
}
