/**
 * What the map's 3D tools do, independent of which camera you are looking
 * through.
 *
 * Both views — orbiting and first-person — resolve a pointer to a cell in
 * completely different ways and then hand the answer to the same code, so this
 * is where the behaviour actually lives and where it is worth pinning:
 *
 * - building grows *outward*, against the face you aimed at;
 * - a plane wears the sprite you armed, because a flat-coloured quad is just a
 *   rectangle;
 * - painting a pixel paints a pixel, in one click, even on a cell that had no
 *   sprite yet — the alternative silently swallows the first click and then
 *   repaints the whole face, which is what "I tried to edit pixels and it
 *   painted the entire voxel" feels like.
 */

import { describe, expect, it } from "vitest";

import { COLUMN_MATERIAL_NONE, CUBE_FACES, MapVoxelSpace } from "@cartbox/editor";

import {
  MAP_SPRITE_MATERIAL_BASE,
  materialSpriteTile,
  spriteTileMaterial,
} from "../apps/web/src/lib/mapAtlas";
import {
  acrossFace,
  applySpaceTool,
  targetOfTool,
  type SpacePick,
  type SpaceToolContext,
} from "../apps/web/src/app/edit/[cartId]/mapSpaceTools";
import type { PaintSurface } from "../apps/web/src/app/edit/[cartId]/paintSurface";
import { MATERIAL } from "../apps/web/src/lib/faceTextures";

const TILE_SIZE = 8;
const TILES_PER_PAGE = 256;

/** A paint surface that records what was written, so a stroke can be inspected. */
class RecordingSurface implements PaintSurface {
  readonly tileSize = TILE_SIZE;
  readonly strokes: { kind: "pixel" | "fill"; tile: number; x: number; y: number; value: number }[] = [];
  private readonly texels = new Map<string, number>();

  getPixel(_page: 0 | 1, tile: number, x: number, y: number): number {
    return this.texels.get(`${tile}:${x}:${y}`) ?? 0;
  }
  setPixel(_page: 0 | 1, tile: number, x: number, y: number, value: number): void {
    this.texels.set(`${tile}:${x}:${y}`, value);
    this.strokes.push({ kind: "pixel", tile, x, y, value });
  }
  fill(_page: 0 | 1, tile: number, x: number, y: number, value: number): void {
    this.strokes.push({ kind: "fill", tile, x, y, value });
  }
  cssColor(): string {
    return "#000000";
  }
}

/** The index of the cube face pointing along a normal. */
function faceTowards(normal: readonly [number, number, number]): number {
  const index = CUBE_FACES.findIndex(
    (face) => face.normal[0] === normal[0] && face.normal[1] === normal[1] && face.normal[2] === normal[2],
  );
  if (index < 0) throw new Error(`no cube face with normal ${normal.join(",")}`);
  return index;
}

const pickAt = (
  x: number,
  y: number,
  z: number,
  normal: readonly [number, number, number],
  extra: Partial<SpacePick> = {},
): SpacePick => ({ x, y, z, face: faceTowards(normal), u: 0.5, v: 0.5, plane: false, ...extra });

function contextFor(space: MapVoxelSpace, overrides: Partial<SpaceToolContext> = {}) {
  const pixels = new RecordingSurface();
  const context: SpaceToolContext = {
    space,
    tileSize: TILE_SIZE,
    tilesPerPage: TILES_PER_PAGE,
    pixels,
    colorIndex: 7,
    material: COLUMN_MATERIAL_NONE,
    planeKind: "cross",
    brushTile: 12,
    ...overrides,
  };
  return { context, pixels: context.pixels as RecordingSurface };
}

/** A one-cell map with a block to aim at. */
function mapWithBlock(shape: "cube" | "hexel" = "cube") {
  const space = new MapVoxelSpace(20, 20, shape);
  space.set(10, 0, 10, { colorIndex: 2, material: COLUMN_MATERIAL_NONE, kind: "solid" });
  return space;
}

describe("where a tool acts", () => {
  it("builds against the face aimed at, and edits the cell itself otherwise", () => {
    const space = mapWithBlock();
    const pick = pickAt(10, 0, 10, [0, 1, 0]);

    expect(targetOfTool("place", space, pick)).toEqual([10, 1, 10]);
    expect(targetOfTool("plane", space, pick)).toEqual([10, 1, 10]);
    expect(targetOfTool("remove", space, pick)).toEqual([10, 0, 10]);
    expect(targetOfTool("paintCell", space, pick)).toEqual([10, 0, 10]);
    expect(targetOfTool("pencil", space, pick)).toEqual([10, 0, 10]);
  });

  it("steps a hexel along its own lattice, never off it", () => {
    const space = mapWithBlock("hexel");
    // Every one of a hexel's twelve faces has to lead to a valid site, or half
    // the neighbours would be unbuildable.
    for (let face = 0; face < 12; face += 1) {
      const [x, y, z] = acrossFace(space, { x: 10, y: 0, z: 10, face, u: 0, v: 0, plane: false });
      expect((((x + y + z) % 2) + 2) % 2).toBe(0);
    }
  });
});

