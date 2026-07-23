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

import { renderScene, CUBE_GEOMETRY, DEFAULT_MODEL_LIGHT, type ModelLight, type PlacedModel } from "@cartbox/editor";

import { applyHandheldConfig, applyOsScreen, buildWorldScene, sceneModelsAt, stepSnow } from "@/lib/worldScene";
import { renderOsApp, osReduce, initialOsState, type OsButton, type OsState } from "@/lib/cartboxOs";
import { saveHandheldChoice } from "@/lib/handheldChoice";
import { stepWalk, type WalkParams, type WalkState } from "@/lib/walkControls";
import { BuildLayer, screenToBuffer, unprojectScreen, type BlockColor, type WorldCamera } from "@/lib/worldEdit";

/** Native render resolution; the canvas is upscaled by CSS for a crisp pixel look. */
const RENDER = 380;
const WALK_PITCH = 0.5;
const OS_PITCH = 0.4; // flatter while reading the screen

/**
 * Render cadence, capped well below the display refresh: the scene is a CPU
 * software rasterizer, so every frame costs real main-thread time. Walking wants
 * responsiveness; the onboarding hold barely moves, so it runs slower still. The
 * loop also pauses entirely when the canvas is offscreen or the tab is hidden, so
 * an unwatched world stops burning the CPU (see the IntersectionObserver below).
 */
const WALK_FPS = 30;
const OS_FPS = 20;

/** How far (CSS px²) a pointer may travel before a tap becomes a look-drag. */
const TAP_SLOP_SQUARED = 6 * 6;

/** Extra lattice cells around the terrain footprint, so blocks can be built out. */
const BUILD_MARGIN = 8;
/** Extra vertical lattice above the terrain, so blocks can be stacked up. */
const BUILD_HEIGHT_HEADROOM = 32;

