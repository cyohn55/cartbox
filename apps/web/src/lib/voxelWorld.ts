/**
 * Turns the generated Minecraft-style island (voxelWorldSpecs.ts) into a
 * renderable {@link VoxelModel}. The generation is dep-free and node-tested; this
 * thin adapter is the only part that needs the editor's voxel core, so it is kept
 * separate for the same reason retroVoxels.ts is split from retroVoxelSpecs.ts.
 *
 * The world is a static block grid, so its model is built once and then rendered
 * from a slowly drifting camera each frame — {@link voxelGridToModel} drops every
 * interior face, so a solid island costs only its visible shell to draw.
 */

import { VoxelGrid, voxelGridToModel, type VoxelModel } from "@cartbox/editor";

import { DEFAULT_WORLD_PARAMS, generateWorld, type WorldGenParams } from "./voxelWorldSpecs";

/**
 * Build the island's voxel model. The grid is filled from the deterministic
 * generator, then converted with content-centred sizing so the island rotates
 * about its own middle and renders tight to its filled extent.
 */
export function buildWorldModel(params: WorldGenParams = DEFAULT_WORLD_PARAMS): VoxelModel {
  const world = generateWorld(params);
  const grid = new VoxelGrid(world.sizeX, world.sizeY, world.sizeZ);
  for (const cell of world.cells) {
    grid.set(cell.x, cell.y, cell.z, cell.r, cell.g, cell.b, cell.emissive);
  }
  return voxelGridToModel(grid, { center: "content" });
}
