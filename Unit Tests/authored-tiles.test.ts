/**
 * Authored-tile tests — the hand-drawn pixel-art tiles and the string-art helper
 * that builds them. They prove every tile in the library is a well-formed square
 * FaceTexture (so a mis-typed row fails here, not silently at render), that the
 * helper rejects ragged art and unknown palette keys, and that the emissive
 * channel only appears when a tile actually glows.
 */

import { describe, expect, it } from "vitest";
import { AUTHORED_TILES } from "../apps/web/src/lib/authoredTiles";
import { tileFromArt } from "../apps/web/src/lib/tileArt";

describe("authored tile library", () => {
  const entries = Object.entries(AUTHORED_TILES);

  it("has tiles", () => {
    expect(entries.length).toBeGreaterThan(0);
  });

  it.each(entries)("%s is a square tile with a full RGBA buffer", (_name, tile) => {
    expect(tile.size).toBeGreaterThan(0);
    expect(tile.data.length).toBe(tile.size * tile.size * 4);
    // Every texel is opaque (the terrain/block tiles have no holes).
    for (let i = 0; i < tile.size * tile.size; i += 1) {
      expect(tile.data[i * 4 + 3]).toBeGreaterThan(0);
    }
  });

  it("all tiles share one edge length (so they atlas together)", () => {
    const sizes = new Set(entries.map(([, tile]) => tile.size));
    expect(sizes.size).toBe(1);
  });

  it("marks the console tiles emissive and the terrain tiles not", () => {
    expect(AUTHORED_TILES.screen.emissive).toBeDefined();
    expect(AUTHORED_TILES.crystal.emissive).toBeDefined();
    expect(AUTHORED_TILES.monolith.emissive).toBeDefined();
    expect(AUTHORED_TILES.grassTop.emissive).toBeUndefined();
    expect(AUTHORED_TILES.dirt.emissive).toBeUndefined();
  });
});

describe("tileFromArt", () => {
  const palette = { a: { r: 10, g: 20, b: 30 }, b: { r: 200, g: 100, b: 50, e: 128 } };

  it("paints each character to its palette colour", () => {
    const tile = tileFromArt(["ab", "ba"], palette);
    expect(tile.size).toBe(2);
    expect([tile.data[0], tile.data[1], tile.data[2]]).toEqual([10, 20, 30]); // 'a'
    expect([tile.data[4], tile.data[5], tile.data[6]]).toEqual([200, 100, 50]); // 'b'
    expect(tile.emissive).toBeDefined();
    expect(tile.emissive![1]).toBe(128); // 'b' glows
  });

  it("rejects a row of the wrong width", () => {
    expect(() => tileFromArt(["ab", "b"], palette)).toThrow(/square/);
  });

  it("rejects a character missing from the palette", () => {
    expect(() => tileFromArt(["az", "ba"], palette)).toThrow(/palette/);
  });
});
