/**
 * Lighting conditions — an artist-facing description of a directional light,
 * and the presets that stand in for real-world times of day / studio setups.
 *
 * The editor's voxel preview lets you inspect a sprite's pixels under different
 * lighting; this module is the pure model behind that. A condition is an
 * azimuth/elevation (where the light sits in the sky), an intensity and ambient
 * floor, and a colour. `directionFromConditions` turns the sky angles into a
 * unit light vector in the renderer's screen space (x right, y down, z toward
 * the viewer), the same space the normal maps and `shade` use.
 */

import type { Vec3 } from "../model/normals";

export interface LightingConditions {
  /** Compass angle of the light, degrees clockwise from North (0=N, 90=E). */
  azimuth: number;
  /** Height above the horizon, degrees. 90 = straight overhead; negative = from below. */
  elevation: number;
  /** Direct-light strength multiplier (0 = ambient only). */
  intensity: number;
  /** Minimum brightness in shadow, 0..1. */
  ambient: number;
  /** Light colour, each channel 0..1. */
  color: readonly [number, number, number];
}

export interface LightingPreset {
  id: string;
  label: string;
  conditions: LightingConditions;
}

const DEG_TO_RAD = Math.PI / 180;

/**
 * A curated set of lighting conditions covering the range an artist checks a
 * sprite under: full overhead sun, warm low-angle light, cool night, flat
 * studio fill, and dramatic under-lighting.
 */
export const LIGHTING_PRESETS: readonly LightingPreset[] = [
  {
    id: "noon",
    label: "Noon",
    conditions: { azimuth: 180, elevation: 82, intensity: 1.2, ambient: 0.35, color: [1, 0.98, 0.9] },
  },
  {
    id: "golden-hour",
    label: "Golden hour",
    conditions: { azimuth: 250, elevation: 22, intensity: 1.15, ambient: 0.28, color: [1, 0.76, 0.46] },
  },
  {
    id: "sunset",
    label: "Sunset",
    conditions: { azimuth: 270, elevation: 8, intensity: 1.0, ambient: 0.22, color: [1, 0.5, 0.34] },
  },
  {
    id: "moonlight",
    label: "Moonlight",
    conditions: { azimuth: 150, elevation: 58, intensity: 0.7, ambient: 0.18, color: [0.6, 0.72, 1] },
  },
  {
    id: "studio",
    label: "Studio",
    conditions: { azimuth: 135, elevation: 45, intensity: 1.3, ambient: 0.4, color: [1, 1, 1] },
  },
  {
    id: "underglow",
    label: "Underglow",
    conditions: { azimuth: 0, elevation: -28, intensity: 1.1, ambient: 0.16, color: [1, 0.24, 0.82] },
  },
];

/** The preset the preview opens on. */
export const DEFAULT_LIGHTING_PRESET_ID = "studio";

/** Returns the named preset's conditions, falling back to the default preset. */
export function lightingPresetConditions(id: string): LightingConditions {
  const preset = LIGHTING_PRESETS.find((entry) => entry.id === id);
  const fallback = LIGHTING_PRESETS.find((entry) => entry.id === DEFAULT_LIGHTING_PRESET_ID);
  // The default preset is always present, so `conditions` is well-defined.
  return (preset ?? fallback ?? LIGHTING_PRESETS[0]!).conditions;
}

/**
 * Converts sky angles to a unit vector pointing from the surface toward the
 * light. North (azimuth 0) points up-screen (−y); East (90) points right (+x);
 * elevation lifts the vector toward the viewer (+z), so 90° is head-on.
 */
export function directionFromConditions(conditions: LightingConditions): Vec3 {
  const azimuth = conditions.azimuth * DEG_TO_RAD;
  const elevation = conditions.elevation * DEG_TO_RAD;
  const horizontal = Math.cos(elevation);
  const x = horizontal * Math.sin(azimuth);
  const y = -horizontal * Math.cos(azimuth);
  const z = Math.sin(elevation);
  const length = Math.hypot(x, y, z) || 1;
  return [x / length, y / length, z / length];
}
