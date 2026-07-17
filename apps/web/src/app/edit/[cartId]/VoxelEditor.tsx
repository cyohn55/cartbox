"use client";

/**
 * The Voxel tab: a true 3D voxel sculptor. Unlike the sprite editor's extruded
 * previews, this authors an arbitrary {@link VoxelGrid} — place, remove, and
 * paint individual cubes on a model you orbit freely.
 *
 * Interaction mirrors block editors like MagicaVoxel: drag to orbit the camera,
 * click a cube face to grow a new cube against it, right-click (or the Remove
 * tool) to carve one away, and Paint to recolour. Picking is exact — the shared
 * voxel renderer emits a per-pixel voxel + face buffer, so a click resolves to
 * the cube and face under the cursor with no ray-marching here.
 *
 * The model is a controlled value (`model` in, `onModelChange` out) so it lives
 * in the cart's undo timeline and saves with the cart, exactly like the FX stack.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  VoxelGrid,
  voxelGridToModel,
  serializeVoxelGrid,
  deserializeVoxelGrid,
  renderVoxelModel,
  CUBE_FACES,
  DEFAULT_MODEL_LIGHT,
  MAX_VOXEL_GRID_DIM,
  shapeOffsets,
  type VoxelShapeKind,
  type VoxelShapeStyle,
  type ShapeOffset,
  type SpriteSheet,
} from "@cartbox/editor";

import { createVoxelBackdropProp } from "@/lib/backdropProps";
import { loadWorkingSet, loadPublishedSet, saveWorkingSet, type PendingVoxelEdit } from "@/lib/backdropPropsStore";
import styles from "./editor.module.css";

const DEFAULT_GRID = 16;
const GRID_SIZES = [8, 16, 24, 32, 64, 128, 256].filter((n) => n <= MAX_VOXEL_GRID_DIM);

// The model renders into a fixed-resolution square viewport, and `cell` (the
// zoom) scales the model *within* it — so zooming visibly grows/shrinks the
// model, and the render + pick buffers stay a bounded, constant size regardless
// of grid size. The model is centred on its filled content, so a small sculpt in
// a large grid still sits in the middle of the frame.
const VIEWPORT = 560; // canvas edge in device pixels; also its CSS display width
const CELL_MIN = 2; // most zoomed-out cube size, in viewport pixels
const CELL_MAX = 64; // most zoomed-in cube size
const CELL_STEP = 2; // per wheel-notch / button-press zoom increment
const FIT_FRACTION = 0.7; // share of the viewport the model fills at the default zoom
// The opening (fit-to-view) zoom is capped below CELL_MAX so a small model still
// leaves headroom to zoom in — otherwise a tiny seed would open pinned at maximum
// zoom, and "Zoom in" would sit disabled as if zooming were broken.
const DEFAULT_CELL_MAX = 24;

/** The opening cell (zoom) size that frames `contentDiagonal` voxels in the viewport. */
function fitCell(contentDiagonal: number): number {
  const fit = Math.floor((VIEWPORT * FIT_FRACTION) / Math.max(1, contentDiagonal));
  return Math.max(CELL_MIN, Math.min(DEFAULT_CELL_MAX, fit));
}

/** Default zoom framing a grid's *filled content* (not the whole grid) in the viewport. */
function fitCellForGrid(grid: VoxelGrid): number {
  const model = voxelGridToModel(grid, { center: "content" });
  return fitCell(Math.hypot(model.sizeX, model.sizeY, model.sizeZ));
}
const PITCH_LIMIT = 1.45;
const ORBIT_SPEED = 0.011; // radians per pixel dragged
const DRAG_THRESHOLD = 4; // px of movement before a press becomes an orbit
const SEED_COLOR: readonly [number, number, number] = [176, 182, 198];

type VoxelTool = "add" | "remove" | "paint" | "shape";
const TOOLS: readonly { id: VoxelTool; label: string; glyph: string }[] = [
  { id: "add", label: "Add", glyph: "＋" },
  { id: "remove", label: "Remove", glyph: "－" },
  { id: "paint", label: "Paint", glyph: "🖌" },
  { id: "shape", label: "Shape", glyph: "◫" },
];

