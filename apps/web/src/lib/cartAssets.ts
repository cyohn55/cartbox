/**
 * The cart's named assets.
 *
 * Until now a cart's authored art was addressed positionally: sprites by tile
 * number, and the 3D sculpt as *the* sculpt — exactly one per cart, with nowhere
 * to put a second. That is the whole reason the editor needs one tab per medium;
 * there is no list of things to browse, only two fixed slots. This module gives
 * both mediums the same shape — an id, a name, and enough addressing to find the
 * art — so an editor can offer "which asset are you working on?" as a question.
 *
 * The two kinds are deliberately asymmetric, because the underlying storage is:
 *
 * - A **sprite block** is a *reference*, never a container. The `.tic` format
 *   pins the sprite sheet — fixed size, two pages, one sheet per bank — so a
 *   named sprite is a coordinate into that sheet (which bank, which page, which
 *   tile, how many tiles across). Deleting one frees nothing and changes no
 *   pixels; it only forgets the name.
 * - A **voxel grid** is a *payload*. Sculpts have no home in the `.tic` banks at
 *   all, so the asset carries the serialized grid itself, plus the sprite
 *   materials skinning it (the grid stores only material indices, which mean
 *   nothing without the list they index into).
 *
 * Everything here is pure data — no DOM, no React — and every reader is
 * defensive, because these values arrive from storage and the API. A malformed
 * entry is dropped rather than thrown on: losing one asset's name is a far better
 * failure than an editor that will not mount.
 */

import { BANK_COUNT, type SpritePage } from "@cartbox/editor";

import { isSpriteRef, type SpriteMaterial } from "./spriteTiles";

/** Discriminators for the asset union. */
export const SPRITE_BLOCK_KIND = "spriteBlock";
export const VOXEL_GRID_KIND = "voxelGrid";

/**
 * Sprite sizes an asset can name, as tiles per side — the same 8×8 / 16×16 /
 * 32×32 blocks the sprite editor authors.
 */
export const SPRITE_BLOCK_SIZES: readonly number[] = [1, 2, 4];

/**
 * Sanity ceiling on a tile index. The real bound is the live sheet's
 * `tilesPerPage`, which this module has no access to; like the sculpt's
 * dimension check, this rejects absurd values structurally and leaves the exact
 * check to the editor, which has the sheet in hand.
 */
export const MAX_TILE_INDEX = 4096;

/** Longest asset name kept, in characters. Long enough to be descriptive. */
export const MAX_ASSET_NAME_CHARS = 64;

/** Ceiling on how many assets one cart may carry, so a payload stays bounded. */
export const MAX_CART_ASSETS = 256;

/** What every asset has, whatever it addresses. */
interface AssetIdentity {
  /** Stable across renames — what other records point at. */
  readonly id: string;
  /** The author's label. Never empty; readers substitute a default. */
  readonly name: string;
}

/** A named region of the sprite sheet: a coordinate, not a copy of the pixels. */
export interface SpriteBlockAsset extends AssetIdentity {
  readonly kind: typeof SPRITE_BLOCK_KIND;
  /** Sprite sheets are per-bank, so a block is only meaningful within its own. */
  readonly bank: number;
  readonly page: SpritePage;
  /** Index of the block's top-left tile within the page. */
  readonly tile: number;
  /** Block size in tiles per side; one of {@link SPRITE_BLOCK_SIZES}. */
  readonly tilesPerSide: number;
}

/** A named sculpt, carrying its own grid because the .tic banks have no room. */
export interface VoxelGridAsset extends AssetIdentity {
  readonly kind: typeof VOXEL_GRID_KIND;
  /** Serialized `VoxelGrid` payload. */
  readonly grid: string;
  /** Sprite-backed materials, in the order their indices follow the base atlas. */
  readonly spriteMaterials: readonly SpriteMaterial[];
}

export type CartAsset = SpriteBlockAsset | VoxelGridAsset;
export type CartAssetKind = CartAsset["kind"];

/**
 * The id given to the sculpt a pre-assets cart carried.
 *
 * Fixed rather than generated: migration runs on every load of an old cart, and
 * a fresh id each time would make the same stored bytes decode to a different
 * value every read — breaking round-tripping and the "unchanged carts save
 * byte-identical" guarantee the sidecar depends on.
 */
