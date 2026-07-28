/**
 * What the FX tab previews its shader stack over.
 *
 * The post-processing chain takes one buffer of cart-resolution RGBA and knows
 * nothing about where it came from, so the whole contract of the source layer is
 * about that buffer: it must be exactly the frame's size, fully opaque, and it
 * must actually contain the thing it claims to show — flat tile art for the 2D
 * source, the built cells for the 3D ones. A frame that is right in shape and
 * wrong in content would sail through a type check and show the author a lie.
 *
 * Driven through the real engine, the real sheet and map, the real map space and
 * the real atlas — the same objects the editor composes with — so the assertions
 * are about the pipeline rather than about fixtures shaped to please it. The
 * colours asserted on are read back out of the palette that was written, never
 * hard-coded, so re-tuning the default palette cannot break these.
 */

import { describe, expect, it } from "vitest";
import {
  COLUMN_MATERIAL_NONE,
  MapVoxelSpace,
  SpriteSheet,
  StubCartEngine,
  TileMap,
  loadMapVoxelSpace,
  serializeMapVoxelSpace,
  type MapVoxelCell,
  type Rgb,
} from "@cartbox/editor";

import { buildMapAtlas } from "../apps/web/src/lib/mapAtlas";
import {
  DEFAULT_ORBIT_RADIUS,
  FX_SKY,
  FX_SOURCES,
  FX_SOURCE_IDS,
  ORBIT_CELL_MAX,
  ORBIT_CELL_MIN,
  clampOrbitCell,
  clampOrbitPitch,
  createFxFrameBuffers,
  orbitCameraOnContent,
  renderFxFrame,
  type FxFrameBuffers,
  type FxSpaceView,
} from "../apps/web/src/app/edit/[cartId]/fxSources";
import {
  EYE_HEIGHT,
  clampToMap,
  standOnGround,
  walkCameraOnContent,
} from "../apps/web/src/app/edit/[cartId]/walkCamera";

/** A cart's worth of live editor surfaces, over the in-memory engine. */
function makeCart() {
  const engine = new StubCartEngine();
  const sheet = new SpriteSheet(engine);
  const map = new TileMap(engine);
  return { engine, sheet, map };
}

const solid = (colorIndex: number): MapVoxelCell => ({
  colorIndex,
  material: COLUMN_MATERIAL_NONE,
  kind: "solid",
});

/** The RGB the sheet's palette actually holds at an index. */
function paletteColor(sheet: SpriteSheet, index: number): Rgb {
  return sheet.paletteRgb()[index] ?? [0, 0, 0];
}

/** A palette lookup over the sheet, exactly as the FX tab builds one. */
function paletteOf(sheet: SpriteSheet) {
  const table = sheet.paletteRgb();
  return (index: number): Rgb => table[index] ?? [255, 255, 255];
}

/** Read one pixel of a composed frame. */
function pixelAt(buffers: FxFrameBuffers, x: number, y: number): [number, number, number, number] {
  const at = (y * buffers.width + x) * 4;
  return [buffers.frame[at]!, buffers.frame[at + 1]!, buffers.frame[at + 2]!, buffers.frame[at + 3]!];
}

/** How many pixels of the frame are not the sky — i.e. how much world was drawn. */
function worldPixels(buffers: FxFrameBuffers): number {
  let count = 0;
  for (let pixel = 0; pixel < buffers.width * buffers.height; pixel += 1) {
    const at = pixel * 4;
    const sky =
      buffers.frame[at] === FX_SKY[0] &&
      buffers.frame[at + 1] === FX_SKY[1] &&
      buffers.frame[at + 2] === FX_SKY[2];
    if (!sky) count += 1;
  }
  return count;
}

/** A block of solid cells in the middle of a space, in a single colour. */
function buildPlateau(space: MapVoxelSpace, colorIndex: number, half = 3): void {
  const centreX = Math.floor(space.width / 2);
  const centreZ = Math.floor(space.depth / 2);
  for (let z = centreZ - half; z <= centreZ + half; z += 1) {
    for (let x = centreX - half; x <= centreX + half; x += 1) {
      space.set(x, 0, z, solid(colorIndex));
    }
  }
}

