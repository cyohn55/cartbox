/**
 * Sprite-as-material tests — turning a sprite drawn in the editor's Sprites tab
 * into a face tile a voxel can wear.
 *
 * They drive the real {@link spriteFaceTexture} / {@link buildSpriteMaterialAtlas}
 * against a real sprite source (a small indexed sheet holding actual pixels and a
 * real palette, satisfying the same interface the editor's `SpriteSheet` does) and
 * assert on the produced pixels and on what the renderer's own
 * {@link faceTile} resolves for each face — the contract the preview relies on.
 * No DOM, no canvas, no mocks.
 */

import { describe, expect, it } from "vitest";

import { buildWorldAtlas } from "../apps/web/src/lib/faceTextures";
import {
  buildSpriteMaterialAtlas,
  firstSpriteMaterialIndex,
  isBlankSprite,
  spriteFaceTexture,
  uniformSpriteMaterial,
  isSpriteRef,
  TRANSPARENT_COLOR_INDEX,
  type SpritePixelSource,
} from "../apps/web/src/lib/spriteTiles";
import { faceTile, type SpritePage } from "@cartbox/editor";

const TILE_SIZE = 8;

/** The palette these sprites are drawn in: transparent, then three flat colours. */
const PALETTE: ReadonlyArray<readonly [number, number, number]> = [
  [0, 0, 0], // 0 — the transparent index
  [200, 40, 40], // 1 — red
  [40, 180, 90], // 2 — green
  [60, 90, 220], // 3 — blue
];

/**
 * A real indexed sprite sheet: two pages of `TILE_SIZE` squares backed by actual
 * pixel data, addressed exactly as the editor's sheet is.
 */
class TestSpriteSheet implements SpritePixelSource {
  readonly tileSize = TILE_SIZE;
  private readonly pages: Uint8Array[];

  constructor(readonly tilesPerPage: number) {
    this.pages = [
      new Uint8Array(tilesPerPage * TILE_SIZE * TILE_SIZE),
      new Uint8Array(tilesPerPage * TILE_SIZE * TILE_SIZE),
    ];
  }

  /** Paint a whole sprite one colour index. */
  fillTile(page: SpritePage, tile: number, colorIndex: number): void {
    const base = tile * TILE_SIZE * TILE_SIZE;
    this.pages[page]!.fill(colorIndex, base, base + TILE_SIZE * TILE_SIZE);
  }

  setPixel(page: SpritePage, tile: number, x: number, y: number, colorIndex: number): void {
    this.pages[page]![tile * TILE_SIZE * TILE_SIZE + y * TILE_SIZE + x] = colorIndex;
  }

  getPixel(page: SpritePage, tile: number, x: number, y: number): number {
    return this.pages[page]![tile * TILE_SIZE * TILE_SIZE + y * TILE_SIZE + x] ?? 0;
  }

  paletteRgb(): ReadonlyArray<readonly [number, number, number]> {
    return PALETTE;
  }
}

/** The RGBA of a texel in a face texture. */
function texel(texture: { size: number; data: Uint8ClampedArray }, x: number, y: number): number[] {
  const base = (y * texture.size + x) * 4;
  return [texture.data[base]!, texture.data[base + 1]!, texture.data[base + 2]!, texture.data[base + 3]!];
}

function sheetWithSprites(): TestSpriteSheet {
  const sheet = new TestSpriteSheet(16);
  sheet.fillTile(0, 1, 1); // sprite 1: solid red
  sheet.fillTile(0, 2, 2); // sprite 2: solid green
  sheet.fillTile(1, 3, 3); // page 1, sprite 3: solid blue
  return sheet;
}

describe("spriteFaceTexture", () => {
  it("resolves a sprite's indices through the cart palette", () => {
    const sheet = sheetWithSprites();
    const texture = spriteFaceTexture(sheet, { page: 0, tile: 1 });
    expect(texture.size).toBe(TILE_SIZE);
    expect(texel(texture, 0, 0)).toEqual([200, 40, 40, 255]);
    expect(texel(texture, 7, 7)).toEqual([200, 40, 40, 255]);
  });

  it("leaves the transparent index fully transparent, not black", () => {
    const sheet = sheetWithSprites();
    sheet.setPixel(0, 1, 3, 4, TRANSPARENT_COLOR_INDEX); // punch a hole
    const texture = spriteFaceTexture(sheet, { page: 0, tile: 1 });
    expect(texel(texture, 3, 4)).toEqual([0, 0, 0, 0]);
    expect(texel(texture, 3, 5)[3]).toBe(255); // its neighbour is untouched
  });

  it("reads the page it is given", () => {
    const sheet = sheetWithSprites();
    expect(texel(spriteFaceTexture(sheet, { page: 1, tile: 3 }), 0, 0)).toEqual([60, 90, 220, 255]);
    expect(texel(spriteFaceTexture(sheet, { page: 0, tile: 3 }), 0, 0)).toEqual([0, 0, 0, 0]); // undrawn
  });

  it("reports whether a sprite has anything drawn in it", () => {
    const sheet = sheetWithSprites();
    expect(isBlankSprite(sheet, { page: 0, tile: 1 })).toBe(false);
    expect(isBlankSprite(sheet, { page: 0, tile: 5 })).toBe(true); // never drawn
    // A single drawn pixel is enough to make it usable art.
    sheet.setPixel(0, 5, 2, 2, 3);
    expect(isBlankSprite(sheet, { page: 0, tile: 5 })).toBe(false);
    expect(isBlankSprite(sheet, { page: 0, tile: -4 })).toBe(true); // not a slot at all
  });

  it("rejects an address that is not a sheet slot", () => {
    const sheet = sheetWithSprites();
    expect(() => spriteFaceTexture(sheet, { page: 0, tile: -1 })).toThrow();
    expect(isSpriteRef({ page: 0, tile: 2 })).toBe(true);
    expect(isSpriteRef({ page: 2, tile: 2 })).toBe(false);
    expect(isSpriteRef({ page: 0, tile: 1.5 })).toBe(false);
    expect(isSpriteRef(null)).toBe(false);
  });
});

