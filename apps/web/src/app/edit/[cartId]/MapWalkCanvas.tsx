"use client";

/**
 * Walking the map: a first-person view you move through and build in, the way a
 * block game is played.
 *
 * The orbit view looks *at* the map from outside; this one puts the camera in it.
 * That is not a camera setting — an orthographic projection has no inside — so
 * this needs a true perspective view, and it renders one two ways:
 *
 * - **On the GPU**, when the browser has one. The window of the map around you is
 *   uploaded as a surface once and redrawn in hardware, at the canvas's own
 *   resolution, with the materials the editor authors: normals, height, specular,
 *   roughness and emissive. This is the path that makes a generated landscape
 *   walkable rather than a slideshow.
 * - **By casting a ray per pixel** otherwise, into a small square frame that is
 *   scaled up. Correct, self-contained, and slow — which is why it is the
 *   fallback and no longer the plan.
 *
 * Both agree about where the camera is and what the crosshair is on, because both
 * read the camera basis from one place and both resolve a pick by marching the
 * same ray through the same space.
 *
 * Controls are the ones every voxel game shares, so nothing has to be learned:
 * click to capture the mouse and look around, W A S D to move, Space and Shift
 * for up and down, click to build and right-click to break. Movement is free
 * rather than gravity-bound — an editor is not a game, and being unable to reach
 * the underside of your own bridge would be absurd — with a Stand control that
 * drops you onto the ground when you want to feel the terrain.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DEFAULT_MODEL_LIGHT,
  MapVoxelSpace,
  castMapRay,
  cellContaining,
  firstPersonBasis,
  geometryFor,
  mapSpaceToModel,
  perspectiveProjection,
  renderMapFirstPerson,
  screenRay,
  walkAxes,
  type MapCellKind,
  type MapWindow,
  type SpriteSheet,
  type TextureAtlas,
} from "@cartbox/editor";

import styles from "./editor.module.css";
import type { PaintSurface } from "./paintSurface";
import { type MapSpaceTool } from "./maptools";
import {
  applySpaceTool,
  targetOfTool,
  type SpacePick,
  type SpaceToolResult,
} from "./mapSpaceTools";
import { useLiveValue } from "./useLiveValue";
import { useMapGpu, type MapGpuStatus } from "./useMapGpu";

/** Vertical field of view, in radians — close to what a block game shows. */
const FOV = 1.22;

/** How high above the ground the eye sits when standing, in cells. */
const EYE_HEIGHT = 1.7;

/** Cells per second walked, and the multiplier while a run key is held. */
const WALK_SPEED = 7;
const RUN_MULTIPLIER = 3;

/** Radians of look per pixel of mouse movement, once the pointer is captured. */
const LOOK_SPEED = 0.0026;

/** Pitch stops just short of straight up and down so the view never inverts. */
const PITCH_LIMIT = Math.PI / 2 - 0.02;

/** How far a ray travels before giving up, in cells. */
const VIEW_DISTANCE = 72;

/**
 * Half-width of the window built for the hardware path, and how far you may
 * stray from its centre before it is rebuilt. Generous, because the cost of a
 * rebuild tracks the *whole* map (the cells are stored sparsely and iterated in
 * full) rather than the window, so a wide window is nearly free while a narrow
 * one would rebuild constantly.
 */
const GPU_RADIUS = 48;
const GPU_RECENTRE = 16;

/** Where the view fades into the sky, so the window's edge is haze, not a cliff. */
const FOG_DISTANCE = GPU_RADIUS * 0.9;

/** Night-sky colour behind everything, matching the ray marcher's own. */
const SKY: readonly [number, number, number] = [16 / 255, 20 / 255, 34 / 255];

/** How much an emissive texel bleeds into its surroundings. */
const BLOOM = 0.55;

/** Where the viewer is standing and looking. */
export interface WalkCamera {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly yaw: number;
  readonly pitch: number;
}

/** What the crosshair is on, for the HUD. */
export interface WalkHover {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly target: readonly [number, number, number];
  readonly pick: SpacePick;
}

