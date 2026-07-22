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
  HANDHELD_ANIMATED_PRESETS,
  DEFAULT_HANDHELD_PRESET_ID,
  type HandheldGameId,
  type HandheldScheme,
} from "@cartbox/editor";

import { normalizeArt, type HandheldArt } from "./handheldArt";

export type { HandheldArt } from "./handheldArt";

/** Preset id used when the user has recoloured away from any premade. */
export const CUSTOM_PRESET_ID = "custom";

/** Preset id used when the skin is free-form pixel art from the in-app editor. */
export const CUSTOM_ART_PRESET_ID = "custom-art";

/** The arcade scenes an animation can play, for validating a stored choice. */
const ANIMATION_GAMES: readonly string[] = HANDHELD_ANIMATED_PRESETS.map((preset) => preset.game);

export interface StoredHandheld {
  /** The premade the scheme came from, "custom", or "custom-art". */
  presetId: string;
  /** The region colours actually applied (kept even when custom art is set). */
  scheme: HandheldScheme;
  /** Free-form pixel art drawn in the editor; when present the console renders it. */
  art?: HandheldArt;
  /**
   * The source image shown through the chassis (`face`) region. Kept alongside
   * the rendered `art` so recolouring the chrome re-composites the background in
   * the new colours instead of dropping it (the same live-recolour contract the
   * marquee `animation` has). A bounded PNG data URL / https URL, like `art`.
   */
  background?: HandheldArt;
  /**
   * An arcade scene played on the chassis marquee. Independent of the chassis
   * colours: the animation is rendered live from `scheme`, so recolouring the
   * handheld recolours the animation too. Persisted so re-opening the picker
   * resumes the same animation (and keeps recolouring it).
   */
  animation?: HandheldGameId;
  /**
   * Colour the marquee scene is drawn in, chosen independently of the chassis.
   * When absent the scene follows the button accent (`scheme.buttonColor`). Only
   * meaningful alongside `animation`. A `#rrggbb` colour.
   */
  marqueeColor?: string;
}

/** A stored animation choice, coerced to a known game id or dropped. */
function normalizeAnimation(value: unknown): HandheldGameId | undefined {
  return typeof value === "string" && ANIMATION_GAMES.includes(value) ? (value as HandheldGameId) : undefined;
}

/** A stored marquee colour, coerced to a `#rrggbb` string or dropped. */
function normalizeHexColor(value: unknown): string | undefined {
  return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value.trim()) ? value.trim().toLowerCase() : undefined;
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
  const source = (input ?? {}) as { presetId?: unknown; scheme?: unknown; art?: unknown; background?: unknown };
  const rawId = typeof source.presetId === "string" ? source.presetId : DEFAULT_HANDHELD_PRESET_ID;
  const presetId = isCustomId(rawId) ? rawId : handheldPreset(rawId).id;
  const base = handheldPreset(isCustomId(presetId) ? DEFAULT_HANDHELD_PRESET_ID : presetId).scheme;
  const art = normalizeArt(source.art);
  const background = normalizeArt(source.background);
  const scheme = normalizeScheme(source.scheme, base);
  const animation = normalizeAnimation((source as { animation?: unknown }).animation);
  const marqueeColor = normalizeHexColor((source as { marqueeColor?: unknown }).marqueeColor);
  return {
    presetId,
    scheme,
    ...(art ? { art } : {}),
    ...(background ? { background } : {}),
    ...(animation ? { animation } : {}),
    // A marquee colour is only meaningful while a marquee is playing.
    ...(animation && marqueeColor ? { marqueeColor } : {}),
  };
}

/** The default handheld a brand-new account starts on. */
export function defaultHandheld(): StoredHandheld {
  const preset = handheldPreset(DEFAULT_HANDHELD_PRESET_ID);
  return { presetId: preset.id, scheme: preset.scheme };
}
