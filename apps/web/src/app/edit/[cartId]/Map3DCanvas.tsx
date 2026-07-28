"use client";

/**
 * The map seen from inside it: a navigable 3D view of the cart's
 * {@link MapVoxelSpace}, where cells are placed and removed on the face you point
 * at rather than raised as columns from above.
 *
 * Navigation is the point of the view, so it is bound three ways over the same
 * camera — drag to orbit, drag with a modifier (or the right button) to pan,
 * WASD/arrows to walk the focus through the map, wheel to zoom. The focus is a
 * cell coordinate the camera orbits about and the window is built around; moving
 * it is how you travel a map far larger than any one frame.
 *
 * Picking is exact rather than ray-marched: the shared voxel renderer already
 * emits a per-pixel voxel + face buffer, and this asks it for the face-local
 * coordinates too — which is what lets the pixel tools paint a single texel of the
 * sprite skinning the face you clicked, in place, at the angle you are seeing it.
 *
 * The space is the caller's, mutated in place and committed after each edit, the
 * same contract the top-down canvas has — so both views drive one store and an
 * edit made in either is immediately visible in the other.
 */

import { useCallback, useEffect, useMemo, useRef } from "react";
import {
  CUBE_FACES,
  DEFAULT_MODEL_LIGHT,
  HEXEL_GEOMETRY,
  MapVoxelSpace,
  geometryFor,
  isPlaneVoxel,
  mapSpaceToModel,
  planeAxisOf,
  renderVoxelModel,
  COLUMN_MATERIAL_NONE,
  type CellGeometry,
  type MapCellKind,
  type MapViewFocus,
  type SpriteSheet,
  type TextureAtlas,
} from "@cartbox/editor";

import { MAP_SPRITE_PAGE, materialSpriteTile, spriteTileMaterial } from "@/lib/mapAtlas";

import styles from "./editor.module.css";
import type { PaintSurface } from "./paintSurface";
import { isPixelSpaceTool, type MapSpaceTool } from "./maptools";

/** Canvas edge in device pixels; also the pick buffers' resolution. */
const VIEWPORT = 640;

/** Zoom, as output pixels per cell. */
const CELL_MIN = 3;
const CELL_MAX = 48;
const CELL_STEP = 2;

/** Pitch is clamped short of straight down so the horizon never inverts. */
const PITCH_MIN = -0.25;
const PITCH_MAX = 1.35;
const ORBIT_SPEED = 0.009; // radians per pixel dragged
const DRAG_THRESHOLD = 4; // px of movement before a press becomes a camera move

/** Bright wireframe colour of the cell the cursor is aiming at, per tool. */
const HIGHLIGHT: Record<MapSpaceTool, string> = {
  place: "#7dfcb6",
  remove: "#ff7b7b",
  paintCell: "#ffdd66",
  plane: "#9ad2ff",
  picker: "#c69dff",
  pencil: "#ffdd66",
  pixelFill: "#ffb066",
  pixelEraser: "#ff7b7b",
};

/** A resolved click: the cell under the cursor, and where on its face it landed. */
export interface SpacePick {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** Index into the picked cell's face table — cube faces for a plane cell. */
  readonly face: number;
  /** Face-local coordinates in 0..1, the same the texture fill samples with. */
  readonly u: number;
  readonly v: number;
  /** Whether the picked quad belongs to a plane cell rather than a solid block. */
  readonly plane: boolean;
}

/** What the cursor is aiming at, for the HUD and the wireframe. */
export interface SpaceHover {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** The cell the active tool would act on, which Place reads as the neighbour. */
  readonly target: readonly [number, number, number];
  readonly pick: SpacePick;
}