// The Shape tool stamps a rectangle or circle of voxels onto the plane of the
// clicked face. Radius is voxels from the centre to the edge, so the shape spans
// 2*radius + 1 voxels across; capped so even the largest outline stays a cheap
// per-cell preview to render.
const SHAPE_KINDS: readonly { id: VoxelShapeKind; label: string }[] = [
  { id: "rectangle", label: "Rect" },
  { id: "circle", label: "Circle" },
];
const SHAPE_STYLES: readonly { id: VoxelShapeStyle; label: string }[] = [
  { id: "outline", label: "Outline" },
  { id: "fill", label: "Fill" },
];
const SHAPE_RADIUS_MIN = 1;
const SHAPE_RADIUS_MAX = 32;
const DEFAULT_SHAPE_RADIUS = 3;

/** `#rrggbb` → 0..255 RGB triple (falls back to white on a malformed value). */
function hexToRgb(hex: string): [number, number, number] {
  const value = Number.parseInt(hex.slice(1), 16);
  if (Number.isNaN(value)) return [255, 255, 255];
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}

/** Bright wireframe colour of the hovered target cell, per tool. */
const HIGHLIGHT: Record<VoxelTool, string> = {
  add: "#7dfcb6",
  remove: "#ff7b7b",
  paint: "#ffdd66",
  shape: "#7db8fc",
};

type Cell = [number, number, number];
const sameCell = (a: Cell | null, b: Cell | null): boolean =>
  a === b || (a !== null && b !== null && a[0] === b[0] && a[1] === b[1] && a[2] === b[2]);

/**
 * What the cursor is aiming at: the cell a tool will act on, plus the cube face
 * that was picked. The face fixes the drawing plane for the Shape tool (a shape
 * is stamped in the plane of the face the cursor is over).
 */
interface HoverTarget {
  cell: Cell;
  face: number;
}
const sameHover = (a: HoverTarget | null, b: HoverTarget | null): boolean =>
  a === b || (a !== null && b !== null && a.face === b.face && sameCell(a.cell, b.cell));

/** The two in-plane unit axes of a cube face — the axes its normal doesn't run along. */
function planeAxes(face: number): { u: Cell; v: Cell } {
  const [nx, ny] = CUBE_FACES[face]!.normal;
  if (nx !== 0) return { u: [0, 0, 1], v: [0, 1, 0] }; // ±X face → Z/Y plane
  if (ny !== 0) return { u: [1, 0, 0], v: [0, 0, 1] }; // ±Y face → X/Z plane
  return { u: [1, 0, 0], v: [0, 1, 0] }; // ±Z face → X/Y plane
}

/** Map a shape's in-plane offsets to grid cells around `center`, on `face`'s plane. */
function shapePlaneCells(center: Cell, face: number, offsets: readonly ShapeOffset[]): Cell[] {
  const { u, v } = planeAxes(face);
  return offsets.map(({ u: du, v: dv }) => [
    center[0] + du * u[0] + dv * v[0],
    center[1] + du * u[1] + dv * v[1],
    center[2] + du * u[2] + dv * v[2],
  ]);
}

/** A small 3×3 floor platform, so a new model reads as a surface to build on. */
function seededGrid(size: number): VoxelGrid {
  const grid = new VoxelGrid(size, size, size);
  const mid = Math.floor(size / 2);
  for (let dz = -1; dz <= 1; dz += 1) {
    for (let dx = -1; dx <= 1; dx += 1) {
      grid.set(mid + dx, 0, mid + dz, SEED_COLOR[0], SEED_COLOR[1], SEED_COLOR[2], 0);
    }
  }
  return grid;
}

/**
 * Outline a single grid cell as a glowing wireframe cube, using the same
 * projection as {@link renderVoxelModel}, so the hovered target (where a cube
 * will be added/removed/painted) is always visible — the feedback that makes the
 * tools discoverable.
 */
