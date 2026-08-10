"use client";

/**
 * The World tab: authors a cart's HD-2D {@link WorldScene} — a height-mapped 3D
 * tile terrain plus the billboard slots its 2D character sprites occupy. The cart
 * then drives the camera with `cartbox.worldcam` and places characters with
 * `cartbox.billboard`, and the runtime composites them into one depth buffer so
 * terrain and characters occlude correctly (the feature that makes "3D world, 2D
 * characters" shippable).
 *
 * The editor is deliberately plain: a top-down height grid you paint with a brush
 * height, a ground-tile sprite id, and a list of billboard slots (each a sprite id
 * + world size). The 3D result is seen by pressing Run — the playtest renders the
 * exact same world the shipped cart will. State is owned by the workbench so Save
 * persists it via the `world` sidecar.
 */

import { useMemo } from "react";
import type { WorldScene, WorldTileCell, WorldBillboard } from "@cartbox/player";

import styles from "./editor.module.css";

interface WorldEditorProps {
  world: WorldScene | null;
  onChange: (world: WorldScene | null) => void;
  /** Sprite brush height applied when painting cells. */
  brushHeight: number;
  onBrushHeightChange: (height: number) => void;
}

const DEFAULT_COLS = 8;
const DEFAULT_ROWS = 8;
const TILES_PER_SIDE = 4; // 32×32 tile blocks
const MAX_HEIGHT = 6;

/** A fresh flat world: an 8×8 floor of tile sprite 0 with one character slot. */
function makeDefaultWorld(): WorldScene {
  const cells: WorldTileCell[] = Array.from({ length: DEFAULT_COLS * DEFAULT_ROWS }, () => ({ h: 0, sprite: 0 }));
  return {
    cols: DEFAULT_COLS,
    rows: DEFAULT_ROWS,
    tilesPerSide: TILES_PER_SIDE,
    cells,
    billboards: [{ sprite: 4, width: 1, height: 1.6 }],
    camera: { yaw: Math.PI / 4, pitch: 0.62, distance: 0, fov: 0 },
  };
}

/** Height → a green ramp so the top-down grid reads as terrain relief. */
function heightColor(h: number): string {
  const t = Math.min(1, h / MAX_HEIGHT);
  const light = 26 + t * 45; // % lightness
  return `hsl(140 45% ${light}%)`;
}