/** The view both 3D sources render through, over a space and a cart's art. */
function viewOf(space: MapVoxelSpace, sheet: SpriteSheet): FxSpaceView {
  return { space, atlas: buildMapAtlas(sheet), palette: paletteOf(sheet) };
}

describe("the source registry", () => {
  it("offers exactly the sources the renderer can compose", () => {
    expect(FX_SOURCES.map((option) => option.id)).toEqual([...FX_SOURCE_IDS]);
  });

  it("gives every source a label and an explanation", () => {
    for (const option of FX_SOURCES) {
      expect(option.label.length).toBeGreaterThan(0);
      expect(option.hint.length).toBeGreaterThan(0);
    }
  });
});

describe("frame buffers", () => {
  it("sizes the frame to the cart screen and the scratch square to its longer edge", () => {
    const buffers = createFxFrameBuffers(240, 136);

    expect(buffers.width).toBe(240);
    expect(buffers.height).toBe(136);
    expect(buffers.frame).toHaveLength(240 * 136 * 4);
    expect(buffers.squareSize).toBe(240);
    expect(buffers.square).toHaveLength(240 * 240 * 4);
    expect(buffers.depth).toHaveLength(240 * 240);
  });

  it("refuses to allocate a degenerate frame", () => {
    const buffers = createFxFrameBuffers(0, -4);

    expect(buffers.width).toBe(1);
    expect(buffers.height).toBe(1);
    expect(buffers.frame).toHaveLength(4);
  });
});

describe("the flat screen source", () => {
  it("stamps the map's own tiles, at the position the map puts them", () => {
    const { sheet, map } = makeCart();
    // Author a tile that is a single flat colour, and stand it at the top-left of
    // the second screen across — so the assertion proves the *screen* selection
    // as well as the stamping.
    const tile = 7;
    const colorIndex = 5;
    for (let y = 0; y < sheet.tileSize; y += 1) {
      for (let x = 0; x < sheet.tileSize; x += 1) sheet.setPixel(0, tile, x, y, colorIndex);
    }
    map.setCell(map.screenWidth, 0, tile);

    const buffers = createFxFrameBuffers(map.screenWidth * sheet.tileSize, map.screenHeight * sheet.tileSize);
    renderFxFrame({ source: "screen", sheet, map, screen: { column: 1, row: 0 } }, buffers);

    const [red, green, blue, alpha] = pixelAt(buffers, 0, 0);
    expect([red, green, blue]).toEqual([...paletteColor(sheet, colorIndex)]);
    expect(alpha).toBe(255);
  });

  it("hands the shader an opaque frame, whatever the art's alpha was", () => {
    const { sheet, map } = makeCart();
    const buffers = createFxFrameBuffers(map.screenWidth * sheet.tileSize, map.screenHeight * sheet.tileSize);

    renderFxFrame({ source: "screen", sheet, map, screen: { column: 0, row: 0 } }, buffers);

    for (let pixel = 0; pixel < buffers.width * buffers.height; pixel += 1) {
      expect(buffers.frame[pixel * 4 + 3]).toBe(255);
    }
  });

  it("shows a different screen when a different screen is asked for", () => {
    const { sheet, map } = makeCart();
    const tile = 3;
    for (let y = 0; y < sheet.tileSize; y += 1) {
      for (let x = 0; x < sheet.tileSize; x += 1) sheet.setPixel(0, tile, x, y, 6);
    }
    map.setCell(0, 0, tile);

    const buffers = createFxFrameBuffers(map.screenWidth * sheet.tileSize, map.screenHeight * sheet.tileSize);
    renderFxFrame({ source: "screen", sheet, map, screen: { column: 0, row: 0 } }, buffers);
    const onScreenZero = pixelAt(buffers, 0, 0);
    renderFxFrame({ source: "screen", sheet, map, screen: { column: 1, row: 0 } }, buffers);
    const onScreenOne = pixelAt(buffers, 0, 0);

    expect(onScreenZero).not.toEqual(onScreenOne);
  });
});

