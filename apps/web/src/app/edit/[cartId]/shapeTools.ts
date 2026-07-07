/**
 * Pure pixel geometry and selection helpers for the sprite editor's drawing
 * tools: Bresenham lines, rectangle and ellipse outlines, the magic-wand
 * contiguous region, and a selection-bounded flood fill. All functions are
 * DOM-free so the canvas, the tests, and any future tools share one geometry.
 */

import type { SpritePage } from "@cartbox/editor";

import type { PaintSurface } from "./paintSurface";

export interface PixelPoint {
  x: number;
  y: number;
}

/** Key a pixel for Set membership: y * size + x. */
export function pixelKey(x: number, y: number, size: number): number {
  return y * size + x;
}

/** Bresenham line between two pixels, inclusive of both endpoints. */
export function linePoints(x0: number, y0: number, x1: number, y1: number): PixelPoint[] {
  const points: PixelPoint[] = [];
  const deltaX = Math.abs(x1 - x0);
  const deltaY = -Math.abs(y1 - y0);
  const stepX = x0 < x1 ? 1 : -1;
  const stepY = y0 < y1 ? 1 : -1;
  let error = deltaX + deltaY;
  let x = x0;
  let y = y0;

  for (;;) {
    points.push({ x, y });
    if (x === x1 && y === y1) break;
    const doubledError = 2 * error;
    if (doubledError >= deltaY) {
      error += deltaY;
      x += stepX;
    }
    if (doubledError <= deltaX) {
      error += deltaX;
      y += stepY;
    }
  }
  return points;
}

/** Outline of the axis-aligned rectangle spanned by two corners (any order). */
export function rectOutlinePoints(x0: number, y0: number, x1: number, y1: number): PixelPoint[] {
  const left = Math.min(x0, x1);
  const right = Math.max(x0, x1);
  const top = Math.min(y0, y1);
  const bottom = Math.max(y0, y1);
  const points: PixelPoint[] = [];
  for (let x = left; x <= right; x += 1) {
    points.push({ x, y: top });
    if (bottom !== top) points.push({ x, y: bottom });
  }
  for (let y = top + 1; y <= bottom - 1; y += 1) {
    points.push({ x: left, y });
    if (right !== left) points.push({ x: right, y });
  }
  return points;
}

/**
 * Outline of the ellipse inscribed in the rectangle spanned by two corners.
 * Scans both axes of the implicit equation so steep and shallow arcs are both
 * gap-free, deduplicated via pixel keys. Degenerate boxes fall back to a line.
 */
export function ellipseOutlinePoints(x0: number, y0: number, x1: number, y1: number): PixelPoint[] {
  const left = Math.min(x0, x1);
  const right = Math.max(x0, x1);
  const top = Math.min(y0, y1);
  const bottom = Math.max(y0, y1);
  if (right - left < 2 || bottom - top < 2) return rectOutlinePoints(left, top, right, bottom);

  const centerX = (left + right) / 2;
  const centerY = (top + bottom) / 2;
  const radiusX = (right - left) / 2;
  const radiusY = (bottom - top) / 2;
  const size = Math.max(right, bottom) + 1;
  const seen = new Set<number>();
  const points: PixelPoint[] = [];
  const add = (x: number, y: number) => {
    const key = pixelKey(x, y, size);
    if (!seen.has(key)) {
      seen.add(key);
      points.push({ x, y });
    }
  };

  for (let x = left; x <= right; x += 1) {
    const t = (x - centerX) / radiusX;
    const dy = radiusY * Math.sqrt(Math.max(0, 1 - t * t));
    add(x, Math.round(centerY - dy));
    add(x, Math.round(centerY + dy));
  }
  for (let y = top; y <= bottom; y += 1) {
    const t = (y - centerY) / radiusY;
    const dx = radiusX * Math.sqrt(Math.max(0, 1 - t * t));
    add(Math.round(centerX - dx), y);
    add(Math.round(centerX + dx), y);
  }
  return points;
}

/**
 * Magic-wand selection: the contiguous (4-connected) region of pixels sharing
 * the start pixel's value. Returns a set of pixel keys (y * size + x).
 */
export function wandSelection(
  getPixel: (x: number, y: number) => number,
  size: number,
  startX: number,
  startY: number,
): Set<number> {
  const target = getPixel(startX, startY);
  const selected = new Set<number>();
  const stack: PixelPoint[] = [{ x: startX, y: startY }];
  while (stack.length > 0) {
    const { x, y } = stack.pop()!;
    if (x < 0 || x >= size || y < 0 || y >= size) continue;
    const key = pixelKey(x, y, size);
    if (selected.has(key) || getPixel(x, y) !== target) continue;
    selected.add(key);
    stack.push({ x: x + 1, y }, { x: x - 1, y }, { x, y: y + 1 }, { x, y: y - 1 });
  }
  return selected;
}

/**
 * Flood fill bounded by a selection mask: identical to the plain bucket when
 * mask is null, otherwise the fill never escapes the selected pixels.
 */
export function maskedFloodFill(
  surface: PaintSurface,
  page: SpritePage,
  tile: number,
  startX: number,
  startY: number,
  value: number,
  mask: Set<number> | null,
): void {
  const size = surface.tileSize;
  const inMask = (x: number, y: number) => !mask || mask.has(pixelKey(x, y, size));
  if (!inMask(startX, startY)) return;
  const target = surface.getPixel(page, tile, startX, startY);
  if (target === value) return;

  const stack: PixelPoint[] = [{ x: startX, y: startY }];
  while (stack.length > 0) {
    const { x, y } = stack.pop()!;
    if (x < 0 || x >= size || y < 0 || y >= size) continue;
    if (!inMask(x, y) || surface.getPixel(page, tile, x, y) !== target) continue;
    surface.setPixel(page, tile, x, y, value);
    stack.push({ x: x + 1, y }, { x: x - 1, y }, { x, y: y + 1 }, { x, y: y - 1 });
  }
}
