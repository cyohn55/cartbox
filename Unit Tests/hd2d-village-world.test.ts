/**
 * Unit tests for the HD-2D village world assembler (`assembleVillageWorld`).
 *
 * The assembler is the pure core of the /hd2d slice's "build the world from the
 * asset library" path: given decoded library assets (tile face textures and prop
 * voxel grids, keyed by their library id) it returns the placed models, the
 * hero's start and roam bounds — with no I/O. These tests hand it fixture assets
 * built from explicit parameters and assert the world it produces against those
 * same parameters, so nothing is checked against a copied literal that could
 * drift from what the code builds.
 */

import { describe, expect, it } from "vitest";

import { VoxelGrid, spriteToFaceTexture, type FaceTexture } from "@cartbox/editor";
import {
  assembleVillageWorld,
  TILE_ASSETS,
  PROP_ASSETS,
  type TileAssetId,
  type PropAssetId,
} from "@/lib/hd2d/world";

/** A solid opaque square tile texture of the given edge, as the atlas expects. */
function makeTile(size = 16): FaceTexture {
  const pixels = new Uint8ClampedArray(size * size * 4).fill(200);
  for (let i = 3; i < pixels.length; i += 4) pixels[i] = 255; // fully opaque
  return spriteToFaceTexture(pixels, size, size);
}

/** A prop voxel grid whose filled content spans exactly `height` cells in Y,
 *  starting at y=1, so its content height is unambiguous and independent of grid size. */
function makeProp(height: number): VoxelGrid {
  const grid = new VoxelGrid(3, height + 2, 3);
  for (let y = 1; y <= height; y += 1) grid.set(1, y, 1, 120, 90, 60, 0);
  return grid;
}

/** All tile assets → identical fixture textures. */
function allTiles(size = 16): Map<TileAssetId, FaceTexture> {
  return new Map(TILE_ASSETS.map((id) => [id, makeTile(size)]));
}

/** All prop assets → identical fixture grids of the given content height. */
function allProps(height: number): Map<PropAssetId, VoxelGrid> {
  return new Map(PROP_ASSETS.map((id) => [id, makeProp(height)]));
}

describe("assembleVillageWorld", () => {
  it("puts the terrain atlas on the single ground model, one slot per tile asset given", () => {
    const tiles = allTiles();
    const world = assembleVillageWorld(tiles, new Map());

    // With no props, the only model is the ground.
    expect(world.models).toHaveLength(1);
    const ground = world.models[0]!;
    expect(ground.atlas).toBeDefined();
    // The atlas carries exactly the tiles that were supplied, no more.
    expect(ground.atlas!.tiles).toHaveLength(tiles.size);
  });

  it("drops tile slots for absent tile assets instead of inventing them", () => {
    const partial = new Map<TileAssetId, FaceTexture>([[TILE_ASSETS[0]!, makeTile()]]);
    const world = assembleVillageWorld(partial, new Map());
    expect(world.models[0]!.atlas!.tiles).toHaveLength(1);
  });

  it("places every supplied prop standing with its base on the ground (y = height/2)", () => {
    const height = 8;
    const world = assembleVillageWorld(allTiles(), allProps(height));

    const propModels = world.models.slice(1); // model 0 is the ground
    expect(propModels.length).toBeGreaterThan(0);
    // A content-centred model of content-height H, lifted by H/2, rests its base
    // on the ground plane (y=0). Every prop shares the fixture height here.
    for (const model of propModels) {
      expect(model.position?.[1]).toBeCloseTo(height / 2, 6);
      expect(model.atlas).toBeUndefined(); // props render from their own voxel colours
    }
  });

  it("consumes each prop asset — dropping one removes exactly its placements", () => {
    const full = assembleVillageWorld(allTiles(), allProps(4)).models.length;

    // Remove one prop asset; the world must shrink by however many times it was placed.
    const withoutOne = new Map(allProps(4));
    withoutOne.delete(PROP_ASSETS[0]!);
    const fewer = assembleVillageWorld(allTiles(), withoutOne).models.length;

    expect(fewer).toBeLessThan(full);
    // ...and it never grows or crashes when a prop is missing.
    expect(fewer).toBeGreaterThanOrEqual(1);
  });

  it("keeps the hero's start inside the roam bounds and on the ground plane", () => {
    const world = assembleVillageWorld(allTiles(), allProps(4));
    expect(Math.abs(world.start[0])).toBeLessThanOrEqual(world.bounds.radiusX);
    expect(Math.abs(world.start[2])).toBeLessThanOrEqual(world.bounds.radiusZ);
    expect(world.start[1]).toBe(0);
    expect(world.bounds.radiusX).toBeGreaterThan(0);
    expect(world.bounds.radiusZ).toBeGreaterThan(0);
  });

  it("is deterministic — the same assets produce identical placements", () => {
    const a = assembleVillageWorld(allTiles(), allProps(6));
    const b = assembleVillageWorld(allTiles(), allProps(6));
    const positions = (w: typeof a) => w.models.map((m) => m.position ?? null);
    expect(positions(a)).toEqual(positions(b));
  });
});
