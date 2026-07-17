"use client";

/**
 * The onboarding backdrop: a lit retro-arcade game room where the props —
 * arcade cabinet, console, gamepad, cartridges, characters and accents — are
 * real 3D voxel objects that slowly bob and occasionally spin, with their
 * screens and LEDs glowing. A CPU-lit wall (see `lib/litBackdrop.ts`) fills the
 * viewport; the props are composited over it on an overlay canvas.
 *
 * The overlay uses WebGPU when the browser supports it (WebGpuVoxelRenderer) and
 * transparently falls back to the CPU compositor otherwise — the two share the
 * same voxel models, motion and lighting, so the scene is identical either way.
 * A separate canvas backs each path, since a canvas is locked to its first
 * context type.
 */

import { useEffect, useMemo, useRef } from "react";

import { buildRetroWall, orbitLight, renderBackdropFrame, wallPaletteFromChassis, type BackdropScene } from "@/lib/litBackdrop";
import { CpuVoxelCompositor } from "@/lib/cpuVoxelCompositor";
import { buildRetroProps, propSetToVoxelProps, type VoxelProp } from "@/lib/retroVoxels";
import { scaleVoxelProps } from "@/lib/voxelPropScale";
import { loadActiveSet } from "@/lib/backdropPropsStore";
import { WebGpuVoxelRenderer } from "./WebGpuVoxelRenderer";
import { useChassisColor } from "./chassisColor";
import styles from "./handheld.module.css";

// The backdrop renders into a low-resolution buffer that CSS upscales with
// nearest-neighbour. At the base 260×160, one buffer pixel spans several screen
// pixels, so a prop's slow vertical bob visibly *hops* a chunk of pixels per
// step. Rendering the whole scene at this integer multiple shrinks each buffer
// pixel, so the bob advances in fine sub-steps and glides; the composition is
// unchanged because the wall, light, and prop placement are all buffer-relative,
// and props keep their on-screen size via {@link scaleVoxelProps}. Raising this
// costs ~scale² more per frame, so it trades a little render budget for smooth
// motion — 2 is smooth while staying cheap.
const RESOLUTION_SCALE = 2;
const BUFFER_WIDTH = 260 * RESOLUTION_SCALE;
const BUFFER_HEIGHT = 160 * RESOLUTION_SCALE;
// Fixed tip toward the viewer that gives the props a 3/4 read.
const PROP_PITCH = 0.42;
// The orbit and bob are slow, so ~30fps looks identical to 60 at half the cost.
const FRAME_INTERVAL_MS = 33;
// The CPU compositor is the verified-on-every-device path; the WebGPU accelerator
// has never been runtime-verified on real hardware and can silently render blank
// on some GPUs (no throw, so it wouldn't fall back). Keep it off until verified.
const USE_WEBGPU = false;

// The page sits behind the lit-wall canvases; its base colour is a deep shade of
// the selected chassis so the whole viewport reads as e.g. dark blue for a blue
// handheld, making the bright chassis in front pop against a matching backdrop.
const BACKDROP_DARKEN = 0.22;

interface PropRenderer {
  render(seconds: number): void;
  destroy(): void;
}

/** A near-black shade of `#rrggbb` (its own hue, deeply dimmed) for the page base. */
function darkenChassis(hex: string): string {
  const value = Number.parseInt(hex.replace("#", ""), 16);
  if (Number.isNaN(value)) return "#05070b";
  const r = Math.round(((value >> 16) & 0xff) * BACKDROP_DARKEN);
  const g = Math.round(((value >> 8) & 0xff) * BACKDROP_DARKEN);
  const b = Math.round((value & 0xff) * BACKDROP_DARKEN);
  return `rgb(${r}, ${g}, ${b})`;
}

