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
import { terrainMaterial } from "./faceTextures";

/**
 * Build the terrain's hexel model, textured by material. Grid coordinates map
 * straight through, and content-centred sizing makes the model rotate about the
 * filled terrain's middle and render tight to its extent — ready to place into a
 * scene alongside the atlas from {@link buildWorldAtlas}. Each cell's *material*
 * (grass, dirt, rock, crystal) is looked up via a grid-index map so its faces
 * sample the right tiles — grass capping the surface over soil sides, and so on.
 *
 * Cells are painted near-white so the authored colour tiles show as drawn (the
 * renderer tints a tile by the voxel colour); a cell's emissive is still carried
 * through so cave crystals glow.
 */
export function buildTerrainModel(params: TerrainParams = DEFAULT_TERRAIN_PARAMS): GridVoxelModel {
  const volume = generateTerrain(params);
  const grid = new VoxelGrid(volume.sizeX, volume.sizeY, volume.sizeZ);
  const materialByIndex = new Map<number, number>();
  for (const cell of volume.cells) {
    // White albedo lets the coloured tile show true; emissive (0..1 → 0..255 byte)
    // still floors a cave crystal's glow alongside its tile's own emissive.
    grid.set(cell.x, cell.y, cell.z, 255, 255, 255, Math.round(cell.emissive * 255));
    materialByIndex.set(grid.index(cell.x, cell.y, cell.z), terrainMaterial(cell.material));
  }
  return voxelGridToModel(grid, {
    center: "content",
    geometry: HEXEL_GEOMETRY,
    tileForCell: (x, y, z) => materialByIndex.get(grid.index(x, y, z)) ?? -1,
  });
}
