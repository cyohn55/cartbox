/**
 * Server + client shared logic for the stored handheld skin.
 *
 * A stored handheld is `{ presetId, scheme, art? }`: which premade the user
 * started from (or "custom"), the region colours applied, and — when the player
 * has drawn their own handheld in the pixel editor — the flattened custom art.
 * Everything that persists a handheld routes through `normalizeHandheld`, so an
 * untrusted payload is always coerced to a complete, valid skin before it
 * reaches the DB (or localStorage).
 */

import {
  normalizeScheme,
  handheldPreset,
  DEFAULT_HANDHELD_PRESET_ID,
  type HandheldScheme,
} from "@cartbox/editor";

import { normalizeArt, type HandheldArt } from "./handheldArt";

export type { HandheldArt } from "./handheldArt";

/** Preset id used when the user has recoloured away from any premade. */
export const CUSTOM_PRESET_ID = "custom";

/** Preset id used when the skin is free-form pixel art from the in-app editor. */
export const CUSTOM_ART_PRESET_ID = "custom-art";

export interface StoredHandheld {
  /** The premade the scheme came from, "custom", or "custom-art". */
  presetId: string;
  /** The region colours actually applied (kept even when custom art is set). */
  scheme: HandheldScheme;
  /** Free-form pixel art drawn in the editor; when present the console renders it. */
  art?: HandheldArt;
}

/** True for the ids we keep verbatim rather than resolving to a premade. */
function isCustomId(id: string): boolean {
  return id === CUSTOM_PRESET_ID || id === CUSTOM_ART_PRESET_ID;
}

/**
 * Validate and normalise an untrusted handheld payload into a complete skin.
 * Unknown preset ids are kept verbatim only when they are "custom"/"custom-art";
 * anything else falls back to the default preset. Scheme colours are validated
 * per region, and any custom art is passed through the art gate.
 */
export function normalizeHandheld(input: unknown): StoredHandheld {
  const source = (input ?? {}) as { presetId?: unknown; scheme?: unknown; art?: unknown };
  const rawId = typeof source.presetId === "string" ? source.presetId : DEFAULT_HANDHELD_PRESET_ID;
  const presetId = isCustomId(rawId) ? rawId : handheldPreset(rawId).id;
  const base = handheldPreset(isCustomId(presetId) ? DEFAULT_HANDHELD_PRESET_ID : presetId).scheme;
  const art = normalizeArt(source.art);
  const scheme = normalizeScheme(source.scheme, base);
  return art ? { presetId, scheme, art } : { presetId, scheme };
}

/** The default handheld a brand-new account starts on. */
export function defaultHandheld(): StoredHandheld {
  const preset = handheldPreset(DEFAULT_HANDHELD_PRESET_ID);
  return { presetId: preset.id, scheme: preset.scheme };
}
