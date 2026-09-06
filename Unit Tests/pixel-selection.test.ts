/**
 * Pixel-selection tests (apps/web/src/app/edit/[cartId]/pixelSelection.ts).
 *
 * The sprite editor could select a region with the magic wand and then erase
 * it, and nothing else — no marquee, no move, no copy or paste, no flip or
 * rotate. These are the operations that were missing, and they are the ones
 * where off-by-one errors hide, so the geometry was written pure and is driven
 * here against a tiny in-memory surface rather than through a canvas.
 */

import { describe, expect, it } from "vitest";

import {
  clearSelection,
  copySelection,
  flipStampHorizontal,
  flipStampVertical,
  marqueeSelection,
  moveSelection,
  offsetSelection,
  pasteStamp,
  rotateStamp,
  selectionBounds,
  transformSelection,
  type Stamp,
} from "@/app/edit/[cartId]/pixelSelection";
import { pixelKey } from "@/app/edit/[cartId]/shapeTools";

const SIZE = 8;

/** The smallest thing that satisfies PaintSurface: a flat array of values. */
function surfaceOf(size = SIZE) {
  const pixels = new Array<number>(size * size).fill(0);
  return {
    tileSize: size,
    pixels,
    getPixel: (_page: number, _tile: number, x: number, y: number) => pixels[y * size + x] ?? 0,
    setPixel: (_page: number, _tile: number, x: number, y: number, value: number) => {
      pixels[y * size + x] = value;
    },
    fill: () => undefined,
    cssColor: () => "#000000",
  };
}

/** A selection of the given (x, y) pairs. */
function selectionOf(points: ReadonlyArray<readonly [number, number]>, size = SIZE): Set<number> {
  return new Set(points.map(([x, y]) => pixelKey(x, y, size)));
}

function keysOf(selection: ReadonlySet<number>, size = SIZE): Array<[number, number]> {
  return [...selection].map((key) => [key % size, Math.floor(key / size)] as [number, number]).sort();
}

describe("marqueeSelection", () => {
  it("selects the rectangle a drag covers, in either direction", () => {
    const forward = marqueeSelection({ x: 1, y: 1 }, { x: 3, y: 2 }, SIZE);
    const backward = marqueeSelection({ x: 3, y: 2 }, { x: 1, y: 1 }, SIZE);
    expect(forward.size).toBe(6);
    expect(keysOf(forward)).toEqual(keysOf(backward));
  });

  it("selects one pixel when the drag does not move", () => {
    expect(marqueeSelection({ x: 4, y: 4 }, { x: 4, y: 4 }, SIZE).size).toBe(1);
  });

  it("clamps a drag that leaves the block", () => {
    const selection = marqueeSelection({ x: -5, y: -5 }, { x: 100, y: 100 }, SIZE);
    expect(selection.size).toBe(SIZE * SIZE);
  });
});

describe("selectionBounds", () => {
  it("finds the tight box around a scattered selection", () => {
    const bounds = selectionBounds(selectionOf([[2, 1], [5, 6], [3, 3]]), SIZE);
    expect(bounds).toEqual({ left: 2, top: 1, right: 5, bottom: 6 });
  });

  it("is null for an empty selection", () => {
    expect(selectionBounds(new Set(), SIZE)).toBeNull();
  });
});

describe("copy and paste", () => {
  it("lifts the selected values and puts them back somewhere else", () => {
    const surface = surfaceOf();
    surface.setPixel(0, 0, 1, 1, 7);
    surface.setPixel(0, 0, 2, 1, 8);
    const selection = selectionOf([[1, 1], [2, 1]]);

    const stamp = copySelection(surface, 0, 0, selection, SIZE)!;
    expect(stamp.width).toBe(2);
    expect(stamp.height).toBe(1);
    expect(stamp.values).toEqual([7, 8]);

    pasteStamp(surface, 0, 0, stamp, 4, 4, SIZE);
    expect(surface.getPixel(0, 0, 4, 4)).toBe(7);
    expect(surface.getPixel(0, 0, 5, 4)).toBe(8);
  });

  it("marks pixels inside the box but outside the selection as transparent", () => {
    // A wand-selected blob must paste as that blob, not as its rectangle.
    const surface = surfaceOf();
    surface.setPixel(0, 0, 0, 0, 5);
    surface.setPixel(0, 0, 1, 1, 6);
    const stamp = copySelection(surface, 0, 0, selectionOf([[0, 0], [1, 1]]), SIZE)!;
    expect(stamp.values).toEqual([5, -1, -1, 6]);
  });

  it("does not paint the transparent cells of a stamp", () => {
    const surface = surfaceOf();
    surface.setPixel(0, 0, 3, 3, 9);
    const stamp: Stamp = { width: 2, height: 1, values: [-1, 4] };
    pasteStamp(surface, 0, 0, stamp, 3, 3, SIZE);
    expect(surface.getPixel(0, 0, 3, 3)).toBe(9); // untouched by the -1
    expect(surface.getPixel(0, 0, 4, 3)).toBe(4);
  });

  it("clips a paste that would run off the block", () => {
    const surface = surfaceOf();
    const stamp: Stamp = { width: 3, height: 1, values: [1, 2, 3] };
    const written = pasteStamp(surface, 0, 0, stamp, SIZE - 2, 0, SIZE);
    expect(written.size).toBe(2);
  });

  it("returns nothing for an empty selection", () => {
    expect(copySelection(surfaceOf(), 0, 0, new Set(), SIZE)).toBeNull();
  });
});

