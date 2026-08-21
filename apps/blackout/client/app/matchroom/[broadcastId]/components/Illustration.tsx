"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { brand as C } from "../../../lib/palette";

const FADE_MS = 700;

export function Illustration({ imageUrl }: { imageUrl: string | null }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    const parent = el?.parentElement;
    if (!el || !parent) return;
    const compute = () => {
      const w = parent.clientWidth;
      const h = parent.clientHeight;
      if (w <= 0 || h <= 0) return;
      const widthBound = Math.min(w, (h * 4) / 3);
      const heightBound = Math.min(h, (w * 3) / 4);
      setSize({ w: Math.floor(widthBound), h: Math.floor(heightBound) });
    };
    compute();
    const ro = new ResizeObserver(compute);
    ro.observe(parent);
    return () => ro.disconnect();
  }, []);

  const [current, setCurrent] = useState<string | null>(null);
  const [previous, setPrevious] = useState<string | null>(null);

  useEffect(() => {
    if (!imageUrl || imageUrl === current) return;
    let cancelled = false;
    const preload = new window.Image();
    preload.onload = () => {
      if (cancelled) return;
      setPrevious(current);
      setCurrent(imageUrl);
    };
    preload.src = imageUrl;
    return () => {
      cancelled = true;
    };
  }, [imageUrl, current]);

  useEffect(() => {
    if (!previous) return;
    const t = setTimeout(() => setPrevious(null), FADE_MS + 100);
    return () => clearTimeout(t);
  }, [previous, current]);

  return (
    <div
      ref={ref}
      style={{
        position: "absolute",
        top: "50%",
        left: "50%",
        transform: "translate(-50%, -50%)",
        boxSizing: "border-box",
        width: size ? `${size.w}px` : 0,
        height: size ? `${size.h}px` : 0,
        borderRadius: 12,
        background: `linear-gradient(165deg, #2a3b24 0%, ${C.umber} 55%, #3A2E22 100%)`,
        overflow: "hidden",
      }}
    >
      <div
        style={{
          position: "absolute",
          inset: 0,
          background: `radial-gradient(ellipse at 30% 40%, ${C.driftwood}40, transparent 60%)`,
          pointerEvents: "none",
        }}
      />
      {previous ? (
        <img
          key={`prev-${previous}`}
          src={previous}
          alt=""
          style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover" }}
        />
      ) : null}
      {current ? (
        <img
          key={`cur-${current}`}
          src={current}
          alt=""
          style={{
            position: "absolute",
            inset: 0,
            width: "100%",
            height: "100%",
            objectFit: "cover",
            animation: `matchroom-illustration-fade ${FADE_MS}ms ease-out`,
          }}
        />
      ) : null}
      <style>{`
        @keyframes matchroom-illustration-fade {
          0%   { opacity: 0; }
          100% { opacity: 1; }
        }
      `}</style>
    </div>
  );
}