describe("buildSpriteMaterialAtlas", () => {
  const base = buildWorldAtlas();

  it("appends materials after the base's own, leaving its indices alone", () => {
    const sheet = sheetWithSprites();
    const first = firstSpriteMaterialIndex(base);
    expect(first).toBe(base.materials!.length);

    const atlas = buildSpriteMaterialAtlas(base, [uniformSpriteMaterial("red", { page: 0, tile: 1 })], sheet);
    expect(atlas.materials!.length).toBe(first + 1);
    // Every base material still maps to the same tiles it did before.
    for (let index = 0; index < first; index += 1) {
      expect(atlas.materials![index]).toEqual(base.materials![index]);
    }
    expect(atlas.tiles.slice(0, base.tiles.length)).toEqual(base.tiles);
  });

  it("skins all six faces of a uniform material with the one sprite", () => {
    const sheet = sheetWithSprites();
    const atlas = buildSpriteMaterialAtlas(base, [uniformSpriteMaterial("red", { page: 0, tile: 1 })], sheet);
    const index = firstSpriteMaterialIndex(base);

    for (const normalY of [1, 0, -1]) {
      const tile = faceTile(atlas, index, normalY)!;
      expect(texel(tile, 0, 0)).toEqual([200, 40, 40, 255]);
    }
  });

  it("gives a per-face material the right sprite on each face group", () => {
    const sheet = sheetWithSprites();
    const atlas = buildSpriteMaterialAtlas(
      base,
      [{ name: "mixed", top: { page: 0, tile: 2 }, side: { page: 0, tile: 1 }, bottom: { page: 1, tile: 3 } }],
      sheet,
    );
    const index = firstSpriteMaterialIndex(base);

    expect(texel(faceTile(atlas, index, 1)!, 0, 0)).toEqual([40, 180, 90, 255]); // top: green
    expect(texel(faceTile(atlas, index, 0)!, 0, 0)).toEqual([200, 40, 40, 255]); // side: red
    expect(texel(faceTile(atlas, index, -1)!, 0, 0)).toEqual([60, 90, 220, 255]); // bottom: blue
  });

  it("shares one tile slot between faces and materials naming the same sprite", () => {
    const sheet = sheetWithSprites();
    const red = { page: 0, tile: 1 } as const;
    const atlas = buildSpriteMaterialAtlas(
      base,
      [uniformSpriteMaterial("red", red), uniformSpriteMaterial("red again", red)],
      sheet,
    );
    // Two materials, three faces each, but only one new tile: the sprite is read once.
    expect(atlas.tiles.length).toBe(base.tiles.length + 1);
    const first = firstSpriteMaterialIndex(base);
    expect(atlas.materials![first]).toEqual(atlas.materials![first + 1]);
  });

  it("indexes materials in list order, so the nth sits at first + n", () => {
    const sheet = sheetWithSprites();
    const atlas = buildSpriteMaterialAtlas(
      base,
      [uniformSpriteMaterial("red", { page: 0, tile: 1 }), uniformSpriteMaterial("green", { page: 0, tile: 2 })],
      sheet,
    );
    const first = firstSpriteMaterialIndex(base);
    expect(texel(faceTile(atlas, first, 0)!, 0, 0)).toEqual([200, 40, 40, 255]);
    expect(texel(faceTile(atlas, first + 1, 0)!, 0, 0)).toEqual([40, 180, 90, 255]);
  });

  it("returns the base unchanged when no sprite materials are given", () => {
    const sheet = sheetWithSprites();
    const atlas = buildSpriteMaterialAtlas(base, [], sheet);
    expect(atlas.tiles).toEqual(base.tiles);
    expect(atlas.materials).toEqual(base.materials);
  });
});
