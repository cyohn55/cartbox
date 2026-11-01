/**
 * The shipped maps re-lit in physical units for the AAA tier
 * (AAA_FIDELITY_ROADMAP.md F11a-11), as a rig's re-light (`SceneLighting.aaa`,
 * F11a-10): every other tier keeps the rig the map was tuned under.
 *
 * Nothing in it is tuned by eye. The rules:
 *
 *  - **The sun is the sun.** The key light becomes the sun above the air,
 *    128 klx (the solar illuminance at the top of the atmosphere), white: the
 *    physical sky (F5a) tints it by the air it crosses, so at noon it reaches
 *    the ground at about 110 klx.
 *  - **The sky is the sky.** The painted fill lights (the byte rig's stand-in for
 *    skylight) go: the physical sky's own light (its IBL, F3a) fills the shade.
 *    The painted sky stays as the map's backdrop art: its objects and, with
 *    `landscape`, its valley mist and ranges, in front of the air (F11a-9).
 *  - **The camera is a sunny day's.** Exposure 1 is EV100 15 (F0b), the "sunny
 *    16" rule, so an 18% grey card in the open shows as middle grey.
 *  - **Local lights keep their place against the sun.** Each lamp, strip and
 *    floodlight keeps the ratio to the key light the art gave it, now against
 *    the sun as it reaches the ground.
 *  - **Light moves in real time.** The light maps and probe grids were baked
 *    under the byte rig, so the re-light turns on real-time GI (DDGI, F3e),
 *    which the light-mapped surfaces read in their place, and drops the grid.
 *  - **The air is volumetric.** The rig's fog, its volumes included, becomes a
 *    medium the sun lights through its cascades (F5b); god rays come from it,
 *    so the screen-space shafts go.
 */

import { lightColor, type SceneLight } from "../render/meshRasterizer";
import { integrateTransmittance, parseAtmosphere, resolveAtmosphere, type AtmosphereSettings } from "./atmosphere";
import { luxToUnits } from "./physicalLight";
import { PHYSICAL_ALBEDO, parseAlbedoCalibration } from "./albedoCalibration";
import type { SceneLighting, SceneLightingOverride } from "./SceneLighting";
import { parseVolumetricFog, type VolumetricFogSettings } from "./volumetricFog";

/** What a stored physical re-light holds (`SceneLighting.aaa.physical`): the rest is derived from the rig at load. */
export interface PhysicalRelightSettings {
  /** The physical sky's medium, altitude, clouds and landscape. */
  readonly atmosphere: AtmosphereSettings;
  /** How the rig's fog scatters as a volume. */
  readonly volumetric: VolumetricFogSettings;
  /** Measured mean linear albedos by material name (F11a-13), in place of the physical range for those materials. */
  readonly albedo?: Readonly<Record<string, number>>;
}

/** A stored physical re-light, read defensively; null when it isn't one. */
export function parsePhysicalRelight(value: unknown): PhysicalRelightSettings | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const targets = parseAlbedoCalibration({ targets: raw.albedo })?.targets;
  return { atmosphere: parseAtmosphere(raw.atmosphere) ?? {}, volumetric: parseVolumetricFog(raw.volumetric) ?? {}, ...(targets ? { albedo: targets } : {}) };
}

/** Whether a rig can be re-lit physically: it has a key light to become the sun and a sky to make physical. */
export function canRelight(rig: SceneLighting): boolean {
  return rig.sky != null && rig.lights.some((l) => l.kind === "directional" && l.direction);
}

/** The sun's illuminance above the air, in renderer units: 128 klx. */
export const SUN_ABOVE_AIR = luxToUnits(128_000);

/** Rec. 709 luminance of a linear colour. */
const luminance = (c: readonly number[]) => 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
/** Authored colour into linear light. */
const toLinear = (c: number) => (c <= 0.04045 ? Math.max(0, c) / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

/**
 * The sun as it reaches the scene under `atmosphere` toward `direction`, in
 * renderer units of linear RGB: the transmittance integrated along the one ray,
 * as the LUT holds it (`sunTransmittance`), without baking the LUTs.
 */
export function groundSun(atmosphere: AtmosphereSettings, direction: readonly number[]): [number, number, number] {
  const l = Math.hypot(direction[0]!, direction[1]!, direction[2]!) || 1;
  const a = resolveAtmosphere(atmosphere);
  const t = integrateTransmittance(a, a.bottom + a.viewHeight, direction[1]! / l);
  return [t[0] * SUN_ABOVE_AIR, t[1] * SUN_ABOVE_AIR, t[2] * SUN_ABOVE_AIR];
}

/**
 * A rig's physical re-light: the sun above the air, the physical sky in place
 * of the painted gradient (keeping its objects and landscape as art), EV100 15,
 * the local lights in proportion, real-time GI and volumetric fog.
 */
export function physicalRelight(
  rig: SceneLighting,
  atmosphere: AtmosphereSettings,
  volumetric: VolumetricFogSettings,
  /** Measured albedos by material name (F11a-13). */
  albedo?: Readonly<Record<string, number>>,
): Omit<SceneLightingOverride, "physical"> {
  const key = rig.lights.find((l) => l.kind === "directional" && l.direction);
  if (!key?.direction || !rig.sky) throw new Error("a physical re-light needs a key light and a sky (canRelight)");
  const settings: AtmosphereSettings = { ...atmosphere, landscape: atmosphere.landscape ?? true };
  // The key's luminance as the art set it, against the sun's as it now reaches the ground.
  const authoredKey = luminance(lightColor(key).map(toLinear)) * key.intensity;
  const scale = luminance(groundSun(settings, key.direction)) / authoredKey;
  const lights = rig.lights.flatMap((l): SceneLight[] => {
    if (l === key) {
      // White above the air: the sky's transmittance gives it its colour (a temperature would tint it twice).
      const sun: SceneLight = { ...l, color: [1, 1, 1], intensity: SUN_ABOVE_AIR };
      delete (sun as { temperature?: number }).temperature;
      return [sun];
    }
    // The painted fill lights stood in for the sky, which now lights the shade itself.
    if (l.kind === "directional") return [];
    return [{ ...l, intensity: l.intensity * scale }];
  });
  return {
    lights,
    sky: { ...rig.sky, sunDirection: [...key.direction] as [number, number, number], atmosphere: settings },
    environment: { ...rig.environment, intensity: 1 },
    exposure: 1,
    units: "physical",
    ...(rig.fog ? { fog: { ...rig.fog, volumetric } } : {}),
    shafts: null,
    // About a sixth of either map's probes a frame: a sweep in five or six frames, the cost bounded (F11a-12).
    dynamicGi: { probesPerFrame: 256 },
    // The materials' albedos re-measured for linear light (F11a-13).
    materialAlbedo: { ...PHYSICAL_ALBEDO, ...(albedo ? { targets: albedo } : {}) },
    lightProbes: null,
  };
}
