/**
 * The declarative source registry for the asset library. Each entry says what an
 * asset *is* (the catalogue metadata and its provenance) and where its payload
 * comes from (`origin`); the build script (`build-library.mts`) resolves each
 * origin to bytes, generates a thumbnail, and emits a validated manifest.
 *
 * Growing the library is editing this list, not touching the pipeline. Only
 * public-domain (CC0) assets belong here — the manifest parser rejects anything
 * else, so a non-CC0 entry fails the build rather than shipping.
 */

import type { LibraryAssetKind, LibraryLicense } from "../apps/web/src/lib/libraryManifest.ts";

/** How the pipeline obtains an asset's payload bytes. */
export type SourceOrigin =
  /** A file already staged under `apps/web/public/library` (path relative to it). */
  | { readonly kind: "local"; readonly path: string }
  /** A direct download of a CC0 payload (e.g. a Kenney pack file). */
  | { readonly kind: "http"; readonly url: string; readonly as: string }
  /**
   * A mesh fetched through the Blender MCP bridge (Poly Haven / Sketchfab) and
   * exported to `.glb`. Requires the bridge to be running; the build skips these
   * with a clear message when it is not, so the rest of the catalogue still ships.
   */
  | { readonly kind: "blender"; readonly query: string; readonly as: string };

/** One catalogue entry plus where to get its payload. */
export interface RegistrySource {
  readonly id: string;
  readonly name: string;
  readonly kind: LibraryAssetKind;
  readonly category: string;
  readonly tags: readonly string[];
  readonly provenance: {
    readonly source: string;
    readonly author: string;
    readonly license: LibraryLicense;
    readonly url: string;
  };
  readonly origin: SourceOrigin;
}

const KENNEY = { source: "Kenney", author: "Kenney", license: "CC0-1.0", url: "https://kenney.nl/assets" } as const;

/**
 * First-party public-domain art authored for Cartbox (see
 * `scripts/gen-village-assets.mts`). The "Village Pack" — terrain tiles, 2D
 * scenery sprites, and voxel props — exists so a whole HD-2D village can be
 * *composed from named library assets* instead of built by procedural code.
 */
const CARTBOX = {
  source: "Cartbox Village Pack",
  author: "Cartbox",
  license: "CC0-1.0",
  url: "https://cartbox.app/library/village",
} as const;