function drawHighlight(
  context: CanvasRenderingContext2D,
  cell: Cell,
  origin: readonly [number, number, number],
  yaw: number,
  pitch: number,
  cellPx: number,
  size: number,
  color: string,
): void {
  const cx = cell[0] - origin[0];
  const cy = cell[1] - origin[1];
  const cz = cell[2] - origin[2];
  const cosY = Math.cos(yaw);
  const sinY = Math.sin(yaw);
  const cosP = Math.cos(pitch);
  const sinP = Math.sin(pitch);
  const centre = size / 2;
  const project = (x: number, y: number, z: number): [number, number] => {
    const yawX = x * cosY + z * sinY;
    const yawZ = -x * sinY + z * cosY;
    const camY = y * cosP - yawZ * sinP;
    return [centre + yawX * cellPx, centre - camY * cellPx];
  };

  const corners: [number, number][] = [];
  for (let i = 0; i < 8; i += 1) {
    corners.push(project(cx + (i & 1 ? 0.5 : -0.5), cy + (i & 2 ? 0.5 : -0.5), cz + (i & 4 ? 0.5 : -0.5)));
  }
  context.save();
  context.strokeStyle = color;
  context.lineWidth = Math.max(1.5, cellPx * 0.12);
  context.lineJoin = "round";
  context.shadowColor = color;
  context.shadowBlur = cellPx * 0.4;
  for (let i = 0; i < 8; i += 1) {
    for (let j = i + 1; j < 8; j += 1) {
      const diff = i ^ j;
      if (diff !== 1 && diff !== 2 && diff !== 4) continue; // only cube edges
      context.beginPath();
      context.moveTo(corners[i]![0], corners[i]![1]);
      context.lineTo(corners[j]![0], corners[j]![1]);
      context.stroke();
    }
  }
  context.restore();
}

function loadGrid(serialized: string | null): VoxelGrid {
  if (serialized) {
    try {
      const grid = deserializeVoxelGrid(serialized);
      return grid.filledCount > 0 ? grid : seededGrid(grid.sizeX);
    } catch {
      // fall through to a fresh grid on any corrupt payload
    }
  }
  return seededGrid(DEFAULT_GRID);
}

interface VoxelEditorProps {
  /** Provides the cart palette to paint with. */
  sheet: SpriteSheet;
  /** Serialized {@link VoxelGrid} from the cart, or null for a new model. */
  model: string | null;
  /** Called with the serialized grid after every edit (feeds undo + save). */
  onModelChange: (serialized: string) => void;
  /** A backdrop voxel prop being re-sculpted (manager → "Edit"), or null. */
  pendingEdit?: PendingVoxelEdit | null;
}