interface Map3DCanvasProps {
  sheet: SpriteSheet;
  /** The cart's map cells, mutated in place and committed after each edit. */
  space: MapVoxelSpace;
  /** World materials plus every tiles-page sprite; see `lib/mapAtlas`. */
  atlas: TextureAtlas;
  tool: MapSpaceTool;
  /** Palette index new and repainted cells take, and pixel strokes paint with. */
  colorIndex: number;
  /** Material armed for building, or {@link COLUMN_MATERIAL_NONE} for flat colour. */
  material: number;
  /** The orientation the Plane tool stands its quad in. */
  planeKind: MapCellKind;
  /** The sprite the pixel tools skin an unskinned cell with before painting it. */
  brushTile: number;
  /**
   * The surface pixel edits are written through — the composite material brush,
   * so a stroke on a face carries the colour's material profile exactly as a
   * stroke in the Sprites tab does.
   */
  pixels: PaintSurface;
  /** CSS colours of the cart palette, for rendering flat-coloured cells. */
  palette: readonly string[];
  /** Where the camera is standing. Lifted so the HUD and the 2D view can share it. */
  focus: MapViewFocus;
  onFocusChange: (focus: MapViewFocus) => void;
  /** Half-width of the built window, in cells. */
  radius: number;
  /** Camera orientation and zoom, owned by the caller so they survive a view swap. */
  yaw: number;
  pitch: number;
  cell: number;
  onCameraChange: (camera: { yaw: number; pitch: number; cell: number }) => void;
  /** Bumped when the cart's art changes, so the model and atlas rebuild. */
  version: number;
  /** A sprite's pixels changed; the caller re-reads derived state. */
  onEdit: () => void;
  /** Cells changed — the caller persists the space (one entry per action). */
  onSpaceCommitted: () => void;
  /** The Picker adopted a cell's look. */
  onPickStyle: (colorIndex: number, material: number) => void;
  onHover: (hover: SpaceHover | null) => void;
  /** Reports why a click did nothing, so the HUD can explain rather than stay silent. */
  onNote: (note: string | null) => void;
}

/** `#rrggbb` → 0..255 RGB triple, falling back to white on a malformed value. */
function hexToRgb(hex: string): [number, number, number] {
  const value = Number.parseInt(hex.slice(1), 16);
  if (Number.isNaN(value)) return [255, 255, 255];
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}

/** Projects a world point to canvas pixels — the renderer's camera, for overlays. */
type Project = (x: number, y: number, z: number) => [number, number];

/**
 * The renderer's own projection, rebuilt here so overlays land exactly on the
 * cells they annotate. It has to be the same arithmetic as `drawModelInto`'s, and
 * is small enough that sharing it would cost more indirection than it saves.
 */
function makeProject(yaw: number, pitch: number, cell: number, focus: MapViewFocus): Project {
  const cosYaw = Math.cos(yaw);
  const sinYaw = Math.sin(yaw);
  const cosPitch = Math.cos(pitch);
  const sinPitch = Math.sin(pitch);
  const centre = VIEWPORT / 2;
  return (x, y, z) => {
    const wx = x - focus.x;
    const wy = y - focus.y;
    const wz = z - focus.z;
    const yawX = wx * cosYaw + wz * sinYaw;
    const yawZ = -wx * sinYaw + wz * cosYaw;
    const camY = wy * cosPitch - yawZ * sinPitch;
    return [centre + yawX * cell, centre - camY * cell];
  };
}

/** Stroke a closed polygon of already-projected points, with a soft glow. */
function strokePolygon(
  context: CanvasRenderingContext2D,
  points: readonly [number, number][],
  color: string,
  width: number,
): void {
  if (points.length < 2) return;
  context.save();
  context.strokeStyle = color;
  context.lineWidth = width;
  context.lineJoin = "round";
  context.shadowColor = color;
  context.shadowBlur = width * 3;
  context.beginPath();
  points.forEach(([px, py], index) => (index === 0 ? context.moveTo(px, py) : context.lineTo(px, py)));
  context.closePath();
  context.stroke();
  context.restore();
}

/**
 * Outline a cell as a box wireframe. `half` is the extent on each axis, so a
 * plane — zero on the axis it stands across — draws as the flat rectangle it is,
 * through the same code path as a solid block.
 */
function drawBoxOutline(
  context: CanvasRenderingContext2D,
  project: Project,
  centre: readonly [number, number, number],
  half: readonly [number, number, number],
  color: string,
  lineWidth: number,
): void {
  const corners: [number, number][] = [];
  for (let i = 0; i < 8; i += 1) {
    corners.push(
      project(
        centre[0] + (i & 1 ? half[0] : -half[0]),
        centre[1] + (i & 2 ? half[1] : -half[1]),
        centre[2] + (i & 4 ? half[2] : -half[2]),
      ),
    );
  }
  context.save();
  context.strokeStyle = color;
  context.lineWidth = lineWidth;
  context.lineJoin = "round";
  context.shadowColor = color;
  context.shadowBlur = lineWidth * 3;
  for (let i = 0; i < 8; i += 1) {
    for (let j = i + 1; j < 8; j += 1) {
      const diff = i ^ j;
      if (diff !== 1 && diff !== 2 && diff !== 4) continue; // box edges only
      context.beginPath();
      context.moveTo(corners[i]![0], corners[i]![1]);
      context.lineTo(corners[j]![0], corners[j]![1]);
      context.stroke();
    }
  }
  context.restore();
}

