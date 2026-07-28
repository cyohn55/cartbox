/**
 * procgen — the editor's procedural generation layer.
 *
 * Every generator is a pure, seeded function producing either a 2D
 * {@link ClassField} (the Map tab) or a filled voxel volume (the Voxel tab), and
 * every generator is described declaratively in {@link MAP_GENERATORS} /
 * {@link VOXEL_GENERATORS} so the editor's Generate panel renders itself.
 */

export {
  createClassField,
  classAt,
  setClassAt,
  countByClass,
  classIndexOf,
  classFieldToRgba,
  type ClassField,
  type ClassInfo,
} from "./classField";
export {
  hashCoords2,
  hashCoords3,
  smoothstep,
  valueNoise2D,
  valueNoise3D,
  fractalNoise2D,
  fractalNoise3D,
  createRandom,
  randomInt,
  DEFAULT_OCTAVES,
  type RandomSource,
} from "./noise";
export {
  generateHeightField,
  heightAt,
  moistureAt,
  DEFAULT_HEIGHT_FIELD_PARAMS,
  type HeightField,
  type HeightFieldParams,
} from "./heightField";
export {
  classifyTerrain,
  terrainClassOf,
  bandsForWaterLevel,
  isWaterClass,
  isClassEdge,
  strataColorAt,
  strataSurfaceAt,
  terrainSurfaceOf,
  TERRAIN_LEGEND,
  TERRAIN_CLASS,
  SUBSURFACE_COLORS,
  DEFAULT_TERRAIN_BANDS,
  DEFAULT_FOREST_MOISTURE,
  type TerrainBands,
  type ClassifyTerrainOptions,
} from "./terrain";
export {
  generateCaves2D,
  generateCaves3D,
  CAVE_LEGEND,
  CAVE_CLASS,
  DEFAULT_CAVE_PARAMS,
  type CaveParams,
  type CaveVolume,
} from "./caves";
export {
  generateDungeon,
  roomCenter,
  isWalkable,
  DUNGEON_LEGEND,
  DUNGEON_CLASS,
  DEFAULT_DUNGEON_PARAMS,
  type Dungeon,
  type DungeonParams,
  type DungeonRoom,
} from "./dungeon";
export { generateMaze, MAZE_LEGEND, MAZE_CLASS, DEFAULT_MAZE_PARAMS, type MazeParams } from "./maze";
export {
  MAP_GENERATORS,
  VOXEL_GENERATORS,
  defaultValues,
  findGenerator,
  paramValue,
  type FieldGenerator,
  type VolumeGenerator,
  type GeneratorValues,
  type LatticeOptions,
  type ParamFormat,
  type ParamSpec,
  type VoxelSink,
} from "./generators";
export {
  TEXTURE_GENERATORS,
  DEFAULT_RAMP_OPTIONS,
  findTextureGenerator,
  textureToIndices,
  type RampOptions,
  type TextureField,
  type TextureGenerator,
} from "./textures";
export {
  SURFACE_IDS,
  NO_MATERIAL,
  resolveMaterial,
  type SurfaceId,
  type MaterialResolver,
} from "./surfaces";
export {
  applyFieldToTiles,
  applyFieldToPixels,
  applyFieldToColumns,
  defaultClassMapping,
  surfaceForClassId,
  type ApplyOptions,
  type ClassMapping,
  type DefaultMappingOptions,
  type ColumnTarget,
  type PixelTarget,
  type TileTarget,
} from "./apply";
