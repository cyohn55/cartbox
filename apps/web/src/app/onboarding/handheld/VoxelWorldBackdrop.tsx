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

// The world renders at the canvas's actual on-screen size so the cube edges stay
// crisp (rendering into a small buffer and upscaling is what made them blurry and
// shimmery). To keep the per-frame cost bounded on very large or high-DPI
// displays, the render resolution is capped here; beyond the cap the browser
// upscales the buffer with nearest-neighbour (see `.backdropCanvas`), which keeps
// the blocks crisp rather than smearing them.
const MAX_RENDER_WIDTH = 1920;
const MAX_RENDER_HEIGHT = 1080;
// The rotation is slow, so ~30fps looks identical to 60 at half the cost.
const FRAME_INTERVAL_MS = 33;
// A calm three-quarter view for motion-sensitive visitors' single still frame.
const STILL_FRAME_SECONDS = 6.4;

/** The buffer size to render at: the viewport, scaled down to fit the caps. */
function renderBufferSize(): { width: number; height: number } {
  const viewportWidth = Math.max(1, window.innerWidth);
  const viewportHeight = Math.max(1, window.innerHeight);
  const scale = Math.min(1, MAX_RENDER_WIDTH / viewportWidth, MAX_RENDER_HEIGHT / viewportHeight);
  return {
    width: Math.round(viewportWidth * scale),
    height: Math.round(viewportHeight * scale),
  };
}

export function VoxelWorldBackdrop() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // The foreground layer: the near-side of the world, drawn *over* the handhelds
  // so trees pass in front of them (they sit amongst the world, not before it).
  const frontCanvasRef = useRef<HTMLCanvasElement>(null);
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
    const frontCanvas = frontCanvasRef.current;
    if (!canvas || !frontCanvas) return;

    // The island geometry is independent of the canvas size, so it is built once
    // and reused when the renderer is rebuilt on a resize.
    const model = buildWorldModel();
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    // (Re)build the renderer at the current display resolution, disposing any
    // previous one, and paint the current frame so a resize never shows a blank.
    const rebuild = () => {
      const { width, height } = renderBufferSize();
      rendererRef.current?.destroy();
      const renderer = new VoxelWorldRenderer(canvas, frontCanvas, model, {
        bufferWidth: width,
        bufferHeight: height,
        skyTop: skyRef.current.top,
        skyHorizon: skyRef.current.horizon,
      });
      rendererRef.current = renderer;
      renderer.render(lastSecondsRef.current);
    };

    lastSecondsRef.current = reducedMotion ? STILL_FRAME_SECONDS : 0;
    rebuild();

    // Rebuild on resize, coalescing bursts to the next frame so a drag resizes
    // once it settles rather than reallocating buffers on every pixel.
    let resizeFrame = 0;
    const onResize = () => {
      window.cancelAnimationFrame(resizeFrame);
      resizeFrame = window.requestAnimationFrame(rebuild);
    };
    window.addEventListener("resize", onResize);

    // Motion-sensitive visitors get a single still frame (already painted above).
    if (reducedMotion) {
      return () => {
        window.removeEventListener("resize", onResize);
        window.cancelAnimationFrame(resizeFrame);
        rendererRef.current?.destroy();
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
        rendererRef.current?.render(seconds);
        lastPaint = now;
      }
      frame = window.requestAnimationFrame(loop);
    };
    frame = window.requestAnimationFrame(loop);

    return () => {
      window.removeEventListener("resize", onResize);
      window.cancelAnimationFrame(resizeFrame);
      window.cancelAnimationFrame(frame);
      rendererRef.current?.destroy();
      rendererRef.current = null;
    };
  }, []);

  return (
    <>
      <div className={styles.backdrop} style={{ background: sky.horizon }} aria-hidden>
        <canvas ref={canvasRef} className={styles.backdropCanvas} />
      </div>
      {/* Drawn over the handhelds (see .foreground z-index); only the near-side
          voxels land here, so trees pass in front of the handhelds. */}
      <canvas ref={frontCanvasRef} className={styles.foreground} aria-hidden />
    </>
  );
}
