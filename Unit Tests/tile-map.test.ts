/**
 * Map editor model tests. These drive the real TileMap over the real
 * StubCartEngine and assert on observable cell reads, flood-fill behaviour, and
 * screen math — the contract the map editor UI and (later) the WASM-backed
 * engine both depend on.
 */

import { describe, expect, it } from "vitest";
import { StubCartEngine, TileMap } from "@cartbox/editor";

function newMap(): TileMap {
  return new TileMap(new StubCartEngine());
}

describe("TileMap cell editing", () => {
  it("round-trips a stamped cell", () => {
    const map = newMap();
    map.setCell(10, 4, 7);
    expect(map.getCell(10, 4)).toBe(7);
  });

  it("ignores writes outside the map bounds", () => {
    const map = newMap();
    expect(() => map.setCell(map.width, map.height, 5)).not.toThrow();
    expect(map.getCell(map.width, map.height)).toBe(0);
  });

  it("ignores tile indices outside 0..255", () => {
    const map = newMap();
    map.setCell(2, 2, 9);
    map.setCell(2, 2, 256);
    expect(map.getCell(2, 2)).toBe(9);
  });
});

describe("TileMap flood fill", () => {
  it("fills only the contiguous region sharing the start tile", () => {
    const map = newMap();
    // A 4-wide vertical band of tile 3 against a background of tile 0.
    for (let y = 0; y < 6; y += 1) {
      for (let x = 0; x < 4; x += 1) {
        map.setCell(x, y, 3);
      }
    }

    map.fill(0, 0, 8);

    expect(map.getCell(0, 0)).toBe(8); // filled
    expect(map.getCell(3, 5)).toBe(8); // same region, filled
    expect(map.getCell(4, 0)).toBe(0); // outside the band, untouched
  });

  it("is a no-op when the start tile already matches", () => {
    const map = newMap();
    map.setCell(5, 5, 6);
    map.fill(5, 5, 6);
    expect(map.getCell(5, 5)).toBe(6);
  });
});

describe("TileMap screen math", () => {
  it("maps a cell to its 30x17 screen", () => {
    const map = newMap();
    expect(map.screenOf(0, 0)).toEqual([0, 0]);
    expect(map.screenOf(map.screenWidth, map.screenHeight)).toEqual([1, 1]);
    expect(map.screenOf(map.screenWidth - 1, map.screenHeight - 1)).toEqual([0, 0]);
  });
});
