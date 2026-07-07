"use client";

/**
 * The zoomed 8x8 editing surface — the hero of the sprite editor. Draws the
 * current tile at a large cell size with a pixel grid, a hover outline, and a
 * live coordinate report. Painting mutates the SpriteSheet and asks the parent
 * to re-render via onEdit.
 *
 * Tools work in three families:
 * - immediate (pencil/eraser/fill) — mutate the surface as the pointer moves;
 * - shapes (line/rect/ellipse) — preview while dragging, commit on release;
 * - magic wand — selects the contiguous same-value region; while a selection
 *   is active every tool only affects selected pixels (Esc clears, Del erases).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { SpritePage } from "@cartbox/editor";

import styles from "./editor.module.css";
import type { PaintSurface } from "./paintSurface";
import {
  ellipseOutlinePoints,
  linePoints,
  maskedFloodFill,
  pixelKey,
  rectOutlinePoints,
  wandSelection,
  type PixelPoint,
} from "./shapeTools";
import { SHAPE_TOOLS, type Tool } from "./tools";

// The canvas targets a fixed on-screen size; the per-pixel cell shrinks as the
// surface grows (8×8 → 45px cells, 32×32 → ~11px), keeping the stage stable.
const TARGET_CANVAS_PX = 360;
const MIN_CELL_PX = 6;
const SELECTION_STROKE = "rgba(140, 200, 255, 0.95)";
const PREVIEW_ALPHA = 0.8;

interface PixelCanvasProps {
  surface: PaintSurface;
  page: SpritePage;
  tile: number;
  value: number;
  tool: Tool;
  version: number;
  onEdit: () => void;
  onHover: (cell: { x: number; y: number } | null) => void;
}

export function PixelCanvas({ surface, page, tile, value, tool, version, onEdit, onHover }: PixelCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const painting = useRef(false);
  const hoverCell = useRef<{ x: number; y: number } | null>(null);
  // Shape drags: the anchor pixel and the live preview points (refs — they
  // change every pointer move, so re-rendering React for them would be waste).
  const shapeAnchor = useRef<PixelPoint | null>(null);
  const previewPoints = useRef<PixelPoint[]>([]);
  // Magic-wand selection, as pixel keys (y * tileSize + x). Null = no selection.
  const [selection, setSelection] = useState<Set<number> | null>(null);
  const cellPx = Math.max(MIN_CELL_PX, Math.floor(TARGET_CANVAS_PX / surface.tileSize));
  const size = surface.tileSize * cellPx;

  const inSelection = useCallback(
    (x: number, y: number) => !selection || selection.has(pixelKey(x, y, surface.tileSize)),
    [selection, surface.tileSize],
  );

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext("2d");
    if (!context) return;

    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== size * dpr) {
      canvas.width = size * dpr;
      canvas.height = size * dpr;
    }
    context.setTransform(dpr, 0, 0, dpr, 0, 0);

    for (let y = 0; y < surface.tileSize; y += 1) {
      for (let x = 0; x < surface.tileSize; x += 1) {
        context.fillStyle = surface.cssColor(surface.getPixel(page, tile, x, y));
        context.fillRect(x * cellPx, y * cellPx, cellPx, cellPx);
      }
    }

    context.strokeStyle = "rgba(255,255,255,0.06)";
    context.lineWidth = 1;
    for (let line = 1; line < surface.tileSize; line += 1) {
      context.beginPath();
      context.moveTo(line * cellPx + 0.5, 0);
      context.lineTo(line * cellPx + 0.5, size);
      context.moveTo(0, line * cellPx + 0.5);
      context.lineTo(size, line * cellPx + 0.5);
      context.stroke();
    }

    // Live shape preview: the pending line/rect/ellipse in the brush colour.
    if (previewPoints.current.length > 0) {
      context.globalAlpha = PREVIEW_ALPHA;
      context.fillStyle = surface.cssColor(value);
      for (const point of previewPoints.current) {
        if (inSelection(point.x, point.y)) {
          context.fillRect(point.x * cellPx, point.y * cellPx, cellPx, cellPx);
        }
      }
      context.globalAlpha = 1;
    }

    // Selection outline: stroke each selected cell's edges that face outward.
    if (selection) {
      context.strokeStyle = SELECTION_STROKE;
      context.lineWidth = 2;
      context.beginPath();
      for (const key of selection) {
        const x = key % surface.tileSize;
        const y = Math.floor(key / surface.tileSize);
        const px = x * cellPx;
        const py = y * cellPx;
        if (!selection.has(pixelKey(x, y - 1, surface.tileSize)) || y === 0) {
          context.moveTo(px, py + 1);
          context.lineTo(px + cellPx, py + 1);
        }
        if (!selection.has(pixelKey(x, y + 1, surface.tileSize)) || y === surface.tileSize - 1) {
          context.moveTo(px, py + cellPx - 1);
          context.lineTo(px + cellPx, py + cellPx - 1);
        }
        if (x === 0 || !selection.has(pixelKey(x - 1, y, surface.tileSize))) {
          context.moveTo(px + 1, py);
          context.lineTo(px + 1, py + cellPx);
        }
        if (x === surface.tileSize - 1 || !selection.has(pixelKey(x + 1, y, surface.tileSize))) {
          context.moveTo(px + cellPx - 1, py);
          context.lineTo(px + cellPx - 1, py + cellPx);
        }
      }
      context.stroke();
    }

    const cell = hoverCell.current;
    if (cell) {
      context.strokeStyle = "rgba(255,255,255,0.85)";
      context.lineWidth = 2;
      context.strokeRect(cell.x * cellPx + 1, cell.y * cellPx + 1, cellPx - 2, cellPx - 2);
    }
  }, [surface, page, tile, size, cellPx, value, selection, inSelection]);

  useEffect(() => {
    draw();
  }, [draw, version]);

  // A selection is a set of coordinates on one tile; switching what the canvas
  // shows would leave it pointing at unrelated pixels, so drop it.
  useEffect(() => {
    setSelection(null);
    previewPoints.current = [];
    shapeAnchor.current = null;
  }, [surface, page, tile]);

  // Esc clears the selection; Delete/Backspace erases the selected pixels.
  useEffect(() => {
    if (!selection) return;
    const handleKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
      if (event.key === "Escape") {
        setSelection(null);
      } else if (event.key === "Delete" || event.key === "Backspace") {
        for (const key of selection) {
          surface.setPixel(page, tile, key % surface.tileSize, Math.floor(key / surface.tileSize), 0);
        }
        onEdit();
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [selection, surface, page, tile, onEdit]);

  const cellFromEvent = (event: React.PointerEvent): { x: number; y: number } | null => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const x = Math.floor(((event.clientX - rect.left) / rect.width) * surface.tileSize);
    const y = Math.floor(((event.clientY - rect.top) / rect.height) * surface.tileSize);
    if (x < 0 || x >= surface.tileSize || y < 0 || y >= surface.tileSize) return null;
    return { x, y };
  };

  /** The pixels a shape drag from the anchor to `cell` would paint. */
  const shapePoints = (anchor: PixelPoint, cell: PixelPoint): PixelPoint[] => {
    if (tool === "line") return linePoints(anchor.x, anchor.y, cell.x, cell.y);
    if (tool === "rect") return rectOutlinePoints(anchor.x, anchor.y, cell.x, cell.y);
    return ellipseOutlinePoints(anchor.x, anchor.y, cell.x, cell.y);
  };

  const apply = (cell: { x: number; y: number }) => {
    if (tool === "fill") {
      maskedFloodFill(surface, page, tile, cell.x, cell.y, value, selection);
    } else if (inSelection(cell.x, cell.y)) {
      surface.setPixel(page, tile, cell.x, cell.y, tool === "eraser" ? 0 : value);
    } else {
      return;
    }
    onEdit();
  };

  const handleDown = (event: React.PointerEvent) => {
    const cell = cellFromEvent(event);
    if (!cell) return;
    (event.target as HTMLElement).setPointerCapture(event.pointerId);

    if (tool === "wand") {
      setSelection(wandSelection((x, y) => surface.getPixel(page, tile, x, y), surface.tileSize, cell.x, cell.y));
      return;
    }
    if (SHAPE_TOOLS.has(tool)) {
      shapeAnchor.current = cell;
      previewPoints.current = [cell];
      draw();
      return;
    }
    painting.current = true;
    apply(cell);
  };

  const handleMove = (event: React.PointerEvent) => {
    const cell = cellFromEvent(event);
    hoverCell.current = cell;
    onHover(cell);
    if (shapeAnchor.current && cell) {
      previewPoints.current = shapePoints(shapeAnchor.current, cell);
      draw();
    } else if (painting.current && cell && tool !== "fill") {
      apply(cell);
    } else {
      draw();
    }
  };

  const stop = (event: React.PointerEvent) => {
    painting.current = false;
    if (shapeAnchor.current) {
      const cell = cellFromEvent(event) ?? previewPoints.current[previewPoints.current.length - 1] ?? null;
      const anchor = shapeAnchor.current;
      const points = cell ? shapePoints(anchor, cell) : previewPoints.current;
      for (const point of points) {
        if (inSelection(point.x, point.y)) surface.setPixel(page, tile, point.x, point.y, value);
      }
      shapeAnchor.current = null;
      previewPoints.current = [];
      onEdit();
    }
  };

  const handleLeave = () => {
    hoverCell.current = null;
    onHover(null);
    draw();
  };

  return (
    <div className={styles.canvasPanel}>
      <canvas
        ref={canvasRef}
        className={styles.pixelCanvas}
        style={{ width: size, height: size }}
        onPointerDown={handleDown}
        onPointerMove={handleMove}
        onPointerUp={stop}
        onPointerCancel={stop}
        onPointerLeave={handleLeave}
        role="img"
        aria-label={`Sprite ${tile}, ${surface.tileSize} by ${surface.tileSize} pixels`}
      />
      {selection && (
        <div className={styles.selectionBar}>
          <span className="data">{selection.size} px selected</span>
          <span className={styles.selectionHint}>Esc clears · Del erases</span>
          <button type="button" className="cbx-btn" onClick={() => setSelection(null)}>
            Clear
          </button>
        </div>
      )}
    </div>
  );
}
