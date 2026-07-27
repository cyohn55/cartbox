/**
 * The world's texture atlas — hand-authored pixel-art tiles (see
 * {@link AUTHORED_TILES}) plus the {@link FaceMaterial}s that decide which tile
 * skins a face. A voxel carries a *material* index (not a raw tile index): the
 * renderer then picks the material's top / side / bottom tile per face, so a grass
 * block shows grass on top, a grassy lip on its sides and soil beneath, and a log
 * shows rings on its ends and bark around it.
 *
 * Materials index into the tile list, so the two stay a single atlas the renderer
 * samples directly. Colour tiles (terrain, blocks) are drawn true-colour and used
 * on near-white voxels; console tiles (metal, screen, monolith) stay greyscale so
 * the voxel's own colour tints them.
 */

import type { FaceMaterial, TextureAtlas } from "@cartbox/editor";
import { AUTHORED_TILES, type AuthoredTileName } from "./authoredTiles";
import type { TerrainMaterial } from "./hexelTerrainSpecs";

/**
 * Atlas tile slots, in the order the tiles are laid out. Named for the art each
 * holds; materials below reference these. Deriving the order from the authored
 * library keeps slots and art in lockstep.
 */
const TILE_ORDER = [
  "grassTop",
  "grassSide",
  "dirt",
  "rock",
  "sand",
  "water",
  "brick",
  "planks",
  "woodBark",
  "woodRings",
  "leaves",
  "crystal",
  "metal",
  "screen",
  "monolith",
] as const satisfies readonly AuthoredTileName[];

/** Tile index by name, so materials read declaratively. */
const TILE: Record<AuthoredTileName, number> = TILE_ORDER.reduce(
  (map, name, index) => ({ ...map, [name]: index }),
  {} as Record<AuthoredTileName, number>,
);

/** A material whose three face groups all sample the one tile `tile`. */
function uniform(tile: number): FaceMaterial {
  return { top: tile, side: tile, bottom: tile };
}

/**
 * Named materials, in the order they occupy atlas material slots. A voxel's tile
 * value is one of these indices. The genuinely per-face ones are grass (grass cap
 * over soil sides) and wood (ringed ends, bark sides); the rest are uniform.
 */
export const MATERIAL = {
  grass: 0,
  dirt: 1,
  rock: 2,
  sand: 3,
  water: 4,
  brick: 5,
  planks: 6,
  wood: 7,
  leaves: 8,
  crystal: 9,
  metal: 10,
  screen: 11,
  monolith: 12,
} as const;

export type MaterialName = keyof typeof MATERIAL;

/** The face→tile mapping for each material, indexed by its {@link MATERIAL} value. */
const MATERIAL_FACES: readonly FaceMaterial[] = [
  { top: TILE.grassTop, side: TILE.grassSide, bottom: TILE.dirt }, // grass
  uniform(TILE.dirt),
  uniform(TILE.rock),
  uniform(TILE.sand),
  uniform(TILE.water),
  uniform(TILE.brick),
  uniform(TILE.planks),
  { top: TILE.woodRings, side: TILE.woodBark, bottom: TILE.woodRings }, // wood
  uniform(TILE.leaves),
  uniform(TILE.crystal),
  uniform(TILE.metal),
  uniform(TILE.screen),
  uniform(TILE.monolith),
];

/** Map a terrain cell's material to its atlas material index. */
export function terrainMaterial(material: TerrainMaterial): number {
  return MATERIAL[material];
}

/** A material offered in a build/paint palette: its index, a label and a swatch. */
export interface BuildMaterial {
  readonly name: MaterialName;
  readonly material: number;
  /** A representative colour for the palette button, matching the tile art. */
  readonly swatch: string;
}

/**
 * The materials a player can build or paint with, in palette order. Excludes the
 * console-only surfaces (metal / screen / monolith), which are greyscale detail
 * meant to be tinted by a specific voxel rather than placed as world blocks.
 */
export const BUILD_MATERIALS: readonly BuildMaterial[] = [
  { name: "grass", material: MATERIAL.grass, swatch: "#4a9644" },
  { name: "dirt", material: MATERIAL.dirt, swatch: "#78562f" },
  { name: "sand", material: MATERIAL.sand, swatch: "#deca95" },
  { name: "rock", material: MATERIAL.rock, swatch: "#6c6c74" },
  { name: "brick", material: MATERIAL.brick, swatch: "#a84a3a" },
  { name: "planks", material: MATERIAL.planks, swatch: "#a87c4c" },
  { name: "wood", material: MATERIAL.wood, swatch: "#7a5836" },
  { name: "leaves", material: MATERIAL.leaves, swatch: "#3a8238" },
  { name: "water", material: MATERIAL.water, swatch: "#2e6cbe" },
  { name: "crystal", material: MATERIAL.crystal, swatch: "#5adceb" },
];

/**
 * Build the world atlas: the authored tiles in slot order, plus the material
 * face-maps. Unlike the old procedural atlas this takes no seed — the art is
 * fixed, so the world textures identically every load.
 */
export function buildWorldAtlas(): TextureAtlas {
  const tiles = TILE_ORDER.map((name) => AUTHORED_TILES[name]);
  return { tiles, materials: MATERIAL_FACES };
}
