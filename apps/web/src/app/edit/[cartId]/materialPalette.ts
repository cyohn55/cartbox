/**
 * The material palette, as every tab that has one offers it.
 *
 * Two tabs let you arm a material — the voxel sculptor and the map's 3D view —
 * and both had built the same picker by hand: a "flat" chip that means *no*
 * material, then {@link BUILD_MATERIALS} in table order, then whatever sprite
 * skins that tab knows about. Same chips, same meaning, two copies, and only one
 * of them had a readout saying which was armed.
 *
 * Worse, they disagreed on where it lived — the sculptor in the left rail, the
 * map in the right inspector — so the same choice was in two places depending on
 * which tab you were in. That is the layout half, fixed by the slot contract in
 * {@link ./workbenchLayout}; this is the content half.
 *
 * Pure data and naming, so the options a picker shows and the label it reads out
 * are testable without rendering anything.
 */

import { BUILD_MATERIALS } from "@/lib/faceTextures";
import { materialSpriteTile } from "@/lib/mapAtlas";

/**
 * The armed-material value meaning "no material".
 *
 * Both callers already had a constant for this — `MATERIAL_NONE` in the editor
 * package and `COLUMN_MATERIAL_NONE` in the map's — and they agree, because a
 * material index is a slot in one shared atlas. Re-exported under one name here
 * so a picker does not have to know which tab is asking.
 */
export const NO_MATERIAL = -1;

/** One chip in the material palette. */
export interface MaterialOption {
  /** The armed value this chip sets, or {@link NO_MATERIAL} for flat. */
  readonly material: number;
  /** What the chip is, for its tooltip and its accessible name. */
  readonly name: string;
  /** A representative colour, or null when the chip draws its own art. */
  readonly swatch: string | null;
  /**
   * Whether this chip means "paint no material at all". The flat chip is drawn
   * in the *active palette colour* rather than in a colour of its own, so it has
   * to be distinguishable from a material that merely happens to be grey.
   */
  readonly flat: boolean;
}

/** The flat chip, first in every material palette. */
export const FLAT_OPTION: MaterialOption = {
  material: NO_MATERIAL,
  name: "Flat",
  swatch: null,
  flat: true,
};

/**
 * The material chips, in palette order: flat, then the world's build materials.
 *
 * Sprite skins are deliberately not here. They are per-cart and per-tab — the
 * sculptor's come from the sculpt's own list, the map's from the armed tile — so
 * they are appended by the caller rather than baked into a shared constant that
 * would then have to know about both.
 */
export const MATERIAL_OPTIONS: readonly MaterialOption[] = [
  FLAT_OPTION,
  ...BUILD_MATERIALS.map((entry) => ({
    material: entry.material,
    name: entry.name,
    swatch: entry.swatch,
    flat: false,
  })),
];

/**
 * What the armed material is, for the picker's readout.
 *
 * A sprite skin reads out as the sprite it is, since "sprite #12" is the only
 * name it has; an unrecognised index reads as flat rather than as an error,
 * because an armed material can outlive the atlas slot it named and a readout
 * that says "flat" is a better failure than one that says "undefined".
 */
export function materialOptionLabel(material: number, tilesPerPage: number): string {
  if (material < 0) return "flat";
  const tile = materialSpriteTile(material, tilesPerPage);
  if (tile !== null) return `sprite #${tile}`;
  return BUILD_MATERIALS.find((entry) => entry.material === material)?.name ?? "flat";
}
