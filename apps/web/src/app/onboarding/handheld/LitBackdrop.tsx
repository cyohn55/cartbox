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

import { useEffect, useRef } from "react";

import { buildRetroWall, orbitLight, renderBackdropFrame } from "@/lib/litBackdrop";
import { CpuVoxelCompositor } from "@/lib/cpuVoxelCompositor";
import { buildRetroProps } from "@/lib/retroVoxels";
import { WebGpuVoxelRenderer } from "./WebGpuVoxelRenderer";
import styles from "./handheld.module.css";

// Low-resolution buffer; CSS upscales it with nearest-neighbour for crisp
// pixels. The overlay canvases share these dimensions so props stay aligned.
const BUFFER_WIDTH = 260;
const BUFFER_HEIGHT = 160;
// Fixed tip toward the viewer that gives the props a 3/4 read.
const PROP_PITCH = 0.42;
// The orbit and bob are slow, so ~30fps looks identical to 60 at half the cost.
const FRAME_INTERVAL_MS = 33;

interface PropRenderer {
  render(seconds: number): void;
  destroy(): void;
}

export function LitBackdrop() {
  const wallRef = useRef<HTMLCanvasElement>(null);
  const gpuRef = useRef<HTMLCanvasElement>(null);
  const cpuRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const wallCanvas = wallRef.current;
    const gpuCanvas = gpuRef.current;
    const cpuCanvas = cpuRef.current;
    if (!wallCanvas || !gpuCanvas || !cpuCanvas) return;
    const wallContext = wallCanvas.getContext("2d");
    if (!wallContext) return;

    wallCanvas.width = BUFFER_WIDTH;
    wallCanvas.height = BUFFER_HEIGHT;
    const wallScene = buildRetroWall(BUFFER_WIDTH, BUFFER_HEIGHT);
    const wallImage = wallContext.createImageData(BUFFER_WIDTH, BUFFER_HEIGHT);
    const wallBuffer = new Uint8ClampedArray(BUFFER_WIDTH * BUFFER_HEIGHT * 4);
    const props = buildRetroProps();
    const compositorOptions = { bufferWidth: BUFFER_WIDTH, bufferHeight: BUFFER_HEIGHT, pitch: PROP_PITCH };

    const paintWall = (seconds: number) => {
      renderBackdropFrame(wallScene, orbitLight(BUFFER_WIDTH, BUFFER_HEIGHT, seconds), wallBuffer);
      wallImage.data.set(wallBuffer);
      wallContext.putImageData(wallImage, 0, 0);
    };

    // Motion-sensitive visitors get a single still frame (CPU, no GPU init).
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      gpuCanvas.style.display = "none";
      paintWall(2.2);
      new CpuVoxelCompositor(cpuCanvas, props, compositorOptions).render(2.2);
      return;
    }

    paintWall(0);

    let renderer: PropRenderer | null = null;
    let usingGpu = false;
    let frame = 0;
    let cancelled = false;
    let lastPaint = 0;
    const start = performance.now();

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
      const gpu = await WebGpuVoxelRenderer.create(gpuCanvas, props, compositorOptions);
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
    <div className={styles.backdrop} aria-hidden>
      <canvas ref={wallRef} className={styles.backdropCanvas} />
      <canvas ref={gpuRef} className={styles.backdropCanvas} />
      <canvas ref={cpuRef} className={styles.backdropCanvas} />
    </div>
  );
}
