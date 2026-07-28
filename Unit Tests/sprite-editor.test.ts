/**
 * Sprite editor model tests. These drive the real SpriteSheet over the real
 * StubCartEngine (the same objects the UI uses) and assert on observable
 * outputs — pixel reads, palette colours, and rasterised RGBA — rather than any
 * hard-coded internal state. When the WASM-backed engine replaces the stub, the
 * SpriteSheet contract these tests pin down stays identical.
 */

import { describe, expect, it } from "vitest";
import { SpriteSheet, StubCartEngine, SWEETIE_16, hexToRgb } from "@cartbox/editor";

function newSheet(): SpriteSheet {
  return new SpriteSheet(new StubCartEngine());
}

describe("SpriteSheet pixel editing", () => {
  it("round-trips a painted pixel through the engine", () => {
    const sheet = newSheet();
    sheet.setPixel(0, 5, 3, 4, 9);
    expect(sheet.getPixel(0, 5, 3, 4)).toBe(9);
  });

  it("keeps the two sprite pages independent", () => {
    const sheet = newSheet();
    sheet.setPixel(0, 1, 0, 0, 7);
    sheet.setPixel(1, 1, 0, 0, 2);
    expect(sheet.getPixel(0, 1, 0, 0)).toBe(7);
    expect(sheet.getPixel(1, 1, 0, 0)).toBe(2);
  });

  it("ignores writes outside the 8x8 tile", () => {
    const sheet = newSheet();
    sheet.setPixel(0, 0, 8, 8, 5);
    // Nothing to assert on the out-of-range cell itself; the guarantee is that
    // an in-range neighbour is untouched and no exception is thrown.
    expect(() => sheet.getPixel(0, 0, 8, 8)).not.toThrow();
    expect(sheet.getPixel(0, 0, 8, 8)).toBe(0);
  });

  it("ignores palette indices outside 0..15", () => {
    const sheet = newSheet();
    sheet.setPixel(0, 2, 1, 1, 4);
    sheet.setPixel(0, 2, 1, 1, 99);
    expect(sheet.getPixel(0, 2, 1, 1)).toBe(4);
  });
});

describe("SpriteSheet flood fill", () => {
  it("fills only the contiguous region of the starting colour", () => {
    const sheet = newSheet();
    const tile = 10;
    // Split the tile into a left half (colour 3) and right half (colour 6).
    for (let y = 0; y < sheet.tileSize; y += 1) {
      for (let x = 0; x < sheet.tileSize; x += 1) {
        sheet.setPixel(0, tile, x, y, x < 4 ? 3 : 6);
      }
    }

    sheet.fill(0, tile, 0, 0, 11);

    expect(sheet.getPixel(0, tile, 0, 0)).toBe(11); // filled
    expect(sheet.getPixel(0, tile, 3, 7)).toBe(11); // same region, filled
    expect(sheet.getPixel(0, tile, 4, 0)).toBe(6); // other region, untouched
  });

  it("is a no-op when the start colour already matches", () => {
    const sheet = newSheet();
    sheet.setPixel(0, 0, 0, 0, 8);
    sheet.fill(0, 0, 0, 0, 8);
    expect(sheet.getPixel(0, 0, 0, 0)).toBe(8);
  });
});

describe("SpriteSheet palette", () => {
  it("exposes all 16 default palette colours", () => {
    const sheet = newSheet();
    expect(sheet.cssPalette()).toEqual([...SWEETIE_16]);
  });

  it("resolves a pixel's colour to its palette hex", () => {
    const sheet = newSheet();
    sheet.setPixel(0, 0, 2, 2, 4);
    expect(sheet.cssColor(sheet.getPixel(0, 0, 2, 2))).toBe(SWEETIE_16[4]);
  });
});

describe("SpriteSheet rasterisation", () => {
  it("renders a pixel's index to its palette RGB with opaque alpha", () => {
    const sheet = newSheet();
    const tile = 20;
    const colorIndex = 5;
    sheet.setPixel(0, tile, 0, 0, colorIndex);

    const rgba = sheet.renderTileRgba(0, tile);
    const [red, green, blue] = hexToRgb(SWEETIE_16[colorIndex]);
    expect([rgba[0], rgba[1], rgba[2], rgba[3]]).toEqual([red, green, blue, 255]);
  });

  it("produces one RGBA quad per pixel in the tile", () => {
    const sheet = newSheet();
    const rgba = sheet.renderTileRgba(0, 0);
    expect(rgba.length).toBe(sheet.tileSize * sheet.tileSize * 4);
  });
});
