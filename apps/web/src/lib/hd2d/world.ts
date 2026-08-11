// The HD-2D vertical slice's 3D world, composed ENTIRELY from named asset-library
// entries instead of procedural code. Terrain tiles (grass, cobblestone, water)
// come from the library's 2D tile assets worn as face textures; the scenery
// (trees, rocks, a cottage, a well, lamp posts) are the library's voxel props,
// each placed at an authored spot. Nothing here is hashed or randomised — the
// village is a fixed layout that references library assets by id, so "make the
// world from the library" is literally what the code does.
//
// Split into a pure assembler (`assembleVillageWorld`, testable against decoded
// assets with no I/O) and an async loader (`loadVillageWorld`, which reads the
// library manifest and decodes payloads in the browser). Both feed the same
// z-buffered voxel renderer the editor's Voxel tab and /world already use.

import {
  VoxelGrid,
  voxelGridToModel,
  spriteToFaceTexture,
  parseVox,
  type PlacedModel,
  type TextureAtlas,
  type FaceTexture,
} from "@cartbox/editor";

/** A ready-to-render world: placed models plus where the hero stands and roams. */
export interface Hd2dWorld {
  readonly models: readonly PlacedModel[];
  /** Where the character starts (foot centre), world units. */
  readonly start: readonly [number, number, number];
  /** How far the character may roam from centre (kept over the ground). */
  readonly bounds: { readonly radiusX: number; readonly radiusZ: number };
}

// --- Library asset ids the village is built from -----------------------------
// These name real entries in the asset-library manifest (see
// scripts/library-sources.mts → "Village Pack"). The loader resolves each id to
// its payload URL through the manifest, so the world tracks the library.

/** Terrain tile assets, in the order they occupy the shared face-texture atlas. */
export const TILE_ASSETS = ["village-grass", "village-flowers", "village-dirt-path", "village-cobble", "village-water"] as const;
export type TileAssetId = (typeof TILE_ASSETS)[number];

/** Voxel scenery assets placed into the world. */
export const PROP_ASSETS = ["village-tree-vox", "village-rock-vox", "village-house-vox", "village-well-vox", "village-lamp-vox"] as const;
export type PropAssetId = (typeof PROP_ASSETS)[number];

/** Atlas slot index for each tile asset — the terrain map references these. */
const TILE_SLOT: Record<TileAssetId, number> = {
  "village-grass": 0,
  "village-flowers": 1,
  "village-dirt-path": 2,
  "village-cobble": 3,
  "village-water": 4,
};

/**
 * The village floor plan. One character per cell picks a terrain tile; a grass
 * field with a cobble path down the middle, a pond, and flower patches. Authored,
 * not generated — the layout is data, so it reads exactly as drawn.
 *   g grass · f flowers · d dirt · c cobble path · w pond water
 */
const TERRAIN_MAP = [
  "gggggggggfggggggggg",
  "ggfgggggcggggggfggg",
  "ggggggggcgggggggggg",
  "gwwwggggcggggggggfg",
  "gwwwwgggcgggggggggg",
  "gwwwggggcccccccgggg",
  "ggggggggggggggcgggg",
  "ggfggggggggggccgggg",
  "gggggggggfggggcgggg",
  "ggggggggggggggcgfgg",
  "gfggggggggggggcgggg",
  "gggggggfggggggcgggg",
] as const;

const TILE_CHAR_SLOT: Record<string, number> = { g: 0, f: 1, d: 2, c: 3, w: 4 };

/** A prop placed on the map: which voxel asset, and the grid cell it stands on. */
interface PropPlacement {
  readonly asset: PropAssetId;
  /** Grid column and row (into TERRAIN_MAP) of the prop's foot. */
  readonly col: number;
  readonly row: number;
}

/** Authored scenery: trees framing the field, a cottage and well by the path,
 *  lamp posts lighting it, and boulders for texture. All library voxel props. */
const PROP_PLACEMENTS: readonly PropPlacement[] = [
  { asset: "village-house-vox", col: 15, row: 2 },
  { asset: "village-house-vox", col: 3, row: 10 },
  { asset: "village-well-vox", col: 11, row: 6 },
  { asset: "village-tree-vox", col: 1, row: 1 },
  { asset: "village-tree-vox", col: 17, row: 5 },
  { asset: "village-tree-vox", col: 16, row: 10 },
  { asset: "village-tree-vox", col: 2, row: 7 },
  { asset: "village-lamp-vox", col: 7, row: 3 },
  { asset: "village-lamp-vox", col: 7, row: 8 },
  { asset: "village-lamp-vox", col: 13, row: 9 },
  { asset: "village-rock-vox", col: 5, row: 4 },
  { asset: "village-rock-vox", col: 12, row: 11 },
  { asset: "village-rock-vox", col: 10, row: 1 },
];

// --- Grid ↔ world mapping ----------------------------------------------------
// The ground is one content-centred voxel grid, so its cell (i,j) sits at world
// (i - (cols-1)/2, 0, j - (rows-1)/2) with its top face at y = 0. Every prop is
// placed with the same mapping so scenery lands exactly on the tile it names.

const GROUND_TOP_Y = 0;

function gridToWorldX(col: number, cols: number): number {
  return col - (cols - 1) / 2;
}
function gridToWorldZ(row: number, rows: number): number {
  return row - (rows - 1) / 2;
}

/** Vertical extent (in voxels) of a grid's filled content — a prop's height. */
function contentHeight(grid: VoxelGrid): number {
  let minY = Infinity;
  let maxY = -Infinity;
  grid.forEachFilled((_x, y) => {
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  });
  return maxY >= minY ? maxY - minY + 1 : 0;
}

// --- Pure assembler ----------------------------------------------------------

