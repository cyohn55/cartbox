/**
 * Tests for the sprite editor's adjustable brush weight and fill/wand tolerance.
 * These drive the pure geometry/selection helpers the canvas uses — brushStamp,
 * thickenPoints, wandSelection, and maskedFloodFill — with small hand-built
 * grids and assert on the actual pixels stamped, thickened, filled and selected.
 * The functions live in the web app, so they're imported by relative path (the
 * same pattern as the render-worker tests).
 */

import { describe, expect, it } from "vitest";
import type { SpritePage } from "@cartbox/editor";

import {
  brushStamp,
  thickenPoints,
  wandSelection,
  maskedFloodFill,
  parseHexColor,
  pixelKey,
  type ColorSampler,
} from "../apps/web/src/app/edit/[cartId]/shapeTools";
import type { PaintSurface } from "../apps/web/src/app/edit/[cartId]/paintSurface";

/** A minimal square PaintSurface over an in-memory grid, for exercising fills. */
class GridSurface implements PaintSurface {
  private readonly cells: number[];
  constructor(
    readonly tileSize: number,
    fill: number,
    private readonly palette: Record<number, string> = {},
  ) {
    this.cells = new Array(tileSize * tileSize).fill(fill);
  }
  getPixel(_page: SpritePage, _tile: number, x: number, y: number): number {
    return this.cells[y * this.tileSize + x] ?? 0;
  }
  setPixel(_page: SpritePage, _tile: number, x: number, y: number, value: number): void {
    this.cells[y * this.tileSize + x] = value;
  }
  fill(): void {
    /* unused here */
  }
  cssColor(value: number): string {
    return this.palette[value] ?? "#000000";
  }
  count(value: number): number {
    return this.cells.filter((cell) => cell === value).length;
  }
}

describe("brushStamp", () => {
  it("is a single pixel at weight 1", () => {
    expect(brushStamp(3, 4, 1)).toEqual([{ x: 3, y: 4 }]);
  });

  it("stamps weight×weight pixels", () => {
    expect(brushStamp(0, 0, 2).length).toBe(4);
    expect(brushStamp(0, 0, 3).length).toBe(9);
  });

  it("centres odd weights on the pixel", () => {
    const stamp = brushStamp(5, 5, 3);
    expect(stamp).toContainEqual({ x: 4, y: 4 });
    expect(stamp).toContainEqual({ x: 5, y: 5 });
    expect(stamp).toContainEqual({ x: 6, y: 6 });
  });
});

describe("thickenPoints", () => {
  it("returns the input unchanged at weight 1", () => {
    const line = [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
    ];
    expect(thickenPoints(line, 1)).toEqual(line);
  });

  it("widens a horizontal line into a 2px-tall band without duplicates", () => {
    const line = [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 2, y: 0 },
    ];
    const thick = thickenPoints(line, 2);
    // 3 points × 2×2 stamp = 12 cells, minus overlaps → the 2×4 band = 8 unique.
    expect(thick.length).toBe(8);
    const keys = new Set(thick.map((p) => `${p.x},${p.y}`));
    expect(keys.size).toBe(thick.length); // no duplicates
    expect(keys.has("0,1")).toBe(true); // the added lower row
  });
});

describe("parseHexColor", () => {
  it("parses #rrggbb into an RGB triplet", () => {
    expect(parseHexColor("#ff8000")).toEqual([255, 128, 0]);
    expect(parseHexColor("#000000")).toEqual([0, 0, 0]);
  });
});

describe("wandSelection tolerance", () => {
  // A 3×3 grid of palette indices whose colours are near/far from the seed.
  const size = 3;
  // index 1 = red seed, 2 = near-red (within tolerance), 3 = blue (far).
  const palette: Record<number, [number, number, number]> = {
    1: [200, 0, 0],
    2: [210, 10, 10],
    3: [0, 0, 200],
  };
  const grid = [
    1, 2, 3,
    2, 1, 3,
    3, 3, 3,
  ];
  const getPixel = (x: number, y: number) => grid[y * size + x] ?? 0;
  const sampleColor: ColorSampler = (value) => palette[value] ?? [0, 0, 0];

  it("selects only the exact value with no tolerance", () => {
    const selection = wandSelection(getPixel, size, 1, 1); // seed value 1
    // Only the two value-1 cells are contiguous through matching neighbours…
    for (const key of selection) {
      const x = key % size;
      const y = Math.floor(key / size);
      expect(getPixel(x, y)).toBe(1);
    }
  });

  it("grows the selection to include near colours at higher tolerance", () => {
    const exact = wandSelection(getPixel, size, 1, 1);
    const loose = wandSelection(getPixel, size, 1, 1, { tolerance: 0.1, sampleColor });
    expect(loose.size).toBeGreaterThan(exact.size);
    // The near-red (value 2) cells are now selected; the far blue (3) never is.
    let hasBlue = false;
    for (const key of loose) {
      if (getPixel(key % size, Math.floor(key / size)) === 3) hasBlue = true;
    }
    expect(hasBlue).toBe(false);
  });
});

describe("maskedFloodFill tolerance", () => {
  const palette = { 0: "#000000", 1: "#c80000", 2: "#d20a0a", 3: "#0000c8", 9: "#00ff00" };

  function seededGrid(): GridSurface {
    // 3×3: a red column (value 1) beside a near-red column (value 2) and a blue
    // pixel, on black. The two 1s are adjacent, as are the two 2s.
    const surface = new GridSurface(3, 0, palette);
    const layout = [
      1, 2, 3,
      1, 2, 0,
      0, 0, 0,
    ];
    for (let y = 0; y < 3; y += 1) for (let x = 0; x < 3; x += 1) surface.setPixel(0, 0, x, y, layout[y * 3 + x]!);
    return surface;
  }

  it("fills only the exact value with no tolerance", () => {
    const surface = seededGrid();
    maskedFloodFill(surface, 0, 0, 0, 0, 9, null); // seed a value-1 pixel
    // The two contiguous value-1 pixels become 9; the value-2 column stays.
    expect(surface.count(9)).toBe(2);
    expect(surface.count(2)).toBe(2);
  });

  it("fills the near-colour neighbours at higher tolerance", () => {
    const surface = seededGrid();
    const sampleColor: ColorSampler = (value) => parseHexColor(surface.cssColor(value));
    maskedFloodFill(surface, 0, 0, 0, 0, 9, null, { tolerance: 0.1, sampleColor });
    // The red column (1s) and adjacent near-red column (2s) fill as one region;
    // the blue pixel is far and untouched.
    expect(surface.count(9)).toBe(4);
    expect(surface.count(3)).toBe(1); // blue survives
  });

  it("never escapes the selection mask", () => {
    const surface = seededGrid();
    const sampleColor: ColorSampler = (value) => parseHexColor(surface.cssColor(value));
    const mask = new Set<number>([pixelKey(1, 1, 3)]); // only the centre pixel
    maskedFloodFill(surface, 0, 0, 1, 1, 9, mask, { tolerance: 0.5, sampleColor });
    expect(surface.count(9)).toBe(1); // just the masked pixel, despite high tolerance
  });
});
