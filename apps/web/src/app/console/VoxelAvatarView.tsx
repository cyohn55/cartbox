"use client";

/**
 * Renders a voxel avatar on a slowly rotating turntable. Pure canvas 2D —
 * the projection/painter math lives in lib/voxelRender.
 */

import { useEffect, useMemo, useRef } from "react";

import { buildAvatarVoxels, type VoxelAvatarSpec } from "@/lib/voxelAvatar";
import { drawVoxels } from "@/lib/voxelRender";

interface VoxelAvatarViewProps {
  spec: VoxelAvatarSpec;
  /** Canvas size in CSS pixels. */
  size?: number;
  /** Radians per frame; 0 freezes the turntable. */
  spin?: number;
}

export function VoxelAvatarView({ spec, size = 140, spin = 0.012 }: VoxelAvatarViewProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const voxels = useMemo(() => buildAvatarVoxels(spec), [spec]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) {
      return;
    }
    const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = size * pixelRatio;
    canvas.height = size * pixelRatio;
    const scale = (size * pixelRatio) / 34; // body ≈ 15 wide + spin margin

    let angle = -0.4;
    let raf = 0;
    const frame = () => {
      // Feet sit near screenY 0 and the head around -21 units, so the
      // vertical anchor lives low in the frame.
      drawVoxels(context, voxels, angle, {
        width: canvas.width,
        height: canvas.height,
        scale,
        centerY: 0.82,
      });
      angle += spin;
      if (spin !== 0) {
        raf = requestAnimationFrame(frame);
      }
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [voxels, size, spin]);

  return (
    <canvas
      ref={canvasRef}
      style={{ width: size, height: size }}
      data-testid="voxel-avatar"
      aria-label="Player avatar"
    />
  );
}
