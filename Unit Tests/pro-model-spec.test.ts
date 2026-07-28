/**
 * Pro hardware-spec consistency.
 *
 * The Pro console model is finalised as a 16:9 640x360 display with a larger
 * palette (64) and more audio channels (8). Rather than re-asserting the literals
 * (which would just duplicate the spec), these tests prove the numbers satisfy
 * the *relationships* the pro engine fork depends on: a true 16:9 frame, room to
 * pillarbox a Classic cart at pixel-perfect integer 2x with even margins, a tile
 * grid and sprite sheet that divide cleanly, a preserved tiles-to-screen ratio, a
 * power-of-two palette (integer bit depth), and agreement between the runtime spec
 * (@cartbox/player) and the authoring spec (@cartbox/editor). If a future edit
 * makes the spec internally inconsistent, one of these fails.
 */

import { describe, expect, it } from "vitest";
import { CLASSIC_MODEL, PRO_MODEL, type ConsoleModelSpec } from "@cartbox/editor";
import { MODELS, framebufferBytes } from "@cartbox/player";

const CLASSIC_COMPOSITE_SCALE = 2; // Classic renders inside Pro at integer 2x.

/** log2 that returns null unless the value is an exact power of two. */
function exactLog2(value: number): number | null {
  const bits = Math.log2(value);
  return Number.isInteger(bits) ? bits : null;
}

describe("Pro is a true 16:9 frame", () => {
  it("has a 16:9 width:height ratio", () => {
    expect(PRO_MODEL.width * 9).toBe(PRO_MODEL.height * 16);
  });

  it("scales to 1080p at an exact integer factor", () => {
    expect(1920 % PRO_MODEL.width).toBe(0);
    expect(1080 % PRO_MODEL.height).toBe(0);
    expect(1920 / PRO_MODEL.width).toBe(1080 / PRO_MODEL.height);
  });
});

describe("Pro can pillarbox a Classic cart at pixel-perfect integer 2x", () => {
  const classicWidthAt2x = CLASSIC_MODEL.width * CLASSIC_COMPOSITE_SCALE;
  const classicHeightAt2x = CLASSIC_MODEL.height * CLASSIC_COMPOSITE_SCALE;

  it("is large enough to contain Classic's 2x render", () => {
    expect(PRO_MODEL.width).toBeGreaterThanOrEqual(classicWidthAt2x);
    expect(PRO_MODEL.height).toBeGreaterThanOrEqual(classicHeightAt2x);
  });

  it("leaves even margins on both axes (so the border is symmetric)", () => {
    expect((PRO_MODEL.width - classicWidthAt2x) % 2).toBe(0);
    expect((PRO_MODEL.height - classicHeightAt2x) % 2).toBe(0);
  });

  it("keeps the 8px tile size shared with Classic", () => {
    expect(PRO_MODEL.tileSize).toBe(CLASSIC_MODEL.tileSize);
  });
});

describe("each raster model's grid divides cleanly", () => {
  const models: ConsoleModelSpec[] = [CLASSIC_MODEL, PRO_MODEL];

  it.each(models)("$id: screen size is the pixel size over the tile grid", (model) => {
    expect(model.width % model.tileSize).toBe(0);
    expect(model.height % model.tileSize).toBe(0);
    expect(model.screenWidth).toBe(model.width / model.tileSize);
    expect(model.screenHeight).toBe(model.height / model.tileSize);
  });

  it.each(models)("$id: map spans a whole number of screen-grids", (model) => {
    // TIC-80's map rows/cols equal the tile size, so map cells = screen cells x tileSize.
    expect(model.mapWidth).toBe(model.screenWidth * model.tileSize);
    expect(model.mapHeight).toBe(model.screenHeight * model.tileSize);
  });

  it.each(models)("$id: the sprite sheet is square", (model) => {
    expect(model.tilesPerPage).toBe(model.sheetCols * model.sheetCols);
  });
});

describe("Pro shares Classic's sprite-sheet geometry (8bpp tiles, same layout)", () => {
  // The built pro engine reuses Classic's 128px / 16-col / 256-tile-per-page sheet;
  // only the per-pixel depth grew (8bpp -> 256 colors). Enlarging the tile *count*
  // is a deferred, power-of-2-constrained change (TIC_BANK_SPRITES), so the specs
  // match here rather than claiming capacity the engine does not store.
  it("uses the same sheet columns and tiles-per-page as Classic", () => {
    expect(PRO_MODEL.sheetCols).toBe(CLASSIC_MODEL.sheetCols);
    expect(PRO_MODEL.tilesPerPage).toBe(CLASSIC_MODEL.tilesPerPage);
    expect(PRO_MODEL.spritePages).toBe(CLASSIC_MODEL.spritePages);
  });
});

describe("palettes have integer bit depth and Pro out-colours Classic", () => {
  it("Classic is 16 colours = 4bpp", () => {
    expect(exactLog2(CLASSIC_MODEL.paletteSize)).toBe(4);
  });

  it("Pro is 64 colours = 6bpp (a power of two, so the core packs indices cleanly)", () => {
    expect(exactLog2(PRO_MODEL.paletteSize)).toBe(6);
    expect(PRO_MODEL.paletteSize).toBeGreaterThan(CLASSIC_MODEL.paletteSize);
  });
});

describe("runtime spec (@cartbox/player) and authoring spec (@cartbox/editor) agree", () => {
  const shared: Array<[string, ConsoleModelSpec, { width: number; height: number; paletteSize: number }]> = [
    ["classic", CLASSIC_MODEL, MODELS.classic],
    ["pro", PRO_MODEL, MODELS.pro],
  ];

  it.each(shared)("%s: width/height/paletteSize match across packages", (_id, editorSpec, runtimeSpec) => {
    expect(runtimeSpec.width).toBe(editorSpec.width);
    expect(runtimeSpec.height).toBe(editorSpec.height);
    expect(runtimeSpec.paletteSize).toBe(editorSpec.paletteSize);
  });

  it("Pro's display framebuffer is RGBA-sized and larger than Classic's", () => {
    // The display buffer is always RGBA (pixelBytes=4) regardless of palette depth.
    expect(framebufferBytes(MODELS.pro)).toBe(MODELS.pro.width * MODELS.pro.height * 4);
    expect(framebufferBytes(MODELS.pro)).toBeGreaterThan(framebufferBytes(MODELS.classic));
  });
});
