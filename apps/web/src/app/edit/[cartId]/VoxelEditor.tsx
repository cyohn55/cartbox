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
  scaleGridAxis,
  serializeVoxelGrid,
  deserializeVoxelGrid,
  renderVoxelModel,
  floodRegion,
  cellCoords,
  CUBE_FACES,
  MAX_VOXEL_GRID_DIM,
  shapeOffsets,
  solidOffsets,
  type VoxelShapeKind,
  type VoxelSolidKind,
  type VoxelShapeStyle,
  type ShapeOffset,
  type GridAxis,
  type GridVoxelModel,
  type ModelLight,
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

type VoxelTool = "add" | "remove" | "paint" | "fill" | "select" | "wand" | "shape";
const TOOLS: readonly { id: VoxelTool; label: string; glyph: string }[] = [
  { id: "add", label: "Add", glyph: "＋" },
  { id: "remove", label: "Remove", glyph: "－" },
  { id: "paint", label: "Paint", glyph: "🖌" },
  { id: "fill", label: "Fill", glyph: "🪣" },
  { id: "select", label: "Select", glyph: "⬚" },
  { id: "wand", label: "Wand", glyph: "✨" },
  { id: "shape", label: "Shape", glyph: "◫" },
];

// The paint/add/remove tools stamp a solid cube "brush" of this radius around the
// target cell (radius 0 = a single voxel, the classic one-cube edit). Kept small
// so even the largest brush is a cheap stamp.
const BRUSH_RADIUS_MIN = 0;
const BRUSH_RADIUS_MAX = 8;
const DEFAULT_BRUSH_RADIUS = 0;
const BRUSH_TOOLS: readonly VoxelTool[] = ["add", "remove", "paint"];

// The Magic Wand and Paint Bucket share one colour-matching flood; this is its
// tolerance, as a 0..100% slider mapped to the 0..1 the flood expects. 0 = an
// exact colour match, higher grabs progressively more of a shaded region.
const DEFAULT_TOLERANCE_PCT = 0;
const TOLERANCE_TOOLS: readonly VoxelTool[] = ["wand", "fill"];

// Selected voxels are tinted toward this colour and given an emissive floor when
// the model is built, so the selection glows from every camera angle without a
// per-voxel wireframe overlay (which would be costly for a large flood select).
const SELECT_TINT: readonly [number, number, number] = [96, 232, 255];
const SELECT_TINT_MIX = 0.6; // share of the tint blended over a selected voxel's colour
const SELECT_EMISSIVE_FLOOR = 0.5;

// The Shape tool stamps a shape of voxels at the cursor. Flat shapes (rectangle,
// circle) land on the plane of the clicked face; solid shapes (cube, sphere) are
// stamped as a 3D volume centred on the target cell. Radius is voxels from the
// centre to the edge, so the shape spans 2*radius + 1 voxels across; capped so
// even the largest outline stays a cheap preview to render.
type ShapeChoice = VoxelShapeKind | VoxelSolidKind;
const SHAPE_KINDS: readonly { id: ShapeChoice; label: string; solid: boolean }[] = [
  { id: "rectangle", label: "Rect", solid: false },
  { id: "circle", label: "Circle", solid: false },
  { id: "cube", label: "Cube", solid: true },
  { id: "sphere", label: "Sphere", solid: true },
];
const isSolidKind = (kind: ShapeChoice): kind is VoxelSolidKind => kind === "cube" || kind === "sphere";
const SHAPE_STYLES: readonly { id: VoxelShapeStyle; label: string }[] = [
  { id: "outline", label: "Outline" },
  { id: "fill", label: "Fill" },
];
const SHAPE_RADIUS_MIN = 1;
const SHAPE_RADIUS_MAX = 32;
const DEFAULT_SHAPE_RADIUS = 3;