describe("building", () => {
  it("places a cell against the face, in the armed colour and material", () => {
    const space = mapWithBlock();
    const { context } = contextFor(space, { material: MATERIAL.brick, colorIndex: 5 });

    const result = applySpaceTool("place", pickAt(10, 0, 10, [0, 1, 0]), false, context);

    expect(result.changedCells).toBe(true);
    expect(space.cellAt(10, 1, 10)).toEqual({ colorIndex: 5, material: MATERIAL.brick, kind: "solid" });
  });

  it("removes the cell aimed at when the secondary button is used", () => {
    const space = mapWithBlock();
    const { context } = contextFor(space);

    applySpaceTool("place", pickAt(10, 0, 10, [0, 1, 0]), true, context);

    expect(space.isFilled(10, 0, 10)).toBe(false);
  });

  it("explains itself rather than failing silently past the edge of the map", () => {
    const space = new MapVoxelSpace(20, 20);
    space.set(0, 0, 0, { colorIndex: 1, material: COLUMN_MATERIAL_NONE, kind: "solid" });
    const { context } = contextFor(space);

    const result = applySpaceTool("place", pickAt(0, 0, 0, [-1, 0, 0]), false, context);

    expect(result.changedCells).toBe(false);
    expect(result.note).toMatch(/edge of the map/i);
  });

  it("restyles a cell, and strips it back to flat colour on the secondary button", () => {
    const space = mapWithBlock();
    const { context } = contextFor(space, { material: MATERIAL.grass, colorIndex: 9 });

    applySpaceTool("paintCell", pickAt(10, 0, 10, [0, 1, 0]), false, context);
    expect(space.cellAt(10, 0, 10)).toEqual({ colorIndex: 9, material: MATERIAL.grass, kind: "solid" });

    applySpaceTool("paintCell", pickAt(10, 0, 10, [0, 1, 0]), true, context);
    expect(space.cellAt(10, 0, 10)?.material).toBe(COLUMN_MATERIAL_NONE);
  });

  it("picks up both the colour and the skin of the cell aimed at", () => {
    const space = new MapVoxelSpace(20, 20);
    space.set(10, 0, 10, { colorIndex: 3, material: spriteTileMaterial(40), kind: "solid" });
    const { context } = contextFor(space);

    const result = applySpaceTool("picker", pickAt(10, 0, 10, [0, 1, 0]), false, context);

    expect(result.picked).toEqual({ colorIndex: 3, material: spriteTileMaterial(40) });
    expect(result.note).toMatch(/#40/);
  });
});

describe("standing sprite planes", () => {
  it("wears the armed sprite rather than a flat colour", () => {
    // A plane is art on a surface; a flat-coloured quad would just be a
    // rectangle, so the tile picker — not the material palette — decides.
    const space = mapWithBlock();
    const { context } = contextFor(space, { brushTile: 31, material: MATERIAL.rock });

    applySpaceTool("plane", pickAt(10, 0, 10, [0, 1, 0]), false, context);

    const placed = space.cellAt(10, 1, 10);
    expect(placed?.kind).toBe("cross");
    expect(materialSpriteTile(placed!.material, TILES_PER_PAGE)).toBe(31);
  });

  it("stands whichever orientation is armed", () => {
    const space = mapWithBlock();
    const { context } = contextFor(space, { planeKind: "planeY" });

    applySpaceTool("plane", pickAt(10, 0, 10, [0, 1, 0]), false, context);

    expect(space.cellAt(10, 1, 10)?.kind).toBe("planeY");
  });

  it("says what it stood, so an invisible sprite is not a mystery", () => {
    const space = mapWithBlock();
    const { context } = contextFor(space, { brushTile: 5 });

    const result = applySpaceTool("plane", pickAt(10, 0, 10, [0, 1, 0]), false, context);

    expect(result.note).toMatch(/#5/);
  });
});

describe("painting pixels on a face", () => {
  it("paints the texel under the cursor of the sprite the cell wears", () => {
    const space = new MapVoxelSpace(20, 20);
    space.set(10, 0, 10, { colorIndex: 1, material: spriteTileMaterial(20), kind: "solid" });
    const { context, pixels } = contextFor(space, { colorIndex: 6 });

    const result = applySpaceTool(
      "pencil",
      pickAt(10, 0, 10, [0, 1, 0], { u: 0.3, v: 0.8 }),
      false,
      context,
    );

    expect(result.changedPixels).toBe(true);
    expect(pixels.strokes).toEqual([
      { kind: "pixel", tile: 20, x: Math.floor(0.3 * TILE_SIZE), y: Math.floor(0.8 * TILE_SIZE), value: 6 },
    ]);
  });

  it("paints in one click on a cell that had no sprite, and says what it did", () => {
    // The behaviour this replaced skinned the cell and stopped, so the first
    // click looked like the tool repainting the whole face instead of drawing.
    const space = mapWithBlock();
    const { context, pixels } = contextFor(space, { brushTile: 17, colorIndex: 4 });

    const result = applySpaceTool(
      "pencil",
      pickAt(10, 0, 10, [0, 1, 0], { u: 0.1, v: 0.1 }),
      false,
      context,
    );

    expect(materialSpriteTile(space.cellAt(10, 0, 10)!.material, TILES_PER_PAGE)).toBe(17);
    expect(pixels.strokes).toHaveLength(1);
    expect(pixels.strokes[0]).toMatchObject({ tile: 17, value: 4 });
    expect(result.changedCells).toBe(true);
    expect(result.changedPixels).toBe(true);
    expect(result.note).toMatch(/#17/);
  });

  it("keeps painting the same sprite on later clicks, without re-skinning", () => {
    const space = mapWithBlock();
    const { context, pixels } = contextFor(space, { brushTile: 17 });
    const pick = pickAt(10, 0, 10, [0, 1, 0], { u: 0.4, v: 0.4 });

    applySpaceTool("pencil", pick, false, context);
    const second = applySpaceTool("pencil", pick, false, context);

    expect(second.changedCells).toBe(false); // nothing to re-skin
    expect(second.note).toBeNull();
    expect(pixels.strokes).toHaveLength(2);
    expect(pixels.strokes.every((stroke) => stroke.tile === 17)).toBe(true);
  });

  it("paints a world-skinned cell with its own sprite instead of the world's art", () => {
    // Grass and rock are fixed art shared by every cart, so painting them is not
    // on offer; the cell takes an editable sprite of its own first.
    const space = new MapVoxelSpace(20, 20);
    space.set(10, 0, 10, { colorIndex: 1, material: MATERIAL.grass, kind: "solid" });
    const { context, pixels } = contextFor(space, { brushTile: 9 });

    applySpaceTool("pencil", pickAt(10, 0, 10, [0, 1, 0]), false, context);

    expect(space.cellAt(10, 0, 10)!.material).toBeGreaterThanOrEqual(MAP_SPRITE_MATERIAL_BASE);
    expect(pixels.strokes[0]!.tile).toBe(9);
  });

  it("erases with the transparent index, so the face shows through", () => {
    const space = new MapVoxelSpace(20, 20);
    space.set(10, 0, 10, { colorIndex: 1, material: spriteTileMaterial(3), kind: "solid" });
    const { context, pixels } = contextFor(space, { colorIndex: 6 });

    applySpaceTool("pixelEraser", pickAt(10, 0, 10, [0, 1, 0]), false, context);

    expect(pixels.strokes[0]!.value).toBe(0);
  });

  it("floods through the fill tool rather than setting one pixel", () => {
    const space = new MapVoxelSpace(20, 20);
    space.set(10, 0, 10, { colorIndex: 1, material: spriteTileMaterial(3), kind: "solid" });
    const { context, pixels } = contextFor(space);

    applySpaceTool("pixelFill", pickAt(10, 0, 10, [0, 1, 0]), false, context);

    expect(pixels.strokes[0]!.kind).toBe("fill");
  });

  it("does nothing when there is no cell to paint", () => {
    const space = new MapVoxelSpace(20, 20);
    const { context, pixels } = contextFor(space);

    const result = applySpaceTool("pencil", pickAt(5, 5, 5, [0, 1, 0]), false, context);

    expect(result.changedPixels).toBe(false);
    expect(pixels.strokes).toHaveLength(0);
  });

  it("reaches every texel of a face as the cursor crosses it", () => {
    const space = new MapVoxelSpace(20, 20);
    space.set(10, 0, 10, { colorIndex: 1, material: spriteTileMaterial(2), kind: "solid" });
    const { context, pixels } = contextFor(space);

    for (let step = 0; step < TILE_SIZE; step += 1) {
      const along = (step + 0.5) / TILE_SIZE;
      applySpaceTool("pencil", pickAt(10, 0, 10, [0, 1, 0], { u: along, v: along }), false, context);
    }

    expect(pixels.strokes.map((stroke) => stroke.x)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(pixels.strokes.map((stroke) => stroke.y)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });
});
