"use client";

/**
 * The onboarding backdrop: a lit, material-mapped pixel-art retro-arcade scene
 * rendered to a small canvas and upscaled to fill the viewport behind the
 * picker. Original pixel-art props — an arcade cabinet, console, gamepad,
 * cartridges and characters — sit on a night-lit game-room wall, all relit each
 * frame by a light on a slow orbit (no cursor tracking) so the surface reads as
 * dimensional and playful without pulling focus from the form on top. All the
 * shading is CPU — see `lib/litBackdrop.ts` — so there is no WebGL dependency.
 */

import { useEffect, useRef } from "react";

import { buildRetroScene, orbitLight, renderBackdropFrame } from "@/lib/litBackdrop";
import styles from "./handheld.module.css";

// Low-resolution buffer; CSS upscales it with nearest-neighbour for crisp
// pixels. Sized for enough room to read the props without heavy CPU cost.
const BUFFER_WIDTH = 260;
const BUFFER_HEIGHT = 160;
// The orbit is slow, so ~30fps looks identical to 60 and halves the CPU cost.
const FRAME_INTERVAL_MS = 33;

export function LitBackdrop() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext("2d");
    if (!context) return;

    canvas.width = BUFFER_WIDTH;
    canvas.height = BUFFER_HEIGHT;
    const scene = buildRetroScene(BUFFER_WIDTH, BUFFER_HEIGHT);
    const image = context.createImageData(BUFFER_WIDTH, BUFFER_HEIGHT);
    const buffer = new Uint8ClampedArray(BUFFER_WIDTH * BUFFER_HEIGHT * 4);

    const paint = (seconds: number) => {
      renderBackdropFrame(scene, orbitLight(BUFFER_WIDTH, BUFFER_HEIGHT, seconds), buffer);
      image.data.set(buffer);
      context.putImageData(image, 0, 0);
    };

    // Motion-sensitive visitors get a single still frame.
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      paint(2.2);
      return;
    }

    let frame = 0;
    let lastPaint = 0;
    const start = performance.now();
    const loop = (now: number) => {
      if (now - lastPaint >= FRAME_INTERVAL_MS) {
        paint((now - start) / 1000);
        lastPaint = now;
      }
      frame = window.requestAnimationFrame(loop);
    };
    frame = window.requestAnimationFrame(loop);
    return () => window.cancelAnimationFrame(frame);
  }, []);

  return (
    <div className={styles.backdrop} aria-hidden>
      <canvas ref={canvasRef} className={styles.backdropCanvas} />
    </div>
  );
}
