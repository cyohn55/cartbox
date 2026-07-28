/**
 * Layer coverage: what a sprite block carries on the layers you cannot see.
 *
 * The editor shows one of seven parallel planes at a time, so everything
 * painted on the other six is invisible from wherever you are standing. These
 * functions are what the palette badges, the canvas coverage ticks and the
 * per-pixel readout are all read from, so they are the thing worth pinning down.
 *
 * Driven through the real {@link NormalMap}/{@link MaterialMap} over the real
 * {@link StubCartEngine} and the real block wrapper — the same objects the
 * editor paints through. A fixture surface would prove the loop counts
 * correctly and prove nothing about whether a 2× block reads its whole area,
 * which is exactly where a per-tile assumption would hide.
 */

import { describe, expect, it } from "vitest";
import { MaterialMap, NormalMap, SpriteSheet, StubCartEngine } from "@cartbox/editor";

import {
  measureCoverage,
  pixelKey,
  sampleChannels,
  valueUsage,
} from "../apps/web/src/app/edit/[cartId]/layerCoverage";
import {
  MaterialSurface,
  NormalSurface,
} from "../apps/web/src/app/edit/[cartId]/paintSurface";
import { SpriteBlockSurface } from "../apps/web/src/app/edit/[cartId]/spriteBlockSurface";

/** The five probed layers over one fresh cart, exactly as the editor builds them. */
function newChannels() {
  const engine = new StubCartEngine();
  const sheet = new SpriteSheet(engine);
  const normals = new NormalSurface(new NormalMap(engine), sheet.tileSize);
  const height = new MaterialSurface(new MaterialMap(engine, "height"), sheet.tileSize);
  const specular = new MaterialSurface(new MaterialMap(engine, "specular"), sheet.tileSize);
  const roughness = new MaterialSurface(new MaterialMap(engine, "roughness"), sheet.tileSize);
  const emissive = new MaterialSurface(new MaterialMap(engine, "emissive"), sheet.tileSize);
  return {
    sheet,
    surfaces: { normal: normals, height, specular, roughness, emissive },
    channels: [
      { id: "normal" as const, surface: normals },
      { id: "height" as const, surface: height },
      { id: "specular" as const, surface: specular },
      { id: "roughness" as const, surface: roughness },
      { id: "emissive" as const, surface: emissive },
    ],
  };
}

describe("measureCoverage", () => {
  it("reports nothing on a block where no layer has been painted", () => {
    const { sheet, channels } = newChannels();
    const coverage = measureCoverage(channels, 0, 4, sheet.tileSize);

    expect(coverage.channels).toEqual([]);
    expect(coverage.pixels.size).toBe(0);
    expect(coverage.counts.height).toBe(0);
  });

  it("names only the layers that carry data, and counts each one's pixels", () => {
    const { sheet, surfaces, channels } = newChannels();
    surfaces.height.setPixel(0, 4, 1, 1, 9);
    surfaces.height.setPixel(0, 4, 2, 1, 9);
    surfaces.emissive.setPixel(0, 4, 5, 5, 3);

    const coverage = measureCoverage(channels, 0, 4, sheet.tileSize);

    expect(coverage.channels).toEqual(["height", "emissive"]);
    expect(coverage.counts.height).toBe(2);
    expect(coverage.counts.emissive).toBe(1);
    expect(coverage.counts.normal).toBe(0);
  });

  it("unions the painted pixels across layers, counting a shared pixel once", () => {
    const { sheet, surfaces, channels } = newChannels();
    surfaces.height.setPixel(0, 4, 3, 2, 7);
    surfaces.specular.setPixel(0, 4, 3, 2, 5); // the same pixel, a second layer
    surfaces.normal.setPixel(0, 4, 6, 6, 4);

    const coverage = measureCoverage(channels, 0, 4, sheet.tileSize);

    expect(coverage.pixels.size).toBe(2);
    expect(coverage.pixels.has(pixelKey(3, 2, sheet.tileSize))).toBe(true);
    expect(coverage.pixels.has(pixelKey(6, 6, sheet.tileSize))).toBe(true);
    expect(coverage.counts.height).toBe(1);
    expect(coverage.counts.specular).toBe(1);
  });

  it("treats a painted-then-cleared pixel as unpainted", () => {
    const { sheet, surfaces, channels } = newChannels();
    surfaces.height.setPixel(0, 4, 1, 1, 9);
    surfaces.height.setPixel(0, 4, 1, 1, 0);

    const coverage = measureCoverage(channels, 0, 4, sheet.tileSize);
    expect(coverage.channels).toEqual([]);
  });

  it("reads the whole area of a multi-tile block, not just its first tile", () => {
    // The bug this guards: a 2× sprite is four adjacent tiles, and probing the
    // base surface would silently ignore three quarters of the artist's work.
    const { sheet, surfaces } = newChannels();
    const blockTiles = 2;
    const blockSize = sheet.tileSize * blockTiles;
    const blockHeight = new SpriteBlockSurface(surfaces.height, sheet.sheetCols, blockTiles);

    // A pixel in the block's bottom-right quadrant — outside the first tile.
    const x = sheet.tileSize + 3;
    const y = sheet.tileSize + 5;
    blockHeight.setPixel(0, 0, x, y, 11);

    const viaBlock = measureCoverage([{ id: "height" as const, surface: blockHeight }], 0, 0, blockSize);
    expect(viaBlock.counts.height).toBe(1);
    expect(viaBlock.pixels.has(pixelKey(x, y, blockSize))).toBe(true);

    // The same measurement against the base tile finds nothing, which is what
    // makes the block wrapper load-bearing rather than decorative.
    const viaTile = measureCoverage([{ id: "height" as const, surface: surfaces.height }], 0, 0, sheet.tileSize);
    expect(viaTile.counts.height).toBe(0);
  });

  it("honours a channel whose resting value is not zero", () => {
    const { sheet, surfaces } = newChannels();
    surfaces.height.setPixel(0, 4, 0, 0, 5);

    // With 5 declared as this channel's empty value, the painted pixel reads as
    // unpainted and every untouched pixel reads as painted.
    const coverage = measureCoverage(
      [{ id: "height" as const, surface: surfaces.height, empty: 5 }],
      0,
      4,
      sheet.tileSize,
    );
    expect(coverage.counts.height).toBe(sheet.tileSize * sheet.tileSize - 1);
    expect(coverage.pixels.has(pixelKey(0, 0, sheet.tileSize))).toBe(false);
  });
});

