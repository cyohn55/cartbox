/**
 * Turns the generated hexel terrain volume (hexelTerrainSpecs.ts) into a
 * renderable {@link VoxelModel} built on the rhombic-dodecahedron cell geometry.
 *
 * This is the only part of the terrain that needs the editor's voxel core, so it
 * is kept separate for the same reason voxelWorld.ts is split from
 * voxelWorldSpecs.ts. The generated cells are written onto an even-parity grid
 * and converted with {@link HEXEL_GEOMETRY}, so the model builder drops every
 * interior rhombic face and a solid hill costs only its visible shell to draw.
 */

import {
  VoxelGrid,
  voxelGridToModel,
  HEXEL_GEOMETRY,
  type GridVoxelModel,
} from "@cartbox/editor";

import {
  DEFAULT_TERRAIN_PARAMS,
  generateTerrain,
  type TerrainParams,
} from "./hexelTerrainSpecs";
import { terrainTile } from "./faceTextures";

/**
 * Build the terrain's hexel model, textured by material. Grid coordinates map
 * straight through, and content-centred sizing makes the model rotate about the
 * filled terrain's middle and render tight to its extent — ready to place into a
 * scene alongside the atlas from {@link buildWorldAtlas}. Each cell's texture tile
 * is looked up by its material via a grid-index map, so grass, dirt, rock and
 * crystal each get their own surface.
 */
export function buildTerrainModel(params: TerrainParams = DEFAULT_TERRAIN_PARAMS): GridVoxelModel {
  const volume = generateTerrain(params);
  const grid = new VoxelGrid(volume.sizeX, volume.sizeY, volume.sizeZ);
  const tileByIndex = new Map<number, number>();
  for (const cell of volume.cells) {
    // The grid stores emissive as a 0..255 byte; the cell's is 0..1.
    grid.set(cell.x, cell.y, cell.z, cell.r, cell.g, cell.b, Math.round(cell.emissive * 255));
    tileByIndex.set(grid.index(cell.x, cell.y, cell.z), terrainTile(cell.material));
  }
  return voxelGridToModel(grid, {
    center: "content",
    geometry: HEXEL_GEOMETRY,
    tileForCell: (x, y, z) => tileByIndex.get(grid.index(x, y, z)) ?? -1,
  });
}