export const PRIMARY_VOXEL_ASSET_ID = "voxel-primary";

/** The name that migrated sculpt is given, and the default for the first new one. */
export const PRIMARY_VOXEL_ASSET_NAME = "Model 1";

/**
 * A fresh asset id. Prefers `crypto.randomUUID` and falls back to a timestamped
 * counter where it is unavailable, since ids only need to be unique within one
 * cart's list.
 */
let idCounter = 0;
export function createAssetId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  idCounter += 1;
  return `asset-${Date.now().toString(36)}-${idCounter}`;
}

/** Narrow an asset to a sculpt. */
export function isVoxelGridAsset(asset: CartAsset): asset is VoxelGridAsset {
  return asset.kind === VOXEL_GRID_KIND;
}

/** Narrow an asset to a sprite-sheet region. */
export function isSpriteBlockAsset(asset: CartAsset): asset is SpriteBlockAsset {
  return asset.kind === SPRITE_BLOCK_KIND;
}

/** Every sculpt in the list, in order. */
export function voxelGridAssets(assets: readonly CartAsset[]): VoxelGridAsset[] {
  return assets.filter(isVoxelGridAsset);
}

/**
 * Every sprite block in the list, optionally narrowed to one bank.
 *
 * Sprite assets are bank-scoped because the sheet they point into is; a browser
 * showing all of them at once would list coordinates that mean nothing in the
 * bank currently open.
 */
export function spriteBlockAssets(assets: readonly CartAsset[], bank?: number): SpriteBlockAsset[] {
  const blocks = assets.filter(isSpriteBlockAsset);
  return bank === undefined ? blocks : blocks.filter((block) => block.bank === bank);
}

/** The asset with this id, or null when the list has no such entry. */
export function findAsset(assets: readonly CartAsset[], id: string | null): CartAsset | null {
  if (!id) return null;
  return assets.find((asset) => asset.id === id) ?? null;
}

/**
 * Replace the asset sharing this one's id, or append it when the list has none.
 *
 * Position is preserved on replace so editing an asset never reorders the list
 * out from under whatever is displaying it.
 */
export function upsertAsset(assets: readonly CartAsset[], asset: CartAsset): CartAsset[] {
  const index = assets.findIndex((entry) => entry.id === asset.id);
  if (index < 0) return [...assets, asset];
  const next = [...assets];
  next[index] = asset;
  return next;
}

/** The list without the asset of this id. */
export function removeAsset(assets: readonly CartAsset[], id: string): CartAsset[] {
  return assets.filter((asset) => asset.id !== id);
}

/**
 * The list with one asset moved to sit immediately before another — or at the
 * end, when `beforeId` is null.
 *
 * Expressed in terms of a *neighbour* rather than an index because the browser
 * reorders within a filtered view (one medium, one bank), where positions are
 * the filtered list's and mean nothing in the full one. Two real ids do mean the
 * same thing in both.
 *
 * Moving an asset onto itself, or naming an id the list does not hold, leaves the
 * order untouched.
 */
export function moveAssetBefore(
  assets: readonly CartAsset[],
  id: string,
  beforeId: string | null,
): CartAsset[] {
  if (id === beforeId) return [...assets];
  const moving = assets.find((asset) => asset.id === id);
  if (!moving) return [...assets];
  if (beforeId !== null && !assets.some((asset) => asset.id === beforeId)) return [...assets];

  const without = assets.filter((asset) => asset.id !== id);
  if (beforeId === null) return [...without, moving];

  const target = without.findIndex((asset) => asset.id === beforeId);
  return [...without.slice(0, target), moving, ...without.slice(target)];
}

/**
 * A copy of an asset, with a fresh id and an unused name.
 *
 * Copying a sprite block copies only the *name and coordinates* — both entries
 * then point at the same pixels, which is the honest meaning of duplicating a
 * reference. Copying a sculpt copies its grid, giving a genuinely independent
 * model to diverge from.
 */
export function duplicateAsset(assets: readonly CartAsset[], id: string): CartAsset[] {
  const source = assets.find((asset) => asset.id === id);
  if (!source) return [...assets];

  const copy: CartAsset = { ...source, id: createAssetId(), name: copyName(source.name, assets) };
  const index = assets.findIndex((asset) => asset.id === id);
  return [...assets.slice(0, index + 1), copy, ...assets.slice(index + 1)];
}

