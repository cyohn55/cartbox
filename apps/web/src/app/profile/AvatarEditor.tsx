"use client";

/**
 * Mii-style avatar compositor. Cycles part choices per category, previews the
 * result live on a canvas, and saves the spec. Parts are drawn as placeholder
 * shapes keyed by part index + palette; real sprite sheets can replace the
 * drawing without changing the data model.
 */

import { useEffect, useRef, useState } from "react";

import {
  AVATAR_CATEGORIES,
  AVATAR_OPTION_COUNTS,
  DEFAULT_AVATAR,
  normalizeAvatar,
  randomAvatar,
  type AvatarCategory,
  type AvatarSpec,
} from "@/lib/avatar";
import { PREVIEW_SIZE, drawAvatar } from "@/lib/avatarRender";
import { authHeaders } from "@/lib/supabase-browser";

interface AvatarEditorProps {
  /** Existing avatar to edit; falls back to the default. */
  initial?: unknown;
}

export function AvatarEditor({ initial }: AvatarEditorProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [spec, setSpec] = useState<AvatarSpec>(() =>
    initial ? normalizeAvatar(initial) : DEFAULT_AVATAR,
  );
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");

  useEffect(() => {
    const ctx = canvasRef.current?.getContext("2d");
    if (ctx) {
      drawAvatar(ctx, spec);
    }
  }, [spec]);

  const cycle = (category: AvatarCategory, delta: number) => {
    setSaveState("idle");
    setSpec((current) => {
      const count = AVATAR_OPTION_COUNTS[category];
      const next = (current.parts[category] + delta + count) % count;
      return { ...current, parts: { ...current.parts, [category]: next } };
    });
  };

  const save = async () => {
    setSaveState("saving");
    try {
      const response = await fetch("/api/profile/avatar", {
        method: "POST",
        headers: await authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ avatar: spec }),
      });
      setSaveState(response.ok ? "saved" : "error");
    } catch {
      setSaveState("error");
    }
  };

  return (
    <div>
      <canvas
        ref={canvasRef}
        width={PREVIEW_SIZE}
        height={PREVIEW_SIZE}
        style={{ width: 192, height: 192, imageRendering: "pixelated", background: "#241f38", borderRadius: 12 }}
      />
      <ul style={{ listStyle: "none", padding: 0 }}>
        {AVATAR_CATEGORIES.map((category) => (
          <li key={category} style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <button type="button" onClick={() => cycle(category, -1)} aria-label={`Previous ${category}`}>
              ‹
            </button>
            <span style={{ minWidth: 90 }}>
              {category}: {spec.parts[category] + 1}/{AVATAR_OPTION_COUNTS[category]}
            </span>
            <button type="button" onClick={() => cycle(category, 1)} aria-label={`Next ${category}`}>
              ›
            </button>
          </li>
        ))}
      </ul>
      <div style={{ display: "flex", gap: 8 }}>
        <button type="button" onClick={() => { setSaveState("idle"); setSpec(randomAvatar()); }}>
          🎲 Randomize
        </button>
        <button type="button" onClick={save} disabled={saveState === "saving"}>
          {saveState === "saved" ? "✓ Saved" : "Save avatar"}
        </button>
      </div>
      {saveState === "error" && <p role="alert">Could not save your avatar.</p>}
    </div>
  );
}