export const LIBRARY_SOURCES: readonly RegistrySource[] = [
  {
    id: "kenney-barrel",
    name: "Wooden Barrel",
    kind: "mesh",
    category: "props",
    tags: ["barrel", "container", "wood"],
    provenance: KENNEY,
    origin: { kind: "local", path: "meshes/kenney-barrel.glb" },
  },
  {
    id: "kenney-crate",
    name: "Crate",
    kind: "mesh",
    category: "props",
    tags: ["crate", "container", "wood"],
    provenance: KENNEY,
    origin: { kind: "local", path: "meshes/kenney-crate.glb" },
  },
  {
    id: "kenney-grass-tile",
    name: "Grass Tile",
    kind: "tile",
    category: "tilesets",
    tags: ["grass", "nature", "green", "terrain"],
    provenance: KENNEY,
    origin: { kind: "local", path: "sprites/kenney-grass-tile.png" },
  },
  {
    id: "voxel-pyramid",
    name: "Stepped Pyramid",
    kind: "voxel",
    category: "structures",
    tags: ["pyramid", "structure", "stone"],
    provenance: { source: "Cartbox samples", author: "Cartbox", license: "CC0-1.0", url: "https://kenney.nl/assets" },
    origin: { kind: "local", path: "voxels/kenney-pyramid.vox" },
  },

  // --- Village Pack: terrain tiles (2D, seamless) ----------------------------
  {
    id: "village-grass",
    name: "Village Grass",
    kind: "tile",
    category: "tilesets",
    tags: ["grass", "nature", "green", "terrain", "village"],
    provenance: CARTBOX,
    origin: { kind: "local", path: "sprites/village-grass.png" },
  },
  {
    id: "village-flowers",
    name: "Flowering Meadow",
    kind: "tile",
    category: "tilesets",
    tags: ["grass", "flowers", "meadow", "terrain", "village"],
    provenance: CARTBOX,
    origin: { kind: "local", path: "sprites/village-flowers.png" },
  },
  {
    id: "village-dirt-path",
    name: "Dirt Path",
    kind: "tile",
    category: "tilesets",
    tags: ["dirt", "path", "road", "terrain", "village"],
    provenance: CARTBOX,
    origin: { kind: "local", path: "sprites/village-dirt-path.png" },
  },
  {
    id: "village-cobble",
    name: "Cobblestone",
    kind: "tile",
    category: "tilesets",
    tags: ["stone", "cobble", "path", "terrain", "village"],
    provenance: CARTBOX,
    origin: { kind: "local", path: "sprites/village-cobble.png" },
  },
  {
    id: "village-water",
    name: "Pond Water",
    kind: "tile",
    category: "tilesets",
    tags: ["water", "pond", "blue", "terrain", "village"],
    provenance: CARTBOX,
    origin: { kind: "local", path: "sprites/village-water.png" },
  },

  // --- Village Pack: scenery sprites (2D billboards) -------------------------
  {
    id: "village-pine",
    name: "Pine Tree",
    kind: "sprite",
    category: "nature",
    tags: ["tree", "pine", "conifer", "nature", "village"],
    provenance: CARTBOX,
    origin: { kind: "local", path: "sprites/village-pine.png" },
  },
  {
    id: "village-oak",
    name: "Oak Tree",
    kind: "sprite",
    category: "nature",
    tags: ["tree", "oak", "round", "nature", "village"],
    provenance: CARTBOX,
    origin: { kind: "local", path: "sprites/village-oak.png" },
  },
  {
    id: "village-rock",
    name: "Boulder",
    kind: "sprite",
    category: "nature",
    tags: ["rock", "boulder", "stone", "nature", "village"],
    provenance: CARTBOX,
    origin: { kind: "local", path: "sprites/village-rock.png" },
  },
  {
    id: "village-bush",
    name: "Berry Bush",
    kind: "sprite",
    category: "nature",
    tags: ["bush", "shrub", "berries", "nature", "village"],
    provenance: CARTBOX,
    origin: { kind: "local", path: "sprites/village-bush.png" },
  },
  {
    id: "village-lantern",
    name: "Street Lantern",
    kind: "sprite",
    category: "props",
    tags: ["lantern", "lamp", "light", "props", "village"],
    provenance: CARTBOX,
    origin: { kind: "local", path: "sprites/village-lantern.png" },
  },
  {
    id: "village-house",
    name: "Cottage",
    kind: "sprite",
    category: "structures",
    tags: ["house", "cottage", "building", "structures", "village"],
    provenance: CARTBOX,
    origin: { kind: "local", path: "sprites/village-house.png" },
  },
  {
    id: "village-fence",
    name: "Wooden Fence",
    kind: "sprite",
    category: "props",
    tags: ["fence", "wood", "barrier", "props", "village"],
    provenance: CARTBOX,
    origin: { kind: "local", path: "sprites/village-fence.png" },
  },
  {
    id: "village-well",
    name: "Stone Well",
    kind: "sprite",
    category: "structures",
    tags: ["well", "water", "stone", "structures", "village"],
    provenance: CARTBOX,
    origin: { kind: "local", path: "sprites/village-well.png" },
  },

  // --- Village Pack: voxel props (for true-3D worlds) -----------------------
  {
    id: "village-tree-vox",
    name: "Voxel Tree",
    kind: "voxel",
    category: "nature",
    tags: ["tree", "nature", "voxel", "village"],
    provenance: CARTBOX,
    origin: { kind: "local", path: "voxels/village-tree.vox" },
  },
  {
    id: "village-rock-vox",
    name: "Voxel Boulder",
    kind: "voxel",
    category: "nature",
    tags: ["rock", "boulder", "voxel", "village"],
    provenance: CARTBOX,
    origin: { kind: "local", path: "voxels/village-rock.vox" },
  },
  {
    id: "village-house-vox",
    name: "Voxel Cottage",
    kind: "voxel",
    category: "structures",
    tags: ["house", "cottage", "voxel", "village"],
    provenance: CARTBOX,
    origin: { kind: "local", path: "voxels/village-house.vox" },
  },
  {
    id: "village-well-vox",
    name: "Voxel Well",
    kind: "voxel",
    category: "structures",
    tags: ["well", "voxel", "village"],
    provenance: CARTBOX,
    origin: { kind: "local", path: "voxels/village-well.vox" },
  },
  {
    id: "village-lamp-vox",
    name: "Voxel Lamp Post",
    kind: "voxel",
    category: "props",
    tags: ["lamp", "lantern", "light", "voxel", "village"],
    provenance: CARTBOX,
    origin: { kind: "local", path: "voxels/village-lamp.vox" },
  },
];
