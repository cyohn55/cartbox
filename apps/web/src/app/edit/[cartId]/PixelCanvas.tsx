"use client";

/**
 * The zoomed editing surface — the hero of the sprite editor. Draws the current
 * tile at a large cell size with a pixel grid, a hover outline, and a live
 * coordinate report. Painting mutates the SpriteSheet and asks the parent to
 * re-render via onEdit.
 *
 * Tools work in four families:
 * - immediate (pencil/eraser/fill) — mutate the surface as the pointer moves;
 * - shapes (line/rect/ellipse) — preview while dragging, commit on release;
 * - selections (wand, marquee) — mark a region without painting it;
 * - the colour picker, which takes a value rather than placing one. Alt-drag
 *   does the same thing with whatever tool is active, which is the reflex most
 *   pixel artists arrive with.
 *
 * A selection is what the editing verbs act on. It used to be erasable and
 * nothing else; now it can also be moved, nudged, copied, cut, pasted, flipped
 * and rotated — the operations that make a pixel editor feel finished. The
 * geometry for all of that lives in `pixelSelection.ts`, pure and unit-tested;
 * this file only binds it to pointers and keys.
 *
 * Zoom is the artist's, not the layout's. The canvas used to be pinned to a
 * fixed on-screen size, so a 32×32 block drew at ~11px cells and could not be
 * enlarged.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { SpritePage } from "@cartbox/editor";

import type { PointerSample } from "@/lib/tabletInput";
import { scrollableParent, useGestures } from "@/lib/useTabletGestures";

import styles from "./editor.module.css";
import type { PaintSurface } from "./paintSurface";
import {
  brushStamp,
  ellipseFillPoints,
  ellipseOutlinePoints,
  linePoints,
  maskedFloodFill,
  parseHexColor,
  pixelKey,
  rectFillPoints,
  rectOutlinePoints,
  thickenPoints,
  wandSelection,
  type PixelPoint,
  type ToleranceMatch,
} from "./shapeTools";
import {
  clearSelection,
  copySelection,
  marqueeSelection,
  moveSelection,
  pasteStamp,
  rotateStamp,
  flipStampHorizontal,
  flipStampVertical,
  selectionBounds,
  transformSelection,
  type Stamp,
} from "./pixelSelection";
import { SHAPE_TOOLS, WEIGHTED_TOOLS, type Tool } from "./tools";

// The canvas targets this on-screen size at zoom 1; the per-pixel cell shrinks
// as the surface grows (8×8 → 45px cells, 32×32 → ~11px), keeping the stage
// stable. Zoom multiplies it, so a 32×32 block can be worked on at any size.
const TARGET_CANVAS_PX = 360;
// Floor on the per-pixel cell so a large block never renders sub-pixel. Kept
// small enough that a full 128×128 block still meets the target (128 × 3 =
// 384px ≈ the target) and so fits the stage; a bigger floor forced 128×128 to
// 768px, past the viewport, so its bottom/right were unreachable. Zoom in for
// finer cells.
const MIN_CELL_PX = 3;
export const MIN_ZOOM = 0.5;
export const MAX_ZOOM = 4;
const SELECTION_STROKE = "rgba(140, 200, 255, 0.95)";
// The coverage tick. Warm and semi-transparent so it reads as an annotation over
// the art rather than as a pixel someone painted.
const COVERAGE_STROKE = "rgba(255, 196, 92, 0.85)";
const PREVIEW_ALPHA = 0.8;

interface PixelCanvasProps {
  surface: PaintSurface;
  page: SpritePage;
  tile: number;
  value: number;
  tool: Tool;
  /** Stroke thickness in pixels for the pencil/eraser/shape tools (>= 1). */
  weight: number;
  /** Colour tolerance (0..100) for the fill and magic-wand tools. */
  tolerance: number;
  /** Whether the rectangle/ellipse tools fill their interior (vs. draw an outline). */
  fillShape: boolean;
  version: number;
  onEdit: () => void;
  onHover: (cell: { x: number; y: number } | null) => void;
  /**
   * Pixels ({@link pixelKey}) carrying data on a layer other than the one being
   * shown, hatched over the art so material work is visible while painting
   * colour. Null when the overlay is off — the common case, since the hatch
   * would otherwise compete with the art it annotates.
   */
  coverage?: ReadonlySet<number> | null;
  /** On-screen scale, 0.5..4. The pixel grid stays crisp at any of them. */
  zoom?: number;
  /** Take a value from the art as the active colour (the picker, Alt-drag, and a long press). */
  onPickValue?: (value: number) => void;
  /** Pinch zoom (TABLET_EDITOR_ROADMAP.md T2): scale the on-screen zoom by `factor` (above 1: closer). */
  onZoom?: (factor: number) => void;
}

