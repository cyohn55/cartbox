"use client";

/**
 * Read-only avatar render. Draws a normalized {@link AvatarSpec} onto a canvas —
 * used on public profiles and (later) next to leaderboard rows and comments.
 */

import { useEffect, useRef } from "react";

import { normalizeAvatar } from "@/lib/avatar";
import { PREVIEW_SIZE, drawAvatar } from "@/lib/avatarRender";

interface AvatarPreviewProps {
  /** The stored avatar_json (any shape; normalized before drawing). */
  avatar: unknown;
  /** On-screen size in CSS pixels. */
  size?: number;
}

export function AvatarPreview({ avatar, size = 96 }: AvatarPreviewProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const ctx = canvasRef.current?.getContext("2d");
    if (ctx) {
      drawAvatar(ctx, normalizeAvatar(avatar));
    }
  }, [avatar]);

  return (
    <canvas
      ref={canvasRef}
      width={PREVIEW_SIZE}
      height={PREVIEW_SIZE}
      style={{ width: size, height: size, imageRendering: "pixelated", background: "#241f38", borderRadius: 12 }}
    />
  );
}
