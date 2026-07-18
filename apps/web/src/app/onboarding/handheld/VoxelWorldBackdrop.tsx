"use client";

/**
 * The onboarding backdrop: a Minecraft-style voxel world — a chunk of blocky
 * terrain with grass hills, cliff strata, trees and ponds — turning slowly behind
 * the "Choose your handheld" UI, under a sky tinted to the selected chassis.
 *
 * The island geometry (voxelWorld.ts) is built once on mount; each frame the
 * renderer (voxelWorldRenderer.ts) draws it at the current yaw over the sky. All
 * of it runs on the CPU 2D canvas — the same guaranteed-everywhere path the retro
 * props backdrop settled on — so there is no GPU code path to fall back from.
 */

import { useEffect, useMemo, useRef } from "react";

import { buildWorldModel } from "@/lib/voxelWorld";
import { skyGradientFromChassis } from "@/lib/voxelWorldSpecs";
import { VoxelWorldRenderer } from "@/lib/voxelWorldRenderer";
import { useChassisColor } from "./chassisColor";
import styles from "./handheld.module.css";

// The world renders into a low-resolution buffer that CSS upscales with
// nearest-neighbour, keeping the blocks crisp. This size balances detail against
// the per-frame cost of re-projecting the island's visible shell.
const BUFFER_WIDTH = 520;
const BUFFER_HEIGHT = 320;
// The rotation is slow, so ~30fps looks identical to 60 at half the cost.
const FRAME_INTERVAL_MS = 33;
// A calm three-quarter view for motion-sensitive visitors' single still frame.
const STILL_FRAME_SECONDS = 6.4;

export function VoxelWorldBackdrop() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<VoxelWorldRenderer | null>(null);
  // The most recent frame time, so a chassis-colour change can retint and redraw
  // immediately without waiting for the next animation tick.
  const lastSecondsRef = useRef(0);

  const { color } = useChassisColor();
  const sky = useMemo(() => skyGradientFromChassis(color), [color]);
  const skyRef = useRef(sky);
  skyRef.current = sky;

  // Retint the sky the moment the selected chassis changes, redrawing the current
  // frame so the change is instant even for a reduced-motion still.
  useEffect(() => {
    const renderer = rendererRef.current;
    if (!renderer) return;
    renderer.setSky(sky.top, sky.horizon);
    renderer.render(lastSecondsRef.current);
  }, [sky]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const model = buildWorldModel();
    const renderer = new VoxelWorldRenderer(canvas, model, {
      bufferWidth: BUFFER_WIDTH,
      bufferHeight: BUFFER_HEIGHT,
      skyTop: skyRef.current.top,
      skyHorizon: skyRef.current.horizon,
    });
    rendererRef.current = renderer;

    // Motion-sensitive visitors get a single still frame of the world.
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      lastSecondsRef.current = STILL_FRAME_SECONDS;
      renderer.render(STILL_FRAME_SECONDS);
      return () => {
        renderer.destroy();
        rendererRef.current = null;
      };
    }

    let frame = 0;
    let lastPaint = 0;
    const start = performance.now();
    const loop = (now: number) => {
      if (now - lastPaint >= FRAME_INTERVAL_MS) {
        const seconds = (now - start) / 1000;
        lastSecondsRef.current = seconds;
        renderer.render(seconds);
        lastPaint = now;
      }
      frame = window.requestAnimationFrame(loop);
    };
    frame = window.requestAnimationFrame(loop);

    return () => {
      window.cancelAnimationFrame(frame);
      renderer.destroy();
      rendererRef.current = null;
    };
  }, []);

  return (
    <div className={styles.backdrop} style={{ background: sky.horizon }} aria-hidden>
      <canvas ref={canvasRef} className={styles.backdropCanvas} />
    </div>
  );
}
