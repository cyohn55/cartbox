/**
 * Model-awareness tests. The editor models take their dimensions from the
 * engine's console model rather than hardwired constants; these confirm the
 * classic engine reports the classic spec and that SpriteSheet/TileMap follow
 * it. When a higher-resolution engine returns a different spec, the same models
 * pick up the new sizes with no further change.
 */

import { describe, expect, it } from "vitest";
import {
  CLASSIC_MODEL,
  CONSOLE_MODELS,
  SpriteSheet,
  StubCartEngine,
  TileMap,
} from "@cartbox/editor";

describe("console model registry", () => {
  it("describes classic exactly", () => {
    expect(CLASSIC_MODEL).toMatchObject({
      id: "classic",
      width: 240,
      height: 136,
      tileSize: 8,
      paletteSize: 16,
      tilesPerPage: 256,
      sheetCols: 16,
      mapWidth: 240,
      mapHeight: 136,
      screenWidth: 30,
      screenHeight: 17,
    });
  });

  it("registers classic, pro, and voxel", () => {
    expect(Object.keys(CONSOLE_MODELS).sort()).toEqual(["classic", "pro", "voxel"]);
    expect(CONSOLE_MODELS.pro.paletteSize).toBeGreaterThan(CLASSIC_MODEL.paletteSize);
  });
});

describe("editor models follow the engine's console model", () => {
  const engine = new StubCartEngine();

  it("reports the classic model", () => {
    expect(engine.model().id).toBe("classic");
  });

  it("sizes the sprite sheet from the model", () => {
    const sheet = new SpriteSheet(engine);
    expect(sheet.tileSize).toBe(CLASSIC_MODEL.tileSize);
    expect(sheet.paletteSize).toBe(CLASSIC_MODEL.paletteSize);
    expect(sheet.tilesPerPage).toBe(CLASSIC_MODEL.tilesPerPage);
    expect(sheet.sheetCols).toBe(CLASSIC_MODEL.sheetCols);
    expect(sheet.sheetSize).toBe(CLASSIC_MODEL.sheetCols * CLASSIC_MODEL.tileSize);
  });

  it("sizes the map from the model", () => {
    const map = new TileMap(engine);
    expect(map.width).toBe(CLASSIC_MODEL.mapWidth);
    expect(map.height).toBe(CLASSIC_MODEL.mapHeight);
    expect(map.screenWidth).toBe(CLASSIC_MODEL.screenWidth);
    expect(map.screenHeight).toBe(CLASSIC_MODEL.screenHeight);
  });
});
