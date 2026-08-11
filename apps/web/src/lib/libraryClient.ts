/**
 * Browser-side access to the asset library: query the `/api/library` endpoint,
 * and fetch a chosen asset's payload and turn it into an editor model ready to
 * insert. This is the client half of {@link libraryRoute} — the query string it
 * builds is exactly what that module parses back.
 *
 * The query-string builder is pure and exported so it is testable without a
 * network; the fetches are thin wrappers around it. Mesh payloads are decoded
 * with the same `@cartbox/editor` codecs the file-import path uses, so a library
 * mesh and an uploaded mesh land in the cart through identical code.
 */

import { parseGlb, parseGltfText, parseVox, type MeshAsset, type VoxelGrid } from "@cartbox/editor";

import type { LibraryAssetKind } from "./libraryManifest";
import type { LibraryQuery } from "./librarySearch";
import type { LibraryResponse } from "./libraryRoute";

/** Build the `/api/library` query string from a query and paging intent. */
export function buildLibraryQueryString(
  query: LibraryQuery = {},
  page = 0,
  pageSize?: number,
): string {
  const params = new URLSearchParams();
  if (query.text) params.set("q", query.text);
  for (const kind of query.kinds ?? []) params.append("kind", kind);
  for (const category of query.categories ?? []) params.append("category", category);
  for (const tag of query.tags ?? []) params.append("tag", tag);
  if (page > 0) params.set("page", String(page));
  if (pageSize !== undefined) params.set("pageSize", String(pageSize));
  const query_ = params.toString();
  return query_ ? `?${query_}` : "";
}

/** Fetch a page of library results for a query. Throws on a non-OK response. */
export async function fetchLibrary(
  query: LibraryQuery = {},
  page = 0,
  pageSize?: number,
): Promise<LibraryResponse> {
  const response = await fetch(`/api/library${buildLibraryQueryString(query, page, pageSize)}`, {
    // The catalogue is small and rarely changes; letting the browser cache it
    // keeps re-opening the browser instant without a stale-data risk that matters.
    cache: "default",
  });
  if (!response.ok) {
    throw new Error(`Asset library request failed (${response.status})`);
  }
  return (await response.json()) as LibraryResponse;
}

/** The lowercase extension of a payload URL, without the dot. */
function extensionOf(url: string): string {
  const withoutQuery = url.split(/[?#]/)[0] ?? url;
  const match = /\.([^.]+)$/.exec(withoutQuery.toLowerCase());
  return match ? match[1]! : "";
}

/**
 * Fetch a library asset's mesh payload and decode it to a {@link MeshAsset}.
 * Library meshes are self-contained `.glb` (texture embedded) — the format the
 * ingestion pipeline exports — with `.gltf` accepted for completeness. An
 * unexpected extension is a clear error rather than a corrupt insert.
 */
export async function fetchLibraryMesh(payloadUrl: string, name: string): Promise<MeshAsset> {
  const response = await fetch(payloadUrl);
  if (!response.ok) {
    throw new Error(`Could not download “${name}” (${response.status})`);
  }
  const extension = extensionOf(payloadUrl);
  if (extension === "glb") {
    return parseGlb(new Uint8Array(await response.arrayBuffer()), name);
  }
  if (extension === "gltf") {
    return parseGltfText(await response.text(), name);
  }
  throw new Error(`Library mesh “${name}” has an unsupported format ".${extension}".`);
}

/**
 * Fetch a library asset's voxel payload and decode it to a {@link VoxelGrid}.
 * Voxel assets ship as MagicaVoxel `.vox`, which {@link parseVox} reads directly;
 * the caller serialises the grid into a cart's voxel sidecar. An unexpected
 * extension is a clear error rather than a corrupt insert.
 */
export async function fetchLibraryVoxel(payloadUrl: string, name: string): Promise<VoxelGrid> {
  const response = await fetch(payloadUrl);
  if (!response.ok) {
    throw new Error(`Could not download “${name}” (${response.status})`);
  }
  const extension = extensionOf(payloadUrl);
  if (extension === "vox") {
    return parseVox(new Uint8Array(await response.arrayBuffer()));
  }
  throw new Error(`Library voxel “${name}” has an unsupported format ".${extension}".`);
}

/** An RGBA image decoded from a payload, shaped for `SpriteSheet.importImage`. */
export interface DecodedSpriteImage {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

/**
 * Fetch a library asset's sprite/tile payload (a PNG) and decode it to RGBA.
 * Decoding uses the browser's image pipeline — the sprite sheet then snaps each
 * pixel to the cart palette on import, so this need only produce straight RGBA.
 */
export async function fetchLibrarySprite(payloadUrl: string, name: string): Promise<DecodedSpriteImage> {
  const response = await fetch(payloadUrl);
  if (!response.ok) {
    throw new Error(`Could not download “${name}” (${response.status})`);
  }
  const bitmap = await createImageBitmap(await response.blob());
  try {
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Could not read image pixels (no 2D canvas).");
    context.drawImage(bitmap, 0, 0);
    const { data, width, height } = context.getImageData(0, 0, bitmap.width, bitmap.height);
    return { data, width, height };
  } finally {
    bitmap.close();
  }
}

/** Kinds this build can insert from the library, guarding the UI's insert paths. */
export const INSERTABLE_MESH_KINDS: readonly LibraryAssetKind[] = ["mesh"];
export const INSERTABLE_VOXEL_KINDS: readonly LibraryAssetKind[] = ["voxel"];
export const INSERTABLE_SPRITE_KINDS: readonly LibraryAssetKind[] = ["sprite", "tile"];