interface MapWalkCanvasProps {
  sheet: SpriteSheet;
  space: MapVoxelSpace;
  atlas: TextureAtlas;
  tool: MapSpaceTool;
  colorIndex: number;
  material: number;
  planeKind: MapCellKind;
  brushTile: number;
  pixels: PaintSurface;
  palette: readonly string[];
  /** Where the viewer stands, owned by the caller so it survives a view swap. */
  camera: WalkCamera;
  onCameraChange: (camera: WalkCamera) => void;
  /** Square render resolution for the fallback path; ignored on the GPU path. */
  resolution: number;
  /** Bumped when the cart's art changes, so the view redraws. */
  version: number;
  onEdit: () => void;
  onSpaceCommitted: () => void;
  onPickStyle: (colorIndex: number, material: number) => void;
  onHover: (hover: WalkHover | null) => void;
  onNote: (note: string | null) => void;
  /** Which renderer ended up drawing, so the rail can say so. */
  onRendererChange?: (status: MapGpuStatus) => void;
}

/** `#rrggbb` → 0..255 RGB triple, falling back to white on a malformed value. */
function hexToRgb(hex: string): [number, number, number] {
  const value = Number.parseInt(hex.slice(1), 16);
  if (Number.isNaN(value)) return [255, 255, 255];
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}

/** The movement keys, as the codes a keyboard layout cannot change. */
const MOVE_KEYS = new Set([
  "KeyW",
  "KeyA",
  "KeyS",
  "KeyD",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Space",
  "ShiftLeft",
  "ShiftRight",
  "ControlLeft",
  "ControlRight",
]);

