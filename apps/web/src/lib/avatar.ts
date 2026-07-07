/**
 * Mii/Xbox-style avatar model (Platform P1).
 *
 * An avatar is a set of layered part choices plus a small palette. It's stored
 * as JSON on the profile and rendered client-side by stacking part shapes. This
 * module is the pure, validated core — normalization and randomization — so the
 * spec is always well-formed regardless of what a client or the database sends.
 *
 * Part art is currently drawn as placeholder shapes (see AvatarEditor); swapping
 * in real sprite sheets keyed by these same part indices is additive.
 */

export type AvatarCategory = "body" | "face" | "hair" | "eyes" | "accessory";

/** Layer order, back to front. */
export const AVATAR_CATEGORIES: readonly AvatarCategory[] = [
  "body",
  "face",
  "hair",
  "eyes",
  "accessory",
];

/** Number of options available per category (part ids are 0..count-1). */
export const AVATAR_OPTION_COUNTS: Record<AvatarCategory, number> = {
  body: 4,
  face: 4,
  hair: 6,
  eyes: 5,
  accessory: 4,
};

export const AVATAR_PALETTE_SIZE = 4;

/** Brand-neutral placeholder palette. */
export const DEFAULT_PALETTE: readonly string[] = ["#ff5c8a", "#35e0c8", "#ffd23f", "#14121f"];

export interface AvatarSpec {
  parts: Record<AvatarCategory, number>;
  palette: string[];
}

export const DEFAULT_AVATAR: AvatarSpec = {
  parts: { body: 0, face: 0, hair: 0, eyes: 0, accessory: 0 },
  palette: [...DEFAULT_PALETTE],
};

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

/** Clamps a part id into the valid range for its category. */
function clampPart(value: unknown, category: AvatarCategory): number {
  const count = AVATAR_OPTION_COUNTS[category];
  const id = typeof value === "number" && Number.isInteger(value) ? value : 0;
  return Math.min(Math.max(id, 0), count - 1);
}

/**
 * Coerces arbitrary input (client payload or a `avatar_json` DB value) into a
 * valid {@link AvatarSpec}: every part is in range, the palette is exactly
 * {@link AVATAR_PALETTE_SIZE} valid hex colors.
 */
export function normalizeAvatar(input: unknown): AvatarSpec {
  const raw = (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>;
  const rawParts = (
    typeof raw.parts === "object" && raw.parts !== null ? raw.parts : {}
  ) as Record<string, unknown>;

  const parts = {} as Record<AvatarCategory, number>;
  for (const category of AVATAR_CATEGORIES) {
    parts[category] = clampPart(rawParts[category], category);
  }

  const rawPalette = Array.isArray(raw.palette) ? raw.palette : [];
  const palette = Array.from({ length: AVATAR_PALETTE_SIZE }, (_, index) => {
    const color = rawPalette[index];
    return typeof color === "string" && HEX_COLOR.test(color) ? color : DEFAULT_PALETTE[index]!;
  });

  return { parts, palette };
}

/**
 * Produces a random, valid avatar. RNG is injectable so callers (and tests) can
 * make it deterministic.
 */
export function randomAvatar(rng: () => number = Math.random): AvatarSpec {
  const parts = {} as Record<AvatarCategory, number>;
  for (const category of AVATAR_CATEGORIES) {
    parts[category] = Math.floor(rng() * AVATAR_OPTION_COUNTS[category]);
  }
  return { parts, palette: [...DEFAULT_PALETTE] };
}
