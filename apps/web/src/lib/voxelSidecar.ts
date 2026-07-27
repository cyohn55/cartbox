/**
 * The cart's authoring payload — everything the `.tic` banks have no room for.
 *
 * Stored in the cart row's `voxel` column, which is now a misnomer: it began as
 * one serialized {@link VoxelGrid} and has grown, in order, the sprite materials
 * skinning that sculpt, the Map tab's height columns, and now the cart's named
 * asset list. The column name is left alone deliberately — renaming it would be a
 * migration that buys nothing, since every reader goes through this module.
 *
 * Three payload shapes exist in storage, and all three must load:
 *
 * - **bare** — a serialized grid, from before any envelope existed.
 * - **v1** — `{kind, version: 1, grid, spriteMaterials, mapLayer?}`.
 * - **v2** — `{kind, version: 2, assets, mapLayer?}`, where `assets` is the cart's
 *   named asset list (see {@link ./cartAssets}).
 *
 * Encoding runs that ladder backwards, writing the *oldest* shape that can carry
 * the data: a cart with one unrenamed sculpt and nothing else still saves as the
 * bare grid string it always did, byte for byte. Only a cart that actually uses
 * the newer features pays for the newer envelope. That is what lets this ship
 * without a data migration — old carts are upgraded lazily, on their next save,
 * and only if the author does something that needs it.
 *
 * Decoding is defensive throughout: the payload comes back from storage or the
 * API, so a malformed envelope degrades to the most it can be read as rather than
 * throwing into the editor's mount path.
 */

import { MAX_VOXEL_GRID_DIM } from "@cartbox/editor";

import {
  PRIMARY_VOXEL_ASSET_ID,
  PRIMARY_VOXEL_ASSET_NAME,
  VOXEL_GRID_KIND,
  isSpriteBlockAsset,
  readCartAssets,
  readSpriteMaterials,
  voxelGridAssets,
  type CartAsset,
  type VoxelGridAsset,
} from "./cartAssets";
import type { SpriteMaterial } from "./spriteTiles";

/** Marks a payload as the wrapped form rather than a bare grid. */
export const VOXEL_SIDECAR_KIND = "cartbox.voxel";

/** The envelope version that first carried named assets. */
export const VOXEL_SIDECAR_VERSION = 2;

/** The envelope version that carried a single unnamed sculpt. */
export const VOXEL_SIDECAR_V1 = 1;

/** What the cart's authoring payload holds: its named assets and the map's height. */
export interface VoxelSidecar {
  /**
   * The cart's assets, sculpts and named sprite blocks alike. This is the only
   * representation of the sculpts — there is no separate "the grid" field, so
   * there is nothing for a caller to keep in sync.
   */
  readonly assets: readonly CartAsset[];
  /**
   * Serialized `MapVoxelLayer` — the Map tab's voxel/hexel columns — or null
   * when the map has no height authored. It rides in this envelope rather than
   * in a column of its own because it is the same kind of thing (data hung off
   * the cart) and the storage path for it already exists end to end.
   */
  readonly mapLayer: string | null;
}

/** An empty sidecar — a cart with no assets and a flat map. */
export const EMPTY_VOXEL_SIDECAR: VoxelSidecar = { assets: [], mapLayer: null };

/**
 * The cart's main sculpt: the first voxel asset, or null when it has none.
 *
 * The overwhelmingly common case is a cart with exactly one sculpt, and this is
 * how callers that don't care about the list ask for it.
 */
export function primaryVoxelAsset(sidecar: VoxelSidecar): VoxelGridAsset | null {
  return voxelGridAssets(sidecar.assets)[0] ?? null;
}

/** The sculpt with this id, or null when the cart has no such asset. */
export function voxelAssetById(sidecar: VoxelSidecar, id: string | null): VoxelGridAsset | null {
  if (!id) return null;
  return voxelGridAssets(sidecar.assets).find((asset) => asset.id === id) ?? null;
}

