"use client";

/**
 * Walking the map: a first-person view you move through and build in, the way a
 * block game is played.
 *
 * The orbit view looks *at* the map from outside; this one puts the camera in it.
 * That is not a camera setting — an orthographic projection has no inside — so
 * this renders through {@link renderMapFirstPerson}, which casts a ray per pixel
 * and therefore gives true perspective and, incidentally, an exact answer for
 * what is under the crosshair.
 *
 * Controls are the ones every voxel game shares, so nothing has to be learned:
 * click to capture the mouse and look around, W A S D to move, Space and Shift
 * for up and down, click to build and right-click to break. Movement is free
 * rather than gravity-bound — an editor is not a game, and being unable to reach
 * the underside of your own bridge would be absurd — with a Stand control that
 * drops you onto the ground when you want to feel the terrain.
 *
 * Rendering is deliberately coarse and upscaled with hard pixel edges: the map is
 * pixel art, so a low-resolution frame is both faithful and what keeps a
 * CPU-cast view moving at a usable rate.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DEFAULT_MODEL_LIGHT,
  MapVoxelSpace,
  cellContaining,
  geometryFor,
  renderMapFirstPerson,
  type MapCellKind,
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
  /** Square render resolution in pixels; the frame is upscaled to the stage. */
  resolution: number;
  /** Bumped when the cart's art changes, so the view redraws. */
  version: number;
  onEdit: () => void;
  onSpaceCommitted: () => void;
  onPickStyle: (colorIndex: number, material: number) => void;
  onHover: (hover: WalkHover | null) => void;
  onNote: (note: string | null) => void;
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
}: MapWalkCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [locked, setLocked] = useState(false);

  // The camera is mirrored into a ref because the animation loop reads it every
  // frame and must not be rebuilt (and re-subscribed) on each move.
  const cameraRef = useRef(camera);
  cameraRef.current = camera;
  const heldKeys = useRef(new Set<string>());
  const dirty = useRef(true);
  const hoverRef = useRef<WalkHover | null>(null);

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

  /** Resolve a pixel of the last frame to the cell and face it struck. */
  const pickAtPixel = useCallback(
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

  /** What the crosshair is on — the centre pixel of the frame. */
  const crosshairPick = useCallback(
    () => pickAtPixel(resolution >> 1, resolution >> 1),
    [pickAtPixel, resolution],
  );

  /** Draw the frame, then the crosshair over it. */
  const render = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext("2d");
    if (!context) return;
    const view = cameraRef.current;

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
  }, [atlas, buffers, crosshairPick, onHover, paletteRgb, resolution, space, tool]);

  // Redraw whenever the map, the art or the render size changes.
  useEffect(() => {
    dirty.current = true;
  }, [space, version, atlas, resolution, tool]);

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
        const view = cameraRef.current;
        const running_ = keys.has("ControlLeft") || keys.has("ControlRight");
        const distance = WALK_SPEED * (running_ ? RUN_MULTIPLIER : 1) * elapsed;
        // Movement is relative to where you are looking, but stays level: looking
        // at your feet should not drive you into the ground.
        const forward = (keys.has("KeyW") || keys.has("ArrowUp") ? 1 : 0) - (keys.has("KeyS") || keys.has("ArrowDown") ? 1 : 0);
        const strafe = (keys.has("KeyD") || keys.has("ArrowRight") ? 1 : 0) - (keys.has("KeyA") || keys.has("ArrowLeft") ? 1 : 0);
        const lift = (keys.has("Space") ? 1 : 0) - (keys.has("ShiftLeft") || keys.has("ShiftRight") ? 1 : 0);

        if (forward !== 0 || strafe !== 0 || lift !== 0) {
          const sinYaw = Math.sin(view.yaw);
          const cosYaw = Math.cos(view.yaw);
          onCameraChange(
            clampToMap(space, {
              ...view,
              x: view.x + (sinYaw * forward + cosYaw * strafe) * distance,
              z: view.z + (cosYaw * forward - sinYaw * strafe) * distance,
              y: view.y + lift * distance,
            }),
          );
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
  }, [onCameraChange, render, space]);

  // Keys are tracked on the window while the pointer is captured, and on the
  // canvas otherwise, so walking never eats typing elsewhere in the editor.
  useEffect(() => {
    const canvas = canvasRef.current;
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
  }, [locked]);

  // Mouse-look while the pointer is captured. Releasing the lock (Escape) is the
  // browser's own gesture, so the state is read back from the document rather
  // than assumed.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const onLockChange = () => {
      const held = document.pointerLockElement === canvas;
      setLocked(held);
      if (!held) heldKeys.current.clear();
    };
    const onMove = (event: MouseEvent) => {
      if (document.pointerLockElement !== canvas) return;
      const view = cameraRef.current;
      onCameraChange({
        ...view,
        yaw: view.yaw - event.movementX * LOOK_SPEED,
        pitch: Math.max(
          -PITCH_LIMIT,
          Math.min(PITCH_LIMIT, view.pitch - event.movementY * LOOK_SPEED),
        ),
      });
      dirty.current = true;
    };

    document.addEventListener("pointerlockchange", onLockChange);
    document.addEventListener("mousemove", onMove);
    return () => {
      document.removeEventListener("pointerlockchange", onLockChange);
      document.removeEventListener("mousemove", onMove);
    };
  }, [onCameraChange]);

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
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.focus();

    if (document.pointerLockElement !== canvas) {
      // Only the left button asks for the pointer; a right-click while free
      // should still be able to break the block under the cursor.
      if (event.button === 0) {
        void canvas.requestPointerLock?.();
        return;
      }
      const rect = canvas.getBoundingClientRect();
      const px = Math.floor(((event.clientX - rect.left) / rect.width) * resolution);
      const py = Math.floor(((event.clientY - rect.top) / rect.height) * resolution);
      const free = pickAtPixel(px, py);
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

  return (
    <div className={styles.spaceViewport}>
      <div className={styles.walkFrame}>
        <canvas
          ref={canvasRef}
          className={styles.spaceCanvas}
          width={resolution}
          height={resolution}
          tabIndex={0}
          onPointerDown={onPointerDown}
          onContextMenu={(event) => event.preventDefault()}
          role="application"
          aria-label={`Map in first person at ${Math.round(camera.x)}, ${Math.round(camera.y)}, ${Math.round(
            camera.z,
          )}. Click to capture the mouse, W A S D to move, Space and Shift for height, Escape to release.`}
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
