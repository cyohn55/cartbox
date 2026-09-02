/**
 * Selections, the clipboard, and the transforms that act on them.
 *
 * The pixel editor could select a contiguous colour region with the magic wand
 * and then… erase it. There was no marquee, no way to move what was selected,
 * no copy or paste, and no flip or rotate — the operations a pixel artist
 * reaches for constantly, and the reason the tool felt unfinished next to any
 * other sprite editor.
 *
 * Everything here is pure: it takes and returns plain data (a set of pixel
 * keys, a stamp of values) and never touches a canvas or a React state setter.
 * That keeps the geometry — which is where the off-by-one bugs live — testable
 * without a DOM.
 */

import type { PaintSurface } from "./paintSurface";
import { pixelKey, type PixelPoint } from "./shapeTools";
import type { SpritePage } from "@cartbox/editor";

/** A selection as pixel keys within one tile block. */
export type Selection = ReadonlySet<number>;

/** Pixels lifted out of a surface, with their values, ready to paste. */
export interface Stamp {
  readonly width: number;
  readonly height: number;
  /** Row-major values; -1 means "transparent here", so a shape keeps its edges. */
  readonly values: readonly number[];
}

/** Every pixel in the rectangle the drag covers, clamped to the block. */
export function marqueeSelection(
  from: PixelPoint,
  to: PixelPoint,
  size: number,
): Set<number> {
  const left = Math.max(0, Math.min(from.x, to.x));
  const right = Math.min(size - 1, Math.max(from.x, to.x));
  const top = Math.max(0, Math.min(from.y, to.y));
  const bottom = Math.min(size - 1, Math.max(from.y, to.y));
  const selection = new Set<number>();
  for (let y = top; y <= bottom; y += 1) {
    for (let x = left; x <= right; x += 1) selection.add(pixelKey(x, y, size));
  }
  return selection;
}

/** The tight bounding box of a selection, or null when it is empty. */
export function selectionBounds(
  selection: Selection,
  size: number,
): { left: number; top: number; right: number; bottom: number } | null {
  let left = size;
  let top = size;
  let right = -1;
  let bottom = -1;
  for (const key of selection) {
    const x = key % size;
    const y = Math.floor(key / size);
    if (x < left) left = x;
    if (x > right) right = x;
    if (y < top) top = y;
    if (y > bottom) bottom = y;
  }
  return right < 0 ? null : { left, top, right, bottom };
}

/**
 * Lift a selection's pixels into a stamp. Pixels inside the bounding box but
 * outside the selection come back as -1, so a wand-selected blob pastes as that
 * blob rather than as its rectangle.
 */
export function copySelection(
  surface: PaintSurface,
  page: SpritePage,
  tile: number,
  selection: Selection,
  size: number,
): Stamp | null {
  const bounds = selectionBounds(selection, size);
  if (!bounds) return null;
  const width = bounds.right - bounds.left + 1;
  const height = bounds.bottom - bounds.top + 1;
  const values: number[] = [];
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const sx = bounds.left + x;
      const sy = bounds.top + y;
      values.push(selection.has(pixelKey(sx, sy, size)) ? surface.getPixel(page, tile, sx, sy) : -1);
    }
  }
  return { width, height, values };
}

/**
 * Paste a stamp with its top-left at (x, y), skipping its transparent cells and
 * anything that falls outside the block. Returns the keys actually written, so
 * the caller can make the pasted pixels the new selection — which is what lets
 * a paste be nudged into place immediately.
 */
export function pasteStamp(
  surface: PaintSurface,
  page: SpritePage,
  tile: number,
  stamp: Stamp,
  x: number,
  y: number,
  size: number,
): Set<number> {
  const written = new Set<number>();
  for (let row = 0; row < stamp.height; row += 1) {
    for (let column = 0; column < stamp.width; column += 1) {
      const value = stamp.values[row * stamp.width + column] ?? -1;
      if (value < 0) continue;
      const tx = x + column;
      const ty = y + row;
      if (tx < 0 || tx >= size || ty < 0 || ty >= size) continue;
      surface.setPixel(page, tile, tx, ty, value);
      written.add(pixelKey(tx, ty, size));
    }
  }
  return written;
}

/** Clear a selection's pixels to `value` (0 for the albedo layer's empty). */
export function clearSelection(
  surface: PaintSurface,
  page: SpritePage,
  tile: number,
  selection: Selection,
  size: number,
  value = 0,
): void {
  for (const key of selection) {
    surface.setPixel(page, tile, key % size, Math.floor(key / size), value);
  }
}

export function flipStampHorizontal(stamp: Stamp): Stamp {
  const values: number[] = [];
  for (let row = 0; row < stamp.height; row += 1) {
    for (let column = 0; column < stamp.width; column += 1) {
      values.push(stamp.values[row * stamp.width + (stamp.width - 1 - column)] ?? -1);
    }
  }
  return { width: stamp.width, height: stamp.height, values };
}

export function flipStampVertical(stamp: Stamp): Stamp {
  const values: number[] = [];
  for (let row = 0; row < stamp.height; row += 1) {
    for (let column = 0; column < stamp.width; column += 1) {
      values.push(stamp.values[(stamp.height - 1 - row) * stamp.width + column] ?? -1);
    }
  }
  return { width: stamp.width, height: stamp.height, values };
}

/** A quarter turn clockwise. Width and height swap, as they must. */
export function rotateStamp(stamp: Stamp): Stamp {
  const values: number[] = [];
  for (let row = 0; row < stamp.width; row += 1) {
    for (let column = 0; column < stamp.height; column += 1) {
      values.push(stamp.values[(stamp.height - 1 - column) * stamp.width + row] ?? -1);
    }
  }
  return { width: stamp.height, height: stamp.width, values };
}

/** Shift every key in a selection by (dx, dy), dropping what leaves the block. */
export function offsetSelection(selection: Selection, dx: number, dy: number, size: number): Set<number> {
  const moved = new Set<number>();
  for (const key of selection) {
    const x = (key % size) + dx;
    const y = Math.floor(key / size) + dy;
    if (x < 0 || x >= size || y < 0 || y >= size) continue;
    moved.add(pixelKey(x, y, size));
  }
  return moved;
}

/**
 * Apply a transform to the selected pixels in place, keeping them anchored to
 * their bounding box's top-left. Returns the new selection, which differs from
 * the old one after a rotate (the box's width and height swap).
 */
export function transformSelection(
  surface: PaintSurface,
  page: SpritePage,
  tile: number,
  selection: Selection,
  size: number,
  transform: (stamp: Stamp) => Stamp,
  empty = 0,
): Set<number> {
  const bounds = selectionBounds(selection, size);
  const stamp = copySelection(surface, page, tile, selection, size);
  if (!bounds || !stamp) return new Set(selection);
  clearSelection(surface, page, tile, selection, size, empty);
  return pasteStamp(surface, page, tile, transform(stamp), bounds.left, bounds.top, size);
}

/**
 * Move the selected pixels by (dx, dy): lift them, clear where they were, and
 * stamp them down at the offset. Returns the selection at its new place.
 */
export function moveSelection(
  surface: PaintSurface,
  page: SpritePage,
  tile: number,
  selection: Selection,
  size: number,
  dx: number,
  dy: number,
  empty = 0,
): Set<number> {
  const bounds = selectionBounds(selection, size);
  const stamp = copySelection(surface, page, tile, selection, size);
  if (!bounds || !stamp) return new Set(selection);
  clearSelection(surface, page, tile, selection, size, empty);
  return pasteStamp(surface, page, tile, stamp, bounds.left + dx, bounds.top + dy, size);
}
