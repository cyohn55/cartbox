/**
 * Server + client shared logic for the stored handheld skin.
 *
 * A stored handheld is `{ presetId, scheme }`: which premade the user started
 * from (or "custom"), and the region colours actually applied. Everything that
 * persists a handheld routes through `normalizeHandheld`, so an untrusted
 * payload is always coerced to a complete, valid skin before it reaches the DB.
 */

import {
  normalizeScheme,
  handheldPreset,
  DEFAULT_HANDHELD_PRESET_ID,
  type HandheldScheme,
} from "@cartbox/editor";

/** Preset id used when the user has recoloured away from any premade. */
export const CUSTOM_PRESET_ID = "custom";

export interface StoredHandheld {
  /** The premade the scheme came from, or "custom" after recolouring. */
  presetId: string;
  /** The region colours actually applied. */
  scheme: HandheldScheme;
}

/**
 * Validate and normalise an untrusted handheld payload into a complete skin.
 * Unknown preset ids are kept verbatim only when they are "custom"; anything
 * else falls back to the default preset. Scheme colours are validated per
 * region against the resolved preset's colours.
 */
export function normalizeHandheld(input: unknown): StoredHandheld {
  const source = (input ?? {}) as { presetId?: unknown; scheme?: unknown };
  const rawId = typeof source.presetId === "string" ? source.presetId : DEFAULT_HANDHELD_PRESET_ID;
  const presetId = rawId === CUSTOM_PRESET_ID ? CUSTOM_PRESET_ID : handheldPreset(rawId).id;
  const base = handheldPreset(presetId === CUSTOM_PRESET_ID ? DEFAULT_HANDHELD_PRESET_ID : presetId).scheme;
  return { presetId, scheme: normalizeScheme(source.scheme, base) };
}

/** The default handheld a brand-new account starts on. */
export function defaultHandheld(): StoredHandheld {
  const preset = handheldPreset(DEFAULT_HANDHELD_PRESET_ID);
  return { presetId: preset.id, scheme: preset.scheme };
}
