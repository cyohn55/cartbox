/**
 * The Voxel tab's saved payload.
 *
 * A sculpt used to be exactly one thing — the serialized {@link VoxelGrid} — but
 * a sculpt skinned with sprite materials also needs to remember *which* sprites
 * skin it: the grid stores only material indices, and those mean nothing without
 * the list they index into. This module wraps the two in one envelope and, just
 * as importantly, keeps the old payload shape when there is nothing extra to say,
 * so carts saved before sprite materials existed load unchanged and carts that
 * don't use them still save byte-identical.
 *
 * Decoding is defensive: the payload comes back from storage or the API, so a
 * malformed envelope degrades to "no sprite materials" rather than throwing into
 * the editor's mount path.
 */

import { MAX_VOXEL_GRID_DIM } from "@cartbox/editor";

import { isSpriteRef, type SpriteMaterial } from "./spriteTiles";

/** Marks a payload as the wrapped form rather than a bare grid. */
export const VOXEL_SIDECAR_KIND = "cartbox.voxel";

/** Current envelope version, bumped only on a breaking change to the shape. */
export const VOXEL_SIDECAR_VERSION = 1;

/** What the cart's 3D payload holds: the sculpt, its skins, and the map's height. */
export interface VoxelSidecar {
  /** Serialized {@link VoxelGrid} payload, or null when there is no sculpt yet. */
  readonly grid: string | null;
  /** Sprite-backed materials, in the order their indices follow the base atlas. */
  readonly spriteMaterials: readonly SpriteMaterial[];
  /**
   * Serialized `MapVoxelLayer` — the Map tab's voxel/hexel columns — or null
   * when the map has no height authored. It rides in this envelope rather than
   * in a column of its own because it is the same kind of thing (3D data hung
   * off the cart) and the storage path for it already exists end to end.
   */
  readonly mapLayer: string | null;
}

/** An empty sidecar — a cart with no sculpt, no sprite skins and a flat map. */
export const EMPTY_VOXEL_SIDECAR: VoxelSidecar = { grid: null, spriteMaterials: [], mapLayer: null };

/**
 * Encode a sidecar for saving. With nothing beyond the sculpt to say, the grid
 * payload is returned as-is, so nothing about existing carts changes; only a
 * cart that uses sprite skins or map columns pays for the envelope.
 */
export function encodeVoxelSidecar(sidecar: VoxelSidecar): string {
  const grid = sidecar.grid ?? "";
  if (sidecar.spriteMaterials.length === 0 && !sidecar.mapLayer) return grid;
  return JSON.stringify({
    kind: VOXEL_SIDECAR_KIND,
    version: VOXEL_SIDECAR_VERSION,
    grid,
    spriteMaterials: sidecar.spriteMaterials,
    ...(sidecar.mapLayer ? { mapLayer: sidecar.mapLayer } : {}),
  });
}

/**
 * Re-encode a payload with some fields replaced, preserving everything else it
 * carried. The Map and Voxel tabs each own one part of this envelope; routing
 * their updates through here is what stops either from dropping the other's
 * work when it saves.
 */
export function mergeVoxelSidecar(raw: string | null, patch: Partial<VoxelSidecar>): string {
  return encodeVoxelSidecar({ ...decodeVoxelSidecar(raw), ...patch });
}

/**
 * Decode a saved payload. Accepts the envelope, a bare grid payload from before
 * sprite materials existed, and anything unreadable — the last two yield the
 * payload as the grid with no sprite materials, letting the grid loader make its
 * own (already guarded) attempt at it.
 */
export function decodeVoxelSidecar(raw: string | null): VoxelSidecar {
  if (!raw) return EMPTY_VOXEL_SIDECAR;

  const bare = (payload: string): VoxelSidecar => ({ grid: payload, spriteMaterials: [], mapLayer: null });

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return bare(raw);
  }
  if (typeof parsed !== "object" || parsed === null) return bare(raw);

  const envelope = parsed as { kind?: unknown; grid?: unknown; spriteMaterials?: unknown; mapLayer?: unknown };
  if (envelope.kind !== VOXEL_SIDECAR_KIND || typeof envelope.grid !== "string") {
    return bare(raw); // a bare grid payload
  }
  return {
    grid: envelope.grid === "" ? null : envelope.grid,
    spriteMaterials: readSpriteMaterials(envelope.spriteMaterials),
    mapLayer: typeof envelope.mapLayer === "string" && envelope.mapLayer !== "" ? envelope.mapLayer : null,
  };
}

/**
 * Ceiling on a saved payload, in characters. The payload is ASCII (JSON around
 * base64), so characters track bytes closely enough to bound a request; the value
 * sits under the 4.5 MB body limit a serverless deploy enforces, and far above any
 * real sculpt — a sparse 128³ model is tens of kilobytes.
 */
export const MAX_VOXEL_PAYLOAD_CHARS = 4_000_000;

/**
 * Validate a payload arriving from a client before it is stored: it must be a
 * bounded string that parses, and whose sculpt declares a grid the editor could
 * actually have produced. Returns the payload to store, or null to reject.
 *
 * Deliberately structural — the declared dimensions are checked *without*
 * building the grid, so a payload claiming a huge volume is rejected rather than
 * allocated. The editor re-validates for real when it loads the sculpt.
 */
export function parseVoxelPayload(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const payload = value.trim();
  if (payload === "" || payload.length > MAX_VOXEL_PAYLOAD_CHARS) return null;

  const sidecar = decodeVoxelSidecar(payload);
  // A cart may carry map columns without ever having a sculpt — the Map tab can
  // author height without the Voxel tab being opened — so either half is enough
  // to make the payload worth storing.
  if (!sidecar.grid) return sidecar.mapLayer ? payload : null;
  if (!describesAGrid(sidecar.grid)) return null;
  return payload;
}

/** Whether a serialized-grid payload declares dimensions the editor allows. */
function describesAGrid(grid: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(grid);
  } catch {
    return false;
  }
  if (typeof parsed !== "object" || parsed === null) return false;

  const { sizeX, sizeY, sizeZ, count } = parsed as Record<string, unknown>;
  const dims = [sizeX, sizeY, sizeZ];
  if (!dims.every((dim) => Number.isInteger(dim) && (dim as number) >= 1 && (dim as number) <= MAX_VOXEL_GRID_DIM)) {
    return false;
  }
  if (count === undefined) return true; // the v1 dense payload carries no count
  const volume = (sizeX as number) * (sizeY as number) * (sizeZ as number);
  return Number.isInteger(count) && (count as number) >= 0 && (count as number) <= volume;
}

/** Keep only well-formed materials; a corrupt entry is dropped, not thrown on. */
function readSpriteMaterials(value: unknown): SpriteMaterial[] {
  if (!Array.isArray(value)) return [];
  const materials: SpriteMaterial[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) continue;
    const { name, top, side, bottom } = entry as Partial<SpriteMaterial>;
    if (typeof name !== "string") continue;
    if (!isSpriteRef(top) || !isSpriteRef(side) || !isSpriteRef(bottom)) continue;
    materials.push({ name, top, side, bottom });
  }
  return materials;
}