/** What the canvas reads of a pointer (an event, or a tablet-layer sample). */
interface PointerInput {
  readonly clientX: number;
  readonly clientY: number;
  readonly altKey: boolean;
  readonly buttons: number;
  readonly ctrlKey?: boolean;
  readonly metaKey?: boolean;
  readonly shiftKey?: boolean;
}


export function PixelCanvas({
  surface,
  page,
  tile,
  value,
  tool,
  weight,
  tolerance,
  fillShape,
  version,
  onEdit,
  onHover,
  coverage = null,
  zoom = 1,
  onPickValue,
  onZoom,
}: PixelCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const painting = useRef(false);
  const hoverCell = useRef<{ x: number; y: number } | null>(null);
  // Shape drags: the anchor pixel and the live preview points (refs — they
  // change every pointer move, so re-rendering React for them would be waste).
  const shapeAnchor = useRef<PixelPoint | null>(null);
  const previewPoints = useRef<PixelPoint[]>([]);
  // Magic-wand selection, as pixel keys (y * tileSize + x). Null = no selection.
  const [selection, setSelection] = useState<Set<number> | null>(null);
  // Marquee drags: the anchor, and whether the drag is moving an existing
  // selection rather than drawing a new one.
  const marqueeAnchor = useRef<PixelPoint | null>(null);
  const movingFrom = useRef<PixelPoint | null>(null);
  // The clipboard is a ref, not state: pasting reads it, nothing renders it,
  // and it must survive a tool change without re-rendering the canvas.
  const clipboard = useRef<Stamp | null>(null);
  // Whether anything has been copied, so the selection bar can offer Paste.
  const [copied, setCopied] = useState(false);
  const cellPx = Math.max(
    MIN_CELL_PX,
    Math.round((TARGET_CANVAS_PX / surface.tileSize) * Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom))),
  );
  const size = surface.tileSize * cellPx;

  const inSelection = useCallback(
    (x: number, y: number) => !selection || selection.has(pixelKey(x, y, surface.tileSize)),
    [selection, surface.tileSize],
  );

  // Tolerance for fill/wand: undefined at 0 (exact match), else a colour matcher
  // that reads each pixel's swatch colour from the surface.
  const toleranceMatch = useCallback((): ToleranceMatch | undefined => {
    if (tolerance <= 0) return undefined;
    return { tolerance: tolerance / 100, sampleColor: (v) => parseHexColor(surface.cssColor(v)) };
  }, [tolerance, surface]);

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

    // Layer coverage: a diagonal tick in each pixel that carries data on some
    // other layer. A tick rather than a tint, because a tint would change the
    // colour of the pixel it is describing — which is the one thing the albedo
    // canvas has to report faithfully.
    if (coverage && coverage.size > 0) {
      context.strokeStyle = COVERAGE_STROKE;
      context.lineWidth = Math.max(1, Math.floor(cellPx / 8));
      context.beginPath();
      for (const key of coverage) {
        const x = (key % surface.tileSize) * cellPx;
        const y = Math.floor(key / surface.tileSize) * cellPx;
        context.moveTo(x + cellPx * 0.62, y + cellPx * 0.16);
        context.lineTo(x + cellPx * 0.84, y + cellPx * 0.38);
      }
      context.stroke();
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
      // The hover outline previews the brush footprint, so the chosen weight is
      // visible before painting; fill/wand stay a single cell.
      const brushSide = WEIGHTED_TOOLS.has(tool) ? Math.max(1, weight) : 1;
      const offset = Math.floor((brushSide - 1) / 2);
      context.strokeStyle = "rgba(255,255,255,0.85)";
      context.lineWidth = 2;
      context.strokeRect(
        (cell.x - offset) * cellPx + 1,
        (cell.y - offset) * cellPx + 1,
        brushSide * cellPx - 2,
        brushSide * cellPx - 2,
      );
    }
  }, [surface, page, tile, size, cellPx, value, selection, inSelection, tool, weight, coverage]);

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

  /**
   * Everything a creator can do to a selection from the keyboard.
   *
   * Bound here rather than in the workbench because every verb needs the
   * surface, the open tile and the live selection — state this component owns.
   * Paste is the one binding that works without a selection, since its whole
   * job is to create one.
   */
  // The selection's verbs, shared by the keys and the selection bar's buttons
  // (TABLET_EDITOR_ROADMAP.md T4: a tablet has no keyboard to press them with).
  const tileSize = surface.tileSize;
  const verbs = {
    /** Paste lands at the current selection's corner, or at the origin, and becomes the new selection so it can be nudged into place. */
    paste: () => {
      const stamp = clipboard.current;
      if (!stamp) return false;
      const corner = selection ? selectionBounds(selection, tileSize) : null;
      setSelection(pasteStamp(surface, page, tile, stamp, corner?.left ?? 0, corner?.top ?? 0, tileSize));
      onEdit();
      return true;
    },
    copy: (cut: boolean) => {
      if (!selection || selection.size === 0) return;
      clipboard.current = copySelection(surface, page, tile, selection, tileSize);
      setCopied(true);
      if (cut) {
        clearSelection(surface, page, tile, selection, tileSize);
        onEdit();
      }
    },
    erase: () => {
      if (!selection || selection.size === 0) return;
      clearSelection(surface, page, tile, selection, tileSize);
      onEdit();
    },
    nudge: (dx: number, dy: number) => {
      if (!selection || selection.size === 0) return;
      setSelection(moveSelection(surface, page, tile, selection, tileSize, dx, dy));
      onEdit();
    },
    transform: (how: typeof flipStampHorizontal) => {
      if (!selection || selection.size === 0) return;
      setSelection(transformSelection(surface, page, tile, selection, tileSize, how));
      onEdit();
    },
  };
  const verbsRef = useRef(verbs);
  verbsRef.current = verbs;

  /**
   * Everything a creator can do to a selection from the keyboard.
   *
   * Bound here rather than in the workbench because every verb needs the
   * surface, the open tile and the live selection — state this component owns.
   * Paste is the one binding that works without a selection, since its whole
   * job is to create one.
   */
  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
      const mod = event.ctrlKey || event.metaKey;
      const v = verbsRef.current;

      if (mod && event.key.toLowerCase() === "v") {
        if (v.paste()) event.preventDefault();
        return;
      }

      if (!selection || selection.size === 0) return;

      if (mod && (event.key.toLowerCase() === "c" || event.key.toLowerCase() === "x")) {
        event.preventDefault();
        v.copy(event.key.toLowerCase() === "x");
        return;
      }
      if (mod) return; // leave every other chord to the workbench

      switch (event.key) {
        case "Escape":
          setSelection(null);
          return;
        case "Delete":
        case "Backspace":
          event.preventDefault();
          v.erase();
          return;
        case "ArrowLeft":
        case "ArrowRight":
        case "ArrowUp":
        case "ArrowDown": {
          event.preventDefault();
          v.nudge(event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : 0, event.key === "ArrowUp" ? -1 : event.key === "ArrowDown" ? 1 : 0);
          return;
        }
        default:
          break;
      }

      const key = event.key.toLowerCase();
      const transform =
        key === "h" ? flipStampHorizontal : key === "v" ? flipStampVertical : key === "r" ? rotateStamp : null;
      if (transform) {
        event.preventDefault();
        v.transform(transform);
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [selection]);

  const cellFromEvent = (event: { readonly clientX: number; readonly clientY: number }): { x: number; y: number } | null => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const x = Math.floor(((event.clientX - rect.left) / rect.width) * surface.tileSize);
    const y = Math.floor(((event.clientY - rect.top) / rect.height) * surface.tileSize);
    if (x < 0 || x >= surface.tileSize || y < 0 || y >= surface.tileSize) return null;
    return { x, y };
  };

  /** The pixels a shape drag from the anchor to `cell` would paint, thickened to
   * the current brush weight. */
  const shapePoints = (anchor: PixelPoint, cell: PixelPoint): PixelPoint[] => {
    // A filled rectangle/ellipse already covers its interior, so it neither needs
    // nor wants brush-weight thickening — only outlines and lines are thickened.
    if (fillShape && tool === "rect") return rectFillPoints(anchor.x, anchor.y, cell.x, cell.y);
    if (fillShape && tool === "ellipse") return ellipseFillPoints(anchor.x, anchor.y, cell.x, cell.y);
    const base =
      tool === "line"
        ? linePoints(anchor.x, anchor.y, cell.x, cell.y)
        : tool === "rect"
          ? rectOutlinePoints(anchor.x, anchor.y, cell.x, cell.y)
          : ellipseOutlinePoints(anchor.x, anchor.y, cell.x, cell.y);
    return thickenPoints(base, weight);
  };

  const apply = (cell: { x: number; y: number }) => {
    if (tool === "fill") {
      maskedFloodFill(surface, page, tile, cell.x, cell.y, value, selection, toleranceMatch());
    } else {
      // Pencil/eraser stamp a weight×weight brush, clipped to any selection.
      const paintValue = tool === "eraser" ? 0 : value;
      for (const point of brushStamp(cell.x, cell.y, weight)) {
        if (inSelection(point.x, point.y)) surface.setPixel(page, tile, point.x, point.y, paintValue);
      }
    }
    onEdit();
  };

  /** Take the value under the cursor as the active one. */
  const pick = (cell: PixelPoint) => {
    onPickValue?.(surface.getPixel(page, tile, cell.x, cell.y));
  };

  /** The tile's pixels before the stroke under way, to put back if it's cancelled (a second finger made it a gesture). */
  const strokeBefore = useRef<number[] | null>(null);
  const snapshotTile = (): number[] => {
    const out: number[] = [];
    for (let y = 0; y < surface.tileSize; y++) for (let x = 0; x < surface.tileSize; x++) out.push(surface.getPixel(page, tile, x, y));
    return out;
  };
  // Only the pixels the stroke changed are written back: writing a pixel
  // through a material surface re-stamps its material channels, so leaving
  // the rest alone keeps their grain as it was.
  const restoreTile = (pixels: readonly number[]) => {
    let i = 0;
    for (let y = 0; y < surface.tileSize; y++)
      for (let x = 0; x < surface.tileSize; x++) {
        const was = pixels[i++]!;
        if (surface.getPixel(page, tile, x, y) !== was) surface.setPixel(page, tile, x, y, was);
      }
    onEdit();
  };

  const handleDown = (event: PointerInput) => {
    const cell = cellFromEvent(event);
    if (!cell) return;

    // Alt is the eyedropper with any tool held — the reflex most pixel artists
    // arrive with, and it beats round-tripping through the tool rail.
    if (event.altKey || tool === "picker") {
      pick(cell);
      return;
    }

    if (tool === "wand") {
      setSelection(
        wandSelection((x, y) => surface.getPixel(page, tile, x, y), surface.tileSize, cell.x, cell.y, toleranceMatch()),
      );
      return;
    }

    if (tool === "marquee") {
      // Pressing inside an existing selection drags it; pressing outside starts
      // a new box. That is what makes "select, then move" one gesture.
      if (selection?.has(pixelKey(cell.x, cell.y, surface.tileSize))) {
        movingFrom.current = cell;
      } else {
        marqueeAnchor.current = cell;
        setSelection(marqueeSelection(cell, cell, surface.tileSize));
      }
      return;
    }

    if (SHAPE_TOOLS.has(tool)) {
      shapeAnchor.current = cell;
      previewPoints.current = [cell];
      draw();
      return;
    }
    painting.current = true;
    strokeBefore.current = snapshotTile();
    apply(cell);
  };

  const handleMove = (event: PointerInput) => {
    const cell = cellFromEvent(event);
    hoverCell.current = cell;
    onHover(cell);

    if (event.altKey && event.buttons > 0 && cell) {
      pick(cell);
      return;
    }
    if (marqueeAnchor.current && cell) {
      setSelection(marqueeSelection(marqueeAnchor.current, cell, surface.tileSize));
      return;
    }
    if (movingFrom.current && cell && selection) {
      const dx = cell.x - movingFrom.current.x;
      const dy = cell.y - movingFrom.current.y;
      if (dx !== 0 || dy !== 0) {
        setSelection(moveSelection(surface, page, tile, selection, surface.tileSize, dx, dy));
        movingFrom.current = cell;
        onEdit();
      }
      return;
    }
    if (shapeAnchor.current && cell) {
      previewPoints.current = shapePoints(shapeAnchor.current, cell);
      draw();
    } else if (painting.current && cell && tool !== "fill") {
      apply(cell);
    } else {
      draw();
    }
  };

  const stop = (event: PointerInput) => {
    painting.current = false;
    strokeBefore.current = null;
    marqueeAnchor.current = null;
    movingFrom.current = null;
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

  // Input through the tablet layer (T2): the Pencil (and the mouse) draws; one
  // finger does too until a Pencil is used, then pans; two fingers pan the
  // panel and pinch to zoom; a long press picks the colour under it.
  const asInput = (s: PointerSample): PointerInput => ({ clientX: s.x, clientY: s.y, altKey: s.altKey, buttons: s.buttons, ctrlKey: s.ctrlKey, metaKey: s.metaKey, shiftKey: s.shiftKey });
  const gestures = useGestures<HTMLCanvasElement>(
    {
      onToolDown: (s) => handleDown(asInput(s)),
      onToolMove: (s) => handleMove(asInput(s)),
      onToolUp: (s) => stop(asInput(s)),
      onToolCancel: () => {
        const before = strokeBefore.current;
        painting.current = false;
        marqueeAnchor.current = null;
        movingFrom.current = null;
        shapeAnchor.current = null;
        previewPoints.current = [];
        strokeBefore.current = null;
        if (before) restoreTile(before);
        draw();
      },
      onHover: (s) => handleMove({ ...asInput(s), buttons: 0 }),
      onPan: (dx, dy, el) => scrollableParent(el)?.scrollBy(-dx, -dy),
      onZoom: (factor) => onZoom?.(factor),
      onLongPress: (s) => {
        const cell = cellFromEvent(asInput(s));
        if (cell) pick(cell);
      },
    },
    { drag: "pan" },
  );

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
        {...gestures}
        onPointerLeave={handleLeave}
        role="img"
        aria-label={`Sprite ${tile}, ${surface.tileSize} by ${surface.tileSize} pixels`}
      />
      {(selection || copied) && (
        <div className={styles.selectionBar}>
          {selection && <span className="data">{selection.size} px selected</span>}
          {selection && (
            <span className={styles.selectionHint}>
              drag to move · arrows nudge · H/V flip · R rotate · Ctrl+C/X/V · Del erases · Esc clears
            </span>
          )}
          {/* The same verbs as buttons, for a tablet (and anyone without the keys to hand). */}
          <div className={styles.selectionActions} role="toolbar" aria-label="Selection">
            {selection && (
              <>
                <button type="button" className="cbx-btn" title="Copy (Ctrl+C)" onClick={() => verbs.copy(false)}>
                  Copy
                </button>
                <button type="button" className="cbx-btn" title="Cut (Ctrl+X)" onClick={() => verbs.copy(true)}>
                  Cut
                </button>
              </>
            )}
            {copied && (
              <button type="button" className="cbx-btn" title="Paste (Ctrl+V)" onClick={() => verbs.paste()}>
                Paste
              </button>
            )}
            {selection && (
              <>
                <button type="button" className="cbx-btn" aria-label="Flip horizontally" title="Flip horizontally (H)" onClick={() => verbs.transform(flipStampHorizontal)}>
                  ⇋
                </button>
                <button type="button" className="cbx-btn" aria-label="Flip vertically" title="Flip vertically (V)" onClick={() => verbs.transform(flipStampVertical)}>
                  ⇵
                </button>
                <button type="button" className="cbx-btn" aria-label="Rotate a quarter turn" title="Rotate a quarter turn (R)" onClick={() => verbs.transform(rotateStamp)}>
                  ⟳
                </button>
                <button type="button" className="cbx-btn" aria-label="Nudge left" title="Nudge left (←)" onClick={() => verbs.nudge(-1, 0)}>
                  ←
                </button>
                <button type="button" className="cbx-btn" aria-label="Nudge up" title="Nudge up (↑)" onClick={() => verbs.nudge(0, -1)}>
                  ↑
                </button>
                <button type="button" className="cbx-btn" aria-label="Nudge down" title="Nudge down (↓)" onClick={() => verbs.nudge(0, 1)}>
                  ↓
                </button>
                <button type="button" className="cbx-btn" aria-label="Nudge right" title="Nudge right (→)" onClick={() => verbs.nudge(1, 0)}>
                  →
                </button>
                <button type="button" className="cbx-btn" title="Erase the selection (Del)" onClick={verbs.erase}>
                  Erase
                </button>
                <button type="button" className="cbx-btn" title="Clear the selection (Esc)" onClick={() => setSelection(null)}>
                  Clear
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