describe("sampleChannels", () => {
  it("returns every channel's value at one pixel, including the empty ones", () => {
    const { surfaces, channels } = newChannels();
    surfaces.normal.setPixel(0, 2, 4, 4, 6);
    surfaces.emissive.setPixel(0, 2, 4, 4, 12);

    const sample = sampleChannels(channels, 0, 2, 4, 4);

    expect(sample).toEqual({ normal: 6, height: 0, specular: 0, roughness: 0, emissive: 12 });
  });

  it("reads the pixel asked for, not a neighbour", () => {
    const { surfaces, channels } = newChannels();
    surfaces.height.setPixel(0, 2, 4, 4, 9);

    expect(sampleChannels(channels, 0, 2, 4, 4).height).toBe(9);
    expect(sampleChannels(channels, 0, 2, 5, 4).height).toBe(0);
    expect(sampleChannels(channels, 0, 2, 4, 5).height).toBe(0);
  });
});

/** Blank one tile of page 0 — the seeded cart opens with art on it. */
function clearTile(sheet: SpriteSheet, tile: number): void {
  for (let y = 0; y < sheet.tileSize; y += 1) {
    for (let x = 0; x < sheet.tileSize; x += 1) sheet.setPixel(0, tile, x, y, 0);
  }
}

describe("valueUsage", () => {
  it("counts a fresh block as entirely colour 0", () => {
    const engine = new StubCartEngine();
    const sheet = new SpriteSheet(engine);
    clearTile(sheet, 3);

    const usage = valueUsage(sheet, 0, 3, sheet.tileSize);

    expect(usage.get(0)).toBe(sheet.tileSize * sheet.tileSize);
    expect(usage.size).toBe(1);
  });

  it("counts each colour the block uses, and omits the ones it does not", () => {
    const engine = new StubCartEngine();
    const sheet = new SpriteSheet(engine);
    clearTile(sheet, 3);
    sheet.setPixel(0, 3, 0, 0, 7);
    sheet.setPixel(0, 3, 1, 0, 7);
    sheet.setPixel(0, 3, 2, 0, 4);

    const usage = valueUsage(sheet, 0, 3, sheet.tileSize);

    expect(usage.get(7)).toBe(2);
    expect(usage.get(4)).toBe(1);
    expect(usage.get(9)).toBeUndefined();
    // Everything not painted is still colour 0.
    expect(usage.get(0)).toBe(sheet.tileSize * sheet.tileSize - 3);
  });

  it("counts across a multi-tile block", () => {
    const engine = new StubCartEngine();
    const sheet = new SpriteSheet(engine);
    const blockTiles = 2;
    const blockSize = sheet.tileSize * blockTiles;
    const block = new SpriteBlockSurface(sheet, sheet.sheetCols, blockTiles);
    for (let y = 0; y < blockSize; y += 1) {
      for (let x = 0; x < blockSize; x += 1) block.setPixel(0, 0, x, y, 0);
    }
    block.setPixel(0, 0, blockSize - 1, blockSize - 1, 5);

    const usage = valueUsage(block, 0, 0, blockSize);

    expect(usage.get(5)).toBe(1);
    expect(usage.get(0)).toBe(blockSize * blockSize - 1);
  });
});
