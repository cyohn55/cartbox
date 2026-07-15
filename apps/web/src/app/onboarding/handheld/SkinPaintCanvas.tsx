"use client";

/**
 * The zoom/pan painting surface for the handheld pixel editor. It renders a
 * layered RGBA document (one offscreen canvas per layer, stacked with per-layer
 * opacity) and lets the artist paint the active layer with the sprite editor's
 * tools — pencil, eraser, bucket fill, line/rect/ellipse, and an eyedropper —
 * plus drag-to-pan and wheel-to-zoom.
 *
 * Painting mutates the active layer's pixel buffer in place (the same buffers
 * the parent holds), and each completed stroke is reported to the parent as a
 * rectangular before/after snapshot so undo/redo stays cheap. The parent bumps
 * `repaintVersion` after an undo (or any external buffer change) and
 * `structureVersion` when the layer set/visibility/opacity/order changes, so the
 * canvas knows when to resync its offscreens.
 */

import { useCallback, useEffect, useMemo, useRef } from "react";

import {
  activeLayer,
  clampRect,
  floodFillRgba,
  getLayerPixel,
  setLayerPixel,
  snapshotRect,
  type PaintDoc,
  type PaintLayer,
  type PixelRect,
  type Rgba,
} from "@cartbox/editor";

import {
  ellipseOutlinePoints,
  linePoints,
  parseHexColor,
  rectOutlinePoints,
  thickenPoints,
  type PixelPoint,
} from "../../edit/[cartId]/shapeTools";

import styles from "./skinEditor.module.css";

/** A tool the paint canvas understands (a superset of the sprite tools). */
export type SkinTool = "pencil" | "eraser" | "fill" | "line" | "rect" | "ellipse" | "eyedropper" | "pan";

/** Tools that drag out a shape previewed live and committed on release. */
const SHAPE_TOOLS: ReadonlySet<SkinTool> = new Set<SkinTool>(["line", "rect", "ellipse"]);
/** Tools whose stroke thickness the artist can adjust. */
const WEIGHTED_TOOLS: ReadonlySet<SkinTool> = new Set<SkinTool>(["pencil", "eraser", "line", "rect", "ellipse"]);

/** A completed pixel edit, as the rectangle that changed with its before/after. */
export interface StrokeSnapshot {
  layerId: string;
  rect: PixelRect;
  before: Uint8ClampedArray;
  after: Uint8ClampedArray;
}

interface SkinPaintCanvasProps {
  doc: PaintDoc;
  tool: SkinTool;
  /** Paint colour as `#rrggbb`. */
  color: string;
  /** Brush thickness in pixels (>= 1) for weighted tools. */
  weight: number;
  /** Fill tolerance 0..1. */
  tolerance: number;
  /** Bumped by the parent after an undo/redo or any external buffer change. */
  repaintVersion: number;
  /** Bumped by the parent when layers are added/removed/reordered/toggled. */
  structureVersion: number;
  /** Report a completed pixel edit so the parent can push it onto the undo stack. */
  onStroke: (snapshot: StrokeSnapshot) => void;
  /** The eyedropper picked a colour from the composite. */
  onPickColor: (hex: string) => void;
}

/** Convert a `#rrggbb` string to an opaque RGBA paint colour. */
function hexToRgba(hex: string): Rgba {
  const [r, g, b] = parseHexColor(hex);
  return [r, g, b, 255];
}

/** The transparent-erase colour. */
const ERASE: Rgba = [0, 0, 0, 0];