describe("stamp transforms", () => {
  const stamp: Stamp = { width: 3, height: 2, values: [1, 2, 3, 4, 5, 6] };

  it("mirrors horizontally", () => {
    expect(flipStampHorizontal(stamp).values).toEqual([3, 2, 1, 6, 5, 4]);
  });

  it("mirrors vertically", () => {
    expect(flipStampVertical(stamp).values).toEqual([4, 5, 6, 1, 2, 3]);
  });

  it("is its own inverse when mirrored twice", () => {
    expect(flipStampHorizontal(flipStampHorizontal(stamp)).values).toEqual(stamp.values);
    expect(flipStampVertical(flipStampVertical(stamp)).values).toEqual(stamp.values);
  });

  it("swaps width and height on a quarter turn", () => {
    const turned = rotateStamp(stamp);
    expect(turned.width).toBe(stamp.height);
    expect(turned.height).toBe(stamp.width);
  });

  it("returns to the original after four quarter turns", () => {
    const round = rotateStamp(rotateStamp(rotateStamp(rotateStamp(stamp))));
    expect(round.width).toBe(stamp.width);
    expect(round.height).toBe(stamp.height);
    expect(round.values).toEqual(stamp.values);
  });

  it("rotates clockwise, putting the bottom-left value top-left", () => {
    expect(rotateStamp(stamp).values[0]).toBe(4);
  });
});

describe("moving a selection", () => {
  it("takes the pixels with it and leaves emptiness behind", () => {
    const surface = surfaceOf();
    surface.setPixel(0, 0, 1, 1, 3);
    const moved = moveSelection(surface, 0, 0, selectionOf([[1, 1]]), SIZE, 2, 1);

    expect(surface.getPixel(0, 0, 1, 1)).toBe(0);
    expect(surface.getPixel(0, 0, 3, 2)).toBe(3);
    expect(keysOf(moved)).toEqual([[3, 2]]);
  });

  it("drops what a move pushes off the block", () => {
    const surface = surfaceOf();
    surface.setPixel(0, 0, 0, 0, 5);
    const moved = moveSelection(surface, 0, 0, selectionOf([[0, 0]]), SIZE, -1, 0);
    expect(moved.size).toBe(0);
  });

  it("offsets a selection's coordinates without touching pixels", () => {
    const moved = offsetSelection(selectionOf([[1, 1], [2, 2]]), 1, 0, SIZE);
    expect(keysOf(moved)).toEqual([[2, 1], [3, 2]]);
  });
});

describe("transforming a selection in place", () => {
  it("keeps the result anchored to the box's top-left corner", () => {
    const surface = surfaceOf();
    surface.setPixel(0, 0, 2, 2, 1);
    surface.setPixel(0, 0, 3, 2, 2);
    const selection = selectionOf([[2, 2], [3, 2]]);

    transformSelection(surface, 0, 0, selection, SIZE, flipStampHorizontal);
    expect(surface.getPixel(0, 0, 2, 2)).toBe(2);
    expect(surface.getPixel(0, 0, 3, 2)).toBe(1);
  });

  it("clears the selected pixels", () => {
    const surface = surfaceOf();
    surface.setPixel(0, 0, 1, 1, 6);
    clearSelection(surface, 0, 0, selectionOf([[1, 1]]), SIZE);
    expect(surface.getPixel(0, 0, 1, 1)).toBe(0);
  });
});
