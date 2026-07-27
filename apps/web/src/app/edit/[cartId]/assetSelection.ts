/**
 * Which assets a medium shows, and which of them is being edited.
 *
 * Pure functions rather than logic inline in the Assets container, because these
 * are the fiddly parts — a sculpt's lattice is buried in its serialized grid, a
 * sprite asset is matched by coordinates rather than remembered, and a stale
 * selection has to resolve to something sensible instead of to nothing. All three
 * are worth testing directly, and none of them needs React to be true.
 */

import { deserializeCellShape, type CellShape } from "@cartbox/editor";

import { spriteBlockAssets, voxelGridAssets, type SpriteBlockAsset, type VoxelGridAsset } from "@/lib/cartAssets";

import type { CartAsset } from "@/lib/cartAssets";
import type { AssetMedium } from "./AssetStrip";
import type { SpriteSelection } from "./SpriteEditor";

/** The lattice a 3D medium sculpts on; null for the pixel medium. */
export function shapeForMedium(medium: AssetMedium): CellShape | null {
  if (medium === "voxels") return "cube";
  if (medium === "hexels") return "hexel";
  return null;
}

/** The medium a sculpt belongs to, read from the lattice its grid was saved on. */
export function mediumForSculpt(sculpt: VoxelGridAsset): AssetMedium {
  return deserializeCellShape(sculpt.grid) === "hexel" ? "hexels" : "voxels";
}

/**
 * The sculpts on one lattice.
 *
 * A sculpt's cell shape is a property of the model, stored inside its serialized
 * grid, so this reads it back rather than trusting a separate field that could
 * disagree with the payload.
 */
export function sculptsForMedium(assets: readonly CartAsset[], medium: AssetMedium): VoxelGridAsset[] {
  const shape = shapeForMedium(medium);
  if (!shape) return [];
  return voxelGridAssets(assets).filter((sculpt) => deserializeCellShape(sculpt.grid) === shape);
}

/** What the strip lists for a medium: sprite blocks in this bank, or sculpts. */
export function assetsForMedium(
  assets: readonly CartAsset[],
  medium: AssetMedium,
  bank: number,
): readonly CartAsset[] {
  return medium === "pixels" ? spriteBlockAssets(assets, bank) : sculptsForMedium(assets, medium);
}

/**
 * The sprite asset naming exactly this block, or null.
 *
 * Derived from the selection rather than stored, so moving the tile picker off a
 * named block deselects it. The alternative — remembering the last chosen asset —
 * leaves the strip claiming you are editing "Hero" while the canvas shows some
 * unrelated tile.
 */
export function blockIdAt(blocks: readonly SpriteBlockAsset[], selection: SpriteSelection): string | null {
  const match = blocks.find(
    (block) =>
      block.page === selection.page &&
      block.tile === selection.tile &&
      block.tilesPerSide === selection.tilesPerSide,
  );
  return match?.id ?? null;
}

/** The selection a sprite asset stands for. */
export function selectionForBlock(block: SpriteBlockAsset): SpriteSelection {
  return { page: block.page, tile: block.tile, tilesPerSide: block.tilesPerSide };
}

/**
 * Which sculpt the sculptor should edit: the chosen one if it is still on this
 * lattice, else the medium's first, else none.
 *
 * "None" is not a failure — it means the sculptor edits the cart's main sculpt,
 * which is exactly what a cart that has never named an asset has, and what keeps
 * such a cart re-encoding to the bytes it was stored with.
 */
export function resolveSculptId(sculpts: readonly VoxelGridAsset[], chosen: string | null): string | null {
  if (chosen && sculpts.some((sculpt) => sculpt.id === chosen)) return chosen;
  return sculpts[0]?.id ?? null;
}
