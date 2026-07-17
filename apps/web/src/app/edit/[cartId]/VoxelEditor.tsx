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
  voxelCanvasSize,
  CUBE_FACES,
  DEFAULT_MODEL_LIGHT,
  MAX_VOXEL_GRID_DIM,
  type SpriteSheet,
} from "@cartbox/editor";

import { createVoxelBackdropProp } from "@/lib/backdropProps";
import { loadWorkingSet, loadPublishedSet, saveWorkingSet } from "@/lib/backdropPropsStore";
import styles from "./editor.module.css";

const DEFAULT_GRID = 16;
const GRID_SIZES = [8, 16, 24, 32].filter((n) => n <= MAX_VOXEL_GRID_DIM);
const CELL_MIN = 4;
const CELL_MAX = 22;
const PITCH_LIMIT = 1.45;
const ORBIT_SPEED = 0.011; // radians per pixel dragged
const DRAG_THRESHOLD = 4; // px of movement before a press becomes an orbit
const SEED_COLOR: readonly [number, number, number] = [176, 182, 198];

type VoxelTool = "add" | "remove" | "paint";
const TOOLS: readonly { id: VoxelTool; label: string; glyph: string }[] = [
  { id: "add", label: "Add", glyph: "＋" },
  { id: "remove", label: "Remove", glyph: "－" },
  { id: "paint", label: "Paint", glyph: "🖌" },
];

/** `#rrggbb` → 0..255 RGB triple (falls back to white on a malformed value). */
function hexToRgb(hex: string): [number, number, number] {
  const value = Number.parseInt(hex.slice(1), 16);
  if (Number.isNaN(value)) return [255, 255, 255];
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}

/** Bright wireframe colour of the hovered target cell, per tool. */
const HIGHLIGHT: Record<VoxelTool, string> = { add: "#7dfcb6", remove: "#ff7b7b", paint: "#ffdd66" };

type Cell = [number, number, number];
const sameCell = (a: Cell | null, b: Cell | null): boolean =>
  a === b || (a !== null && b !== null && a[0] === b[0] && a[1] === b[1] && a[2] === b[2]);

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
  gridSize: number,
  yaw: number,
  pitch: number,
  cellPx: number,
  size: number,
  color: string,
): void {
  const half = (gridSize - 1) / 2;
  const cx = cell[0] - half;
  const cy = cell[1] - half;
  const cz = cell[2] - half;
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
}

