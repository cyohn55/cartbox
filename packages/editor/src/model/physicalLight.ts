/**
 * Physical light units (AAA_FIDELITY_ROADMAP.md F0b): lux for a sun, candela
 * for a punctual light, nits (cd/m²) for luminance (the sky, emissive, the
 * ambient floor) and EV100 for exposure.
 *
 * A rig stays stored in the renderer's own units, where 1 is the brightness
 * every existing scene was authored in. These are the exact, fixed factors
 * between those units and physical ones, so a rig can be shown, typed and
 * imported in physical units without the renderers, the cart API or any stored
 * scene changing. Converting is a change of display, and an existing scene
 * looks the same whichever units it is edited in.
 *
 * The calibration follows the usual photographic model (Lagarde & de
 * Rousiers, "Moving Frostbite to PBR"): at EV100 `ev`, the luminance that just
 * saturates the sensor is 1.2 · 2^ev nits. The reference is EV100 15, a sunny
 * day (the "sunny 16" rule), where exposure 1 is the renderer's own:
 *
 *  - luminance: 1 unit = 1.2 · 2^15 = 39 321.6 nits;
 *  - a sun: 1 unit = π · 39 321.6 ≈ 123 532 lux. A white Lambertian surface
 *    under E lux has luminance E/π; the renderer's diffuse term carries no 1/π;
 *  - a punctual light with inverse-square falloff: 1 unit = π · 39 321.6
 *    candela, as I/d² is the illuminance it gives at d metres. A light with the
 *    default (1 − d/range)² fade has no candela; its intensity reads as the
 *    illuminance next to it, in lux;
 *  - exposure: EV100 ev is exposure 2^(15 − ev).
 */

import type { SceneLight } from "../render/meshRasterizer";

/** The EV100 at which exposure 1 is the renderer's own: a sunny day. */
export const REFERENCE_EV100 = 15;

/** The luminance, in nits, of one renderer unit: what saturates at {@link REFERENCE_EV100}. */
export const NITS_PER_UNIT = 1.2 * 2 ** REFERENCE_EV100;

/** The illuminance, in lux, of a unit-intensity sun (and the candela of a unit inverse-square light). */
export const LUX_PER_UNIT = Math.PI * NITS_PER_UNIT;

/** A luminance in nits, as renderer units. */
export function nitsToUnits(nits: number): number {
  return nits / NITS_PER_UNIT;
}

/** Renderer units, as a luminance in nits. */
export function unitsToNits(units: number): number {
  return units * NITS_PER_UNIT;
}

/** An illuminance in lux (or a candela, for an inverse-square light), as renderer units. */
export function luxToUnits(lux: number): number {
  return lux / LUX_PER_UNIT;
}

/** Renderer units, as lux (or candela, for an inverse-square light). */
export function unitsToLux(units: number): number {
  return units * LUX_PER_UNIT;
}

/** The exposure multiplier for an EV100: 2^(15 − ev). */
export function ev100ToExposure(ev100: number): number {
  return 2 ** (REFERENCE_EV100 - ev100);
}

/** The EV100 an exposure multiplier is (> 0). */
export function exposureToEv100(exposure: number): number {
  return REFERENCE_EV100 - Math.log2(Math.max(exposure, 1e-9));
}

/** A physical quantity to three figures with an SI prefix: "123 klx", "1.20 Mcd", "0.35 nt". */
export function formatPhysical(value: number, unit: string): string {
  if (!(value > 0)) return `0 ${unit}`;
  const [scaled, prefix] = value >= 1e6 ? [value / 1e6, "M"] : value >= 1e3 ? [value / 1e3, "k"] : [value, ""];
  const digits = scaled >= 100 ? 0 : scaled >= 10 ? 1 : 2;
  return `${scaled.toFixed(digits)} ${prefix}${unit}`;
}

/** The physical unit a light's intensity reads in. */
export type LightUnit = "lx" | "cd" | "nt";

/** A sun reads in lux, an inverse-square light in candela, a light with the default fade in lux (next to it), and an area light in nits (its luminance). */
export function lightUnit(light: Pick<SceneLight, "kind" | "falloff">): LightUnit {
  if (light.kind === "area") return "nt";
  return light.kind !== "directional" && light.falloff === "inverseSquare" ? "cd" : "lx";
}

/**
 * Switch a point or spot light between the default fade and inverse-square
 * falloff, scaling its intensity so it is as bright as before halfway to its
 * range, where the eye judges a light's reach. Without a range there is no
 * such point, and the intensity carries over. A sun is returned as it is.
 */
export function withLightFalloff(light: SceneLight, inverseSquare: boolean): SceneLight {
  if (light.kind === "directional" || light.kind === "area" || (light.falloff === "inverseSquare") === inverseSquare) return light;
  const { falloff: _old, ...rest } = light;
  const range = light.range ?? 0;
  if (range <= 0) return inverseSquare ? { ...rest, falloff: "inverseSquare" } : rest;
  const half = range / 2;
  // Default fade at range/2: (1 − 1/2)² = 1/4. Inverse square: (1 − 1/16)² / half².
  const fade = 0.25;
  const square = (1 - 1 / 16) ** 2 / Math.max(half * half, 1e-4);
  return inverseSquare
    ? { ...rest, falloff: "inverseSquare", intensity: (light.intensity * fade) / square }
    : { ...rest, intensity: (light.intensity * square) / fade };
}
