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

import { isSpriteRef, type SpriteMaterial } from "./spriteTiles";

/** Marks a payload as the wrapped form rather than a bare grid. */
export const VOXEL_SIDECAR_KIND = "cartbox.voxel";

/** Current envelope version, bumped only on a breaking change to the shape. */
export const VOXEL_SIDECAR_VERSION = 1;

/** What the Voxel tab persists: the sculpt, plus the sprite skins it uses. */
export interface VoxelSidecar {
  /** Serialized {@link VoxelGrid} payload, or null when there is no sculpt yet. */
  readonly grid: string | null;
  /** Sprite-backed materials, in the order their indices follow the base atlas. */
  readonly spriteMaterials: readonly SpriteMaterial[];
}

/** An empty sidecar — a cart with no sculpt and no sprite skins. */
export const EMPTY_VOXEL_SIDECAR: VoxelSidecar = { grid: null, spriteMaterials: [] };

/**
 * Encode a sidecar for saving. With no sprite materials the grid payload is
 * returned as-is, so nothing about existing carts changes; only a sculpt that
 * actually uses sprite skins pays for the envelope.
 */
export function encodeVoxelSidecar(sidecar: VoxelSidecar): string {
  const grid = sidecar.grid ?? "";
  if (sidecar.spriteMaterials.length === 0) return grid;
  return JSON.stringify({
    kind: VOXEL_SIDECAR_KIND,
    version: VOXEL_SIDECAR_VERSION,
    grid,
    spriteMaterials: sidecar.spriteMaterials,
  });
}

/**
 * Decode a saved payload. Accepts the envelope, a bare grid payload from before
 * sprite materials existed, and anything unreadable — the last two yield the
 * payload as the grid with no sprite materials, letting the grid loader make its
 * own (already guarded) attempt at it.
 */
export function decodeVoxelSidecar(raw: string | null): VoxelSidecar {
  if (!raw) return EMPTY_VOXEL_SIDECAR;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { grid: raw, spriteMaterials: [] };
  }
  if (typeof parsed !== "object" || parsed === null) return { grid: raw, spriteMaterials: [] };

  const envelope = parsed as { kind?: unknown; grid?: unknown; spriteMaterials?: unknown };
  if (envelope.kind !== VOXEL_SIDECAR_KIND || typeof envelope.grid !== "string") {
    return { grid: raw, spriteMaterials: [] }; // a bare grid payload
  }
  return {
    grid: envelope.grid === "" ? null : envelope.grid,
    spriteMaterials: readSpriteMaterials(envelope.spriteMaterials),
  };
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