/**
 * A sidecar with one sculpt replaced — or created, when the id names none yet —
 * leaving every other asset and the map layer untouched.
 *
 * An empty grid removes the sculpt rather than storing a blank one, so clearing a
 * model returns the cart to the payload it had before one existed.
 *
 * `name` is used only when creating; an existing sculpt keeps the name it has, so
 * saving an edit can never silently rename the author's asset.
 */
export function withVoxelAsset(
  sidecar: VoxelSidecar,
  id: string,
  sculpt: { grid: string | null; spriteMaterials: readonly SpriteMaterial[] },
  name: string = PRIMARY_VOXEL_ASSET_NAME,
): VoxelSidecar {
  const existing = voxelAssetById(sidecar, id);

  if (!sculpt.grid) {
    return { ...sidecar, assets: existing ? sidecar.assets.filter((a) => a.id !== id) : sidecar.assets };
  }

  const next: VoxelGridAsset = {
    kind: VOXEL_GRID_KIND,
    id,
    name: existing?.name ?? name,
    grid: sculpt.grid,
    spriteMaterials: sculpt.spriteMaterials,
  };

  if (!existing) return { ...sidecar, assets: [...sidecar.assets, next] };
  return { ...sidecar, assets: sidecar.assets.map((asset) => (asset.id === id ? next : asset)) };
}

/**
 * A sidecar whose main sculpt has been replaced. The one-sculpt shorthand for
 * {@link withVoxelAsset}, and what a cart with no asset browser still goes
 * through — a cart that has never named an asset keeps the migration identity,
 * which is what lets it re-encode to its original bytes.
 */
export function withPrimaryVoxel(
  sidecar: VoxelSidecar,
  sculpt: { grid: string | null; spriteMaterials: readonly SpriteMaterial[] },
): VoxelSidecar {
  return withVoxelAsset(sidecar, primaryVoxelAsset(sidecar)?.id ?? PRIMARY_VOXEL_ASSET_ID, sculpt);
}

/**
 * Encode a sidecar for saving, in the oldest shape that can carry it.
 *
 * The ladder, cheapest first:
 * 1. nothing to say → the empty string;
 * 2. one untouched sculpt, nothing else → the bare grid payload;
 * 3. one untouched sculpt plus skins and/or map columns → the v1 envelope;
 * 4. anything else (a second asset, a named sprite block, a renamed sculpt) → v2.
 *
 * Steps 2 and 3 are what keep carts saved before assets existed byte-identical
 * across a load-and-save, so shipping this rewrites nobody's stored payload.
 */
