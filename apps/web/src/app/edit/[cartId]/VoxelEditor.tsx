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

/** A starter cube on the floor so there is always a face to build from. */
function seededGrid(size: number): VoxelGrid {
  const grid = new VoxelGrid(size, size, size);
  const mid = Math.floor(size / 2);
  grid.set(mid, 0, mid, SEED_COLOR[0], SEED_COLOR[1], SEED_COLOR[2], 0);
  return grid;
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
  const [pitch, setPitch] = useState(0.5);
  const [cell, setCell] = useState(12);
  const [tool, setTool] = useState<VoxelTool>("add");
  const [colorIndex, setColorIndex] = useState(1);

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
  }, [model3d, yaw, pitch, cell, size, buffers]);

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

  /** Apply the active tool (or Remove on a right-click) at a canvas pixel. */
  const editAt = (clientX: number, clientY: number, removeOverride: boolean) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const px = Math.floor(((clientX - rect.left) / rect.width) * size);
    const py = Math.floor(((clientY - rect.top) / rect.height) * size);
    if (px < 0 || px >= size || py < 0 || py >= size) return;

    const di = py * size + px;
    const voxel = buffers.pickVoxel[di]!;
    if (voxel < 0) return; // clicked empty space — nothing to act on

    const grid = gridRef.current!;
    const [x, y, z] = cellCoords(model3d.gridIndex[voxel]!, grid);
    const [r, g, b] = hexToRgb(paintHex);
    const action = removeOverride ? "remove" : tool;

    if (action === "remove") {
      grid.clear(x, y, z);
    } else if (action === "paint") {
      grid.set(x, y, z, r, g, b);
    } else {
      const [nx, ny, nz] = CUBE_FACES[buffers.pickFace[di]!]!.normal;
      grid.set(x + nx, y + ny, z + nz, r, g, b);
    }
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
    if (!state) return;
    const dx = event.clientX - state.lastX;
    const dy = event.clientY - state.lastY;
    if (!state.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
    state.moved = true;
    state.lastX = event.clientX;
    state.lastY = event.clientY;
    setYaw((value) => value - dx * ORBIT_SPEED);
    setPitch((value) => Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, value + dy * ORBIT_SPEED)));
  };
  const onPointerUp = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const state = drag.current;
    drag.current = null;
    if (state && !state.moved) editAt(event.clientX, event.clientY, state.button === 2);
  };
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
      </aside>

      <section className={styles.mapStage}>
        <canvas
          ref={canvasRef}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
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
          Drag to orbit. Click a face to add a cube, right-click to remove, or use the tools. Scroll
          to zoom.
        </p>
      </aside>
    </div>
  );
}