export function SkinPaintCanvas({
  doc,
  tool,
  color,
  weight,
  tolerance,
  repaintVersion,
  structureVersion,
  onStroke,
  onPickColor,
}: SkinPaintCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // One offscreen canvas per layer id, at document resolution.
  const layerCanvases = useRef<Map<string, HTMLCanvasElement>>(new Map());

  // View transform: `scale` art-pixels→CSS-pixels, `pan` in CSS pixels.
  const view = useRef({ scale: 1, panX: 0, panY: 0, fitted: false });

  // Live interaction state (refs — they change per pointer move).
  const painting = useRef(false);
  const panning = useRef<{ startX: number; startY: number; panX: number; panY: number } | null>(null);
  const shapeAnchor = useRef<PixelPoint | null>(null);
  // The previous painted cell, so a fast pencil/eraser drag interpolates a
  // gap-free line instead of leaving isolated dots between pointer samples.
  const lastCell = useRef<PixelPoint | null>(null);
  const previewPoints = useRef<PixelPoint[]>([]);
  const strokeMinX = useRef(0);
  const strokeMinY = useRef(0);
  const strokeMaxX = useRef(0);
  const strokeMaxY = useRef(0);
  const strokeBefore = useRef<{ layer: PaintLayer; snapshot: Uint8ClampedArray } | null>(null);

  const width = doc.width;
  const height = doc.height;

  // Keep the offscreen layer canvases in step with the document's layer set.
  const syncStructure = useCallback(() => {
    const map = layerCanvases.current;
    const present = new Set(doc.layers.map((layer) => layer.id));
    for (const id of [...map.keys()]) if (!present.has(id)) map.delete(id);
    for (const layer of doc.layers) {
      let canvas = map.get(layer.id);
      if (!canvas) {
        canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        map.set(layer.id, canvas);
      }
    }
  }, [doc.layers, width, height]);

  /** Push a layer's pixel buffer into its offscreen canvas. */
  const syncLayerPixels = useCallback(
    (layer: PaintLayer) => {
      const canvas = layerCanvases.current.get(layer.id);
      const context = canvas?.getContext("2d");
      if (!canvas || !context) return;
      const image = context.createImageData(width, height);
      image.data.set(layer.pixels);
      context.putImageData(image, 0, 0);
    },
    [width, height],
  );

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;
    const context = canvas.getContext("2d");
    if (!context) return;

    const dpr = window.devicePixelRatio || 1;
    const cssWidth = container.clientWidth;
    const cssHeight = container.clientHeight;
    if (canvas.width !== Math.round(cssWidth * dpr) || canvas.height !== Math.round(cssHeight * dpr)) {
      canvas.width = Math.round(cssWidth * dpr);
      canvas.height = Math.round(cssHeight * dpr);
    }

    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.imageSmoothingEnabled = false;

    const { scale, panX, panY } = view.current;
    context.setTransform(dpr * scale, 0, 0, dpr * scale, dpr * panX, dpr * panY);

    for (const layer of doc.layers) {
      if (!layer.visible || layer.opacity <= 0) continue;
      const offscreen = layerCanvases.current.get(layer.id);
      if (!offscreen) continue;
      context.globalAlpha = layer.opacity;
      context.drawImage(offscreen, 0, 0);
    }
    context.globalAlpha = 1;

    // Live shape preview in the brush colour.
    if (previewPoints.current.length > 0) {
      const [r, g, b] = parseHexColor(color);
      context.globalAlpha = 0.8;
      context.fillStyle = `rgb(${r}, ${g}, ${b})`;
      for (const point of previewPoints.current) context.fillRect(point.x, point.y, 1, 1);
      context.globalAlpha = 1;
    }
  }, [doc.layers, color]);

  // Fit the document into the viewport once it (and the container) are ready.
  const fitToView = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    const scale = Math.min(container.clientWidth / width, container.clientHeight / height) || 1;
    view.current.scale = scale;
    view.current.panX = (container.clientWidth - width * scale) / 2;
    view.current.panY = (container.clientHeight - height * scale) / 2;
    view.current.fitted = true;
    draw();
  }, [width, height, draw]);

  // Initial mount: build offscreens, paint them, and fit.
  useEffect(() => {
    syncStructure();
    for (const layer of doc.layers) syncLayerPixels(layer);
    fitToView();
    const container = containerRef.current;
    if (!container || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => (view.current.fitted ? draw() : fitToView()));
    observer.observe(container);
    return () => observer.disconnect();
    // Mount-only; later syncs are handled by the version effects below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Structure changed (layer added/removed/reordered/toggled/opacity): rebuild
  // the offscreen set, repaint every layer, and redraw.
  useEffect(() => {
    syncStructure();
    for (const layer of doc.layers) syncLayerPixels(layer);
    draw();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [structureVersion]);

  // External buffer change (undo/redo): repaint every layer from its buffer.
  useEffect(() => {
    for (const layer of doc.layers) syncLayerPixels(layer);
    draw();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repaintVersion]);

  /** Map a pointer event to an integer art pixel, or null if outside the art. */
  const pixelFromEvent = (event: React.PointerEvent): PixelPoint | null => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const { scale, panX, panY } = view.current;
    const x = Math.floor((event.clientX - rect.left - panX) / scale);
    const y = Math.floor((event.clientY - rect.top - panY) / scale);
    if (x < 0 || x >= width || y < 0 || y >= height) return null;
    return { x, y };
  };

  /** Grow the current stroke's dirty bounds to include a painted pixel. */
  const extendBounds = (x: number, y: number) => {
    strokeMinX.current = Math.min(strokeMinX.current, x);
    strokeMinY.current = Math.min(strokeMinY.current, y);
    strokeMaxX.current = Math.max(strokeMaxX.current, x);
    strokeMaxY.current = Math.max(strokeMaxY.current, y);
  };

  /** Paint a set of points onto the active layer, tracking dirty bounds. */
  const paintPoints = (layer: PaintLayer, points: readonly PixelPoint[], value: Rgba) => {
    for (const point of points) {
      if (point.x < 0 || point.x >= width || point.y < 0 || point.y >= height) continue;
      setLayerPixel(layer, width, height, point.x, point.y, value);
      extendBounds(point.x, point.y);
    }
  };

  /** The pixels a shape drag from anchor to cell paints, thickened to the weight. */
  const shapePoints = (anchor: PixelPoint, cell: PixelPoint): PixelPoint[] => {
    const base =
      tool === "line"
        ? linePoints(anchor.x, anchor.y, cell.x, cell.y)
        : tool === "rect"
          ? rectOutlinePoints(anchor.x, anchor.y, cell.x, cell.y)
          : ellipseOutlinePoints(anchor.x, anchor.y, cell.x, cell.y);
    return thickenPoints(base, weight);
  };

  /** Begin recording a stroke on the active layer (snapshot taken lazily on end). */
  const beginStroke = (layer: PaintLayer) => {
    strokeBefore.current = { layer, snapshot: layer.pixels.slice() };
    strokeMinX.current = width;
    strokeMinY.current = height;
    strokeMaxX.current = -1;
    strokeMaxY.current = -1;
    lastCell.current = null;
  };

  /** Finish a stroke: report the changed rectangle's before/after to the parent. */
  const endStroke = () => {
    const record = strokeBefore.current;
    strokeBefore.current = null;
    if (!record || strokeMaxX.current < strokeMinX.current) return; // nothing changed
    const rect = clampRect(
      {
        x: strokeMinX.current,
        y: strokeMinY.current,
        width: strokeMaxX.current - strokeMinX.current + 1,
        height: strokeMaxY.current - strokeMinY.current + 1,
      },
      width,
      height,
    );
    if (!rect) return;
    // `before` reads from the pre-stroke snapshot; `after` from the live buffer.
    const beforeLayer: PaintLayer = { ...record.layer, pixels: record.snapshot };
    onStroke({
      layerId: record.layer.id,
      rect,
      before: snapshotRect(beforeLayer, width, rect),
      after: snapshotRect(record.layer, width, rect),
    });
  };

  const handleDown = (event: React.PointerEvent) => {
    (event.target as HTMLElement).setPointerCapture(event.pointerId);

    // Pan with the pan tool, middle mouse, or a space-held drag (handled by CSS
    // cursor); wheel handles zoom.
    if (tool === "pan" || event.button === 1) {
      panning.current = { startX: event.clientX, startY: event.clientY, panX: view.current.panX, panY: view.current.panY };
      return;
    }

    const cell = pixelFromEvent(event);
    if (!cell) return;

    if (tool === "eyedropper") {
      onPickColor(sampleCompositeHex(doc, cell.x, cell.y));
      return;
    }

    const layer = activeLayer(doc);
    if (!layer || !layer.visible) return; // don't paint an invisible/absent layer

    if (SHAPE_TOOLS.has(tool)) {
      beginStroke(layer);
      shapeAnchor.current = cell;
      previewPoints.current = [cell];
      draw();
      return;
    }

    beginStroke(layer);
    painting.current = true;
    applyImmediate(layer, cell);
  };

  /** Apply a pencil/eraser/fill at a cell and refresh the active layer canvas. */
  const applyImmediate = (layer: PaintLayer, cell: PixelPoint) => {
    if (tool === "fill") {
      floodFillRgba(layer, width, height, cell.x, cell.y, hexToRgba(color), tolerance);
      // A fill can touch anywhere; mark the whole canvas dirty for this stroke.
      extendBounds(0, 0);
      extendBounds(width - 1, height - 1);
    } else {
      const value = tool === "eraser" ? ERASE : hexToRgba(color);
      const brush = WEIGHTED_TOOLS.has(tool) ? weight : 1;
      // Stamp along the segment from the last cell (gap-free fast drags); the
      // first sample of a stroke has no predecessor and stamps a single dab.
      const previous = lastCell.current;
      const centres = previous ? linePoints(previous.x, previous.y, cell.x, cell.y) : [cell];
      paintPoints(layer, thickenPoints(centres, brush), value);
      lastCell.current = cell;
    }
    syncLayerPixels(layer);
    draw();
  };

  const handleMove = (event: React.PointerEvent) => {
    if (panning.current) {
      view.current.panX = panning.current.panX + (event.clientX - panning.current.startX);
      view.current.panY = panning.current.panY + (event.clientY - panning.current.startY);
      draw();
      return;
    }
    const cell = pixelFromEvent(event);
    if (shapeAnchor.current && cell) {
      previewPoints.current = shapePoints(shapeAnchor.current, cell);
      draw();
    } else if (painting.current && cell) {
      const layer = activeLayer(doc);
      if (layer) applyImmediate(layer, cell);
    }
  };

  const handleUp = (event: React.PointerEvent) => {
    if (panning.current) {
      panning.current = null;
      return;
    }
    if (shapeAnchor.current) {
      const layer = activeLayer(doc);
      const cell = pixelFromEvent(event) ?? previewPoints.current[previewPoints.current.length - 1] ?? null;
      if (layer && cell) {
        paintPoints(layer, shapePoints(shapeAnchor.current, cell), tool === "eraser" ? ERASE : hexToRgba(color));
        syncLayerPixels(layer);
      }
      shapeAnchor.current = null;
      previewPoints.current = [];
      draw();
      endStroke();
      return;
    }
    if (painting.current) {
      painting.current = false;
      endStroke();
    }
  };

  const handleWheel = (event: React.WheelEvent) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const cursorX = event.clientX - rect.left;
    const cursorY = event.clientY - rect.top;
    const { scale, panX, panY } = view.current;
    const factor = event.deltaY < 0 ? 1.15 : 1 / 1.15;
    const nextScale = Math.max(0.1, Math.min(40, scale * factor));
    // Keep the art point under the cursor fixed while zooming.
    view.current.panX = cursorX - ((cursorX - panX) / scale) * nextScale;
    view.current.panY = cursorY - ((cursorY - panY) / scale) * nextScale;
    view.current.scale = nextScale;
    draw();
  };

  const cursor = useMemo(() => (tool === "pan" ? "grab" : tool === "eyedropper" ? "crosshair" : "cell"), [tool]);

  return (
    <div ref={containerRef} className={styles.viewport} style={{ cursor }}>
      <canvas
        ref={canvasRef}
        className={styles.canvas}
        onPointerDown={handleDown}
        onPointerMove={handleMove}
        onPointerUp={handleUp}
        onPointerCancel={handleUp}
        onPointerLeave={handleUp}
        onWheel={handleWheel}
        role="img"
        aria-label={`Handheld artwork, ${width} by ${height} pixels`}
      />
    </div>
  );
}

/** Read the composited colour at a pixel (top visible opaque layer) as `#rrggbb`. */
function sampleCompositeHex(doc: PaintDoc, x: number, y: number): string {
  for (let index = doc.layers.length - 1; index >= 0; index -= 1) {
    const layer = doc.layers[index]!;
    if (!layer.visible || layer.opacity <= 0) continue;
    const [r, g, b, a] = getLayerPixel(layer, doc.width, x, y);
    if (a > 0) return `#${[r, g, b].map((c) => c.toString(16).padStart(2, "0")).join("")}`;
  }
  return "#000000";
}