export function encodeVoxelSidecar(sidecar: VoxelSidecar): string {
  const sculpts = voxelGridAssets(sidecar.assets);
  const hasSpriteBlocks = sidecar.assets.some(isSpriteBlockAsset);

  if (sculpts.length === 0 && !hasSpriteBlocks && !sidecar.mapLayer) return "";

  // "Untouched" means a lone sculpt still carrying the identity a migrated
  // pre-assets cart is given — nothing a v1 reader would lose by ignoring.
  const lone = sculpts.length === 1 && !hasSpriteBlocks ? sculpts[0]! : null;
  const legacy = lone && lone.id === PRIMARY_VOXEL_ASSET_ID && lone.name === PRIMARY_VOXEL_ASSET_NAME ? lone : null;

  if (legacy) {
    if (legacy.spriteMaterials.length === 0 && !sidecar.mapLayer) return legacy.grid;
    return JSON.stringify({
      kind: VOXEL_SIDECAR_KIND,
      version: VOXEL_SIDECAR_V1,
      grid: legacy.grid,
      spriteMaterials: legacy.spriteMaterials,
      ...(sidecar.mapLayer ? { mapLayer: sidecar.mapLayer } : {}),
    });
  }

  // A cart with no sculpt but with map columns predates assets too, and a v1
  // reader understands it; keep writing v1 unless there are assets to name.
  if (sculpts.length === 0 && !hasSpriteBlocks) {
    return JSON.stringify({
      kind: VOXEL_SIDECAR_KIND,
      version: VOXEL_SIDECAR_V1,
      grid: "",
      spriteMaterials: [],
      ...(sidecar.mapLayer ? { mapLayer: sidecar.mapLayer } : {}),
    });
  }

  return JSON.stringify({
    kind: VOXEL_SIDECAR_KIND,
    version: VOXEL_SIDECAR_VERSION,
    assets: sidecar.assets,
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
 * Decode a saved payload — v2, v1, a bare grid, or anything unreadable.
 *
 * The older shapes are migrated on the way through: a v1 envelope's or a bare
 * payload's sculpt becomes a single named asset with a fixed id, so the rest of
 * the app only ever sees the asset list and never has to ask which era a cart
 * came from.
 */
export function decodeVoxelSidecar(raw: string | null): VoxelSidecar {
  if (!raw) return EMPTY_VOXEL_SIDECAR;

  const bare = (payload: string): VoxelSidecar => ({
    assets: [primaryAsset(payload, [])],
    mapLayer: null,
  });

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return bare(raw);
  }
  if (typeof parsed !== "object" || parsed === null) return bare(raw);

  const envelope = parsed as {
    kind?: unknown;
    version?: unknown;
    grid?: unknown;
    spriteMaterials?: unknown;
    assets?: unknown;
    mapLayer?: unknown;
  };
  if (envelope.kind !== VOXEL_SIDECAR_KIND) return bare(raw); // a bare grid payload

  const mapLayer =
    typeof envelope.mapLayer === "string" && envelope.mapLayer !== "" ? envelope.mapLayer : null;

  // v2 and later: the asset list is authoritative. Keyed on the field being
  // *present*, not on it being well-formed — a payload written by a newer client
  // must still yield its assets rather than be mistaken for a v1 envelope with an
  // empty grid, and a corrupt list degrades to no assets inside readCartAssets.
  if ("assets" in envelope) {
    return { assets: readCartAssets(envelope.assets), mapLayer };
  }

  // v1: one unnamed sculpt, migrated to the primary asset. A missing or
  // non-string grid is an envelope we cannot read, which is not the same thing as
  // a bare grid payload — it degrades to an empty cart, never to itself-as-a-grid.
  if (typeof envelope.grid !== "string") return { assets: [], mapLayer };
  const materials = readSpriteMaterials(envelope.spriteMaterials);
  return {
    assets: envelope.grid === "" ? [] : [primaryAsset(envelope.grid, materials)],
    mapLayer,
  };
}

/** The migrated sculpt of a pre-assets cart, with its fixed id and default name. */
function primaryAsset(grid: string, spriteMaterials: readonly SpriteMaterial[]): VoxelGridAsset {
  return {
    kind: VOXEL_GRID_KIND,
    id: PRIMARY_VOXEL_ASSET_ID,
    name: PRIMARY_VOXEL_ASSET_NAME,
    grid,
    spriteMaterials,
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
 * bounded string that parses, and whose every sculpt declares a grid the editor
 * could actually have produced. Returns the payload to store, or null to reject.
 *
 * Deliberately structural — declared dimensions are checked *without* building
 * any grid, so a payload claiming a huge volume is rejected rather than
 * allocated. The editor re-validates for real when it loads a sculpt.
 */
export function parseVoxelPayload(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const payload = value.trim();
  if (payload === "" || payload.length > MAX_VOXEL_PAYLOAD_CHARS) return null;

  const sidecar = decodeVoxelSidecar(payload);
  const sculpts = voxelGridAssets(sidecar.assets);

  // A cart may carry map columns or named sprite blocks without ever having a
  // sculpt — the Map and Sprites tabs can author without the Voxel tab being
  // opened — so any of the three is enough to make the payload worth storing.
  if (sculpts.length === 0) {
    return sidecar.mapLayer || sidecar.assets.length > 0 ? payload : null;
  }
  // One malformed sculpt rejects the payload rather than being silently dropped:
  // this is a write path, and quietly storing less than was sent loses work.
  if (!sculpts.every((sculpt) => describesAGrid(sculpt.grid))) return null;
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