// Non-uniform scaling: arm an axis with the X/Y/Z key, then the wheel stretches
// (scroll up) or squashes (scroll down) the model's content along it. One notch
// is a fixed proportional step, applied by resampling the grid.
const AXIS_KEYS: Record<string, GridAxis> = { x: 0, y: 1, z: 2 };
const AXIS_LABELS = ["X", "Y", "Z"] as const;
const SCALE_STEP = 1.18; // per wheel-notch stretch factor (its reciprocal squashes)

// Live relighting so the sculpt can be judged under different conditions. The
// direction is derived from an azimuth (around) and elevation (up/down); the
// toggle's "off" state is a flat, fully-ambient light that shows pure albedo.
const LIGHT_DEFAULTS = { azimuth: 35, elevation: 45, intensity: 1, ambient: 0.32 };

/** A world-fixed light built from the editor's azimuth/elevation/strength controls. */
function buildLight(
  on: boolean,
  azimuthDeg: number,
  elevationDeg: number,
  intensity: number,
  ambient: number,
): ModelLight {
  if (!on) return { direction: [0, 1, 0], color: [1, 1, 1], intensity: 0, ambient: 1 };
  const az = (azimuthDeg * Math.PI) / 180;
  const el = (elevationDeg * Math.PI) / 180;
  return {
    direction: [Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az)],
    color: [1, 1, 1],
    intensity,
    ambient,
  };
}

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
  fill: "#ffb066",
  select: "#7df0ff",
  wand: "#c69dff",
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
  half = 0.5,
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
    corners.push(project(cx + (i & 1 ? half : -half), cy + (i & 2 ? half : -half), cz + (i & 4 ? half : -half)));
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
  const [shapeKind, setShapeKind] = useState<ShapeChoice>("rectangle");
  const [shapeStyle, setShapeStyle] = useState<VoxelShapeStyle>("outline");
  const [shapeRadius, setShapeRadius] = useState(DEFAULT_SHAPE_RADIUS);
  const solidShape = isSolidKind(shapeKind);

  // Brush size for the add/remove/paint tools, and colour tolerance for the
  // wand/fill flood.
  const [brushRadius, setBrushRadius] = useState(DEFAULT_BRUSH_RADIUS);
  const [tolerancePct, setTolerancePct] = useState(DEFAULT_TOLERANCE_PCT);

  // The set of selected grid-cell indices (flat), populated by the Select and
  // Wand tools. A new Set each change so React re-renders and the memo below
  // recomputes the tinted model.
  const [selection, setSelection] = useState<ReadonlySet<number>>(() => new Set());

  // The axis armed for wheel-scaling (X/Y/Z key), or null when the wheel zooms.
  const [scaleAxis, setScaleAxis] = useState<GridAxis | null>(null);

  // Lighting controls for previewing the sculpt under different conditions.
  const [lightOn, setLightOn] = useState(true);
  const [lightAzimuth, setLightAzimuth] = useState(LIGHT_DEFAULTS.azimuth);
  const [lightElevation, setLightElevation] = useState(LIGHT_DEFAULTS.elevation);
  const [lightIntensity, setLightIntensity] = useState(LIGHT_DEFAULTS.intensity);
  const [lightAmbient, setLightAmbient] = useState(LIGHT_DEFAULTS.ambient);
  const light = useMemo(
    () => buildLight(lightOn, lightAzimuth, lightElevation, lightIntensity, lightAmbient),
    [lightOn, lightAzimuth, lightElevation, lightIntensity, lightAmbient],
  );

  const palette = useMemo(() => sheet.cssPalette(), [sheet]);
  const paintHex = palette[colorIndex] ?? "#ffffff";

  // Rebuild the renderable model whenever the grid changes (rev) or resizes.
  // Centre on the filled content so a small sculpt sits in the middle of the
  // viewport (and rotates about its own centre), not low against the grid floor.
  const model3d = useMemo(() => voxelGridToModel(gridRef.current!, { center: "content" }), [rev, gridSize]);

  // The model actually drawn: identical geometry to `model3d` (so picking still
  // resolves through the same voxel/grid indices), but with selected voxels
  // tinted and made emissive so the selection glows. Falls through to `model3d`
  // untouched when nothing is selected, the common case.
  const renderModel = useMemo<GridVoxelModel>(() => {
    if (selection.size === 0) return model3d;
    const r = Uint8ClampedArray.from(model3d.r);
    const g = Uint8ClampedArray.from(model3d.g);
    const b = Uint8ClampedArray.from(model3d.b);
    const emissive = Float32Array.from(model3d.emissive);
    for (let v = 0; v < model3d.count; v += 1) {
      if (!selection.has(model3d.gridIndex[v]!)) continue;
      r[v] = Math.round(r[v]! * (1 - SELECT_TINT_MIX) + SELECT_TINT[0] * SELECT_TINT_MIX);
      g[v] = Math.round(g[v]! * (1 - SELECT_TINT_MIX) + SELECT_TINT[1] * SELECT_TINT_MIX);
      b[v] = Math.round(b[v]! * (1 - SELECT_TINT_MIX) + SELECT_TINT[2] * SELECT_TINT_MIX);
      emissive[v] = Math.max(emissive[v]!, SELECT_EMISSIVE_FLOOR);
    }
    return { ...model3d, r, g, b, emissive };
  }, [model3d, selection]);

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
    renderVoxelModel(renderModel, {
      yaw,
      pitch,
      cell: renderCell,
      size: VIEWPORT,
      light,
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
      if (tool === "shape" && solidShape) {
        // A solid's footprint is a whole volume; one bounding-box wireframe reads
        // clearly and stays cheap regardless of radius.
        drawHighlight(context, hover.cell, origin, yaw, pitch, renderCell, VIEWPORT, color, shapeRadius + 0.5);
      } else if (BRUSH_TOOLS.includes(tool) && brushRadius > 0) {
        // The brush stamps a cube; a single bounding wireframe shows its reach.
        drawHighlight(context, hover.cell, origin, yaw, pitch, renderCell, VIEWPORT, color, brushRadius + 0.5);
      } else {
        const cells =
          tool === "shape"
            ? shapePlaneCells(hover.cell, hover.face, shapeOffsets(shapeKind as VoxelShapeKind, "outline", shapeRadius))
            : [hover.cell];
        for (const target of cells) {
          drawHighlight(context, target, origin, yaw, pitch, renderCell, VIEWPORT, color);
        }
      }
    }
  }, [renderModel, model3d, yaw, pitch, renderCell, buffers, hover, tool, brushRadius, shapeKind, solidShape, shapeRadius, light]);

  /** Persist the current grid to undo/save; re-seed if it was emptied. */
  const commit = () => {
    const grid = gridRef.current!;
    if (grid.filledCount === 0) gridRef.current = seededGrid(grid.sizeX);
    setRev((value) => value + 1);
    onModelChange(serializeVoxelGrid(gridRef.current!));
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
    const [x, y, z] = cellCoords(gridRef.current!, model3d.gridIndex[voxel]!);
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
    // Flat shapes stamp on the clicked face's plane; solids fill a 3D volume
    // around the centre cell.
    const cells: Cell[] = solidShape
      ? solidOffsets(shapeKind as VoxelSolidKind, shapeStyle, shapeRadius).map(({ du, dv, dw }) => [
          center[0] + du,
          center[1] + dv,
          center[2] + dw,
        ])
      : shapePlaneCells(center, pick.face, shapeOffsets(shapeKind as VoxelShapeKind, shapeStyle, shapeRadius));
    const [r, g, b] = hexToRgb(paintHex);
    for (const [cx, cy, cz] of cells) {
      if (!grid.inBounds(cx, cy, cz)) continue;
      if (erase) grid.clear(cx, cy, cz);
      else grid.set(cx, cy, cz, r, g, b);
    }
  };

  /**
   * Stamp the add/remove/paint brush — a solid cube of `brushRadius` centred on
   * the target cell (the empty neighbour for Add, the clicked cell otherwise).
   * Add fills every cell in the cube, Remove clears them, Paint recolours only
   * the cells that are already solid (so it never conjures new voxels).
   */
  const applyBrush = (pick: Pick, action: "add" | "remove" | "paint") => {
    const center = targetCell(pick, action);
    if (!center) return;
    const grid = gridRef.current!;
    const [r, g, b] = hexToRgb(paintHex);
    for (const { du, dv, dw } of solidOffsets("cube", "fill", brushRadius)) {
      const cx = center[0] + du;
      const cy = center[1] + dv;
      const cz = center[2] + dw;
      if (!grid.inBounds(cx, cy, cz)) continue;
      if (action === "remove") grid.clear(cx, cy, cz);
      else if (action === "add") grid.set(cx, cy, cz, r, g, b);
      else if (grid.isFilled(cx, cy, cz)) grid.set(cx, cy, cz, r, g, b);
    }
    setHover(null);
    commit();
  };

  /** Toggle (additive) or set (replace) the picked voxel in the selection. */
  const applySelect = (pick: Pick, additive: boolean) => {
    const index = gridRef.current!.index(pick.x, pick.y, pick.z);
    setSelection((prev) => {
      if (!additive) return new Set([index]);
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  };

  /** Magic Wand: flood the connected same-colour run and select it (add on shift). */
  const applyWand = (pick: Pick, additive: boolean) => {
    const region = floodRegion(gridRef.current!, pick.x, pick.y, pick.z, { tolerance: tolerancePct / 100 });
    if (region.length === 0) return;
    setSelection((prev) => (additive ? new Set([...prev, ...region]) : new Set(region)));
  };

  /** Paint Bucket: flood the connected same-colour run and recolour it (erase on right-click). */
  const applyFill = (pick: Pick, erase: boolean) => {
    const grid = gridRef.current!;
    const region = floodRegion(grid, pick.x, pick.y, pick.z, { tolerance: tolerancePct / 100 });
    if (region.length === 0) return;
    const [r, g, b] = hexToRgb(paintHex);
    for (const index of region) {
      const [x, y, z] = cellCoords(grid, index);
      if (erase) grid.clear(x, y, z);
      else grid.set(x, y, z, r, g, b);
    }
    setHover(null);
    commit();
  };

  /** Apply the active tool at a canvas pixel. Right-click removes/erases; Shift adds to a selection. */
  const applyAt = (clientX: number, clientY: number, secondary: boolean, shift: boolean) => {
    const pick = pickAt(clientX, clientY);
    if (!pick) {
      // Clicking empty space with the Select tool (no modifier) clears the selection.
      if (tool === "select" && !shift) setSelection(new Set());
      return;
    }
    switch (tool) {
      case "shape":
        stampShape(pick, secondary);
        setHover(null);
        commit();
        return;
      case "select":
        applySelect(pick, shift || secondary);
        return;
      case "wand":
        applyWand(pick, shift);
        return;
      case "fill":
        applyFill(pick, secondary);
        return;
      default:
        applyBrush(pick, secondary ? "remove" : (tool as "add" | "remove" | "paint"));
    }
  };

  // Pointer: a drag past the threshold orbits the camera; a click edits. The
  // Shift state is captured at press time so Shift-click accumulates a selection.
  const drag = useRef<{ lastX: number; lastY: number; moved: boolean; button: number; shift: boolean } | null>(null);

  const onPointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { lastX: event.clientX, lastY: event.clientY, moved: false, button: event.button, shift: event.shiftKey };
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
    if (state && !state.moved) applyAt(event.clientX, event.clientY, state.button === 2, state.shift);
  };
  const onPointerLeave = () => setHover(null);
  const zoomBy = (delta: number) => setCell((value) => Math.max(CELL_MIN, Math.min(CELL_MAX, value + delta)));

  const clearSelection = () => setSelection(new Set());

  /** Recolour every selected (still-solid) voxel to the active palette colour. */
  const paintSelection = () => {
    if (selection.size === 0) return;
    const grid = gridRef.current!;
    const [r, g, b] = hexToRgb(paintHex);
    for (const index of selection) {
      const [x, y, z] = cellCoords(grid, index);
      if (grid.isFilled(x, y, z)) grid.set(x, y, z, r, g, b);
    }
    commit();
  };

  /** Delete every selected voxel, then clear the (now-empty) selection. */
  const deleteSelection = () => {
    if (selection.size === 0) return;
    const grid = gridRef.current!;
    for (const index of selection) {
      const [x, y, z] = cellCoords(grid, index);
      grid.clear(x, y, z);
    }
    clearSelection();
    setHover(null);
    commit();
  };

  /** Stretch (grow) or squash the model along `axis` by one proportional step. */
  const scaleActiveAxis = (axis: GridAxis, grow: boolean) => {
    const next = scaleGridAxis(gridRef.current!, axis, grow ? SCALE_STEP : 1 / SCALE_STEP);
    if (next.filledCount === 0) return; // squashed to nothing — keep what we had
    gridRef.current = next;
    clearSelection(); // cell indices no longer map to the same voxels
    setHover(null);
    commit();
  };

  // Arm/disarm a scale axis with the X/Y/Z keys (press again, or Escape, to
  // disarm). Ignored while a form field is focused so it never eats typing.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
      if (event.key === "Escape") {
        setScaleAxis(null);
        return;
      }
      const axis = AXIS_KEYS[event.key.toLowerCase()];
      if (axis === undefined) return;
      event.preventDefault();
      setScaleAxis((current) => (current === axis ? null : axis));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Delete/Backspace removes the current selection; Escape clears it. Re-bound on
  // selection changes so the handler closes over the latest set. Ignored while a
  // form field is focused so it never eats typing.
  useEffect(() => {
    if (selection.size === 0) return;
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
      if (event.key === "Delete" || event.key === "Backspace") {
        event.preventDefault();
        deleteSelection();
      } else if (event.key === "Escape") {
        event.preventDefault();
        clearSelection();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selection]);

  // Wheel without letting the page scroll under the cursor. React's onWheel is
  // passive (can't preventDefault), so bind a non-passive native listener. With
  // an axis armed the wheel scales the model along it (scroll up = stretch);
  // otherwise scroll up (deltaY < 0) zooms in, clamped to the fixed range.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const handler = (event: WheelEvent) => {
      event.preventDefault();
      if (scaleAxis !== null) scaleActiveAxis(scaleAxis, event.deltaY < 0);
      else zoomBy(-Math.sign(event.deltaY) * CELL_STEP);
    };
    canvas.addEventListener("wheel", handler, { passive: false });
    return () => canvas.removeEventListener("wheel", handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scaleAxis]);

  const resize = (next: number) => {
    const old = gridRef.current!;
    const grid = new VoxelGrid(next, next, next);
    old.forEachFilled((x, y, z, voxel) => {
      if (x < next && y < next && z < next) grid.set(x, y, z, voxel.r, voxel.g, voxel.b, voxel.emissive);
    });
    if (grid.filledCount === 0) gridRef.current = seededGrid(next);
    else gridRef.current = grid;
    setGridSize(next);
    clearSelection(); // indices are relative to the old grid dimensions
    // Refit the zoom so the resized model opens framed to the viewport.
    setCell(fitCellForGrid(gridRef.current!));
    setRev((value) => value + 1);
    onModelChange(serializeVoxelGrid(gridRef.current!));
  };

  const clearAll = () => {
    gridRef.current = seededGrid(gridSize);
    clearSelection();
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

        {BRUSH_TOOLS.includes(tool) && (
          <div>
            <div className={styles.groupLabel}>Brush size</div>
            <div className={styles.rangeRow}>
              <input
                type="range"
                min={BRUSH_RADIUS_MIN}
                max={BRUSH_RADIUS_MAX}
                step={1}
                value={brushRadius}
                onChange={(event) => setBrushRadius(Number(event.target.value))}
                aria-label="Brush size in voxels"
              />
              <span className={`${styles.rangeValue} data`}>{brushRadius * 2 + 1}</span>
            </div>
            <p className={styles.panelMeta} style={{ lineHeight: 1.5, marginTop: 6 }}>
              {brushRadius === 0
                ? "One voxel per click."
                : `Stamps a ${brushRadius * 2 + 1}³ cube per click.`}
            </p>
          </div>
        )}

        {TOLERANCE_TOOLS.includes(tool) && (
          <div>
            <div className={styles.groupLabel}>Colour tolerance</div>
            <div className={styles.rangeRow}>
              <input
                type="range"
                min={0}
                max={100}
                step={1}
                value={tolerancePct}
                onChange={(event) => setTolerancePct(Number(event.target.value))}
                aria-label="Colour match tolerance"
              />
              <span className={`${styles.rangeValue} data`}>{tolerancePct}%</span>
            </div>
            <p className={styles.panelMeta} style={{ lineHeight: 1.5, marginTop: 6 }}>
              {tool === "wand"
                ? "Click a voxel to select its connected colour run. Shift-click adds another run."
                : "Click a voxel to flood the palette colour through its connected run. Right-click erases it."}
            </p>
          </div>
        )}

        {selection.size > 0 && (
          <div>
            <div className={styles.groupLabel}>Selection · {selection.size}</div>
            <button
              type="button"
              className={styles.toolBtn}
              onClick={paintSelection}
              title="Recolour the selected voxels to the active palette colour"
            >
              <span className={styles.toolGlyph} aria-hidden>
                🖌
              </span>
              Paint selection
            </button>
            <button
              type="button"
              className={styles.toolBtn}
              onClick={deleteSelection}
              title="Delete the selected voxels (Delete key)"
              style={{ marginTop: 6 }}
            >
              <span className={styles.toolGlyph} aria-hidden>
                🗑
              </span>
              Delete selection
            </button>
            <button
              type="button"
              className={styles.toolBtn}
              onClick={clearSelection}
              title="Clear the selection (Esc)"
              style={{ marginTop: 6 }}
            >
              <span className={styles.toolGlyph} aria-hidden>
                ✕
              </span>
              Deselect
            </button>
          </div>
        )}

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

        <div>
          <div className={styles.groupLabel}>Scale axis · scroll</div>
          <div className={styles.segmented}>
            {AXIS_LABELS.map((label, axis) => (
              <button
                key={label}
                type="button"
                className={`${styles.segment} ${scaleAxis === axis ? styles.segmentActive : ""}`}
                onClick={() => setScaleAxis((current) => (current === axis ? null : (axis as GridAxis)))}
                aria-pressed={scaleAxis === axis}
                title={`Press ${label} then scroll to stretch/squash along ${label}`}
              >
                {label}
              </button>
            ))}
          </div>
          <p className={styles.panelMeta} style={{ lineHeight: 1.5, marginTop: 6 }}>
            {scaleAxis !== null
              ? `Scroll to stretch or squash along ${AXIS_LABELS[scaleAxis]}. Press ${AXIS_LABELS[scaleAxis]} or Esc to stop.`
              : "Press X, Y, or Z (or tap above), then scroll to scale that axis."}
          </p>
        </div>

        <div>
          <div className={styles.groupLabel}>Lighting</div>
          <div className={styles.segmented}>
            <button
              type="button"
              className={`${styles.segment} ${lightOn ? styles.segmentActive : ""}`}
              onClick={() => setLightOn(true)}
              aria-pressed={lightOn}
            >
              On
            </button>
            <button
              type="button"
              className={`${styles.segment} ${!lightOn ? styles.segmentActive : ""}`}
              onClick={() => setLightOn(false)}
              aria-pressed={!lightOn}
              title="Flat, fully-lit — shows the raw voxel colours"
            >
              Flat
            </button>
          </div>
          {lightOn && (
            <>
              <div className={styles.groupLabel} style={{ marginTop: 8 }}>Angle</div>
              <div className={styles.rangeRow}>
                <input
                  type="range"
                  min={0}
                  max={360}
                  step={5}
                  value={lightAzimuth}
                  onChange={(event) => setLightAzimuth(Number(event.target.value))}
                  aria-label="Light angle around the model"
                />
                <span className={`${styles.rangeValue} data`}>{lightAzimuth}°</span>
              </div>
              <div className={styles.groupLabel} style={{ marginTop: 6 }}>Height</div>
              <div className={styles.rangeRow}>
                <input
                  type="range"
                  min={-80}
                  max={80}
                  step={5}
                  value={lightElevation}
                  onChange={(event) => setLightElevation(Number(event.target.value))}
                  aria-label="Light height above the model"
                />
                <span className={`${styles.rangeValue} data`}>{lightElevation}°</span>
              </div>
              <div className={styles.groupLabel} style={{ marginTop: 6 }}>Brightness</div>
              <div className={styles.rangeRow}>
                <input
                  type="range"
                  min={0}
                  max={150}
                  step={5}
                  value={Math.round(lightIntensity * 100)}
                  onChange={(event) => setLightIntensity(Number(event.target.value) / 100)}
                  aria-label="Light brightness"
                />
                <span className={`${styles.rangeValue} data`}>{Math.round(lightIntensity * 100)}%</span>
              </div>
              <div className={styles.groupLabel} style={{ marginTop: 6 }}>Ambient</div>
              <div className={styles.rangeRow}>
                <input
                  type="range"
                  min={0}
                  max={100}
                  step={5}
                  value={Math.round(lightAmbient * 100)}
                  onChange={(event) => setLightAmbient(Number(event.target.value) / 100)}
                  aria-label="Ambient fill light in shadow"
                />
                <span className={`${styles.rangeValue} data`}>{Math.round(lightAmbient * 100)}%</span>
              </div>
            </>
          )}
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
            // Centre the canvas on the stage's cross axis — without this it
            // left-aligns in the column-flex stage whenever the stage is wider
            // than the 560px cap, so the model reads as stuck to the left.
            alignSelf: "center",
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
            <span className={styles.hudLabel}>Scroll</span>
            <span className={`${styles.hudValue} data`}>
              {scaleAxis !== null ? `scale ${AXIS_LABELS[scaleAxis]}` : "zoom"}
            </span>
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
            ? "The glowing outline shows the shape's footprint. Rect and Circle stamp on the face you point at; Cube and Sphere fill a 3D volume there. Pick Outline or Fill and a size, click a face to stamp, right-click to erase. Drag to orbit, scroll to zoom."
            : tool === "select"
              ? "Click a voxel to select it; Shift-click to add or remove more. Selected voxels glow — Paint or Delete the whole selection from the panel on the left. Drag to orbit, scroll to zoom."
              : tool === "wand"
                ? "Click a voxel to select every connected voxel of the same colour; raise the tolerance to grab shaded neighbours. Shift-click adds another run. Then Paint or Delete the selection. Drag to orbit, scroll to zoom."
                : tool === "fill"
                  ? "Click a voxel to flood the active palette colour through its connected same-colour run; right-click erases the run. Raise the tolerance to spread across shaded neighbours. Drag to orbit, scroll to zoom."
                  : "The glowing outline shows where the brush lands. Click a face to add there, right-click to remove; raise Brush size to stamp a cube. Drag to orbit, scroll to zoom — or press X/Y/Z and scroll to scale the model."}
        </p>
      </aside>
    </div>
  );
}