export function WorldEditor({ world, onChange, brushHeight, onBrushHeightChange }: WorldEditorProps) {
  const cols = world?.cols ?? DEFAULT_COLS;
  const rows = world?.rows ?? DEFAULT_ROWS;

  const groundSprite = world?.cells[0]?.sprite ?? 0;

  const paintCell = (index: number) => {
    if (!world) return;
    const cells = world.cells.map((cell, i) => (i === index ? { ...cell, h: brushHeight } : cell));
    onChange({ ...world, cells });
  };

  const setGroundSprite = (sprite: number) => {
    if (!world) return;
    const cells = world.cells.map((cell) => ({ ...cell, sprite }));
    onChange({ ...world, cells });
  };

  const resize = (nextCols: number, nextRows: number) => {
    if (!world) return;
    const cells: WorldTileCell[] = [];
    for (let j = 0; j < nextRows; j += 1) {
      for (let i = 0; i < nextCols; i += 1) {
        const existing = i < world.cols && j < world.rows ? world.cells[j * world.cols + i] : undefined;
        cells.push(existing ?? { h: 0, sprite: groundSprite });
      }
    }
    onChange({ ...world, cols: nextCols, rows: nextRows, cells });
  };

  const setBillboard = (index: number, patch: Partial<WorldBillboard>) => {
    if (!world) return;
    const billboards = world.billboards.map((slot, i) => (i === index ? { ...slot, ...patch } : slot));
    onChange({ ...world, billboards });
  };
  const addBillboard = () => {
    if (!world) return;
    onChange({ ...world, billboards: [...world.billboards, { sprite: 4, width: 1, height: 1.6 }] });
  };
  const removeBillboard = (index: number) => {
    if (!world) return;
    onChange({ ...world, billboards: world.billboards.filter((_slot, i) => i !== index) });
  };

  const setCamera = (patch: Partial<NonNullable<WorldScene["camera"]>>) => {
    if (!world) return;
    const camera = { yaw: 0, pitch: 0.62, distance: 0, fov: 0, ...world.camera, ...patch };
    onChange({ ...world, camera });
  };

  const gridStyle = useMemo(
    () => ({ gridTemplateColumns: `repeat(${cols}, 1fr)` }),
    [cols],
  );

  if (!world) {
    return (
      <div className={styles.body}>
        <section className={styles.stage} style={{ display: "grid", placeItems: "center", padding: 24, textAlign: "center" }}>
          <div>
            <p style={{ maxWidth: 460, marginBottom: 16, opacity: 0.85 }}>
              The World tab builds a 3D tile terrain and stands your 2D character sprites in it as depth-sorted
              billboards. Paint heights, pick a ground tile, and declare a character slot — then move it from code with
              <code> cartbox.billboard(0, x, y, z)</code> and press Run.
            </p>
            <button type="button" className="cbx-btn cbx-btn-accent" onClick={() => onChange(makeDefaultWorld())}>
              Create world
            </button>
          </div>
        </section>
      </div>
    );
  }

  return (
    <div className={styles.body}>
      {/* Left rail: brush + terrain settings. */}
      <aside className={styles.rail} style={{ minWidth: 190, display: "grid", gap: 14, alignContent: "start", padding: 12 }}>
        <div>
          <div className={styles.groupLabel}>Brush height</div>
          <input
            type="range"
            min={0}
            max={MAX_HEIGHT}
            value={brushHeight}
            aria-label="Brush height"
            onChange={(event) => onBrushHeightChange(Number(event.target.value))}
            style={{ width: "100%" }}
          />
          <span className="data">{brushHeight}</span>
        </div>
        <div>
          <div className={styles.groupLabel}>Ground tile sprite</div>
          <input
            type="number"
            min={0}
            value={groundSprite}
            aria-label="Ground tile sprite id"
            onChange={(event) => setGroundSprite(Math.max(0, Math.floor(Number(event.target.value) || 0)))}
            className={styles.detailsInput}
            style={{ width: 90 }}
          />
        </div>
        <div>
          <div className={styles.groupLabel}>Grid size</div>
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <input
              type="number"
              min={1}
              max={24}
              value={cols}
              aria-label="Grid columns"
              onChange={(event) => resize(Math.max(1, Math.min(24, Math.floor(Number(event.target.value) || 1))), rows)}
              className={styles.detailsInput}
              style={{ width: 60 }}
            />
            <span>×</span>
            <input
              type="number"
              min={1}
              max={24}
              value={rows}
              aria-label="Grid rows"
              onChange={(event) => resize(cols, Math.max(1, Math.min(24, Math.floor(Number(event.target.value) || 1))))}
              className={styles.detailsInput}
              style={{ width: 60 }}
            />
          </div>
        </div>
        <div>
          <div className={styles.groupLabel}>Camera</div>
          <label style={{ display: "block", fontSize: 12 }}>
            Yaw
            <input
              type="range"
              min={0}
              max={Math.PI * 2}
              step={0.01}
              value={world.camera?.yaw ?? Math.PI / 4}
              aria-label="Camera yaw"
              onChange={(event) => setCamera({ yaw: Number(event.target.value) })}
              style={{ width: "100%" }}
            />
          </label>
          <label style={{ display: "block", fontSize: 12 }}>
            Pitch
            <input
              type="range"
              min={0.1}
              max={1.4}
              step={0.01}
              value={world.camera?.pitch ?? 0.62}
              aria-label="Camera pitch"
              onChange={(event) => setCamera({ pitch: Number(event.target.value) })}
              style={{ width: "100%" }}
            />
          </label>
        </div>
      </aside>

      {/* Centre: the top-down height grid you paint. */}
      <section className={styles.stage} style={{ display: "grid", placeItems: "center", padding: 16 }}>
        <div style={{ display: "grid", gap: 2, ...gridStyle, width: "min(70vh, 100%)", aspectRatio: `${cols} / ${rows}` }}>
          {world.cells.map((cell, index) => (
            <button
              key={index}
              type="button"
              aria-label={`Cell ${index % cols},${Math.floor(index / cols)} height ${cell.h}`}
              onClick={() => paintCell(index)}
              style={{
                background: heightColor(cell.h),
                border: "1px solid rgba(0,0,0,0.35)",
                color: cell.h > 3 ? "#0b140b" : "#dfeadf",
                fontSize: 11,
                cursor: "pointer",
                aspectRatio: "1",
              }}
            >
              {cell.h}
            </button>
          ))}
        </div>
        <p style={{ marginTop: 10, opacity: 0.7, fontSize: 12 }}>
          Click a cell to set its height to the brush value. Press Run to see the 3D world with your characters in it.
        </p>
      </section>

      {/* Right: billboard (2D character) slots. */}
      <aside className={styles.inspector} style={{ minWidth: 210, display: "grid", gap: 12, alignContent: "start", padding: 12 }}>
        <div className={styles.panelHead}>
          <span className={styles.panelTitle}>Character billboards</span>
        </div>
        <p style={{ fontSize: 12, opacity: 0.75, margin: 0 }}>
          Each slot is a 2D sprite that stands in the world. Move slot <code>i</code> from code with
          <code> cartbox.billboard(i, x, y, z)</code>.
        </p>
        {world.billboards.map((slot, index) => (
          <div key={index} style={{ display: "grid", gap: 6, padding: 8, border: "1px solid rgba(255,255,255,0.12)", borderRadius: 8 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <strong style={{ fontSize: 12 }}>Slot {index}</strong>
              <button type="button" className="cbx-btn" aria-label={`Remove billboard ${index}`} onClick={() => removeBillboard(index)}>
                ✕
              </button>
            </div>
            <label style={{ fontSize: 11 }}>
              Sprite id
              <input
                type="number"
                min={0}
                value={slot.sprite}
                aria-label={`Billboard ${index} sprite id`}
                onChange={(event) => setBillboard(index, { sprite: Math.max(0, Math.floor(Number(event.target.value) || 0)) })}
                className={styles.detailsInput}
                style={{ width: "100%" }}
              />
            </label>
            <div style={{ display: "flex", gap: 6 }}>
              <label style={{ fontSize: 11, flex: 1 }}>
                Width
                <input
                  type="number"
                  min={0.1}
                  step={0.1}
                  value={slot.width}
                  aria-label={`Billboard ${index} width`}
                  onChange={(event) => setBillboard(index, { width: Math.max(0.1, Number(event.target.value) || 1) })}
                  className={styles.detailsInput}
                  style={{ width: "100%" }}
                />
              </label>
              <label style={{ fontSize: 11, flex: 1 }}>
                Height
                <input
                  type="number"
                  min={0.1}
                  step={0.1}
                  value={slot.height}
                  aria-label={`Billboard ${index} height`}
                  onChange={(event) => setBillboard(index, { height: Math.max(0.1, Number(event.target.value) || 1) })}
                  className={styles.detailsInput}
                  style={{ width: "100%" }}
                />
              </label>
            </div>
          </div>
        ))}
        <button type="button" className="cbx-btn" onClick={addBillboard}>
          + Add billboard
        </button>
        <button type="button" className="cbx-btn" onClick={() => onChange(null)} style={{ marginTop: 8 }}>
          Clear world
        </button>
      </aside>
    </div>
  );
}
