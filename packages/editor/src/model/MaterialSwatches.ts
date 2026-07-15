/**
 * MaterialSwatches — authoring metadata that binds each albedo palette colour to
 * a material "profile": the normal direction plus the height/specular/roughness/
 * emissive levels that colour should stamp when painted. It lets an author draw
 * with, say, a "highlight" colour that writes albedo *and* all its material
 * channels in one stroke, instead of painting each channel on a separate layer.
 *
 * Pure plain data (like {@link SpriteRig}), so it serialises straight to the
 * cart's materials sidecar and folds into the editor's undo history. The painted
 * channel pixels themselves still live in the material banks; this only records
 * the per-colour bindings the brush uses.
 *
 * Profiles are keyed by palette index and grow lazily: an unconfigured colour
 * resolves to a disabled default (paints albedo only), so opening a cart with no
 * bindings paints exactly like the plain albedo layer until swatches are set.
 */

import { MATERIAL_LEVELS } from "../engine/CartEngine";
import { NORMAL_DIRECTION_COUNT } from "./normals";

/** The material channels a swatch stamps alongside its albedo colour. */
export type MaterialProfileChannel = "normal" | "height" | "specular" | "roughness" | "emissive";

/** The stampable channels in stamp order (normal first, then the ramps). */
export const MATERIAL_PROFILE_CHANNELS: readonly MaterialProfileChannel[] = [
  "normal",
  "height",
  "specular",
  "roughness",
  "emissive",
];

/**
 * The per-colour binding. `enabled` gates whether painting the colour writes the
 * material channels at all; when false the colour behaves like plain albedo.
 * `normal` is a direction index (0..NORMAL_DIRECTION_COUNT-1); the rest are ramp
 * levels (0..MATERIAL_LEVELS-1).
 */
export interface MaterialProfile {
  readonly enabled: boolean;
  readonly normal: number;
  readonly height: number;
  readonly specular: number;
  readonly roughness: number;
  readonly emissive: number;
}

/** Per-colour material bindings, indexed by albedo palette index. */
export interface MaterialSwatches {
  readonly profiles: readonly MaterialProfile[];
}

/** The neutral binding an unconfigured colour resolves to: albedo-only. */
export function defaultMaterialProfile(): MaterialProfile {
  return { enabled: false, normal: 0, height: 0, specular: 0, roughness: 0, emissive: 0 };
}

/** An empty swatch set: every colour resolves to the default profile. */
export function defaultMaterialSwatches(): MaterialSwatches {
  return { profiles: [] };
}

/** Clamp a value to a whole number within [0, max-1]. */
function clampLevel(value: number, count: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(count - 1, Math.round(value)));
}

/** Normalise an arbitrary profile-shaped value into valid channel ranges. */
export function normalizeMaterialProfile(profile: MaterialProfile): MaterialProfile {
  return {
    enabled: Boolean(profile.enabled),
    normal: clampLevel(profile.normal, NORMAL_DIRECTION_COUNT),
    height: clampLevel(profile.height, MATERIAL_LEVELS),
    specular: clampLevel(profile.specular, MATERIAL_LEVELS),
    roughness: clampLevel(profile.roughness, MATERIAL_LEVELS),
    emissive: clampLevel(profile.emissive, MATERIAL_LEVELS),
  };
}

/** The binding for a palette colour, or the default when it is unconfigured. */
export function materialProfileAt(swatches: MaterialSwatches, colorIndex: number): MaterialProfile {
  return swatches.profiles[colorIndex] ?? defaultMaterialProfile();
}

/** True when the colour stamps material channels (i.e. it is a live swatch). */
export function isMaterialSwatchEnabled(swatches: MaterialSwatches, colorIndex: number): boolean {
  return materialProfileAt(swatches, colorIndex).enabled;
}

/**
 * Return a new swatch set with one colour's profile replaced. The array grows to
 * cover the index, padding any gap with default profiles, so callers never have
 * to pre-size it to the palette.
 */
export function setMaterialProfile(
  swatches: MaterialSwatches,
  colorIndex: number,
  profile: MaterialProfile,
): MaterialSwatches {
  if (colorIndex < 0 || !Number.isInteger(colorIndex)) return swatches;
  const next = swatches.profiles.slice();
  while (next.length <= colorIndex) next.push(defaultMaterialProfile());
  next[colorIndex] = normalizeMaterialProfile(profile);
  return { profiles: next };
}