export function VoxelEditor({ sheet, model, onModelChange, pendingEdit = null }: VoxelEditorProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // The grid is the source of truth; it is seeded once on mount from the cart's
  // model, or from the prop handed over to re-sculpt (the manager routes through
  // /edit/new, which clears the draft, so `model` is empty and the prop wins).
  const gridRef = useRef<VoxelGrid | null>(null);
  if (gridRef.current === null) gridRef.current = loadGrid(model ?? pendingEdit?.voxel ?? null);

  const [gridSize, setGridSize] = useState(() => gridRef.current!.sizeX);
  const [rev, setRev] = useState(0); // bumped to rebuild the model after edits
  const [yaw, setYaw] = useState(0.7);
  const [pitch, setPitch] = useState(0.72);
  const [tool, setTool] = useState<VoxelTool>("add");
  const [colorIndex, setColorIndex] = useState(1);
  const [hover, setHover] = useState<HoverTarget | null>(null); // what the cursor is aiming at
  const [shapeKind, setShapeKind] = useState<VoxelShapeKind>("rectangle");
  const [shapeStyle, setShapeStyle] = useState<VoxelShapeStyle>("outline");
  const [shapeRadius, setShapeRadius] = useState(DEFAULT_SHAPE_RADIUS);

  const palette = useMemo(() => sheet.cssPalette(), [sheet]);
  const paintHex = palette[colorIndex] ?? "#ffffff";

  // Rebuild the renderable model whenever the grid changes (rev) or resizes.
  // Centre on the filled content so a small sculpt sits in the middle of the
  // viewport (and rotates about its own centre), not low against the grid floor.
  const model3d = useMemo(() => voxelGridToModel(gridRef.current!, { center: "content" }), [rev, gridSize]);

  // Zoom is the cube size in viewport pixels; it scales the model within a fixed
  // viewport, so it actually changes the on-screen size. Seed it to fit the model.
  const [cell, setCell] = useState(() => fitCellForGrid(gridRef.current!));
  const renderCell = Math.max(CELL_MIN, Math.min(CELL_MAX, cell));

  // Fixed-size render + picking buffers: allocated once, independent of grid size.
  const buffers = useMemo(
    () => ({
      out: new Uint8ClampedArray(VIEWPORT * VIEWPORT * 4),
      depth: new Float32Array(VIEWPORT * VIEWPORT),
      pickVoxel: new Int32Array(VIEWPORT * VIEWPORT),
      pickFace: new Int8Array(VIEWPORT * VIEWPORT),
    }),
    [],
  );

  // Render on any camera or model change; the pick buffers persist for clicks.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.width = VIEWPORT;
    canvas.height = VIEWPORT;
    const context = canvas.getContext("2d");
    if (!context) return;
    renderVoxelModel(model3d, {
      yaw,
      pitch,
      cell: renderCell,
      size: VIEWPORT,
      light: DEFAULT_MODEL_LIGHT,
      out: buffers.out,
      depthBuffer: buffers.depth,
      pickVoxel: buffers.pickVoxel,
      pickFace: buffers.pickFace,
    });
    const image = context.createImageData(VIEWPORT, VIEWPORT);
    image.data.set(buffers.out);
    context.putImageData(image, 0, 0);
    // Outline the cell(s) the cursor is targeting so every tool shows where it
    // acts, projected with the model's exact content-centred origin so it lines
    // up. The Shape tool previews the shape's boundary (its outline offsets) even
    // in Fill mode, so the footprint reads clearly while staying cheap to draw.
    if (hover) {
      const origin: [number, number, number] = [model3d.originX, model3d.originY, model3d.originZ];
      const color = HIGHLIGHT[tool];
      const cells =
        tool === "shape"
          ? shapePlaneCells(hover.cell, hover.face, shapeOffsets(shapeKind, "outline", shapeRadius))
          : [hover.cell];
      for (const target of cells) {
        drawHighlight(context, target, origin, yaw, pitch, renderCell, VIEWPORT, color);
      }
    }
  }, [model3d, yaw, pitch, renderCell, buffers, hover, tool, shapeKind, shapeRadius]);

  /** Persist the current grid to undo/save; re-seed if it was emptied. */
  const commit = () => {
    const grid = gridRef.current!;
    if (grid.filledCount === 0) gridRef.current = seededGrid(grid.sizeX);
    setRev((value) => value + 1);
    onModelChange(serializeVoxelGrid(gridRef.current!));
  };

  /** Decode a flat grid-cell index back to (x, y, z). */
  const cellCoords = (cellIndex: number, grid: VoxelGrid): [number, number, number] => {
    const layer = grid.sizeX * grid.sizeY;
    const z = Math.floor(cellIndex / layer);
    const rest = cellIndex - z * layer;
    return [rest % grid.sizeX, Math.floor(rest / grid.sizeX), z];
  };

  /** Resolve a canvas pixel to the picked grid cell and its face, or null. */
  const pickAt = (clientX: number, clientY: number): { x: number; y: number; z: number; face: number } | null => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const px = Math.floor(((clientX - rect.left) / rect.width) * VIEWPORT);
    const py = Math.floor(((clientY - rect.top) / rect.height) * VIEWPORT);
    if (px < 0 || px >= VIEWPORT || py < 0 || py >= VIEWPORT) return null;
    const di = py * VIEWPORT + px;
    const voxel = buffers.pickVoxel[di]!;
    if (voxel < 0) return null; // empty space
    const [x, y, z] = cellCoords(model3d.gridIndex[voxel]!, gridRef.current!);
    return { x, y, z, face: buffers.pickFace[di]! };
  };

  type Pick = { x: number; y: number; z: number; face: number };

  /** The cell a tool would act on: the empty neighbour for Add, else the cell itself. */
  const targetCell = (pick: Pick, action: VoxelTool): Cell | null => {
    if (action === "add") {
      const [nx, ny, nz] = CUBE_FACES[pick.face]!.normal;
      const cell: Cell = [pick.x + nx, pick.y + ny, pick.z + nz];
      return gridRef.current!.inBounds(cell[0], cell[1], cell[2]) ? cell : null;
    }
    return [pick.x, pick.y, pick.z];
  };

  /** Where the Shape tool centres: the empty neighbour of the clicked face. */
  const shapeCenter = (pick: Pick): Cell => {
    const [nx, ny, nz] = CUBE_FACES[pick.face]!.normal;
    return [pick.x + nx, pick.y + ny, pick.z + nz];
  };

  /** What the cursor currently targets, for the hover preview. */
  const hoverFrom = (pick: Pick): HoverTarget | null => {
    if (tool === "shape") return { cell: shapeCenter(pick), face: pick.face };
    const cell = targetCell(pick, tool);
    return cell ? { cell, face: pick.face } : null;
  };

  /**
   * Stamp (or, on a right-click, carve) the shape on the clicked face's plane.
   * Adding lands on the empty layer just off the surface (so it builds outward
   * like the Add tool); erasing centres on the clicked cell itself, so a
   * right-click cuts the shape *into* the surface you pointed at rather than into
   * empty space.
   */
  const stampShape = (pick: Pick, erase: boolean) => {
    const grid = gridRef.current!;
    const center: Cell = erase ? [pick.x, pick.y, pick.z] : shapeCenter(pick);
    const cells = shapePlaneCells(center, pick.face, shapeOffsets(shapeKind, shapeStyle, shapeRadius));
    const [r, g, b] = hexToRgb(paintHex);
    for (const [cx, cy, cz] of cells) {
      if (!grid.inBounds(cx, cy, cz)) continue;
      if (erase) grid.clear(cx, cy, cz);
      else grid.set(cx, cy, cz, r, g, b);
    }
  };

  /** Apply the active tool (or Remove on a right-click) at a canvas pixel. */
  const editAt = (clientX: number, clientY: number, removeOverride: boolean) => {
    const pick = pickAt(clientX, clientY);
    if (!pick) return;
    if (tool === "shape") {
      stampShape(pick, removeOverride);
      setHover(null);
      commit();
      return;
    }
    const action = removeOverride ? "remove" : tool;
    const cell = targetCell(pick, action);
    if (!cell) return;
    const grid = gridRef.current!;
    if (action === "remove") {
      grid.clear(cell[0], cell[1], cell[2]);
    } else {
      const [r, g, b] = hexToRgb(paintHex);
      grid.set(cell[0], cell[1], cell[2], r, g, b);
    }
    setHover(null);
    commit();
  };

  // Pointer: a drag past the threshold orbits the camera; a click edits.
  const drag = useRef<{ lastX: number; lastY: number; moved: boolean; button: number } | null>(null);

  const onPointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { lastX: event.clientX, lastY: event.clientY, moved: false, button: event.button };
  };
  const onPointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const state = drag.current;
    if (state) {
      const dx = event.clientX - state.lastX;
      const dy = event.clientY - state.lastY;
      if (!state.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
      if (!state.moved) setHover(null); // this press became an orbit, not a click
      state.moved = true;
      state.lastX = event.clientX;
      state.lastY = event.clientY;
      setYaw((value) => value - dx * ORBIT_SPEED);
      setPitch((value) => Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, value + dy * ORBIT_SPEED)));
      return;
    }
    // Plain hover: preview where the current tool would act.
    const pick = pickAt(event.clientX, event.clientY);
    const next = pick ? hoverFrom(pick) : null;
    setHover((prev) => (sameHover(prev, next) ? prev : next));
  };
  const onPointerUp = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const state = drag.current;
    drag.current = null;
    if (state && !state.moved) editAt(event.clientX, event.clientY, state.button === 2);
  };
  const onPointerLeave = () => setHover(null);
  const zoomBy = (delta: number) => setCell((value) => Math.max(CELL_MIN, Math.min(CELL_MAX, value + delta)));

  // Wheel-zoom without letting the page scroll under the cursor. React's onWheel
  // is passive (can't preventDefault), so bind a non-passive native listener.
  // Scroll up (deltaY < 0) zooms in; the closed-over zoomBy clamps to the fixed range.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const handler = (event: WheelEvent) => {
      event.preventDefault();
      zoomBy(-Math.sign(event.deltaY) * CELL_STEP);
    };
    canvas.addEventListener("wheel", handler, { passive: false });
    return () => canvas.removeEventListener("wheel", handler);
  }, []);

  const resize = (next: number) => {
    const old = gridRef.current!;
    const grid = new VoxelGrid(next, next, next);
    old.forEachFilled((x, y, z, voxel) => {
      if (x < next && y < next && z < next) grid.set(x, y, z, voxel.r, voxel.g, voxel.b, voxel.emissive);
    });
    if (grid.filledCount === 0) gridRef.current = seededGrid(next);
    else gridRef.current = grid;
    setGridSize(next);
    // Refit the zoom so the resized model opens framed to the viewport.
    setCell(fitCellForGrid(gridRef.current!));
    setRev((value) => value + 1);
    onModelChange(serializeVoxelGrid(gridRef.current!));
  };

  const clearAll = () => {
    gridRef.current = seededGrid(gridSize);
    setCell(fitCellForGrid(gridRef.current!));
    setRev((value) => value + 1);
    onModelChange(serializeVoxelGrid(gridRef.current!));
  };

  const [publishedNote, setPublishedNote] = useState<string | null>(null);

  /** Add or update this model in the backdrop working set to place it in the scene. */
  const publishAsProp = async () => {
    const name = window.prompt("Name this backdrop prop", pendingEdit?.name ?? "Voxel prop")?.trim();
    if (!name) return;
    const voxel = serializeVoxelGrid(gridRef.current!);
    const base = loadWorkingSet() ?? (await loadPublishedSet());
    const targetId = pendingEdit?.targetId;
    const props =
      targetId && base.props.some((p) => p.id === targetId)
        ? // Re-publish over the same prop, keeping its placement + motion.
          base.props.map((p) => (p.id === targetId ? { ...p, name, voxel, art: undefined } : p))
        : [...base.props, createVoxelBackdropProp(targetId ?? `voxel-${globalThis.crypto?.randomUUID?.() ?? Date.now().toString(36)}`, name, voxel)];
    saveWorkingSet({ version: base.version, props });
    setPublishedNote(name);
  };

  return (
    <div className={styles.body}>
      <aside className={styles.rail}>
        <div>
          <div className={styles.groupLabel}>Tool</div>
          <div className={styles.toolGroup}>
            {TOOLS.map((definition) => (
              <button
                key={definition.id}
                type="button"
                className={`${styles.toolBtn} ${tool === definition.id ? styles.toolBtnActive : ""}`}
                onClick={() => setTool(definition.id)}
                aria-pressed={tool === definition.id}
              >
                <span className={styles.toolGlyph} aria-hidden>
                  {definition.glyph}
                </span>
                {definition.label}
              </button>
            ))}
          </div>
        </div>

        {tool === "shape" && (
          <div>
            <div className={styles.groupLabel}>Shape</div>
            <div className={styles.segmented}>
              {SHAPE_KINDS.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  className={`${styles.segment} ${shapeKind === option.id ? styles.segmentActive : ""}`}
                  onClick={() => setShapeKind(option.id)}
                  aria-pressed={shapeKind === option.id}
                >
                  {option.label}
                </button>
              ))}
            </div>
            <div className={styles.segmented} style={{ marginTop: 6 }}>
              {SHAPE_STYLES.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  className={`${styles.segment} ${shapeStyle === option.id ? styles.segmentActive : ""}`}
                  onClick={() => setShapeStyle(option.id)}
                  aria-pressed={shapeStyle === option.id}
                >
                  {option.label}
                </button>
              ))}
            </div>
            <div className={styles.rangeRow} style={{ marginTop: 6 }}>
              <input
                type="range"
                min={SHAPE_RADIUS_MIN}
                max={SHAPE_RADIUS_MAX}
                step={1}
                value={shapeRadius}
                onChange={(event) => setShapeRadius(Number(event.target.value))}
                aria-label="Shape size in voxels"
              />
              <span className={`${styles.rangeValue} data`}>{shapeRadius * 2 + 1}</span>
            </div>
          </div>
        )}

        <div>
          <div className={styles.groupLabel}>Grid</div>
          <div className={styles.segmented}>
            {GRID_SIZES.map((option) => (
              <button
                key={option}
                type="button"
                className={`${styles.segment} ${gridSize === option ? styles.segmentActive : ""}`}
                onClick={() => resize(option)}
                title={`${option}³ voxels`}
              >
                {option}
              </button>
            ))}
          </div>
        </div>

        <div>
          <div className={styles.groupLabel}>Zoom</div>
          <div className={styles.segmented}>
            <button
              type="button"
              className={styles.segment}
              onClick={() => zoomBy(-CELL_STEP)}
              disabled={renderCell <= CELL_MIN}
              aria-label="Zoom out"
              title="Zoom out"
            >
              −
            </button>
            <button
              type="button"
              className={styles.segment}
              onClick={() => zoomBy(CELL_STEP)}
              disabled={renderCell >= CELL_MAX}
              aria-label="Zoom in"
              title={renderCell >= CELL_MAX ? "Maximum zoom" : "Zoom in"}
            >
              ＋
            </button>
          </div>
        </div>

        <button type="button" className={styles.toolBtn} onClick={clearAll} title="Clear the model">
          <span className={styles.toolGlyph} aria-hidden>
            ✕
          </span>
          Clear
        </button>

        <div>
          <div className={styles.groupLabel}>Backdrop</div>
          <button
            type="button"
            className={styles.toolBtn}
            onClick={() => void publishAsProp()}
            title="Add this model to the onboarding backdrop scene"
          >
            <span className={styles.toolGlyph} aria-hidden>
              ★
            </span>
            {pendingEdit ? "Update prop" : "Publish as prop"}
          </button>
          {publishedNote && (
            <p className={styles.panelMeta} style={{ lineHeight: 1.5, marginTop: 8 }}>
              Published “{publishedNote}” to the scene.{" "}
              <Link
                href="/backdrop"
                target="_blank"
                rel="noopener"
                style={{ color: "#7dfcb6", textDecoration: "underline" }}
              >
                Open the Backdrop manager
              </Link>{" "}
              to place, size, and animate it.
            </p>
          )}
        </div>
      </aside>

      <section className={styles.mapStage}>
        <canvas
          ref={canvasRef}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerLeave={onPointerLeave}
          onContextMenu={(event) => event.preventDefault()}
          style={{
            maxWidth: "min(560px, 100%)",
            width: "100%",
            height: "auto",
            imageRendering: "pixelated",
            touchAction: "none",
            cursor: "crosshair",
            background: "#0e101a",
            borderRadius: 8,
          }}
          role="img"
          aria-label="3D voxel model — drag to orbit, click a face to add or stamp a shape, right-click to remove"
        />
        <div className={styles.hud}>
          <span className={styles.hudItem}>
            <span className={styles.hudLabel}>Cubes</span>
            <span className={`${styles.hudValue} data`}>{model3d.count}</span>
          </span>
          <span className={styles.hudItem}>
            <span className={styles.hudLabel}>Grid</span>
            <span className={`${styles.hudValue} data`}>
              {gridSize}³
            </span>
          </span>
          <span className={styles.hudItem}>
            <span className={styles.hudLabel}>Drag</span>
            <span className={`${styles.hudValue} data`}>orbit</span>
          </span>
        </div>
      </section>

      <aside className={styles.inspector}>
        <div>
          <div className={styles.panelHead}>
            <span className={styles.panelTitle}>Palette</span>
            <span className={styles.panelMeta}>{paintHex}</span>
          </div>
          <div className={styles.paletteGrid}>
            {palette.map((css, index) => (
              <button
                key={index}
                type="button"
                className={`${styles.swatch} ${index === colorIndex ? styles.swatchActive : ""}`}
                style={{ background: css }}
                onClick={() => setColorIndex(index)}
                title={`${index} · ${css}`}
                aria-label={`Colour ${index}, ${css}`}
                aria-pressed={index === colorIndex}
              />
            ))}
          </div>
        </div>

        <p className={styles.panelMeta} style={{ lineHeight: 1.5 }}>
          {tool === "shape"
            ? "The glowing outline shows the shape's footprint on the face you point at. Pick Rect or Circle, Outline or Fill, and set the size; click a face to stamp it, right-click to erase it. Drag to orbit, scroll to zoom."
            : "The glowing outline shows where the next cube lands. Click a face to add there, right-click to remove, or switch tools. Drag to orbit, scroll to zoom."}
        </p>
      </aside>
    </div>
  );
}