/** The colour a placed block is painted. A warm sandstone that reads on the terrain. */
const BLOCK_COLOR: BlockColor = { r: 214, g: 176, b: 122 };

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
    // Pick buffers turn a click into an edit: per pixel, which placed model won it
    // and which of that model's faces. Populated only while walking (the edit mode);
    // the depth buffer above supplies the surface distance the click unprojects to.
    const pickInstance = new Int32Array(RENDER * RENDER);
    const pickFace = new Int8Array(RENDER * RENDER);
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

    // The editable cube layer the player builds on top of the read-only world,
    // sized to the terrain footprint with margin to build outward and headroom to
    // stack up. Its model is rebuilt only on edit (see `applyEdit`), never per frame.
    const terrainModel = scene.terrain.model;
    const build = new BuildLayer(
      terrainModel.sizeX + BUILD_MARGIN * 2,
      terrainModel.sizeY + BUILD_HEIGHT_HEADROOM,
      terrainModel.sizeZ + BUILD_MARGIN * 2,
    );
    // What the last drawn frame projected with, so a click can unproject exactly.
    // `models` and `buildIndex` let a pick's model index name the object (and tell
    // a build block from terrain); `buildModel` caches the layer between edits.
    const lastFrame: {
      camera: WorldCamera | null;
      models: readonly PlacedModel[];
      buildIndex: number;
    } = { camera: null, models: [], buildIndex: -1 };
    let buildModel = build.toPlacedModel();

    const drawFrame = (
      baseModels: PlacedModel[],
      yaw: number,
      pitch: number,
      origin: readonly [number, number, number],
      withPick: boolean,
    ) => {
      // Append the build layer (if any) so it composites into the same depth buffer
      // and its face wins the pick where it is in front.
      const models = buildModel ? [...baseModels, buildModel] : baseModels;
      const buildIndex = buildModel ? models.length - 1 : -1;

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
        pickInstance: withPick ? pickInstance : undefined,
        pickFace: withPick ? pickFace : undefined,
      });
      image.data.set(out);
      tileContext.putImageData(image, 0, 0);
      context.fillStyle = sky;
      context.fillRect(0, 0, RENDER, RENDER);
      context.drawImage(tile, 0, 0);

      lastFrame.camera = { yaw, pitch, cell, centre: RENDER / 2, origin };
      lastFrame.models = models;
      lastFrame.buildIndex = buildIndex;
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
    // Distinguish a look-drag from a build tap: a pointer that barely moves between
    // down and up is a tap (place/remove a block); one that travels tilts the view.
    let pointerStartX = 0;
    let pointerStartY = 0;
    let pointerMoved = false;
    let pointerButton = 0;

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

    /**
     * Turn a tap into a build edit. The tapped pixel names a placed model and a
     * face (the pick buffers) and carries a surface depth (the depth buffer); the
     * camera the frame was drawn with unprojects that to a world point, and the
     * picked face's outward normal says which side was hit. Left tap places a block
     * in the empty neighbour; right tap removes the block tapped (terrain and props
     * are never removed — {@link BuildLayer.remove} no-ops off the build lattice).
     */
    const applyEdit = (event: PointerEvent, remove: boolean) => {
      if (os.mode !== "done") return; // building is a walk-mode action only
      const camera = lastFrame.camera;
      if (!camera) return;
      const rect = canvas.getBoundingClientRect();
      const buf = screenToBuffer(event.clientX - rect.left, event.clientY - rect.top, rect.width, rect.height, RENDER);
      if (!buf) return;
      const di = buf.py * RENDER + buf.px;
      const instance = pickInstance[di]!;
      if (instance < 0) return; // tapped the open sky
      const faceIndex = pickFace[di]!;
      if (faceIndex < 0) return;
      const placed = lastFrame.models[instance];
      if (!placed) return;
      const face = (placed.model.geometry ?? CUBE_GEOMETRY).faces[faceIndex];
      if (!face) return;

      const hit = unprojectScreen(buf.px + 0.5, buf.py + 0.5, depthBuffer[di]!, camera);
      const changed = remove
        ? build.remove(hit, face.normal)
        : build.place(hit, face.normal, BLOCK_COLOR);
      if (changed) {
        buildModel = build.toPlacedModel();
        requestRender(); // reflect the edit even between capped frames
      }
    };

    const onPointerDown = (event: PointerEvent) => {
      dragging = true;
      pointerMoved = false;
      pointerButton = event.button;
      pointerStartX = event.clientX;
      pointerStartY = event.clientY;
      lastPointerY = event.clientY;
      canvas.setPointerCapture(event.pointerId);
    };
    const onPointerMove = (event: PointerEvent) => {
      if (!dragging) return;
      const dx = event.clientX - pointerStartX;
      const dy = event.clientY - pointerStartY;
      if (dx * dx + dy * dy > TAP_SLOP_SQUARED) pointerMoved = true;
      view.dragPitch = Math.max(-0.2, Math.min(1.1, view.dragPitch + (event.clientY - lastPointerY) * 0.006));
      lastPointerY = event.clientY;
    };
    const onPointerUp = (event: PointerEvent) => {
      if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
      const wasTap = dragging && !pointerMoved;
      dragging = false;
      if (wasTap) applyEdit(event, pointerButton === 2); // secondary button removes
    };
    const onContextMenu = (event: MouseEvent) => {
      event.preventDefault(); // free the right button for block removal
    };
    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerup", onPointerUp);
    canvas.addEventListener("contextmenu", onContextMenu);

    const teardown = () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerup", onPointerUp);
      canvas.removeEventListener("contextmenu", onContextMenu);
    };

    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      drawFrame(sceneModelsAt(scene, 0), 0, OS_PITCH, [heroBase[0], heroBase[1], heroBase[2]], false);
      return teardown;
    }

    let frame = 0;
    let lastDraw = 0;
    let forceRender = false;
    let onScreen = true; // toggled by the IntersectionObserver below
    let osFrozen = false; // the OS screen is drawn once more on entering walk mode, then held
    const start = performance.now();
    // Skip the frame-rate cap for one tick, so an edit shows immediately.
    const requestRender = () => {
      forceRender = true;
    };

    const loop = (now: number) => {
      // Pause entirely when the canvas is offscreen or the tab is hidden: the
      // software rasterizer is pure main-thread cost, and an unwatched world should
      // not burn it. `resume()` restarts the loop when the canvas is seen again.
      if (!onScreen || document.hidden) {
        frame = 0;
        return;
      }
      frame = window.requestAnimationFrame(loop);

      const walking = os.mode === "done";
      // Cap the cadence well under the display refresh — walking wants response, the
      // onboarding hold barely moves — so each expensive render is spaced out.
      const interval = 1000 / (walking ? WALK_FPS : OS_FPS);
      if (!forceRender && now - lastDraw < interval) return;
      forceRender = false;
      const delta = Math.min(0.05, (now - lastDraw) / 1000);
      lastDraw = now;
      const seconds = (now - start) / 1000;

      stepSnow(scene.snow, scene.snowBounds, delta, Math.random);
      // Drive the OS only while it is the focus. Once the handheld is chosen the
      // menu is gone and its framebuffer is static, so draw it one final time on
      // entering walk mode and then stop re-rendering it every frame.
      if (!walking || !osFrozen) {
        renderOsApp(scene.osFramebuffer, os, seconds);
        applyOsScreen(scene.hero, scene.osFramebuffer);
        applyHandheldConfig(scene.hero, os.config);
        if (walking) osFrozen = true;
      }

      let yaw: number;
      let pitch: number;
      let origin: readonly [number, number, number];
      let models: PlacedModel[];
      if (!walking) {
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

      drawFrame(models, yaw, pitch, origin, walking);
    };

    // Resume the loop if it stopped itself while hidden; a no-op if already running.
    const resume = () => {
      if (frame || !onScreen || document.hidden) return;
      lastDraw = performance.now() - 1000 / WALK_FPS; // draw promptly on return
      frame = window.requestAnimationFrame(loop);
    };

    // Track on-screen visibility so a scrolled-away world stops rendering.
    const observer = new IntersectionObserver(
      (entries) => {
        onScreen = entries[0]?.isIntersecting ?? true;
        if (onScreen) resume();
      },
      { threshold: 0.05 },
    );
    observer.observe(canvas);
    const onVisibility = () => resume();
    document.addEventListener("visibilitychange", onVisibility);

    frame = window.requestAnimationFrame(loop);

    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      observer.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
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
