/**
 * Scene-tab authoring tests. The Scene tab builds a parallax backdrop out of two
 * pure pieces: immutable reducers that transform a SceneSpec, and a region source
 * that reads the editor's live sprite sheet the way the runtime reads a loaded
 * cart. These tests exercise both against real inputs and outputs — a real
 * SpriteSheet over the in-memory engine, and real specs — asserting the contract
 * the preview and the save path depend on:
 *   - reducers clamp to the ranges the runtime parser accepts, so what previews
 *     is what reloads; clearing the last layer yields no scene, not an empty one
 *   - the region source tiles regions correctly and keys palette index 0 to
 *     transparent, so far layers and the sky show through background pixels
 */

import { describe, expect, it } from "vitest";
import { StubCartEngine, SpriteSheet } from "@cartbox/editor";

import {
  MAX_SCENE_LAYERS,
  emptyScene,
  withLayerAdded,
  withLayerRemoved,
  withLayerUpdated,
  withLayerSource,
  withLayerMoved,
  withAtmosphere,
  withCamera,
  withKeyColor,
} from "../apps/web/src/app/edit/[cartId]/sceneAuthoring";
import { createEditorRegionSource } from "../apps/web/src/app/edit/[cartId]/sceneRegionSource";

/** Paint every pixel of one tile a single palette index. */
function paintTile(sheet: SpriteSheet, page: 0 | 1, tile: number, colorIndex: number): void {
  for (let y = 0; y < sheet.tileSize; y += 1) {
    for (let x = 0; x < sheet.tileSize; x += 1) {
      sheet.setPixel(page, tile, x, y, colorIndex);
    }
  }
}

/** Straight-alpha RGBA at (x, y) of a resolved region image. */
function pixelAt(image: { pixels: Uint8ClampedArray; width: number }, x: number, y: number): [number, number, number, number] {
  const at = (y * image.width + x) * 4;
  return [image.pixels[at]!, image.pixels[at + 1]!, image.pixels[at + 2]!, image.pixels[at + 3]!];
}

describe("scene reducers", () => {
  it("creates a scene from nothing when the first layer is added", () => {
    const scene = withLayerAdded(null);
    expect(scene.layers).toHaveLength(1);
    expect(scene.layers[0]!.source.tilesW).toBeGreaterThan(0);
  });

  it("refuses to add beyond the runtime's layer cap", () => {
    let scene = withLayerAdded(null);
    for (let i = 1; i < MAX_SCENE_LAYERS + 3; i += 1) scene = withLayerAdded(scene);
    expect(scene.layers).toHaveLength(MAX_SCENE_LAYERS);
  });

  it("returns no scene when the final layer is removed", () => {
    const scene = withLayerAdded(null);
    expect(withLayerRemoved(scene, 0)).toBeNull();
  });

  it("keeps the other layers when a middle layer is removed", () => {
    const scene = withLayerAdded(withLayerAdded(withLayerAdded(null)));
    const marked = withLayerUpdated(scene, 2, { offsetY: 17 });
    const after = withLayerRemoved(marked, 0);
    expect(after?.layers).toHaveLength(2);
    expect(after?.layers[1]!.offsetY).toBe(17);
  });

  it("clamps a layer's depth and out-of-range parallax on update", () => {
    const scene = withLayerAdded(null);
    const updated = withLayerUpdated(scene, 0, { depth: 9, parallax: 99 });
    expect(updated.layers[0]!.depth).toBe(1);
    expect(updated.layers[0]!.parallax).toBe(4);
  });

  it("clamps a layer's sprite region to a real tile range", () => {
    const scene = withLayerAdded(null);
    const updated = withLayerSource(scene, 0, { tile: 999, tilesW: 100 });
    expect(updated.layers[0]!.source.tile).toBeLessThanOrEqual(255);
    expect(updated.layers[0]!.source.tilesW).toBeLessThanOrEqual(32);
    expect(updated.layers[0]!.source.tilesW).toBeGreaterThanOrEqual(1);
  });

  it("clamps atmosphere strengths to 0..1 and fog channels to 0..255", () => {
    const scene = withAtmosphere(emptyScene(), { density: 5, desaturate: -1, fog: [300, -5, 128] });
    expect(scene.atmosphere.density).toBe(1);
    expect(scene.atmosphere.desaturate).toBe(0);
    expect(scene.atmosphere.fog).toEqual([255, 0, 128]);
  });

  it("reorders layers without dropping any", () => {
    let scene = withLayerAdded(withLayerAdded(null));
    scene = withLayerUpdated(scene, 0, { offsetY: 1 });
    scene = withLayerUpdated(scene, 1, { offsetY: 2 });
    const moved = withLayerMoved(scene, 0, 1);
    expect(moved.layers.map((l) => l.offsetY)).toEqual([2, 1]);
  });

  it("keeps the scene unchanged when a move would fall off the ends", () => {
    const scene = withLayerAdded(withLayerAdded(null));
    expect(withLayerMoved(scene, 0, -1)).toEqual(scene);
    expect(withLayerMoved(scene, 1, 1)).toEqual(scene);
  });

  it("clamps the chroma-key index to a real palette entry", () => {
    expect(withKeyColor(emptyScene(), 999).keyColor).toBeLessThanOrEqual(255);
    expect(withCamera(emptyScene(), { autoScrollX: 0.5 }).camera.autoScrollX).toBe(0.5);
  });
});

describe("editor region source", () => {
  it("keys palette index 0 transparent and paints non-background pixels opaque", () => {
    const sheet = new SpriteSheet(new StubCartEngine());
    const opaqueIndex = 4;
    paintTile(sheet, 0, 1, opaqueIndex); // tile 0 stays blank (index 0)

    const source = createEditorRegionSource(sheet);
    const image = source.readRegion(0, 0, 2, 1); // tiles 0 (blank) then 1 (painted)

    expect(image.width).toBe(sheet.tileSize * 2);
    expect(image.height).toBe(sheet.tileSize);

    // Left tile is the transparent background.
    expect(pixelAt(image, 0, 0)[3]).toBe(0);
    // Right tile is opaque and shows the painted colour.
    const [r, g, b, a] = pixelAt(image, sheet.tileSize, 0);
    const expected = sheet.paletteRgb()[opaqueIndex]!;
    expect(a).toBe(255);
    expect([r, g, b]).toEqual([expected[0], expected[1], expected[2]]);
  });

  it("reads a vertical region down the sheet rows", () => {
    const sheet = new SpriteSheet(new StubCartEngine());
    const belowTile = sheet.sheetCols; // one row down from tile 0
    paintTile(sheet, 0, belowTile, 5);

    const source = createEditorRegionSource(sheet);
    const image = source.readRegion(0, 0, 1, 2);

    expect(image.height).toBe(sheet.tileSize * 2);
    expect(pixelAt(image, 0, 0)[3]).toBe(0); // top tile blank
    expect(pixelAt(image, 0, sheet.tileSize)[3]).toBe(255); // bottom tile painted
  });

  it("leaves off-page tiles transparent instead of throwing", () => {
    const sheet = new SpriteSheet(new StubCartEngine());
    const source = createEditorRegionSource(sheet);
    // tile 255 is the last valid tile; the second column would be 256 (off page).
    const image = source.readRegion(0, 255, 2, 1);
    expect(pixelAt(image, sheet.tileSize, 0)[3]).toBe(0);
  });
});