/** "Hero" → "Hero copy", then "Hero copy 2", … — the first name not in use. */
function copyName(name: string, assets: readonly CartAsset[]): string {
  const taken = new Set(assets.map((asset) => asset.name));
  const base = `${name} copy`.slice(0, MAX_ASSET_NAME_CHARS);
  if (!taken.has(base)) return base;
  for (let ordinal = 2; ordinal <= assets.length + 2; ordinal += 1) {
    const candidate = `${base} ${ordinal}`.slice(0, MAX_ASSET_NAME_CHARS);
    if (!taken.has(candidate)) return candidate;
  }
  return base;
}

/** The list with one asset renamed; a blank name is rejected and changes nothing. */
export function renameAsset(assets: readonly CartAsset[], id: string, name: string): CartAsset[] {
  const clean = cleanName(name);
  if (!clean) return [...assets];
  return assets.map((asset) => (asset.id === id ? { ...asset, name: clean } : asset));
}

/**
 * An unused name of the form "Model 3" / "Sprite 2", so a newly created asset
 * arrives with something meaningful rather than "Untitled".
 */
export function defaultAssetName(kind: CartAssetKind, assets: readonly CartAsset[]): string {
  const stem = kind === VOXEL_GRID_KIND ? "Model" : "Sprite";
  const taken = new Set(assets.map((asset) => asset.name));
  for (let ordinal = 1; ordinal <= assets.length + 1; ordinal += 1) {
    const candidate = `${stem} ${ordinal}`;
    if (!taken.has(candidate)) return candidate;
  }
  // Unreachable: the loop tries one more name than there are assets, so at least
  // one candidate is always free. Kept total rather than relying on that.
  return `${stem} ${assets.length + 1}`;
}

/** Trim a name to something storable, or null when nothing is left of it. */
function cleanName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  return trimmed.slice(0, MAX_ASSET_NAME_CHARS);
}

/**
 * Read an asset list from a decoded payload, keeping only well-formed entries.
 *
 * Anything unreadable is dropped: a wrong-shaped entry, a duplicate id (the first
 * wins, since a later one would silently shadow it), or anything past
 * {@link MAX_CART_ASSETS}.
 */
export function readCartAssets(value: unknown): CartAsset[] {
  if (!Array.isArray(value)) return [];

  const assets: CartAsset[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (assets.length >= MAX_CART_ASSETS) break;
    const asset = readCartAsset(entry);
    if (!asset || seen.has(asset.id)) continue;
    seen.add(asset.id);
    assets.push(asset);
  }
  return assets;
}

/** Read one asset, or null when it is not a shape this version understands. */
function readCartAsset(value: unknown): CartAsset | null {
  if (typeof value !== "object" || value === null) return null;
  const entry = value as Record<string, unknown>;

  const id = typeof entry.id === "string" && entry.id.trim() !== "" ? entry.id.trim() : null;
  if (!id) return null;
  const name = cleanName(entry.name);
  if (!name) return null;

  if (entry.kind === VOXEL_GRID_KIND) {
    if (typeof entry.grid !== "string" || entry.grid === "") return null;
    return {
      kind: VOXEL_GRID_KIND,
      id,
      name,
      grid: entry.grid,
      spriteMaterials: readSpriteMaterials(entry.spriteMaterials),
    };
  }

  if (entry.kind === SPRITE_BLOCK_KIND) {
    const { bank, page, tile, tilesPerSide } = entry;
    if (!Number.isInteger(bank) || (bank as number) < 0 || (bank as number) >= BANK_COUNT) return null;
    if (page !== 0 && page !== 1) return null;
    if (!Number.isInteger(tile) || (tile as number) < 0 || (tile as number) > MAX_TILE_INDEX) return null;
    if (!SPRITE_BLOCK_SIZES.includes(tilesPerSide as number)) return null;
    return {
      kind: SPRITE_BLOCK_KIND,
      id,
      name,
      bank: bank as number,
      page: page as SpritePage,
      tile: tile as number,
      tilesPerSide: tilesPerSide as number,
    };
  }

  return null;
}

/** Keep only well-formed materials; a corrupt entry is dropped, not thrown on. */
export function readSpriteMaterials(value: unknown): SpriteMaterial[] {
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
