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

/**
 * The square footprint a brush of side `weight` stamps at (x, y). Weight 1 is
 * the single pixel; larger weights centre the block on the pixel (even sizes
 * bias down-right by half a pixel), so a stroke reads as `weight` pixels thick.
 */
export function brushStamp(x: number, y: number, weight: number): PixelPoint[] {
  const side = Math.max(1, Math.floor(weight));
  if (side === 1) return [{ x, y }];
  const offset = Math.floor((side - 1) / 2);
  const points: PixelPoint[] = [];
  for (let dy = 0; dy < side; dy += 1) {
    for (let dx = 0; dx < side; dx += 1) {
      points.push({ x: x - offset + dx, y: y - offset + dy });
    }
  }
  return points;
}

/**
 * Expands a 1px point path (a line/rect/ellipse outline) into a `weight`-thick
 * path by stamping a brush at every point and de-duplicating. Weight 1 returns
 * the input unchanged.
 */
export function thickenPoints(points: readonly PixelPoint[], weight: number): PixelPoint[] {
  const side = Math.max(1, Math.floor(weight));
  if (side === 1) return points.slice();
  const seen = new Set<string>();
  const out: PixelPoint[] = [];
  for (const point of points) {
    for (const stamp of brushStamp(point.x, point.y, side)) {
      const key = `${stamp.x},${stamp.y}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(stamp);
    }
  }
  return out;
}

/** Maps a pixel value to its display RGB, used for tolerance colour-matching. */
export type ColorSampler = (value: number) => readonly [number, number, number];

/** Optional tolerance matching for the fill and magic-wand tools. */
export interface ToleranceMatch {
  /** 0..1 fraction of the maximum RGB distance. 0 falls back to exact matching. */
  tolerance: number;
  /** Resolves a pixel value to the RGB the tolerance is measured in. */
  sampleColor: ColorSampler;
}

/** Largest possible Euclidean distance between two 8-bit RGB colours. */
const MAX_RGB_DISTANCE = Math.sqrt(3 * 255 * 255);

/** Parses a `#rrggbb` string to an RGB triplet (0..255). */
export function parseHexColor(hex: string): [number, number, number] {
  const value = Number.parseInt(hex.replace("#", ""), 16) || 0;
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}

/**
 * Builds the predicate a fill/wand uses to decide whether a pixel belongs with
 * the seed. With no match option (or tolerance 0) it is an exact value match —
 * the historic behaviour; with a tolerance it includes any pixel whose colour is
 * within `tolerance` of the seed colour, so a higher tolerance grows the region.
 */
function toleranceMatcher(targetValue: number, match?: ToleranceMatch): (value: number) => boolean {
  if (!match || match.tolerance <= 0) {
    return (value) => value === targetValue;
  }
  const target = match.sampleColor(targetValue);
  const threshold = match.tolerance * MAX_RGB_DISTANCE;
  return (value) => {
    if (value === targetValue) return true;
    const color = match.sampleColor(value);
    const dr = color[0] - target[0];
    const dg = color[1] - target[1];
    const db = color[2] - target[2];
    return Math.sqrt(dr * dr + dg * dg + db * db) <= threshold;
  };
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
 * Magic-wand selection: the contiguous (4-connected) region of pixels that match
 * the start pixel. With no tolerance that means the exact same value; with a
 * tolerance it is every contiguous pixel whose colour is within tolerance of the
 * seed, so a higher tolerance selects a broader area. Returns pixel keys.
 */
export function wandSelection(
  getPixel: (x: number, y: number) => number,
  size: number,
  startX: number,
  startY: number,
  match?: ToleranceMatch,
): Set<number> {
  const target = getPixel(startX, startY);
  const matches = toleranceMatcher(target, match);
  const selected = new Set<number>();
  const stack: PixelPoint[] = [{ x: startX, y: startY }];
  while (stack.length > 0) {
    const { x, y } = stack.pop()!;
    if (x < 0 || x >= size || y < 0 || y >= size) continue;
    const key = pixelKey(x, y, size);
    if (selected.has(key) || !matches(getPixel(x, y))) continue;
    selected.add(key);
    stack.push({ x: x + 1, y }, { x: x - 1, y }, { x, y: y + 1 }, { x, y: y - 1 });
  }
  return selected;
}

/**
 * Flood fill bounded by a selection mask. With no tolerance it fills the
 * contiguous region of the seed's exact value; with a tolerance it spreads to
 * every contiguous pixel whose colour is within tolerance of the seed, so a
 * higher tolerance fills more. Never escapes the selection mask when one is set.
 * A visited set makes it safe even when the new value is itself within tolerance
 * of the seed (which would otherwise re-enter just-filled pixels).
 */
export function maskedFloodFill(
  surface: PaintSurface,
  page: SpritePage,
  tile: number,
  startX: number,
  startY: number,
  value: number,
  mask: Set<number> | null,
  match?: ToleranceMatch,
): void {
  const size = surface.tileSize;
  const inMask = (x: number, y: number) => !mask || mask.has(pixelKey(x, y, size));
  if (!inMask(startX, startY)) return;
  const target = surface.getPixel(page, tile, startX, startY);
  if (target === value) return;
  const matches = toleranceMatcher(target, match);

  const visited = new Set<number>();
  const stack: PixelPoint[] = [{ x: startX, y: startY }];
  while (stack.length > 0) {
    const { x, y } = stack.pop()!;
    if (x < 0 || x >= size || y < 0 || y >= size) continue;
    const key = pixelKey(x, y, size);
    if (visited.has(key)) continue;
    if (!inMask(x, y) || !matches(surface.getPixel(page, tile, x, y))) continue;
    visited.add(key);
    surface.setPixel(page, tile, x, y, value);
    stack.push({ x: x + 1, y }, { x: x - 1, y }, { x, y: y + 1 }, { x, y: y - 1 });
  }
}
