/**
 * Server-safe validation for the material-swatches sidecar. The editor package
 * owns the rich MaterialSwatches model, but server code (API route, server
 * component) must stay free of that package's client code — mirroring lib/rig.
 * So this module re-declares the wire shape and validates untrusted JSON (a PUT
 * body or a jsonb column) structurally, rejecting anything malformed rather than
 * storing or loading garbage that could break the editor.
 *
 * The wire shape is structurally identical to MaterialSwatches / MaterialProfile,
 * so the editor consumes a parsed WireMaterials directly.
 */

/** Per-colour material binding, keyed by albedo palette index (array position). */
export interface WireMaterialProfile {
  readonly enabled: boolean;
  readonly normal: number;
  readonly height: number;
  readonly specular: number;
  readonly roughness: number;
  readonly emissive: number;
}

export interface WireMaterials {
  readonly profiles: readonly WireMaterialProfile[];
}

/** Channel values are 4-bit levels (0..15): 16 normal directions or ramp steps. */
const MAX_LEVEL = 15;

/**
 * Upper bound on stored profiles. One per palette entry; the Pro palette holds
 * 64 colours, so this leaves generous headroom while rejecting absurd payloads.
 */
export const MAX_MATERIAL_PROFILES = 256;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** A whole number within [0, MAX_LEVEL], else null. */
function level(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > MAX_LEVEL) return null;
  return value;
}

function parseProfile(value: unknown): WireMaterialProfile | null {
  if (!isRecord(value)) return null;
  if (typeof value.enabled !== "boolean") return null;

  const normal = level(value.normal);
  const height = level(value.height);
  const specular = level(value.specular);
  const roughness = level(value.roughness);
  const emissive = level(value.emissive);

  if (normal === null || height === null || specular === null || roughness === null || emissive === null) {
    return null;
  }

  return { enabled: value.enabled, normal, height, specular, roughness, emissive };
}

/**
 * Validate untrusted JSON into a WireMaterials, or null when malformed. Strict:
 * any bad profile rejects the whole set, since the client only ever sends valid
 * data and a null simply means "no swatch bindings".
 */
export function parseMaterials(value: unknown): WireMaterials | null {
  if (!isRecord(value) || !Array.isArray(value.profiles)) return null;
  if (value.profiles.length > MAX_MATERIAL_PROFILES) return null;

  const profiles: WireMaterialProfile[] = [];
  for (const rawProfile of value.profiles) {
    const profile = parseProfile(rawProfile);
    if (!profile) return null; // no garbage
    profiles.push(profile);
  }

  return { profiles };
}