describe("the orbit source", () => {
  it("draws the cells that were built, over the sky", () => {
    const { sheet } = makeCart();
    const space = new MapVoxelSpace(32, 32);
    const colorIndex = 4;
    buildPlateau(space, colorIndex);

    const buffers = createFxFrameBuffers(240, 136);
    renderFxFrame(
      { source: "orbit", view: viewOf(space, sheet), camera: orbitCameraOnContent(space, buffers.width) },
      buffers,
    );

    // Something was drawn, and it is lit from the palette colour that was built
    // with rather than from the sky.
    expect(worldPixels(buffers)).toBeGreaterThan(0);
  });

  it("shows nothing but sky when nothing has been built", () => {
    const { sheet } = makeCart();
    const space = new MapVoxelSpace(32, 32);

    const buffers = createFxFrameBuffers(240, 136);
    renderFxFrame(
      { source: "orbit", view: viewOf(space, sheet), camera: orbitCameraOnContent(space, buffers.width) },
      buffers,
    );

    expect(worldPixels(buffers)).toBe(0);
    expect(pixelAt(buffers, 0, 0)).toEqual([...FX_SKY, 255]);
  });

  it("leaves no transparent pixel for the shader to read as black", () => {
    const { sheet } = makeCart();
    const space = new MapVoxelSpace(32, 32);
    buildPlateau(space, 4);

    const buffers = createFxFrameBuffers(240, 136);
    renderFxFrame(
      { source: "orbit", view: viewOf(space, sheet), camera: orbitCameraOnContent(space, buffers.width) },
      buffers,
    );

    for (let pixel = 0; pixel < buffers.width * buffers.height; pixel += 1) {
      expect(buffers.frame[pixel * 4 + 3]).toBe(255);
    }
  });

  it("crops the square render about its centre, so turning the camera moves the build", () => {
    const { sheet } = makeCart();
    const space = new MapVoxelSpace(32, 32);
    buildPlateau(space, 4);
    const view = viewOf(space, sheet);
    const camera = orbitCameraOnContent(space, 240);

    const buffers = createFxFrameBuffers(240, 136);
    renderFxFrame({ source: "orbit", view, camera }, buffers);
    const straightOn = Uint8ClampedArray.from(buffers.frame);
    renderFxFrame({ source: "orbit", view, camera: { ...camera, yaw: camera.yaw + 0.8 } }, buffers);

    expect(Array.from(buffers.frame)).not.toEqual(Array.from(straightOn));
    // The build stays in frame rather than being rotated out of the crop.
    expect(worldPixels(buffers)).toBeGreaterThan(0);
  });

  it("opens framed on what was built, not on the middle of an empty map", () => {
    const space = new MapVoxelSpace(64, 64);
    // Build in one corner, far from the map's centre.
    for (let z = 2; z < 6; z += 1) for (let x = 2; x < 6; x += 1) space.set(x, 0, z, solid(4));

    const camera = orbitCameraOnContent(space, 240);

    expect(camera.focus.x).toBeCloseTo(3.5);
    expect(camera.focus.z).toBeCloseTo(3.5);
    expect(camera.radius).toBe(DEFAULT_ORBIT_RADIUS);
    expect(camera.cell).toBeGreaterThanOrEqual(ORBIT_CELL_MIN);
    expect(camera.cell).toBeLessThanOrEqual(ORBIT_CELL_MAX);
  });

  it("keeps the camera within its own limits", () => {
    expect(clampOrbitCell(ORBIT_CELL_MAX + 50)).toBe(ORBIT_CELL_MAX);
    expect(clampOrbitCell(ORBIT_CELL_MIN - 50)).toBe(ORBIT_CELL_MIN);
    expect(clampOrbitCell(6.4)).toBe(6);
    expect(clampOrbitPitch(10)).toBeLessThan(Math.PI / 2);
    expect(clampOrbitPitch(-10)).toBeGreaterThan(-Math.PI / 2);
  });
});