export function LitBackdrop() {
  const wallRef = useRef<HTMLCanvasElement>(null);
  const gpuRef = useRef<HTMLCanvasElement>(null);
  const cpuRef = useRef<HTMLCanvasElement>(null);

  // The wall tints to the selected chassis colour (no stars); rebuilding it on a
  // colour change is cheap, and a ref lets the running animation pick up the new
  // wall without tearing down the props/renderer.
  const { color } = useChassisColor();
  const wallScene = useMemo(
    () => buildRetroWall(BUFFER_WIDTH, BUFFER_HEIGHT, wallPaletteFromChassis(color), false),
    [color],
  );
  const wallSceneRef = useRef<BackdropScene>(wallScene);
  wallSceneRef.current = wallScene;

  // Repaint the wall whenever its palette changes, independent of the animation
  // loop — so selecting a premade re-tints the backdrop immediately even before
  // the props load, and even for reduced-motion visitors whose loop never runs.
  useEffect(() => {
    const wallCanvas = wallRef.current;
    if (!wallCanvas) return;
    const context = wallCanvas.getContext("2d");
    if (!context) return;
    wallCanvas.width = BUFFER_WIDTH;
    wallCanvas.height = BUFFER_HEIGHT;
    const buffer = new Uint8ClampedArray(BUFFER_WIDTH * BUFFER_HEIGHT * 4);
    renderBackdropFrame(wallScene, orbitLight(BUFFER_WIDTH, BUFFER_HEIGHT, 0), buffer);
    const image = context.createImageData(BUFFER_WIDTH, BUFFER_HEIGHT);
    image.data.set(buffer);
    context.putImageData(image, 0, 0);
  }, [wallScene]);

  useEffect(() => {
    const wallCanvas = wallRef.current;
    const gpuCanvas = gpuRef.current;
    const cpuCanvas = cpuRef.current;
    if (!wallCanvas || !gpuCanvas || !cpuCanvas) return;
    const wallContext = wallCanvas.getContext("2d");
    if (!wallContext) return;

    wallCanvas.width = BUFFER_WIDTH;
    wallCanvas.height = BUFFER_HEIGHT;
    const wallImage = wallContext.createImageData(BUFFER_WIDTH, BUFFER_HEIGHT);
    const wallBuffer = new Uint8ClampedArray(BUFFER_WIDTH * BUFFER_HEIGHT * 4);
    const compositorOptions = { bufferWidth: BUFFER_WIDTH, bufferHeight: BUFFER_HEIGHT, pitch: PROP_PITCH };

    // Reads the current wall (which the memo above swaps on a chassis-colour change).
    const paintWall = (seconds: number) => {
      renderBackdropFrame(wallSceneRef.current, orbitLight(BUFFER_WIDTH, BUFFER_HEIGHT, seconds), wallBuffer);
      wallImage.data.set(wallBuffer);
      wallContext.putImageData(wallImage, 0, 0);
    };

    // Show the wall immediately; props load (from the published/working set)
    // and their renderer initialise asynchronously.
    paintWall(0);

    let renderer: PropRenderer | null = null;
    let props: VoxelProp[] = [];
    let usingGpu = false;
    let frame = 0;
    let cancelled = false;
    let lastPaint = 0;
    const start = performance.now();
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    const loop = (now: number) => {
      if (now - lastPaint >= FRAME_INTERVAL_MS) {
        const seconds = (now - start) / 1000;
        paintWall(seconds);
        try {
          renderer?.render(seconds);
        } catch {
          // A device that reports WebGPU but fails to render: swap to the CPU
          // compositor once so the props keep animating.
          if (usingGpu) {
            renderer?.destroy();
            usingGpu = false;
            gpuCanvas.style.display = "none";
            cpuCanvas.style.display = "";
            renderer = new CpuVoxelCompositor(cpuCanvas, props, compositorOptions);
          }
        }
        lastPaint = now;
      }
      frame = window.requestAnimationFrame(loop);
    };

    void (async () => {
      const set = await loadActiveSet();
      if (cancelled) return;
      const authoredProps = set.props.length > 0 ? propSetToVoxelProps(set) : buildRetroProps();
      // Props are authored in base-buffer units; scale them to match the buffer.
      props = scaleVoxelProps(authoredProps, RESOLUTION_SCALE);

      // Motion-sensitive visitors get a single still frame (CPU, no GPU init).
      if (reducedMotion) {
        gpuCanvas.style.display = "none";
        paintWall(2.2);
        new CpuVoxelCompositor(cpuCanvas, props, compositorOptions).render(2.2);
        return;
      }

      const gpu = USE_WEBGPU ? await WebGpuVoxelRenderer.create(gpuCanvas, props, compositorOptions) : null;
      if (cancelled) {
        gpu?.destroy();
        return;
      }
      if (gpu) {
        cpuCanvas.style.display = "none";
        renderer = gpu;
        usingGpu = true;
      } else {
        gpuCanvas.style.display = "none";
        renderer = new CpuVoxelCompositor(cpuCanvas, props, compositorOptions);
      }
      frame = window.requestAnimationFrame(loop);
    })();

    return () => {
      cancelled = true;
      window.cancelAnimationFrame(frame);
      renderer?.destroy();
    };
  }, []);

  return (
    <div className={styles.backdrop} style={{ background: darkenChassis(color) }} aria-hidden>
      <canvas ref={wallRef} className={styles.backdropCanvas} />
      <canvas ref={gpuRef} className={styles.backdropCanvas} />
      <canvas ref={cpuRef} className={styles.backdropCanvas} />
    </div>
  );
}
