"use client";

import { useEffect } from "react";
import { brand as C } from "../../../lib/palette";
import { MONO } from "./types";

export function IllustrationDialog({
  imageUrl,
  prompt,
  model,
  generationMs,
  onClose,
}: {
  imageUrl: string;
  prompt: string;
  model: string;
  generationMs: number;
  onClose: () => void;
}) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);
  return (
    <div
      role="dialog"
      aria-modal="true"
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(31, 26, 20, 0.78)",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        padding: 40,
        zIndex: 100,
        cursor: "zoom-out",
      }}
    >
      <img
        src={imageUrl}
        alt=""
        onClick={(e) => e.stopPropagation()}
        style={{
          maxWidth: "min(1200px, 90vw)",
          maxHeight: "82vh",
          objectFit: "contain",
          borderRadius: 10,
          boxShadow: "0 20px 60px rgba(0,0,0,0.4)",
          cursor: "default",
        }}
      />
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          marginTop: 16,
          maxWidth: "min(1200px, 90vw)",
          fontSize: 12,
          color: C.ivory,
          lineHeight: 1.6,
          fontFamily: MONO,
          cursor: "default",
        }}
      >
        {prompt}
        <div style={{ marginTop: 6, color: `${C.ivory}99`, fontSize: 11 }}>
          {model} · {generationMs}ms
        </div>
      </div>
    </div>
  );
}
