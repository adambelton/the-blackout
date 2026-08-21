"use client";

export function TunerIcon({ color, size }: { color: string; size: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden
      style={{ display: "inline-block", flexShrink: 0 }}
    >
      <path
        d="M5 4.5 A 4.5 4.5 0 1 0 11 4.5"
        stroke={color}
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      <line x1="8" y1="2.5" x2="8" y2="7.5" stroke={color} strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}
