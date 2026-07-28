/**
 * PNG import/export tests. They drive the pure SpriteSheet quantiser and
 * image slicing over the real StubCartEngine (which seeds the Sweetie-16
 * palette) — the same logic the editor's canvas import calls, minus the DOM.
 */

import { describe, expect, it } from "vitest";
import { SpriteSheet, StubCartEngine, SWEETIE_16, hexToRgb, type SheetImage } from "@cartbox/editor";

function newSheet(): SpriteSheet {
  return new SpriteSheet(new StubCartEngine());
}

/** Build a solid-colour RGBA image of the given size. */
function solidImage(size: number, [r, g, b]: [number, number, number]): SheetImage {
  const data = new Uint8ClampedArray(size * size * 4);
  for (let pixel = 0; pixel < size * size; pixel += 1) {
    data[pixel * 4] = r;
    data[pixel * 4 + 1] = g;
    data[pixel * 4 + 2] = b;
    data[pixel * 4 + 3] = 255;
  }
  return { data, width: size, height: size };
}

describe("SpriteSheet.nearestColorIndex", () => {
  it("matches an exact palette colour to its own index", () => {
    const sheet = newSheet();
    const [r, g, b] = hexToRgb(SWEETIE_16[5]);
    expect(sheet.nearestColorIndex(r, g, b)).toBe(5);
  });

  it("snaps a near colour to the closest palette entry", () => {
    const sheet = newSheet();
    const [r, g, b] = hexToRgb(SWEETIE_16[2]);
    expect(sheet.nearestColorIndex(r + 3, g - 2, b + 1)).toBe(2);
  });
});

describe("SpriteSheet.importImage", () => {
  it("fills a tile with the quantised colour", () => {
    const sheet = newSheet();
    sheet.importImage(solidImage(8, hexToRgb(SWEETIE_16[6])), 0);
    expect(sheet.getPixel(0, 0, 3, 4)).toBe(6);
  });

  it("slices a multi-tile image into the correct tiles", () => {
    const sheet = newSheet();
    // 16x16 image: a single colour spanning tiles 0, 1, sheetCols, sheetCols+1.
    sheet.importImage(solidImage(16, hexToRgb(SWEETIE_16[9])), 0);
    expect(sheet.getPixel(0, 0, 0, 0)).toBe(9);
    expect(sheet.getPixel(0, 1, 0, 0)).toBe(9); // second tile across
    expect(sheet.getPixel(0, sheet.sheetCols, 0, 0)).toBe(9); // second tile down
  });

  it("maps transparent pixels to colour 0", () => {
    const sheet = newSheet();
    const image = solidImage(8, [255, 255, 255]);
    for (let pixel = 0; pixel < 8 * 8; pixel += 1) image.data[pixel * 4 + 3] = 0;
    sheet.importImage(image, 0);
    expect(sheet.getPixel(0, 0, 2, 2)).toBe(0);
  });
});

describe("SpriteSheet.exportImage", () => {
  it("round-trips a painted pixel back to its palette colour", () => {
    const sheet = newSheet();
    sheet.setPixel(0, 0, 1, 1, 4);
    const image = sheet.exportImage(0);
    const base = (1 * image.width + 1) * 4;
    const [r, g, b] = hexToRgb(SWEETIE_16[4]);
    expect([image.data[base], image.data[base + 1], image.data[base + 2], image.data[base + 3]]).toEqual([r, g, b, 255]);
  });

  it("produces a full sheet-sized image", () => {
    const sheet = newSheet();
    const image = sheet.exportImage(0);
    expect(image.width).toBe(sheet.sheetSize);
    expect(image.data.length).toBe(sheet.sheetSize * sheet.sheetSize * 4);
  });
});
