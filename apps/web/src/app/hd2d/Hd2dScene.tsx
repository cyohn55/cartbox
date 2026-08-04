"use client";

/**
 * The /hd2d canvas — a playable HD-2D (Octopath × REPLACED) street. The world is
 * true 3D voxel geometry wearing pixel-art materials; the hero is a 2D sprite split
 * into depth layers that parallax as the fixed ¾ camera follows the walk. Arrow keys
 * / WASD walk; the camera tracks the character while the neon street scrolls past.
 *
 * A thin React adapter over the pure modules in @/lib/hd2d: this component only owns
 * the canvas, the input state, and the animation loop — the render and the walk math
 * live in scene.ts / walk.ts so they stay testable and framework-free.
 */

import { useEffect, useRef } from "react";
import { renderFrame, getWorld, YAW } from "@/lib/hd2d/scene";
import { stepCharacter, type CharState, type WalkKeys } from "@/lib/hd2d/walk";

/** Native square render size; CSS upscales it with nearest-neighbour for crisp pixels. */
const RENDER = 340;
/** Cap the software rasterizer's cadence so it stays smooth without pinning a core. */
const FRAME_MS = 1000 / 30;

const KEY_BINDINGS: Record<string, keyof WalkKeys> = {
  ArrowLeft: "left", KeyA: "left", ArrowRight: "right", KeyD: "right",
  ArrowUp: "up", KeyW: "up", ArrowDown: "down", KeyS: "down",
};

export function Hd2dScene() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.width = RENDER;
    canvas.height = RENDER;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const image = ctx.createImageData(RENDER, RENDER);

    const world = getWorld();
    let char: CharState = { pos: [world.start[0], world.start[1], world.start[2]], facing: 1, walkPhase: 0, moving: false };
    // A mutable held-key set; a plain object (not the readonly WalkKeys) so the
    // handlers can flip flags, and it satisfies WalkKeys when passed to stepCharacter.
    const keys: Record<keyof WalkKeys, boolean> = { left: false, right: false, up: false, down: false };

    const onKeyDown = (e: KeyboardEvent) => {
      const bound = KEY_BINDINGS[e.code];
      if (bound) { keys[bound] = true; e.preventDefault(); }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      const bound = KEY_BINDINGS[e.code];
      if (bound) keys[bound] = false;
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);

    let raf = 0;
    let last = performance.now();
    let accumulator = 0;
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      const elapsed = now - last;
      last = now;
      accumulator += elapsed;
      if (accumulator < FRAME_MS) return; // throttle to the target cadence
      const deltaSeconds = Math.min(0.05, accumulator / 1000);
      accumulator = 0;
      char = stepCharacter(char, keys, deltaSeconds, { speed: 8, yaw: YAW, bounds: world.bounds, stride: 10 });
      image.data.set(renderFrame(RENDER, char));
      ctx.putImageData(image, 0, 0);
    };
    raf = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      aria-label="HD-2D street — arrow keys or WASD to walk"
      style={{
        width: "min(100%, 640px)",
        aspectRatio: "1 / 1",
        imageRendering: "pixelated",
        borderRadius: 8,
        background: "#06080f",
        touchAction: "none",
      }}
    />
  );
}