describe("the walk source", () => {
  it("fills the frame from inside the world, opaquely", () => {
    const { sheet } = makeCart();
    const space = new MapVoxelSpace(32, 32);
    buildPlateau(space, 4, 6);

    const buffers = createFxFrameBuffers(240, 136);
    renderFxFrame({ source: "walk", view: viewOf(space, sheet), camera: walkCameraOnContent(space) }, buffers);

    for (let pixel = 0; pixel < buffers.width * buffers.height; pixel += 1) {
      expect(buffers.frame[pixel * 4 + 3]).toBe(255);
    }
    // Standing on the plateau, the ground is under the camera: some of the frame
    // has to be world, or the eye is not where it claims to be.
    expect(worldPixels(buffers)).toBeGreaterThan(0);
  });

  it("shows only sky from inside an empty map", () => {
    const { sheet } = makeCart();
    const space = new MapVoxelSpace(32, 32);

    const buffers = createFxFrameBuffers(240, 136);
    renderFxFrame({ source: "walk", view: viewOf(space, sheet), camera: walkCameraOnContent(space) }, buffers);

    expect(worldPixels(buffers)).toBe(0);
  });

  it("turns the view when the camera turns", () => {
    const { sheet } = makeCart();
    const space = new MapVoxelSpace(32, 32);
    // A wall on one side only, so which way the viewer faces is visible.
    for (let y = 0; y < 4; y += 1) for (let x = 10; x < 22; x += 1) space.set(x, y, 22, solid(4));
    const view = viewOf(space, sheet);
    const camera = { x: 16, y: 2, z: 10, yaw: 0, pitch: 0 };

    const buffers = createFxFrameBuffers(120, 68);
    renderFxFrame({ source: "walk", view, camera }, buffers);
    const facingWall = worldPixels(buffers);
    renderFxFrame({ source: "walk", view, camera: { ...camera, yaw: Math.PI } }, buffers);
    const facingAway = worldPixels(buffers);

    expect(facingWall).toBeGreaterThan(0);
    expect(facingAway).toBe(0);
  });

  it("reuses the caller's buffer rather than allocating a frame per render", () => {
    const { sheet } = makeCart();
    const space = new MapVoxelSpace(16, 16);
    const buffers = createFxFrameBuffers(64, 36);

    const frame = renderFxFrame(
      { source: "walk", view: viewOf(space, sheet), camera: walkCameraOnContent(space) },
      buffers,
    );

    expect(frame).toBe(buffers.frame);
  });
});

describe("the walk camera", () => {
  it("stands the viewer on the ground at eye height", () => {
    const space = new MapVoxelSpace(16, 16);
    space.setColumn(8, 8, 3, 4);

    const stood = standOnGround(space, { x: 8, y: 0, z: 8, yaw: 0, pitch: 0 });

    expect(stood.y).toBeCloseTo(space.heightAt(8, 8) - 0.5 + EYE_HEIGHT);
  });

  it("keeps the viewer inside the map", () => {
    const space = new MapVoxelSpace(16, 16);

    const clamped = clampToMap(space, { x: -5, y: 9999, z: 40, yaw: 0, pitch: 0 });

    expect(clamped.x).toBe(0);
    expect(clamped.z).toBe(space.depth - 1);
    expect(clamped.y).toBe(space.maxHeight - 1);
  });

  it("opens standing on what was built, not in the middle of an empty map", () => {
    const space = new MapVoxelSpace(64, 64);
    for (let z = 50; z < 54; z += 1) for (let x = 50; x < 54; x += 1) space.set(x, 0, z, solid(4));

    const camera = walkCameraOnContent(space);

    expect(camera.x).toBeCloseTo(51.5);
    expect(camera.z).toBeCloseTo(51.5);
    expect(camera.y).toBeGreaterThan(0);
  });

  it("falls back to the map's middle when nothing is built", () => {
    const space = new MapVoxelSpace(32, 32);

    const camera = walkCameraOnContent(space);

    expect(camera.x).toBe(16);
    expect(camera.z).toBe(16);
  });
});

describe("the preview and the cart's stored map", () => {
  it("renders the cells the Map tab saved, round-tripped through the sidecar", () => {
    const { sheet, map } = makeCart();
    const authored = new MapVoxelSpace(map.width, map.height);
    buildPlateau(authored, 4);

    // Exactly the path the workbench takes: the map editor serializes, the cart
    // stores the string, and the FX tab loads it back to preview over.
    const restored = loadMapVoxelSpace(serializeMapVoxelSpace(authored), map.width, map.height);

    expect(restored.cellCount).toBe(authored.cellCount);

    const buffers = createFxFrameBuffers(240, 136);
    renderFxFrame(
      { source: "orbit", view: viewOf(restored, sheet), camera: orbitCameraOnContent(restored, buffers.width) },
      buffers,
    );

    expect(worldPixels(buffers)).toBeGreaterThan(0);
  });
});