export function MapWalkCanvas({
  sheet,
  space,
  atlas,
  tool,
  colorIndex,
  material,
  planeKind,
  brushTile,
  pixels,
  palette,
  camera,
  onCameraChange,
  resolution,
  version,
  onEdit,
  onSpaceCommitted,
  onPickStyle,
  onHover,
  onNote,
  onRendererChange,
}: MapWalkCanvasProps) {
  const cpuCanvasRef = useRef<HTMLCanvasElement>(null);
  const [locked, setLocked] = useState(false);
  const gpu = useMapGpu(atlas, version);
  const onGpu = gpu.status === "gpu";
  const activeCanvasRef = onGpu ? gpu.canvasRef : cpuCanvasRef;

  // The camera is live in a ref rather than read from the prop: the animation
  // loop and the mouse-look listener both write to it, many times between two
  // React commits, and each has to see what the other just did. Reading the prop
  // instead means looking and moving overwrite one another — hold W and the mouse
  // stops turning the view. See useLiveValue.
  const [cameraRef, updateCamera] = useLiveValue(camera, onCameraChange);
  const heldKeys = useRef(new Set<string>());
  const dirty = useRef(true);
  const hoverRef = useRef<WalkHover | null>(null);
  /** Centre of the window currently uploaded, and the columns it covers. */
  const windowRef = useRef<{ focus: { x: number; y: number; z: number }; bounds: MapWindow } | null>(null);

  useEffect(() => {
    onRendererChange?.(gpu.status);
  }, [gpu.status, onRendererChange]);

  const paletteRgb = useCallback(
    (index: number): readonly [number, number, number] => hexToRgb(palette[index] ?? "#ffffff"),
    [palette],
  );

  const buffers = useMemo(
    () => ({
      out: new Uint8ClampedArray(resolution * resolution * 4),
      pickSite: new Int32Array(resolution * resolution),
      pickFace: new Int8Array(resolution * resolution),
      pickU: new Float32Array(resolution * resolution),
      pickV: new Float32Array(resolution * resolution),
    }),
    [resolution],
  );

  /**
   * Build and upload the window around a position. Called when the map changes
   * and when the viewer has walked far enough that the edge would come into view.
   */
  const uploadWindow = useCallback(
    (at: WalkCamera) => {
      const focus = { x: Math.round(at.x), y: Math.round(at.y), z: Math.round(at.z) };
      const model = mapSpaceToModel(space, { palette: paletteRgb, focus, radius: GPU_RADIUS });
      gpu.uploadModel(model);
      windowRef.current = {
        focus,
        bounds: {
          minX: Math.max(0, focus.x - GPU_RADIUS),
          maxX: Math.min(space.width - 1, focus.x + GPU_RADIUS),
          minZ: Math.max(0, focus.z - GPU_RADIUS),
          maxZ: Math.min(space.depth - 1, focus.z + GPU_RADIUS),
        },
      };
    },
    [gpu, paletteRgb, space],
  );

  // Rebuild the uploaded surface whenever the map or the art changes.
  useEffect(() => {
    if (!onGpu) return;
    uploadWindow(cameraRef.current);
    dirty.current = true;
  }, [onGpu, space, version, uploadWindow]);

  /** Fit the hardware canvas to its box, in real device pixels. */
  useEffect(() => {
    if (!onGpu) return;
    const canvas = gpu.canvasRef.current;
    if (!canvas) return;
    const fit = () => {
      const ratio = Math.min(2, window.devicePixelRatio || 1);
      const width = Math.max(1, Math.round(canvas.clientWidth * ratio));
      const height = Math.max(1, Math.round(canvas.clientHeight * ratio));
      if (canvas.width === width && canvas.height === height) return;
      canvas.width = width;
      canvas.height = height;
      dirty.current = true;
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [gpu.canvasRef, onGpu]);

  /** The window bounds a pick may strike: the built window, or the whole map. */
  const pickBounds = useCallback(
    (): MapWindow | undefined => (onGpu ? windowRef.current?.bounds : undefined),
    [onGpu],
  );

  /** Resolve a ray to the cell and face it struck, in the shared pick shape. */
  const pickAlong = useCallback(
    (origin: readonly [number, number, number], direction: readonly [number, number, number]): SpacePick | null => {
      const hit = castMapRay(space, origin, direction, {
        atlas,
        maxDistance: VIEW_DISTANCE,
        bounds: pickBounds(),
      });
      if (!hit) return null;
      const cell = space.cellAt(hit.x, hit.y, hit.z);
      return {
        x: hit.x,
        y: hit.y,
        z: hit.z,
        face: hit.face,
        u: hit.u,
        v: hit.v,
        plane: cell !== null && cell.kind !== "solid",
      };
    },
    [atlas, pickBounds, space],
  );

  /** Resolve a pixel of the last CPU frame to the cell and face it struck. */
  const pickFromBuffers = useCallback(
    (px: number, py: number): SpacePick | null => {
      if (px < 0 || px >= resolution || py < 0 || py >= resolution) return null;
      const index = py * resolution + px;
      const site = buffers.pickSite[index]!;
      if (site < 0) return null;
      const [x, y, z] = space.coordsOf(site);
      const cell = space.cellAt(x, y, z);
      return {
        x,
        y,
        z,
        face: buffers.pickFace[index]!,
        u: buffers.pickU[index]!,
        v: buffers.pickV[index]!,
        plane: cell !== null && cell.kind !== "solid",
      };
    },
    [buffers, resolution, space],
  );

  /** What the crosshair is on: the exact centre of the frame, either way. */
  const crosshairPick = useCallback((): SpacePick | null => {
    const view = cameraRef.current;
    if (onGpu) {
      return pickAlong([view.x, view.y, view.z], firstPersonBasis(view.yaw, view.pitch).forward);
    }
    return pickFromBuffers(resolution >> 1, resolution >> 1);
  }, [onGpu, pickAlong, pickFromBuffers, resolution]);

  /** Aim at an arbitrary point of the canvas — used when the pointer is free. */
  const pickAtClient = useCallback(
    (clientX: number, clientY: number): SpacePick | null => {
      const canvas = activeCanvasRef.current;
      if (!canvas) return null;
      const rect = canvas.getBoundingClientRect();
      const fx = (clientX - rect.left) / rect.width;
      const fy = (clientY - rect.top) / rect.height;
      if (fx < 0 || fx > 1 || fy < 0 || fy > 1) return null;
      if (!onGpu) {
        return pickFromBuffers(Math.floor(fx * resolution), Math.floor(fy * resolution));
      }
      const view = cameraRef.current;
      const ray = screenRay(
        [view.x, view.y, view.z],
        firstPersonBasis(view.yaw, view.pitch),
        perspectiveProjection({ fov: FOV, width: rect.width, height: rect.height, near: 0.05, far: 256 }),
        fx,
        fy,
      );
      return pickAlong(ray.origin, ray.direction);
    },
    [activeCanvasRef, onGpu, pickAlong, pickFromBuffers, resolution],
  );

  /** Draw the frame, then report what the crosshair landed on. */
  const render = useCallback(() => {
    const view = cameraRef.current;

    if (onGpu) {
      const canvas = gpu.canvasRef.current;
      const built = windowRef.current;
      if (!canvas || !built) return;
      // Recentre before drawing, so the surface always extends past the horizon.
      if (
        Math.abs(view.x - built.focus.x) > GPU_RECENTRE ||
        Math.abs(view.z - built.focus.z) > GPU_RECENTRE
      ) {
        uploadWindow(view);
      }
      const centre = windowRef.current!.focus;
      gpu.draw({
        // The uploaded surface is expressed relative to the window's centre, so
        // the eye is too — the two must be in one space or nothing lines up.
        eye: [view.x - centre.x, view.y - centre.y, view.z - centre.z],
        basis: firstPersonBasis(view.yaw, view.pitch),
        projection: perspectiveProjection({
          fov: FOV,
          width: canvas.width,
          height: canvas.height,
          near: 0.05,
          far: 256,
        }),
        light: DEFAULT_MODEL_LIGHT,
        sky: SKY,
        fogDistance: FOG_DISTANCE,
        bloom: BLOOM,
      });
    } else {
      const canvas = cpuCanvasRef.current;
      const context = canvas?.getContext("2d");
      if (!canvas || !context) return;
      renderMapFirstPerson(space, {
        camera: { eye: [view.x, view.y, view.z], yaw: view.yaw, pitch: view.pitch, fov: FOV },
        palette: paletteRgb,
        atlas,
        light: DEFAULT_MODEL_LIGHT,
        width: resolution,
        height: resolution,
        maxDistance: VIEW_DISTANCE,
        out: buffers.out,
        pickSite: buffers.pickSite,
        pickFace: buffers.pickFace,
        pickU: buffers.pickU,
        pickV: buffers.pickV,
      });
      const frame = context.createImageData(resolution, resolution);
      frame.data.set(buffers.out);
      context.putImageData(frame, 0, 0);
    }

    // Report what the crosshair landed on, so the HUD names the cell you would
    // edit before you commit to editing it.
    const pick = crosshairPick();
    const next: WalkHover | null = pick
      ? { x: pick.x, y: pick.y, z: pick.z, target: targetOfTool(tool, space, pick), pick }
      : null;
    const previous = hoverRef.current;
    const same =
      previous === next ||
      (previous !== null &&
        next !== null &&
        previous.pick.x === next.pick.x &&
        previous.pick.y === next.pick.y &&
        previous.pick.z === next.pick.z &&
        previous.pick.face === next.pick.face);
    if (!same) {
      hoverRef.current = next;
      onHover(next);
    }
  }, [
    atlas,
    buffers,
    crosshairPick,
    gpu,
    onGpu,
    onHover,
    paletteRgb,
    resolution,
    space,
    tool,
    uploadWindow,
  ]);

  // Redraw whenever the map, the art or the render size changes.
  useEffect(() => {
    dirty.current = true;
  }, [space, version, atlas, resolution, tool, gpu.status]);

  // One animation loop drives both movement and drawing: a frame is rendered
  // only when something actually moved or changed, so standing still costs
  // nothing while walking stays smooth.
  useEffect(() => {
    let running = true;
    let previous = performance.now();
    let frame = 0;

    const step = (now: number) => {
      if (!running) return;
      const elapsed = Math.min(0.1, (now - previous) / 1000);
      previous = now;

      const keys = heldKeys.current;
      if (keys.size > 0) {
        const running_ = keys.has("ControlLeft") || keys.has("ControlRight");
        const distance = WALK_SPEED * (running_ ? RUN_MULTIPLIER : 1) * elapsed;
        // Movement is relative to where you are looking, but stays level: looking
        // at your feet should not drive you into the ground.
        const forward = (keys.has("KeyW") || keys.has("ArrowUp") ? 1 : 0) - (keys.has("KeyS") || keys.has("ArrowDown") ? 1 : 0);
        const strafe = (keys.has("KeyD") || keys.has("ArrowRight") ? 1 : 0) - (keys.has("KeyA") || keys.has("ArrowLeft") ? 1 : 0);
        const lift = (keys.has("Space") ? 1 : 0) - (keys.has("ShiftLeft") || keys.has("ShiftRight") ? 1 : 0);

        if (forward !== 0 || strafe !== 0 || lift !== 0) {
          // The step is computed from whatever the camera is *now*, inside the
          // update — so a turn the mouse made a moment ago is already applied and
          // this walks along the new heading rather than replacing it.
          updateCamera((view) => {
            // Both axes come from the renderer's own basis rather than from trig
            // written out again here: walking "right" has to mean the direction
            // the frame draws on the right, and two copies of that rule drift.
            const axes = walkAxes(view.yaw);
            return clampToMap(space, {
              ...view,
              x: view.x + (axes.forward[0] * forward + axes.right[0] * strafe) * distance,
              z: view.z + (axes.forward[1] * forward + axes.right[1] * strafe) * distance,
              y: view.y + lift * distance,
            });
          });
          dirty.current = true;
        }
      }

      if (dirty.current) {
        dirty.current = false;
        render();
      }
      frame = requestAnimationFrame(step);
    };

    frame = requestAnimationFrame(step);
    return () => {
      running = false;
      cancelAnimationFrame(frame);
    };
  }, [render, space, updateCamera]);

  // Keys are tracked on the window while the pointer is captured, and on the
  // canvas otherwise, so walking never eats typing elsewhere in the editor.
  useEffect(() => {
    const canvas = activeCanvasRef.current;
    if (!canvas) return;

    const isTyping = (target: EventTarget | null): boolean => {
      const element = target as HTMLElement | null;
      return (
        element !== null &&
        (element.tagName === "INPUT" || element.tagName === "TEXTAREA" || element.isContentEditable)
      );
    };
    const down = (event: KeyboardEvent) => {
      if (isTyping(event.target)) return;
      if (!MOVE_KEYS.has(event.code)) return;
      if (!locked && document.activeElement !== canvas) return;
      event.preventDefault();
      heldKeys.current.add(event.code);
    };
    const up = (event: KeyboardEvent) => {
      heldKeys.current.delete(event.code);
    };
    const clearAll = () => heldKeys.current.clear();

    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", clearAll);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", clearAll);
      clearAll();
    };
  }, [activeCanvasRef, locked]);

  // Mouse-look while the pointer is captured. Releasing the lock (Escape) is the
  // browser's own gesture, so the state is read back from the document rather
  // than assumed.
  useEffect(() => {
    const canvas = activeCanvasRef.current;
    if (!canvas) return;

    const onLockChange = () => {
      const held = document.pointerLockElement === canvas;
      setLocked(held);
      if (!held) heldKeys.current.clear();
    };
    const onMove = (event: MouseEvent) => {
      if (document.pointerLockElement !== canvas) return;
      // Yaw decreases as the pointer travels right, which turns the view right:
      // the basis rotates toward screen-left as yaw grows (see firstPersonBasis).
      // Applied to the live camera, so a step the walk loop just took is kept.
      updateCamera((view) => ({
        ...view,
        yaw: view.yaw - event.movementX * LOOK_SPEED,
        pitch: Math.max(
          -PITCH_LIMIT,
          Math.min(PITCH_LIMIT, view.pitch - event.movementY * LOOK_SPEED),
        ),
      }));
      dirty.current = true;
    };

    document.addEventListener("pointerlockchange", onLockChange);
    document.addEventListener("mousemove", onMove);
    return () => {
      document.removeEventListener("pointerlockchange", onLockChange);
      document.removeEventListener("mousemove", onMove);
    };
  }, [activeCanvasRef, updateCamera]);

  /** Everything the shared tools need besides where the pointer was aimed. */
  const toolContext = () => ({
    space,
    tileSize: sheet.tileSize,
    tilesPerPage: sheet.tilesPerPage,
    pixels,
    colorIndex,
    material,
    planeKind,
    brushTile,
  });

  const report = (result: SpaceToolResult) => {
    if (result.picked) onPickStyle(result.picked.colorIndex, result.picked.material);
    if (result.changedCells) onSpaceCommitted();
    else if (result.changedPixels) onEdit();
    onNote(result.note);
    dirty.current = true;
  };

  /**
   * A press builds. While the mouse is captured that means the crosshair; before
   * it is captured the first click asks for the capture instead, and a click
   * without capture (after Escape) aims where the cursor actually is.
   */
  const onPointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = activeCanvasRef.current;
    if (!canvas) return;
    canvas.focus();

    if (document.pointerLockElement !== canvas) {
      // Only the left button asks for the pointer; a right-click while free
      // should still be able to break the block under the cursor.
      if (event.button === 0) {
        void canvas.requestPointerLock?.();
        return;
      }
      const free = pickAtClient(event.clientX, event.clientY);
      if (!free) {
        onNote("Nothing under the cursor — aim at a cell.");
        return;
      }
      report(applySpaceTool(tool, free, event.button === 2, toolContext()));
      return;
    }

    const pick = crosshairPick();
    if (!pick) {
      onNote("Nothing in front of you — the crosshair is on open sky.");
      return;
    }
    report(applySpaceTool(tool, pick, event.button === 2, toolContext()));
  };

  const label = `Map in first person at ${Math.round(camera.x)}, ${Math.round(camera.y)}, ${Math.round(
    camera.z,
  )}. Click to capture the mouse, W A S D to move, Space and Shift for height, Escape to release.`;

  return (
    <div className={styles.spaceViewport}>
      <div className={onGpu ? styles.walkFrameWide : styles.walkFrame}>
        {/* Both canvases exist from the first render: a WebGPU context can only
            be taken from a canvas that has never had a 2D one, so the choice
            cannot be made after the element is created. The unused one is
            hidden, never absent. */}
        <canvas
          ref={gpu.canvasRef}
          className={styles.gpuCanvas}
          hidden={!onGpu}
          tabIndex={0}
          onPointerDown={onPointerDown}
          onContextMenu={(event) => event.preventDefault()}
          role="application"
          aria-label={label}
        />
        <canvas
          ref={cpuCanvasRef}
          className={styles.spaceCanvas}
          hidden={onGpu}
          width={resolution}
          height={resolution}
          tabIndex={0}
          onPointerDown={onPointerDown}
          onContextMenu={(event) => event.preventDefault()}
          role="application"
          aria-label={label}
        />
        <div className={styles.crosshair} aria-hidden />
        {!locked && <p className={styles.walkPrompt}>Click to look around · Esc releases the mouse</p>}
      </div>
    </div>
  );
}

/** Keep the viewer inside the map, and off the floor below it. */
function clampToMap(space: MapVoxelSpace, camera: WalkCamera): WalkCamera {
  return {
    ...camera,
    x: Math.max(0, Math.min(space.width - 1, camera.x)),
    y: Math.max(0, Math.min(space.maxHeight - 1, camera.y)),
    z: Math.max(0, Math.min(space.depth - 1, camera.z)),
  };
}

/**
 * Drop the viewer onto whatever is beneath them, at eye height — the "put my feet
 * on the ground" gesture that free movement otherwise lacks. Exported because the
 * control that offers it belongs on the editor's rail, not over the canvas.
 */
export function standOnGround(space: MapVoxelSpace, camera: WalkCamera): WalkCamera {
  const geometry = geometryFor(space.shape);
  const [column, , row] = cellContaining(geometry, camera.x, camera.y, camera.z);
  const ground = space.heightAt(column, row);
  return clampToMap(space, { ...camera, y: ground - 0.5 + EYE_HEIGHT });
}
