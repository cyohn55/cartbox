"use client";

/**
 * The /world canvas: the onboarding world. The centre handheld boots the Cartbox
 * OS on its screen; the player drives it with the d-pad and A/B/Start to reach the
 * Make·Play·Share menu, customize the handheld (body/buttons/screen colours), and
 * confirm with "PICK". On confirm the flanking handhelds disappear and the player
 * walks the world — all three primitives (hexel terrain, voxel objects, pixel
 * snow) composited into one camera throughout.
 *
 * An input-router mode stack ties it together: while the OS is up, keys are OS
 * buttons and the camera holds on the hero so the screen is readable; once the
 * handheld is chosen, keys become walk input and the camera drops into the world.
 * Reduced motion draws a single still frame.
 */

import { useEffect, useRef } from "react";

import { renderScene, DEFAULT_MODEL_LIGHT, type ModelLight, type PlacedModel } from "@cartbox/editor";

import { applyHandheldConfig, applyOsScreen, buildWorldScene, sceneModelsAt, stepSnow } from "@/lib/worldScene";
import { renderOsApp, osReduce, initialOsState, type OsButton, type OsState } from "@/lib/cartboxOs";
import { saveHandheldChoice } from "@/lib/handheldChoice";
import { stepWalk, type WalkParams, type WalkState } from "@/lib/walkControls";

/** Native render resolution; the canvas is upscaled by CSS for a crisp pixel look. */
const RENDER = 380;
const WALK_PITCH = 0.5;
const OS_PITCH = 0.4; // flatter while reading the screen

/** A low sun that rakes the terrain so the hexel slopes read. */
const WORLD_LIGHT: ModelLight = {
  ...DEFAULT_MODEL_LIGHT,
  direction: [0.5, 0.62, 0.6],
  ambient: 0.34,
};

/** Keys that walk (once the handheld is chosen), mapped in the loop. */
const FORWARD_KEYS = new Set(["arrowup", "w"]);
const BACK_KEYS = new Set(["arrowdown", "s"]);
const LEFT_KEYS = new Set(["arrowleft", "a"]);
const RIGHT_KEYS = new Set(["arrowright", "d"]);
const STRAFE_LEFT_KEYS = new Set(["q"]);
const STRAFE_RIGHT_KEYS = new Set(["e"]);
const MOVEMENT_KEYS = new Set([
  ...FORWARD_KEYS,
  ...BACK_KEYS,
  ...LEFT_KEYS,
  ...RIGHT_KEYS,
  ...STRAFE_LEFT_KEYS,
  ...STRAFE_RIGHT_KEYS,
]);

/** Map a keyboard key to an OS button while the OS has focus. */
function osButtonFor(key: string): OsButton | null {
  switch (key) {
    case "arrowup":
      return "up";
    case "arrowdown":
      return "down";
    case "arrowleft":
      return "left";
    case "arrowright":
      return "right";
    case "z":
    case " ":
      return "a";
    case "x":
      return "b";
    case "enter":
      return "start";
    default:
      return null;
  }
}