/** Turn one 16×16 straight-alpha RGBA tile into an atlas face texture. */
export function tileTextureFromPixels(pixels: Uint8ClampedArray, width: number, height: number): FaceTexture {
  return spriteToFaceTexture(pixels, width, height);
}

/**
 * Assemble the village from decoded library assets. Pure: given the tile face
 * textures and the prop voxel grids (keyed by their library id), it returns the
 * placed models, hero start and roam bounds — no I/O, so a test can hand it
 * fixture assets and assert the world it produces.
 */
export function assembleVillageWorld(
  tiles: ReadonlyMap<TileAssetId, FaceTexture>,
  props: ReadonlyMap<PropAssetId, VoxelGrid>,
): Hd2dWorld {
  const rows = TERRAIN_MAP.length;
  const cols = TERRAIN_MAP[0]!.length;

  // The shared terrain atlas, in TILE_ASSETS order; a missing tile is skipped so
  // a partial library still yields a (flatter) world rather than throwing.
  const atlas: TextureAtlas = {
    tiles: TILE_ASSETS.map((id) => tiles.get(id)).filter((t): t is FaceTexture => t !== undefined),
  };

  const models: PlacedModel[] = [];

  // Ground: one voxel per cell, skinned with the cell's terrain tile.
  const ground = new VoxelGrid(cols, 1, rows);
  for (let j = 0; j < rows; j += 1) {
    for (let i = 0; i < cols; i += 1) {
      const slot = TILE_CHAR_SLOT[TERRAIN_MAP[j]![i]!] ?? 0;
      // Tint the base voxel toward the tile so a face with no atlas still reads.
      ground.set(i, 0, j, 255, 255, 255, 0, slot);
    }
  }
  models.push({
    model: voxelGridToModel(ground, {
      center: "content",
      tileForCell: (x, _y, z) => TILE_CHAR_SLOT[TERRAIN_MAP[z]![x]!] ?? 0,
    }),
    position: [0, GROUND_TOP_Y - 0.5, 0],
    atlas,
  });

  // Props: each library voxel prop placed on its named cell, lifted so its base
  // rests on the ground (content-centred models sit centred on their origin).
  for (const placement of PROP_PLACEMENTS) {
    const grid = props.get(placement.asset);
    if (!grid) continue; // skip absent assets rather than crash
    const height = contentHeight(grid);
    models.push({
      model: voxelGridToModel(grid, { center: "content" }),
      position: [
        gridToWorldX(placement.col, cols),
        GROUND_TOP_Y + height / 2,
        gridToWorldZ(placement.row, rows),
      ],
    });
  }

  // Start the hero on the grass just off the path, free to roam most of the field.
  const start: [number, number, number] = [gridToWorldX(9, cols), 0, gridToWorldZ(6, rows)];
  return {
    models,
    start,
    bounds: { radiusX: cols / 2 - 1.5, radiusZ: rows / 2 - 1.5 },
  };
}

// --- Async library loading (browser) -----------------------------------------

/** Minimal shape of the library manifest this module reads. */
interface ManifestLike {
  readonly assets: ReadonlyArray<{ readonly id: string; readonly payloadUrl: string }>;
}

/** Fetch the library manifest and index payload URLs by asset id. */
async function loadAssetUrls(baseUrl: string): Promise<Map<string, string>> {
  const response = await fetch(`${baseUrl}/library/manifest.json`, { cache: "default" });
  if (!response.ok) throw new Error(`library manifest request failed (${response.status})`);
  const manifest = (await response.json()) as ManifestLike;
  const urls = new Map<string, string>();
  for (const asset of manifest.assets) urls.set(asset.id, asset.payloadUrl);
  return urls;
}

/** Decode a PNG at `url` into straight-alpha RGBA pixels via the browser codec. */
async function loadImagePixels(url: string): Promise<{ pixels: Uint8ClampedArray; width: number; height: number }> {
  const blob = await (await fetch(url)).blob();
  const bitmap = await createImageBitmap(blob);
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const context = canvas.getContext("2d");
  if (!context) throw new Error("2D canvas unavailable for tile decode");
  context.drawImage(bitmap, 0, 0);
  const { data } = context.getImageData(0, 0, bitmap.width, bitmap.height);
  return { pixels: new Uint8ClampedArray(data), width: bitmap.width, height: bitmap.height };
}

/** Fetch and parse a `.vox` payload into a VoxelGrid. */
async function loadVoxelGrid(url: string): Promise<VoxelGrid> {
  const buffer = await (await fetch(url)).arrayBuffer();
  return parseVox(new Uint8Array(buffer));
}

/**
 * Load the village world from the asset library. Reads the manifest, resolves
 * each tile and prop asset to its payload, decodes them (PNG → face texture,
 * `.vox` → voxel grid), and hands the decoded assets to
 * {@link assembleVillageWorld}. `baseUrl` prefixes the manifest path ("" =
 * same-origin, the local library).
 */
export async function loadVillageWorld(baseUrl = ""): Promise<Hd2dWorld> {
  const urls = await loadAssetUrls(baseUrl);

  const tiles = new Map<TileAssetId, FaceTexture>();
  await Promise.all(
    TILE_ASSETS.map(async (id) => {
      const url = urls.get(id);
      if (!url) return;
      const { pixels, width, height } = await loadImagePixels(url);
      tiles.set(id, tileTextureFromPixels(pixels, width, height));
    }),
  );

  const props = new Map<PropAssetId, VoxelGrid>();
  await Promise.all(
    PROP_ASSETS.map(async (id) => {
      const url = urls.get(id);
      if (!url) return;
      props.set(id, await loadVoxelGrid(url));
    }),
  );

  return assembleVillageWorld(tiles, props);
}