/** Outline a hexel's twelve rhombic faces — a box would misdescribe the cell. */
function drawHexelOutline(
  context: CanvasRenderingContext2D,
  project: Project,
  centre: readonly [number, number, number],
  color: string,
  lineWidth: number,
): void {
  for (const face of HEXEL_GEOMETRY.faces) {
    strokePolygon(
      context,
      face.corners.map((corner) => project(centre[0] + corner[0], centre[1] + corner[1], centre[2] + corner[2])),
      color,
      lineWidth,
    );
  }
}

export function Map3DCanvas({
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
  focus,
  onFocusChange,
  radius,
  yaw,
  pitch,
  cell,
  onCameraChange,
  version,
  onEdit,
  onSpaceCommitted,
  onPickStyle,
  onHover,
  onNote,
}: Map3DCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  /** The last rendered frame, so a hover change only redraws the overlay. */
  const frameRef = useRef<ImageData | null>(null);
  const hoverRef = useRef<SpaceHover | null>(null);

  const geometry = useMemo<CellGeometry>(() => geometryFor(space.shape), [space.shape]);
  const paletteRgb = useCallback(
    (index: number): readonly [number, number, number] => hexToRgb(palette[index] ?? "#ffffff"),
    [palette],
  );

  // Fixed-size render + pick buffers: allocated once, independent of map size.
  const buffers = useMemo(
    () => ({
      out: new Uint8ClampedArray(VIEWPORT * VIEWPORT * 4),
      depth: new Float32Array(VIEWPORT * VIEWPORT),
      pickVoxel: new Int32Array(VIEWPORT * VIEWPORT),
      pickFace: new Int8Array(VIEWPORT * VIEWPORT),
      pickU: new Float32Array(VIEWPORT * VIEWPORT),
      pickV: new Float32Array(VIEWPORT * VIEWPORT),
    }),
    [],
  );

  // The window of the map that is actually built. Rebuilt when the space changes
  // (version), when the focus moves, or when the range control widens it.
  const model = useMemo(
    () => mapSpaceToModel(space, { palette: paletteRgb, focus, radius, geometry }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [space, version, focus.x, focus.y, focus.z, radius, geometry, paletteRgb],
  );

  const project = useMemo(() => makeProject(yaw, pitch, cell, focus), [yaw, pitch, cell, focus]);

  /**
   * The model-space corners of a picked face, with a plane's collapsed along its
   * axis exactly as the renderer collapses it — the basis every overlay and the
   * texel lookup are expressed in.
   */
  const faceCorners = useCallback(
    (pick: SpacePick): [number, number, number][] => {
      const faces = pick.plane ? CUBE_FACES : geometry.faces;
      const face = faces[pick.face];
      if (!face) return [];
      // A plane's quad is collapsed along whichever axis its face normal runs on.
      const axis = pick.plane ? face.normal.findIndex((component) => component !== 0) : -1;
      return face.corners.map((corner) => [
        pick.x + (axis === 0 ? 0 : corner[0]!),
        pick.y + (axis === 1 ? 0 : corner[1]!),
        pick.z + (axis === 2 ? 0 : corner[2]!),
      ]);
    },
    [geometry],
  );

  /** Blit the last render and stroke the cursor overlay over it. */
  const paint = useCallback(() => {
    const canvas = canvasRef.current;
    const frame = frameRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !frame || !context) return;
    context.putImageData(frame, 0, 0);

    const hover = hoverRef.current;
    if (!hover) return;
    const color = HIGHLIGHT[tool];
    const lineWidth = Math.max(1.5, cell * 0.1);

    if (isPixelSpaceTool(tool)) {
      // Outline the face, then the single texel the stroke would land on — the
      // difference between painting where you are looking and painting blind.
      const corners = faceCorners(hover.pick);
      if (corners.length === 4) {
        strokePolygon(context, corners.map(([x, y, z]) => project(x, y, z)), color, lineWidth * 0.6);
        const size = sheet.tileSize;
        const u0 = Math.floor(hover.pick.u * size) / size;
        const v0 = Math.floor(hover.pick.v * size) / size;
        const step = 1 / size;
        const at = (u: number, v: number): [number, number] => {
          const point: [number, number, number] = [0, 0, 0];
          for (let axis = 0; axis < 3; axis += 1) {
            point[axis] =
              corners[0]![axis]! +
              u * (corners[1]![axis]! - corners[0]![axis]!) +
              v * (corners[3]![axis]! - corners[0]![axis]!);
          }
          return project(point[0], point[1], point[2]);
        };
        strokePolygon(
          context,
          [at(u0, v0), at(u0 + step, v0), at(u0 + step, v0 + step), at(u0, v0 + step)],
          color,
          lineWidth,
        );
      }
      return;
    }

    const [tx, ty, tz] = hover.target;
    const planing = tool === "plane";
    if (space.shape === "hexel" && !planing) {
      drawHexelOutline(context, project, [tx, ty, tz], color, lineWidth);
    } else {
      // A plane previews as the flat quad it will actually stand: zero extent on
      // the axis it faces along. A cross stands two, so it keeps its full box.
      const axis = planing ? planeAxisOf(planeKind) : -1;
      const half: [number, number, number] = [0.5, 0.5, 0.5];
      if (axis >= 0) half[axis] = 0;
      drawBoxOutline(context, project, [tx, ty, tz], half, color, lineWidth);
    }
  }, [tool, cell, faceCorners, project, sheet.tileSize, space.shape, planeKind]);

  // Rendering the window is the expensive step, so it is kept off the overlay's
  // path: changing tool or hover only re-blits the frame and re-strokes the
  // cursor, and the model is rebuilt only when the camera or the map moves.
  const paintRef = useRef(paint);
  paintRef.current = paint;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.width = VIEWPORT;
    canvas.height = VIEWPORT;
    const context = canvas.getContext("2d");
    if (!context) return;
    renderVoxelModel(model, {
      yaw,
      pitch,
      cell,
      size: VIEWPORT,
      light: DEFAULT_MODEL_LIGHT,
      atlas,
      out: buffers.out,
      depthBuffer: buffers.depth,
      pickVoxel: buffers.pickVoxel,
      pickFace: buffers.pickFace,
      pickU: buffers.pickU,
      pickV: buffers.pickV,
    });
    const frame = context.createImageData(VIEWPORT, VIEWPORT);
    frame.data.set(buffers.out);
    frameRef.current = frame;
    paintRef.current();
  }, [model, yaw, pitch, cell, atlas, buffers]);

  useEffect(() => {
    paint();
  }, [paint]);

  /** Resolve a canvas position to the cell and face under it. */
  const pickAt = (clientX: number, clientY: number): SpacePick | null => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const px = Math.floor(((clientX - rect.left) / rect.width) * VIEWPORT);
    const py = Math.floor(((clientY - rect.top) / rect.height) * VIEWPORT);
    if (px < 0 || px >= VIEWPORT || py < 0 || py >= VIEWPORT) return null;
    const index = py * VIEWPORT + px;
    const voxel = buffers.pickVoxel[index]!;
    if (voxel < 0) return null; // empty space
    const [x, y, z] = space.coordsOf(model.gridIndex[voxel]!);
    return {
      x,
      y,
      z,
      face: buffers.pickFace[index]!,
      u: buffers.pickU[index]!,
      v: buffers.pickV[index]!,
      plane: isPlaneVoxel(model, voxel),
    };
  };

  /**
   * The neighbouring site across the picked face. A plane's faces are cube faces
   * whatever the map's lattice, so it steps by a cube normal; a solid steps by its
   * own geometry's offset, which is what keeps a hexel landing on the FCC lattice.
   */
  const acrossFace = (pick: SpacePick): [number, number, number] => {
    const offset = pick.plane ? CUBE_FACES[pick.face]?.normal : geometry.faces[pick.face]?.offset;
    const [dx, dy, dz] = offset ?? [0, 0, 0];
    return [pick.x + dx, pick.y + dy, pick.z + dz];
  };

  /** The cell the active tool would act on. */
  const targetOf = (pick: SpacePick): [number, number, number] =>
    tool === "place" || tool === "plane" ? acrossFace(pick) : [pick.x, pick.y, pick.z];

  const placeCell = (pick: SpacePick, kind: MapCellKind) => {
    const [x, y, z] = acrossFace(pick);
    if (!space.isValidSite(x, y, z)) {
      onNote(
        space.inBounds(x, y, z)
          ? "That site is off the hexel lattice — try an adjacent face."
          : "That is past the edge of the map.",
      );
      return;
    }
    // A plane *is* sprite art standing in space — a flat-coloured quad would just
    // be a rectangle — so it always wears the sprite the tile picker has armed,
    // which is the control the rail shows while the Plane tool is active. Solid
    // blocks take the material palette's choice instead.
    const skin = kind === "solid" ? material : spriteTileMaterial(brushTile);
    space.set(x, y, z, { colorIndex, material: skin, kind });
    onSpaceCommitted();
  };

  const removeCell = (pick: SpacePick) => {
    space.clear(pick.x, pick.y, pick.z);
    onSpaceCommitted();
  };

  const restyleCell = (pick: SpacePick, strip: boolean) => {
    space.recolor(pick.x, pick.y, pick.z, colorIndex, strip ? COLUMN_MATERIAL_NONE : material);
    onSpaceCommitted();
  };

  /**
   * Paint a texel of the sprite skinning the picked face.
   *
   * A cell with no editable sprite has nothing to paint, so the first click skins
   * it with the armed tile and stops there — one click, one change the author can
   * see and undo — and the next click paints on it.
   */
  const paintTexel = (pick: SpacePick) => {
    const target = space.cellAt(pick.x, pick.y, pick.z);
    if (!target) return;
    const tile = materialSpriteTile(target.material, sheet.tilesPerPage);
    if (tile === null) {
      space.recolor(pick.x, pick.y, pick.z, target.colorIndex, spriteTileMaterial(brushTile));
      onNote(`Skinned this cell with sprite #${brushTile}. Click again to paint it.`);
      onSpaceCommitted();
      return;
    }

    const size = sheet.tileSize;
    const texelX = Math.max(0, Math.min(size - 1, Math.floor(pick.u * size)));
    const texelY = Math.max(0, Math.min(size - 1, Math.floor(pick.v * size)));
    const value = tool === "pixelEraser" ? 0 : colorIndex;
    if (tool === "pixelFill") pixels.fill(MAP_SPRITE_PAGE, tile, texelX, texelY, value);
    else pixels.setPixel(MAP_SPRITE_PAGE, tile, texelX, texelY, value);
    onNote(null);
    onEdit();
  };

  /** Apply the active tool at a canvas position. The secondary button removes. */
  const applyAt = (clientX: number, clientY: number, secondary: boolean) => {
    const pick = pickAt(clientX, clientY);
    if (!pick) {
      onNote("Nothing under the cursor — aim at a cell.");
      return;
    }
    onNote(null);
    if (isPixelSpaceTool(tool)) {
      paintTexel(pick);
      return;
    }
    switch (tool) {
      case "place":
        if (secondary) removeCell(pick);
        else placeCell(pick, "solid");
        return;
      case "plane":
        if (secondary) removeCell(pick);
        else placeCell(pick, planeKind);
        return;
      case "remove":
        removeCell(pick);
        return;
      case "paintCell":
        restyleCell(pick, secondary);
        return;
      case "picker": {
        const target = space.cellAt(pick.x, pick.y, pick.z);
        if (target) onPickStyle(target.colorIndex, target.material);
        return;
      }
    }
  };

  /**
   * Whether two hovers would draw the same cursor. The pixel tools highlight a
   * single texel, so for them the face-local position matters and moving within
   * one face is a change; for the building tools only the cell and face are.
   */
  const sameHover = (a: SpaceHover | null, b: SpaceHover | null): boolean => {
    if (a === b) return true;
    if (a === null || b === null) return false;
    if (a.pick.x !== b.pick.x || a.pick.y !== b.pick.y || a.pick.z !== b.pick.z) return false;
    if (a.pick.face !== b.pick.face) return false;
    if (!isPixelSpaceTool(tool)) return true;
    const size = sheet.tileSize;
    return (
      Math.floor(a.pick.u * size) === Math.floor(b.pick.u * size) &&
      Math.floor(a.pick.v * size) === Math.floor(b.pick.v * size)
    );
  };

  const setHover = (hover: SpaceHover | null) => {
    if (sameHover(hoverRef.current, hover)) return;
    hoverRef.current = hover;
    onHover(hover);
    paint();
  };

  // --- Camera and travel -----------------------------------------------------
  // Screen-right and screen-forward on the ground plane, from the current yaw.
  // Both are what "move me that way" means once the camera has been turned.
  const groundAxes = () => ({
    right: [Math.cos(yaw), Math.sin(yaw)] as const,
    forward: [-Math.sin(yaw), Math.cos(yaw)] as const,
  });

  const moveFocus = (right: number, forward: number, up: number) => {
    const axes = groundAxes();
    const x = focus.x + axes.right[0] * right + axes.forward[0] * forward;
    const z = focus.z + axes.right[1] * right + axes.forward[1] * forward;
    onFocusChange({
      x: Math.max(0, Math.min(space.width - 1, x)),
      y: Math.max(0, Math.min(space.maxHeight - 1, focus.y + up)),
      z: Math.max(0, Math.min(space.depth - 1, z)),
    });
  };

  const drag = useRef<{ lastX: number; lastY: number; moved: boolean; button: number; pan: boolean } | null>(null);

  const onPointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    // The travel keys are bound to the canvas, so a press has to focus it or
    // WASD would go nowhere until the user found the canvas with Tab.
    event.currentTarget.focus();
    drag.current = {
      lastX: event.clientX,
      lastY: event.clientY,
      moved: false,
      button: event.button,
      // Middle button, or Shift/Space with any button, pans instead of orbiting.
      pan: event.button === 1 || event.shiftKey,
    };
  };

  const onPointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const state = drag.current;
    if (state) {
      const dx = event.clientX - state.lastX;
      const dy = event.clientY - state.lastY;
      if (!state.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
      if (!state.moved) setHover(null); // this press became a camera move, not a click
      state.moved = true;
      state.lastX = event.clientX;
      state.lastY = event.clientY;
      if (state.pan) {
        // Drag the world under the cursor: the scene follows the pointer, so the
        // focus travels the other way. Vertical drags are divided by how steeply
        // the camera looks down, since a shallow pitch foreshortens the ground —
        // floored so a near-horizontal view pans at a sane rate instead of leaping.
        const foreshorten = Math.max(0.25, Math.sin(pitch));
        moveFocus(-dx / cell, -dy / (cell * foreshorten), 0);
      } else {
        onCameraChange({
          yaw: yaw - dx * ORBIT_SPEED,
          pitch: Math.max(PITCH_MIN, Math.min(PITCH_MAX, pitch + dy * ORBIT_SPEED)),
          cell,
        });
      }
      return;
    }
    const pick = pickAt(event.clientX, event.clientY);
    setHover(pick ? { x: pick.x, y: pick.y, z: pick.z, target: targetOf(pick), pick } : null);
  };

  const onPointerUp = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const state = drag.current;
    drag.current = null;
    if (state && !state.moved) applyAt(event.clientX, event.clientY, state.button === 2);
  };

  // Wheel zoom without letting the page scroll under the cursor. React's onWheel
  // is passive and cannot preventDefault, so bind a native listener.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const handler = (event: WheelEvent) => {
      event.preventDefault();
      const next = cell - Math.sign(event.deltaY) * CELL_STEP;
      onCameraChange({ yaw, pitch, cell: Math.max(CELL_MIN, Math.min(CELL_MAX, next)) });
    };
    canvas.addEventListener("wheel", handler, { passive: false });
    return () => canvas.removeEventListener("wheel", handler);
  }, [cell, yaw, pitch, onCameraChange]);

  // Walk the focus with the keyboard. Bound to the canvas rather than the window
  // so it never eats typing elsewhere in the editor; the canvas is focusable and
  // takes focus on pointer-down.
  const onKeyDown = (event: React.KeyboardEvent<HTMLCanvasElement>) => {
    const step = event.shiftKey ? 4 : 1;
    const moves: Record<string, [number, number, number]> = {
      w: [0, step, 0],
      arrowup: [0, step, 0],
      s: [0, -step, 0],
      arrowdown: [0, -step, 0],
      a: [-step, 0, 0],
      arrowleft: [-step, 0, 0],
      d: [step, 0, 0],
      arrowright: [step, 0, 0],
      e: [0, 0, step],
      pageup: [0, 0, step],
      q: [0, 0, -step],
      pagedown: [0, 0, -step],
    };
    const move = moves[event.key.toLowerCase()];
    if (!move) return;
    event.preventDefault();
    moveFocus(move[0], move[1], move[2]);
  };

  return (
    <div className={styles.spaceViewport}>
      <canvas
        ref={canvasRef}
        className={styles.spaceCanvas}
        width={VIEWPORT}
        height={VIEWPORT}
        tabIndex={0}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => (drag.current = null)}
        onPointerLeave={() => setHover(null)}
        onKeyDown={onKeyDown}
        onContextMenu={(event) => event.preventDefault()}
        role="application"
        aria-label={`Map in 3D, ${space.width} by ${space.depth} cells. Drag to orbit, shift-drag to pan, W A S D to move, Q and E for height.`}
      />
    </div>
  );
}