export function WorldDemo() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext("2d");
    if (!context) return;

    canvas.width = RENDER;
    canvas.height = RENDER;

    const scene = buildWorldScene();
    const cell = Math.max(1, Math.floor(RENDER / (scene.fitSpan * 1.3)));
    const centreFloater = scene.floaters[Math.floor(scene.floaters.length / 2)]!;
    const heroBase = centreFloater.base;

    // Reused across frames: the compositor's buffers and a tile to blit through.
    const out = new Uint8ClampedArray(RENDER * RENDER * 4);
    const depthBuffer = new Float32Array(RENDER * RENDER);
    const tile = document.createElement("canvas");
    tile.width = RENDER;
    tile.height = RENDER;
    const tileContext = tile.getContext("2d");
    if (!tileContext) return;
    const image = tileContext.createImageData(RENDER, RENDER);

    const sky = context.createLinearGradient(0, 0, 0, RENDER);
    sky.addColorStop(0, "#1b2a4a");
    sky.addColorStop(0.55, "#3d5a86");
    sky.addColorStop(1, "#7c93b8");

    const drawFrame = (
      models: PlacedModel[],
      yaw: number,
      pitch: number,
      origin: readonly [number, number, number],
    ) => {
      renderScene(models, {
        size: RENDER,
        cell,
        yaw,
        pitch,
        origin,
        light: WORLD_LIGHT,
        particles: scene.snow,
        out,
        depthBuffer,
      });
      image.data.set(out);
      tileContext.putImageData(image, 0, 0);
      context.fillStyle = sky;
      context.fillRect(0, 0, RENDER, RENDER);
      context.drawImage(tile, 0, 0);
    };

    const walkParams: WalkParams = {
      moveSpeed: 11,
      turnSpeed: 1.7,
      bounds: {
        radiusX: (scene.terrain.model.sizeX / 2) * 0.85,
        radiusZ: (scene.terrain.model.sizeZ / 2) * 0.85,
      },
    };

    // Mode-stack state: the OS drives menu/customize; walk state takes over on
    // "done"; drag tilts the view; `pressed` holds walk keys.
    let os: OsState = initialOsState();
    let walk: WalkState = { origin: [0, scene.lookY, 0], yaw: 0 };
    const view = { dragPitch: 0, lastYaw: 0, lastOrigin: [heroBase[0], heroBase[1], heroBase[2]] as readonly [number, number, number] };
    const pressed = new Set<string>();
    let dragging = false;
    let lastPointerY = 0;

    const axis = (positive: Set<string>, negative: Set<string>): number => {
      let value = 0;
      for (const key of pressed) {
        if (positive.has(key)) value += 1;
        if (negative.has(key)) value -= 1;
      }
      return Math.max(-1, Math.min(1, value));
    };

    const onKeyDown = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase();
      if (os.mode !== "done") {
        const button = osButtonFor(key);
        if (!button) return;
        event.preventDefault();
        if (event.repeat) return; // one press = one step through the UI
        os = osReduce(os, button);
        if (os.mode === "done") {
          // Persist the chosen handheld (same store as onboarding), then hand the
          // camera to the player from where the OS view left it.
          saveHandheldChoice(os.config);
          walk = { origin: view.lastOrigin, yaw: view.lastYaw };
        }
        return;
      }
      if (!MOVEMENT_KEYS.has(key)) return;
      event.preventDefault();
      pressed.add(key);
    };
    const onKeyUp = (event: KeyboardEvent) => {
      pressed.delete(event.key.toLowerCase());
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);

    const onPointerDown = (event: PointerEvent) => {
      dragging = true;
      lastPointerY = event.clientY;
      canvas.setPointerCapture(event.pointerId);
    };
    const onPointerMove = (event: PointerEvent) => {
      if (!dragging) return;
      view.dragPitch = Math.max(-0.2, Math.min(1.1, view.dragPitch + (event.clientY - lastPointerY) * 0.006));
      lastPointerY = event.clientY;
    };
    const onPointerUp = (event: PointerEvent) => {
      dragging = false;
      if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    };
    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerup", onPointerUp);

    const teardown = () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerup", onPointerUp);
    };

    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      drawFrame(sceneModelsAt(scene, 0), 0, OS_PITCH, [heroBase[0], heroBase[1], heroBase[2]]);
      return teardown;
    }

    let frame = 0;
    let last = performance.now();
    const start = last;
    const loop = (now: number) => {
      const seconds = (now - start) / 1000;
      const delta = Math.min(0.05, (now - last) / 1000);
      last = now;

      stepSnow(scene.snow, scene.snowBounds, delta, Math.random);
      // Boot + drive the OS, and mirror its state onto the hero handheld.
      renderOsApp(scene.osFramebuffer, os, seconds);
      applyOsScreen(scene.hero, scene.osFramebuffer);
      applyHandheldConfig(scene.hero, os.config);

      let yaw: number;
      let pitch: number;
      let origin: readonly [number, number, number];
      let models: PlacedModel[];
      if (os.mode !== "done") {
        // Hold on the hero, swaying gently, so the screen stays readable.
        yaw = 0.06 * Math.sin(seconds * 0.5);
        pitch = OS_PITCH + view.dragPitch;
        origin = [heroBase[0], heroBase[1], heroBase[2]];
        models = sceneModelsAt(scene, seconds);
      } else {
        const input = {
          forward: axis(FORWARD_KEYS, BACK_KEYS),
          strafe: axis(STRAFE_RIGHT_KEYS, STRAFE_LEFT_KEYS),
          turn: axis(RIGHT_KEYS, LEFT_KEYS),
        };
        walk = stepWalk(walk, input, delta, walkParams);
        yaw = walk.yaw;
        pitch = WALK_PITCH + view.dragPitch;
        origin = walk.origin;
        models = sceneModelsAt(scene, seconds, true); // siblings gone
      }
      view.lastYaw = yaw;
      view.lastOrigin = origin;

      drawFrame(models, yaw, pitch, origin);
      frame = window.requestAnimationFrame(loop);
    };
    frame = window.requestAnimationFrame(loop);

    return () => {
      window.cancelAnimationFrame(frame);
      teardown();
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      tabIndex={0}
      style={{
        width: "min(100%, 560px)",
        aspectRatio: "1 / 1",
        imageRendering: "pixelated",
        borderRadius: 12,
        touchAction: "none",
        cursor: "grab",
        boxShadow: "0 12px 40px rgba(0,0,0,0.35)",
      }}
      aria-label="Onboarding world: customise the handheld in its OS, then walk the world"
    />
  );
}
