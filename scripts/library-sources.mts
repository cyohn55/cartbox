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
];