export function VoxelEditor({ sheet, model, onModelChange }: VoxelEditorProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // The grid is the source of truth; it is seeded once from `model` on mount
  // (the tab remounts on undo/redo, which re-reads the restored `model`).
  const gridRef = useRef<VoxelGrid | null>(null);
  if (gridRef.current === null) gridRef.current = loadGrid(model);

  const [gridSize, setGridSize] = useState(() => gridRef.current!.sizeX);
  const [rev, setRev] = useState(0); // bumped to rebuild the model after edits
  const [yaw, setYaw] = useState(0.7);
  const [pitch, setPitch] = useState(0.72);
  const [cell, setCell] = useState(12);
  const [tool, setTool] = useState<VoxelTool>("add");
  const [colorIndex, setColorIndex] = useState(1);
  const [hover, setHover] = useState<Cell | null>(null); // target cell under the cursor

  const palette = useMemo(() => sheet.cssPalette(), [sheet]);
  const paintHex = palette[colorIndex] ?? "#ffffff";

  // Rebuild the renderable model whenever the grid changes (rev) or resizes.
  const model3d = useMemo(() => voxelGridToModel(gridRef.current!), [rev, gridSize]);
  const size = voxelCanvasSize(model3d, cell);

  // Reused render + picking buffers, reallocated only when the canvas resizes.
  const buffers = useMemo(
    () => ({
      out: new Uint8ClampedArray(size * size * 4),
      depth: new Float32Array(size * size),
      pickVoxel: new Int32Array(size * size),
      pickFace: new Int8Array(size * size),
    }),
    [size],
  );

  // Render on any camera or model change; the pick buffers persist for clicks.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.width = size;
    canvas.height = size;
    const context = canvas.getContext("2d");
    if (!context) return;
    renderVoxelModel(model3d, {
      yaw,
      pitch,
      cell,
      light: DEFAULT_MODEL_LIGHT,
      out: buffers.out,
      depthBuffer: buffers.depth,
      pickVoxel: buffers.pickVoxel,
      pickFace: buffers.pickFace,
    });
    const image = context.createImageData(size, size);
    image.data.set(buffers.out);
    context.putImageData(image, 0, 0);
    // Outline the cell the cursor is targeting so every tool shows where it acts.
    if (hover) drawHighlight(context, hover, gridSize, yaw, pitch, cell, size, HIGHLIGHT[tool]);
  }, [model3d, yaw, pitch, cell, size, buffers, hover, tool, gridSize]);

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
    const px = Math.floor(((clientX - rect.left) / rect.width) * size);
    const py = Math.floor(((clientY - rect.top) / rect.height) * size);
    if (px < 0 || px >= size || py < 0 || py >= size) return null;
    const di = py * size + px;
    const voxel = buffers.pickVoxel[di]!;
    if (voxel < 0) return null; // empty space
    const [x, y, z] = cellCoords(model3d.gridIndex[voxel]!, gridRef.current!);
    return { x, y, z, face: buffers.pickFace[di]! };
  };

  /** The cell a tool would act on: the empty neighbour for Add, else the cell itself. */
  const targetCell = (pick: { x: number; y: number; z: number; face: number }, action: VoxelTool): Cell | null => {
    if (action === "add") {
      const [nx, ny, nz] = CUBE_FACES[pick.face]!.normal;
      const cell: Cell = [pick.x + nx, pick.y + ny, pick.z + nz];
      return gridRef.current!.inBounds(cell[0], cell[1], cell[2]) ? cell : null;
    }
    return [pick.x, pick.y, pick.z];
  };

  /** Apply the active tool (or Remove on a right-click) at a canvas pixel. */
  const editAt = (clientX: number, clientY: number, removeOverride: boolean) => {
    const pick = pickAt(clientX, clientY);
    if (!pick) return;
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
    // Plain hover: preview the cell the current tool would act on.
    const pick = pickAt(event.clientX, event.clientY);
    const next = pick ? targetCell(pick, tool) : null;
    setHover((prev) => (sameCell(prev, next) ? prev : next));
  };
  const onPointerUp = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const state = drag.current;
    drag.current = null;
    if (state && !state.moved) editAt(event.clientX, event.clientY, state.button === 2);
  };
  const onPointerLeave = () => setHover(null);
  const onWheel = (event: React.WheelEvent<HTMLCanvasElement>) => {
    setCell((value) => Math.max(CELL_MIN, Math.min(CELL_MAX, value - Math.sign(event.deltaY))));
  };

  const resize = (next: number) => {
    const old = gridRef.current!;
    const grid = new VoxelGrid(next, next, next);
    old.forEachFilled((x, y, z, voxel) => {
      if (x < next && y < next && z < next) grid.set(x, y, z, voxel.r, voxel.g, voxel.b, voxel.emissive);
    });
    if (grid.filledCount === 0) gridRef.current = seededGrid(next);
    else gridRef.current = grid;
    setGridSize(next);
    setRev((value) => value + 1);
    onModelChange(serializeVoxelGrid(gridRef.current!));
  };

  const clearAll = () => {
    gridRef.current = seededGrid(gridSize);
    setRev((value) => value + 1);
    onModelChange(serializeVoxelGrid(gridRef.current!));
  };

  const [publishedNote, setPublishedNote] = useState<string | null>(null);

  /** Add the current model to the backdrop working set to place it in the scene. */
  const publishAsProp = async () => {
    const name = window.prompt("Name this backdrop prop", "Voxel prop")?.trim();
    if (!name) return;
    const voxel = serializeVoxelGrid(gridRef.current!);
    const base = loadWorkingSet() ?? (await loadPublishedSet());
    const id = `voxel-${globalThis.crypto?.randomUUID?.() ?? Date.now().toString(36)}`;
    saveWorkingSet({ version: base.version, props: [...base.props, createVoxelBackdropProp(id, name, voxel)] });
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
            Publish as prop
          </button>
          {publishedNote && (
            <p className={styles.panelMeta} style={{ lineHeight: 1.5, marginTop: 8 }}>
              Added “{publishedNote}” to the scene.{" "}
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
          onWheel={onWheel}
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
          aria-label="3D voxel model — drag to orbit, click a face to add, right-click to remove"
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
          The glowing outline shows where the next cube lands. Click a face to add there, right-click
          to remove, or switch tools. Drag to orbit, scroll to zoom.
        </p>
      </aside>
    </div>
  );
}
