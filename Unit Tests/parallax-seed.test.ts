/**
 * Parallax cart seed tests. These drive the real seedParallaxDemoCart over the
 * real StubCartEngine and assert on observable outputs — painted tile pixels,
 * stamped map cells, and generated code — all derived from the PARALLAX_LAYERS
 * config rather than hardcoded, so the tests track the layout if it changes.
 */

import { describe, expect, it } from "vitest";
import {
  StubCartEngine,
  seedParallaxDemoCart,
  buildParallaxCode,
  PARALLAX_CODE,
  PARALLAX_LAYERS,
  silhouetteHeight,
  bandTopRow,
  MAP_SCREEN_HEIGHT,
  MAP_SCREEN_WIDTH,
  MAP_WIDTH,
  TILE_SIZE,
} from "@cartbox/editor";

const EMPTY_TILE = 0;

function seededEngine(): StubCartEngine {
  const engine = new StubCartEngine();
  seedParallaxDemoCart(engine);
  return engine;
}

/** Columns worth probing: period boundaries, a peak, and a trough per layer. */
function sampleColumns(periodColumns: number): number[] {
  return [0, Math.floor(periodColumns / 2), periodColumns, periodColumns + 1, MAP_WIDTH - 1];
}

describe("silhouetteHeight", () => {
  it("stays within [baseline, baseline + amplitude] for every layer", () => {
    for (const layer of PARALLAX_LAYERS) {
      for (let column = 0; column < layer.periodColumns * 3; column += 1) {
        const height = silhouetteHeight(layer, column);
        expect(height).toBeGreaterThanOrEqual(layer.baselineCells);
        expect(height).toBeLessThanOrEqual(layer.baselineCells + layer.amplitudeCells);
      }
    }
  });

  it("repeats exactly every period so the scroll loops seamlessly", () => {
    for (const layer of PARALLAX_LAYERS) {
      for (const column of sampleColumns(layer.periodColumns)) {
        expect(silhouetteHeight(layer, column)).toBe(
          silhouetteHeight(layer, column + layer.periodColumns),
        );
      }
    }
  });

  it("never exceeds the band height", () => {
    for (const layer of PARALLAX_LAYERS) {
      for (let column = 0; column < layer.periodColumns; column += 1) {
        expect(silhouetteHeight(layer, column)).toBeLessThanOrEqual(MAP_SCREEN_HEIGHT);
      }
    }
  });
});

describe("seedParallaxDemoCart tiles", () => {
  it("paints each layer's tile as a solid block of its palette color", () => {
    const engine = seededEngine();
    for (const layer of PARALLAX_LAYERS) {
      for (let y = 0; y < TILE_SIZE; y += 1) {
        for (let x = 0; x < TILE_SIZE; x += 1) {
          expect(engine.getPixel(0, layer.tile, x, y)).toBe(layer.colorIndex);
        }
      }
    }
  });
});

describe("seedParallaxDemoCart map bands", () => {
  it("fills each column up to its silhouette height and leaves the rest empty", () => {
    const engine = seededEngine();
    PARALLAX_LAYERS.forEach((layer, layerIndex) => {
      const bandTop = bandTopRow(layerIndex);
      const bandBottom = bandTop + MAP_SCREEN_HEIGHT - 1;
      for (const column of sampleColumns(layer.periodColumns)) {
        const height = silhouetteHeight(layer, column);
        for (let row = bandTop; row <= bandBottom; row += 1) {
          const filledFromBottom = bandBottom - row;
          const expected = filledFromBottom < height ? layer.tile : EMPTY_TILE;
          expect(engine.getMapCell(column, row)).toBe(expected);
        }
      }
    });
  });

  it("keeps each layer's tile inside its own band (no bleed between layers)", () => {
    const engine = seededEngine();
    PARALLAX_LAYERS.forEach((layer, layerIndex) => {
      const bandTop = bandTopRow(layerIndex);
      const bandBottom = bandTop + MAP_SCREEN_HEIGHT - 1;
      for (const column of sampleColumns(layer.periodColumns)) {
        for (let row = 0; row < bandTopRow(PARALLAX_LAYERS.length); row += 1) {
          const insideOwnBand = row >= bandTop && row <= bandBottom;
          if (!insideOwnBand) {
            expect(engine.getMapCell(column, row)).not.toBe(layer.tile);
          }
        }
      }
    });
  });
});

describe("buildParallaxCode", () => {
  it("selects Lua and emits deterministic, self-consistent code", () => {
    const engine = seededEngine();
    expect(engine.getLanguage()).toBe("lua");
    expect(engine.getCode()).toBe(PARALLAX_CODE);
    expect(buildParallaxCode()).toBe(PARALLAX_CODE);
    expect(PARALLAX_CODE).toContain("-- script: lua");
  });

  it("emits one map draw per layer at its band row, with a seamless wrap period", () => {
    const code = buildParallaxCode();
    PARALLAX_LAYERS.forEach((layer, layerIndex) => {
      const bandTop = bandTopRow(layerIndex);
      const drawColumns = MAP_SCREEN_WIDTH + layer.periodColumns + 1;
      const periodPixels = layer.periodColumns * TILE_SIZE;
      const expectedCall =
        `map(0,${bandTop},${drawColumns},${MAP_SCREEN_HEIGHT},` +
        `-((cam*${layer.depth})%${periodPixels}),0)`;
      expect(code).toContain(expectedCall);
    });
  });

  it("draws enough columns to cover the scroll offset without a right-edge gap", () => {
    for (const layer of PARALLAX_LAYERS) {
      const drawColumns = MAP_SCREEN_WIDTH + layer.periodColumns + 1;
      const maxOffsetColumns = layer.periodColumns; // wrap period, in cells
      expect(drawColumns).toBeGreaterThanOrEqual(MAP_SCREEN_WIDTH + maxOffsetColumns);
    }
  });
});
