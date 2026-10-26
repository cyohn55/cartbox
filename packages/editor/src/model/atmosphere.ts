/**
 * A physically based sky (AAA_FIDELITY_ROADMAP.md F5a): Hillaire's 2020
 * atmosphere ("A Scalable and Production Ready Sky and Atmosphere Rendering
 * Technique"), the CPU reference the GPU's LUTs (atmosphere.ts in
 * @cartbox/player) mirror, and what every renderer lights by from it.
 *
 * - **The medium** is a planet's air in kilometres: Rayleigh scattering
 *   falling off with an 8 km scale height, Mie scattering and absorption with
 *   1.2 km, and an ozone layer that absorbs (a tent 30 km wide about 25 km
 *   up), over a ground of some albedo. The defaults are Earth's, Hillaire's.
 * - **Transmittance** to the top of the atmosphere is a LUT over a point's
 *   radius and the ray's zenith cosine, in Bruneton's parametrisation.
 * - **Multiple scattering** is Hillaire's Ψ_ms: the second order of light
 *   scattered isotropically into a point from every direction, summed as the
 *   geometric series 1 / (1 − f_ms) of the share the medium passes on. It is a
 *   32 × 32 LUT over the sun's zenith cosine and the height.
 * - **The sky's radiance** along a view ray is single scattering of the sun
 *   (Rayleigh's and Cornette–Shanks's phases), the LUT's multiple scattering,
 *   and the lit ground where the ray meets it, raymarched with Hillaire's
 *   energy-conserving step.
 *
 * **Units.** The sun is the rig's key light above the atmosphere, in the
 * renderer's units: a sun of 1 is about 123.5 klx (physicalLight.ts), and
 * lights a white Lambertian surface at a luminance of 1 unit. A luminance in
 * units is so the sky's radiance comes out in the units the IBL lights by, the
 * physical sun's π E/π in the renderer's diffuse that carries no 1/π.
 *
 * Pure and DOM-free.
 */

import { lightColor, type SceneLight } from "../render/meshRasterizer";
import type { HdrImage } from "../render/skyLayers";
import { linearToAuthored } from "./bakeSurface";
import type { SceneLighting } from "./SceneLighting";

type V3 = [number, number, number];

/** What a creator sets: each scale is against Earth's (1), the rest physical. */
export interface AtmosphereSettings {
  /** Rayleigh scattering against Earth's: how blue and how bright the clear sky is. */
  readonly rayleigh?: number;
  /** Mie scattering and absorption (haze, aerosols) against Earth's: a whiter sky and a wider glow round the sun. */
  readonly mie?: number;
  /** Ozone against Earth's: the blue of twilight. */
  readonly ozone?: number;
  /** The Mie phase's anisotropy, 0 (even) .. 0.95 (forward). */
  readonly mieAnisotropy?: number;
  /** The ground's albedo (linear), which lights the air from below. */
  readonly groundAlbedo?: number;
  /** How far above the ground the scene stands, metres. */
  readonly altitude?: number;
  /** The planet's radius, km. */
  readonly planetRadius?: number;
  /** The sun's angular diameter, degrees. */
  readonly sunSize?: number;
  /** How many times their length the scene's distances count through the air (aerial perspective): 1 is true, more hazes a small map as a large one, 0 is none. */
  readonly aerialScale?: number;
}

/** An atmosphere resolved into its medium, in kilometres. */
export interface Atmosphere {
  /** The ground's radius and the atmosphere's top, km. */
  readonly bottom: number;
  readonly top: number;
  readonly rayleighScattering: V3;
  readonly rayleighScale: number;
  readonly mieScattering: number;
  readonly mieExtinction: number;
  readonly mieScale: number;
  readonly mieG: number;
  readonly ozoneAbsorption: V3;
  readonly ozoneCenter: number;
  readonly ozoneWidth: number;
  readonly groundAlbedo: number;
  /** The scene's height above the ground, km (at least 10 m, so a level view never grazes the ground). */
  readonly viewHeight: number;
  /** The sun's angular radius, radians. */
  readonly sunRadius: number;
  /** How many times their length the scene's distances count through the air (0: no aerial perspective). */
  readonly aerialScale: number;
}

/** Earth's atmosphere (Hillaire 2020), per km. */
const EARTH = {
  bottom: 6360,
  height: 100,
  rayleigh: [5.802e-3, 13.558e-3, 33.1e-3] as V3,
  rayleighScale: 8,
  mieScattering: 3.996e-3,
  mieAbsorption: 4.4e-3,
  mieScale: 1.2,
  mieG: 0.8,
  ozone: [0.65e-3, 1.881e-3, 0.085e-3] as V3,
  ozoneCenter: 25,
  ozoneWidth: 15,
};

const clampTo = (v: unknown, lo: number, hi: number, fallback: number) => (typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback);

/** Settings as stored, read defensively: each in its range, absent ones left absent (Earth's). */
export function parseAtmosphere(value: unknown): AtmosphereSettings | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const out: Record<string, number> = {};
  const take = (key: keyof AtmosphereSettings, lo: number, hi: number) => {
    if (typeof raw[key] === "number" && Number.isFinite(raw[key])) out[key] = clampTo(raw[key], lo, hi, 0);
  };
  take("rayleigh", 0, 10);
  take("mie", 0, 50);
  take("ozone", 0, 10);
  take("mieAnisotropy", 0, 0.95);
  take("groundAlbedo", 0, 1);
  take("altitude", 0, 20000);
  take("planetRadius", 100, 100000);
  take("sunSize", 0.05, 20);
  take("aerialScale", 0, 100);
  return out as AtmosphereSettings;
}

/** The medium the settings make. */
export function resolveAtmosphere(settings: AtmosphereSettings = {}): Atmosphere {
  const rayleigh = settings.rayleigh ?? 1;
  const mie = settings.mie ?? 1;
  const ozone = settings.ozone ?? 1;
  const bottom = settings.planetRadius ?? EARTH.bottom;
  return {
    bottom,
    top: bottom + EARTH.height,
    rayleighScattering: EARTH.rayleigh.map((s) => s * rayleigh) as V3,
    rayleighScale: EARTH.rayleighScale,
    mieScattering: EARTH.mieScattering * mie,
    mieExtinction: (EARTH.mieScattering + EARTH.mieAbsorption) * mie,
    mieScale: EARTH.mieScale,
    mieG: settings.mieAnisotropy ?? EARTH.mieG,
    ozoneAbsorption: EARTH.ozone.map((s) => s * ozone) as V3,
    ozoneCenter: EARTH.ozoneCenter,
    ozoneWidth: EARTH.ozoneWidth,
    groundAlbedo: settings.groundAlbedo ?? 0.3,
    viewHeight: Math.max(0.01, (settings.altitude ?? 0) / 1000),
    sunRadius: ((settings.sunSize ?? 0.545) * Math.PI) / 360,
    aerialScale: settings.aerialScale ?? 1,
  };
}

/** What a LUT depends on: the medium, rounded to what changes it. */
export function atmosphereKey(a: Atmosphere): string {
  return [a.bottom, a.top, ...a.rayleighScattering, a.rayleighScale, a.mieScattering, a.mieExtinction, a.mieScale, a.mieG, ...a.ozoneAbsorption, a.groundAlbedo].map((v) => v.toPrecision(6)).join(",");
}

// --- The medium ----------------------------------------------------------------

/** Scattering (Rayleigh RGB, Mie) and extinction (RGB) at a height above the ground, km. */
export function mediumAt(a: Atmosphere, h: number): { rayleigh: V3; mie: number; extinction: V3 } {
  const dr = Math.exp(-Math.max(0, h) / a.rayleighScale);
  const dm = Math.exp(-Math.max(0, h) / a.mieScale);
  const dozone = Math.max(0, 1 - Math.abs(h - a.ozoneCenter) / a.ozoneWidth);
  const rayleigh = a.rayleighScattering.map((s) => s * dr) as V3;
  const mie = a.mieScattering * dm;
  const extinction = [0, 1, 2].map((c) => rayleigh[c]! + a.mieExtinction * dm + a.ozoneAbsorption[c]! * dozone) as V3;
  return { rayleigh, mie, extinction };
}

/** Rayleigh's phase function at the cosine between the view and the light. */
export function rayleighPhase(cos: number): number {
  return (3 / (16 * Math.PI)) * (1 + cos * cos);
}

/** Cornette–Shanks's Mie phase at the cosine between the view and the light, anisotropy g. */
export function miePhase(cos: number, g: number): number {
  const g2 = g * g;
  return ((3 / (8 * Math.PI)) * ((1 - g2) * (1 + cos * cos))) / ((2 + g2) * Math.pow(Math.max(1e-6, 1 + g2 - 2 * g * cos), 1.5));
}

/** The nearest distance along a ray from radius r with zenith cosine mu to a sphere of `radius`, or −1. */
export function raySphere(r: number, mu: number, radius: number): number {
  const b = r * mu;
  const c = r * r - radius * radius;
  const disc = b * b - c;
  if (disc < 0) return -1;
  const s = Math.sqrt(disc);
  const t0 = -b - s;
  const t1 = -b + s;
  if (t0 > 0) return t0;
  return t1 > 0 ? t1 : -1;
}

/** Whether a ray from radius r with zenith cosine mu meets the ground. */
export function hitsGround(a: Atmosphere, r: number, mu: number): boolean {
  return mu < 0 && r * r * (mu * mu - 1) + a.bottom * a.bottom >= 0;
}

// --- Transmittance --------------------------------------------------------------

/** The transmittance LUT's size, and the steps its rays take. */
export const TRANSMITTANCE_WIDTH = 256;
export const TRANSMITTANCE_HEIGHT = 64;
export const TRANSMITTANCE_STEPS = 128;

/** A transmittance texel's (u, v) into the radius and zenith cosine it stands for (Bruneton's mapping). */
export function transmittanceRMu(a: Atmosphere, u: number, v: number): { r: number; mu: number } {
  const H = Math.sqrt(a.top * a.top - a.bottom * a.bottom);
  const rho = H * v;
  const r = Math.sqrt(rho * rho + a.bottom * a.bottom);
  const dMin = a.top - r;
  const dMax = rho + H;
  const d = dMin + u * (dMax - dMin);
  const mu = d === 0 ? 1 : Math.min(1, Math.max(-1, (H * H - rho * rho - d * d) / (2 * r * d)));
  return { r, mu };
}

/** The radius and zenith cosine into the LUT's (u, v). */
export function transmittanceUv(a: Atmosphere, r: number, mu: number): [number, number] {
  const H = Math.sqrt(a.top * a.top - a.bottom * a.bottom);
  const rho = Math.sqrt(Math.max(0, r * r - a.bottom * a.bottom));
  const disc = r * r * (mu * mu - 1) + a.top * a.top;
  const d = Math.max(0, -r * mu + Math.sqrt(Math.max(0, disc)));
  const dMin = a.top - r;
  const dMax = rho + H;
  return [dMax > dMin ? (d - dMin) / (dMax - dMin) : 0, rho / H];
}

/** The transmittance from radius r along zenith cosine mu to the top of the atmosphere, by integrating the extinction (ground ignored). */
export function integrateTransmittance(a: Atmosphere, r: number, mu: number, steps = TRANSMITTANCE_STEPS): V3 {
  const t = Math.max(0, raySphere(r, mu, a.top));
  const dt = t / steps;
  const depth = [0, 0, 0];
  for (let i = 0; i < steps; i += 1) {
    const s = (i + 0.5) * dt;
    const h = Math.sqrt(r * r + s * s + 2 * r * mu * s) - a.bottom;
    const e = mediumAt(a, h).extinction;
    for (let c = 0; c < 3; c += 1) depth[c]! += e[c]! * dt;
  }
  return depth.map((d) => Math.exp(-d)) as V3;
}

/** A LUT of RGB floats, sampled bilinearly at (u, v) (clamped to its texel centres). */
export interface RgbLut {
  readonly width: number;
  readonly height: number;
  readonly data: Float32Array;
}

export function sampleLut(lut: RgbLut, u: number, v: number): V3 {
  const x = Math.min(lut.width - 1, Math.max(0, u * lut.width - 0.5));
  const y = Math.min(lut.height - 1, Math.max(0, v * lut.height - 0.5));
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const x1 = Math.min(lut.width - 1, x0 + 1), y1 = Math.min(lut.height - 1, y0 + 1);
  const fx = x - x0, fy = y - y0;
  const out: V3 = [0, 0, 0];
  for (let c = 0; c < 3; c += 1) {
    const a0 = lut.data[(y0 * lut.width + x0) * 3 + c]!, a1 = lut.data[(y0 * lut.width + x1) * 3 + c]!;
    const b0 = lut.data[(y1 * lut.width + x0) * 3 + c]!, b1 = lut.data[(y1 * lut.width + x1) * 3 + c]!;
    out[c] = (a0 + (a1 - a0) * fx) * (1 - fy) + (b0 + (b1 - b0) * fx) * fy;
  }
  return out;
}

/** The transmittance LUT (texel centres). */
export function bakeTransmittanceLut(a: Atmosphere): RgbLut {
  const width = TRANSMITTANCE_WIDTH, height = TRANSMITTANCE_HEIGHT;
  const data = new Float32Array(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const { r, mu } = transmittanceRMu(a, (x + 0.5) / width, (y + 0.5) / height);
      data.set(integrateTransmittance(a, r, mu), (y * width + x) * 3);
    }
  }
  return { width, height, data };
}

/** Transmittance from radius r along zenith cosine mu to the top, from the LUT; 0 where the ground is in the way. */
export function transmittanceTo(a: Atmosphere, lut: RgbLut, r: number, mu: number): V3 {
  if (hitsGround(a, r, mu)) return [0, 0, 0];
  const [u, v] = transmittanceUv(a, r, mu);
  return sampleLut(lut, u, v);
}

// --- Multiple scattering --------------------------------------------------------

/** The multiple-scattering LUT's size, the directions each texel gathers and the steps along each. */
export const MULTISCATTER_SIZE = 32;
export const MULTISCATTER_DIRECTIONS = 64;
export const MULTISCATTER_STEPS = 20;

/** The i-th of n directions spread evenly over the sphere (a Fibonacci set). */
export function fibonacciDirection(i: number, n: number): V3 {
  const y = 1 - (2 * i + 1) / n;
  const r = Math.sqrt(Math.max(0, 1 - y * y));
  const phi = i * 2.399963229728653;
  return [r * Math.cos(phi), y, r * Math.sin(phi)];
}

/**
 * Hillaire's Ψ_ms at a height and the sun's zenith cosine, for a sun of unit
 * illuminance: the second order of scattering into the point from every
 * direction, isotropically, over 1 − f_ms.
 */
export function integrateMultiScattering(a: Atmosphere, lut: RgbLut, h: number, muS: number): V3 {
  const r = a.bottom + Math.max(1e-3, h);
  const sun: V3 = [Math.sqrt(Math.max(0, 1 - muS * muS)), muS, 0];
  const iso = 1 / (4 * Math.PI);
  const L: V3 = [0, 0, 0];
  const f: V3 = [0, 0, 0];
  for (let k = 0; k < MULTISCATTER_DIRECTIONS; k += 1) {
    const d = fibonacciDirection(k, MULTISCATTER_DIRECTIONS);
    const mu = d[1];
    const ground = hitsGround(a, r, mu) ? raySphere(r, mu, a.bottom) : -1;
    const tMax = ground > 0 ? ground : Math.max(0, raySphere(r, mu, a.top));
    const dt = tMax / MULTISCATTER_STEPS;
    const throughput: V3 = [1, 1, 1];
    for (let i = 0; i < MULTISCATTER_STEPS; i += 1) {
      const t = (i + 0.3) * dt;
      const p: V3 = [d[0] * t, r + d[1] * t, d[2] * t];
      const pr = Math.hypot(p[0], p[1], p[2]);
      const m = mediumAt(a, pr - a.bottom);
      const muSun = (p[0] * sun[0] + p[1] * sun[1] + p[2] * sun[2]) / pr;
      const ts = transmittanceTo(a, lut, pr, muSun);
      for (let c = 0; c < 3; c += 1) {
        const scattering = m.rayleigh[c]! + m.mie;
        const ext = Math.max(1e-9, m.extinction[c]!);
        const step = Math.exp(-ext * dt);
        const S = scattering * ts[c]! * iso;
        L[c]! += throughput[c]! * ((S - S * step) / ext);
        f[c]! += throughput[c]! * ((scattering - scattering * step) / ext);
        throughput[c]! *= step;
      }
    }
    if (ground > 0) {
      const p: V3 = [d[0] * ground, r + d[1] * ground, d[2] * ground];
      const pr = Math.hypot(p[0], p[1], p[2]);
      const muSun = (p[0] * sun[0] + p[1] * sun[1] + p[2] * sun[2]) / pr;
      const ts = transmittanceTo(a, lut, pr, muSun);
      for (let c = 0; c < 3; c += 1) L[c]! += throughput[c]! * ts[c]! * Math.max(0, muSun) * (a.groundAlbedo / Math.PI);
    }
  }
  // Each direction stands for 4π / n of the sphere, scattered at the isotropic 1 / 4π.
  return [0, 1, 2].map((c) => L[c]! / MULTISCATTER_DIRECTIONS / (1 - Math.min(0.999, f[c]! * iso * 4 * Math.PI / MULTISCATTER_DIRECTIONS))) as V3;
}

/** The multiple-scattering LUT: u the sun's zenith cosine from −1 to 1, v the height from the ground to the top. */
export function bakeMultiScatteringLut(a: Atmosphere, transmittance: RgbLut): RgbLut {
  const n = MULTISCATTER_SIZE;
  const data = new Float32Array(n * n * 3);
  for (let y = 0; y < n; y += 1) {
    for (let x = 0; x < n; x += 1) {
      const muS = ((x + 0.5) / n) * 2 - 1;
      const h = ((y + 0.5) / n) * (a.top - a.bottom);
      data.set(integrateMultiScattering(a, transmittance, h, muS), (y * n + x) * 3);
    }
  }
  return { width: n, height: n, data };
}

/** Ψ_ms from the LUT at a height and the sun's zenith cosine. */
export function multiScatteringAt(a: Atmosphere, lut: RgbLut, h: number, muS: number): V3 {
  return sampleLut(lut, muS * 0.5 + 0.5, Math.max(0, h) / (a.top - a.bottom));
}

// --- The sky --------------------------------------------------------------------

/** The steps a view ray takes, spaced quadratically so the dense air near the eye gets the most. */
export const SKY_STEPS = 32;

/** An atmosphere's two LUTs, baked once per medium. */
export interface AtmosphereLuts {
  readonly atmosphere: Atmosphere;
  readonly transmittance: RgbLut;
  readonly multiScattering: RgbLut;
}

const lutCache = new Map<string, AtmosphereLuts>();

/** The LUTs for a medium, kept for the last few. */
export function atmosphereLuts(a: Atmosphere): AtmosphereLuts {
  const key = atmosphereKey(a);
  let luts = lutCache.get(key);
  if (!luts) {
    const transmittance = bakeTransmittanceLut(a);
    luts = { atmosphere: a, transmittance, multiScattering: bakeMultiScatteringLut(a, transmittance) };
    if (lutCache.size >= 4) lutCache.delete(lutCache.keys().next().value!);
    lutCache.set(key, luts);
  }
  return luts;
}

/**
 * The sky's radiance along a unit view direction `d` (world, y up) from the
 * scene, under a sun toward `sun` whose radiance above the atmosphere is
 * `sunRadiance` (the key light's linear colour × intensity), in the
 * renderer's luminance units; the sun's own disc is left out (the key light
 * is the sun). Below the horizon it is the lit ground seen through the air.
 */
export function skyRadiance(luts: AtmosphereLuts, d: readonly number[], sun: readonly number[], sunRadiance: readonly number[]): V3 {
  const a = luts.atmosphere;
  const r = a.bottom + a.viewHeight;
  const mu = d[1]!;
  const ground = hitsGround(a, r, mu) ? raySphere(r, mu, a.bottom) : -1;
  const tMax = ground > 0 ? ground : Math.max(0, raySphere(r, mu, a.top));
  const cos = d[0]! * sun[0]! + d[1]! * sun[1]! + d[2]! * sun[2]!;
  const pr = rayleighPhase(cos);
  const pm = miePhase(cos, a.mieG);
  // The physical sun's illuminance, π × the renderer's units (whose diffuse carries no 1/π).
  const E = sunRadiance.map((s) => s * Math.PI);
  const L: V3 = [0, 0, 0];
  const throughput: V3 = [1, 1, 1];
  for (let i = 0; i < SKY_STEPS; i += 1) {
    const t0 = tMax * (i / SKY_STEPS) ** 2;
    const t1 = tMax * ((i + 1) / SKY_STEPS) ** 2;
    const t = t0 + 0.3 * (t1 - t0);
    const dt = t1 - t0;
    const p: V3 = [d[0]! * t, r + d[1]! * t, d[2]! * t];
    const pR = Math.hypot(p[0], p[1], p[2]);
    const m = mediumAt(a, pR - a.bottom);
    const muSun = (p[0] * sun[0]! + p[1] * sun[1]! + p[2] * sun[2]!) / pR;
    const ts = transmittanceTo(a, luts.transmittance, pR, muSun);
    const ms = multiScatteringAt(a, luts.multiScattering, pR - a.bottom, muSun);
    for (let c = 0; c < 3; c += 1) {
      const ext = Math.max(1e-9, m.extinction[c]!);
      const step = Math.exp(-ext * dt);
      const S = E[c]! * ((m.rayleigh[c]! * pr + m.mie * pm) * ts[c]! + ms[c]! * (m.rayleigh[c]! + m.mie));
      L[c]! += throughput[c]! * ((S - S * step) / ext);
      throughput[c]! *= step;
    }
  }
  if (ground > 0) {
    const p: V3 = [d[0]! * ground, r + d[1]! * ground, d[2]! * ground];
    const pR = Math.hypot(p[0], p[1], p[2]);
    const muSun = (p[0] * sun[0]! + p[1] * sun[1]! + p[2] * sun[2]!) / pR;
    const ts = transmittanceTo(a, luts.transmittance, pR, muSun);
    for (let c = 0; c < 3; c += 1) L[c]! += throughput[c]! * ts[c]! * Math.max(0, muSun) * (a.groundAlbedo / Math.PI) * E[c]!;
  }
  return L;
}

/** The transmittance from the scene to the sun along `sun` (0 once it is below the horizon): what tints the key light. */
export function sunTransmittance(luts: AtmosphereLuts, sun: readonly number[]): V3 {
  const a = luts.atmosphere;
  const l = Math.hypot(sun[0]!, sun[1]!, sun[2]!) || 1;
  return transmittanceTo(a, luts.transmittance, a.bottom + a.viewHeight, sun[1]! / l);
}

/** The sun disc's radiance, in the renderer's units, as the eye sees it: its illuminance over its solid angle, through the air. */
export function sunDiscRadiance(luts: AtmosphereLuts, sun: readonly number[], sunRadiance: readonly number[]): V3 {
  const t = sunTransmittance(luts, sun);
  const solid = 2 * Math.PI * (1 - Math.cos(luts.atmosphere.sunRadius));
  return [0, 1, 2].map((c) => (Math.PI * sunRadiance[c]! * t[c]!) / solid) as V3;
}

/**
 * The sky as an equirectangular panorama (u around from −x, v down from the
 * zenith, as the IBL reads it) of RGB floats in the renderer's units.
 */
export function atmospherePanorama(luts: AtmosphereLuts, sun: readonly number[], sunRadiance: readonly number[], width = 256, height = 128): HdrImage {
  const out: HdrImage = { width, height, data: new Float32Array(width * height * 3) };
  atmospherePanoramaRows(luts, sun, sunRadiance, out, 0, height);
  return out;
}

/**
 * Rows `y0` to `y1` of {@link atmospherePanorama} into `out`, so a time of day
 * can spread a panorama over several frames (F5a-2).
 */
export function atmospherePanoramaRows(luts: AtmosphereLuts, sun: readonly number[], sunRadiance: readonly number[], out: HdrImage, y0: number, y1: number): void {
  const { width, height, data } = out;
  const l = Math.hypot(sun[0]!, sun[1]!, sun[2]!) || 1;
  const s = [sun[0]! / l, sun[1]! / l, sun[2]! / l];
  for (let y = Math.max(0, y0); y < Math.min(height, y1); y += 1) {
    const theta = (Math.PI * (y + 0.5)) / height;
    for (let x = 0; x < width; x += 1) {
      const phi = (2 * Math.PI * (x + 0.5)) / width - Math.PI;
      const d = [Math.sin(theta) * Math.cos(phi), Math.cos(theta), Math.sin(theta) * Math.sin(phi)];
      data.set(skyRadiance(luts, d, s, sunRadiance), (y * width + x) * 3);
    }
  }
}

// --- Aerial perspective (F5a-2) ------------------------------------------------------

/**
 * The aerial-perspective LUT (Hillaire's froxel volume over the camera's
 * frustum): {@link AERIAL_SIZE}² columns across the screen, each a view ray,
 * and {@link AERIAL_SLICES} slices along it, spaced quadratically out to
 * {@link AERIAL_RANGE} km, so the near air, which the scene mostly stands in,
 * gets most of them. Each froxel holds the light the air scatters toward the
 * eye between it and the camera, and the share of what lies beyond that
 * reaches the eye (the mean over red, green and blue, as Hillaire keeps it).
 */
export const AERIAL_SIZE = 16;
export const AERIAL_SLICES = 32;
export const AERIAL_RANGE = 32;
/** The steps each slice's stretch of air is integrated in. */
export const AERIAL_SUBSTEPS = 4;

/** A slice coordinate (0..1 along the volume) into the distance it stands for, km. */
export function aerialDistance(w: number): number {
  return w * w * AERIAL_RANGE;
}

/** A distance, km, into its slice coordinate (the inverse of {@link aerialDistance}, clamped to the volume). */
export function aerialSlice(t: number): number {
  return Math.sqrt(Math.min(1, Math.max(0, t) / AERIAL_RANGE));
}

/** The camera a froxel volume is built for: its right, up and back axes (world) and its projection's x and y focal terms (P[0], P[5]). */
export interface AerialCamera {
  readonly right: readonly number[];
  readonly up: readonly number[];
  readonly back: readonly number[];
  readonly focalX: number;
  readonly focalY: number;
}

/** A camera's axes from its view matrix (column-major, world → view) and projection. */
export function aerialCamera(view: ArrayLike<number>, projection: ArrayLike<number>): AerialCamera {
  return { right: [view[0]!, view[4]!, view[8]!], up: [view[1]!, view[5]!, view[9]!], back: [view[2]!, view[6]!, view[10]!], focalX: projection[0]!, focalY: projection[5]! };
}

/** The view ray through screen point (u, v), y down: a froxel column's direction. */
export function aerialDirection(camera: AerialCamera, u: number, v: number): V3 {
  const x = (u * 2 - 1) / camera.focalX;
  const y = (1 - v * 2) / camera.focalY;
  const d = [0, 1, 2].map((k) => camera.right[k]! * x + camera.up[k]! * y - camera.back[k]!);
  const l = Math.hypot(d[0]!, d[1]!, d[2]!) || 1;
  return [d[0]! / l, d[1]! / l, d[2]! / l];
}

/**
 * One froxel column: along the unit direction `d` from the scene's eye, the
 * light scattered toward it (RGB, the renderer's units) and the transmittance
 * (RGB) out to each slice's centre, integrated slice after slice with the sky's
 * own energy-conserving step. The ray passes under the planet's ground as
 * though it were air at its foot (the scene's ground is the scene's), and
 * stops gathering once it leaves the atmosphere.
 */
export function aerialColumn(luts: AtmosphereLuts, d: readonly number[], sun: readonly number[], sunRadiance: readonly number[]): { inscatter: V3[]; transmittance: V3[] } {
  const a = luts.atmosphere;
  const r = a.bottom + a.viewHeight;
  const tTop = Math.max(0, raySphere(r, d[1]!, a.top));
  const cos = d[0]! * sun[0]! + d[1]! * sun[1]! + d[2]! * sun[2]!;
  const pr = rayleighPhase(cos);
  const pm = miePhase(cos, a.mieG);
  const E = sunRadiance.map((s) => s * Math.PI);
  const L: V3 = [0, 0, 0];
  const throughput: V3 = [1, 1, 1];
  const inscatter: V3[] = [];
  const transmittance: V3[] = [];
  let t = 0;
  for (let z = 0; z < AERIAL_SLICES; z += 1) {
    const end = Math.min(tTop, aerialDistance((z + 0.5) / AERIAL_SLICES));
    const dt = Math.max(0, end - t) / AERIAL_SUBSTEPS;
    for (let i = 0; i < AERIAL_SUBSTEPS && dt > 0; i += 1) {
      const s = t + (i + 0.5) * dt;
      const p: V3 = [d[0]! * s, r + d[1]! * s, d[2]! * s];
      const pR = Math.max(a.bottom + 1e-3, Math.hypot(p[0], p[1], p[2]));
      const m = mediumAt(a, pR - a.bottom);
      const muSun = (p[0] * sun[0]! + p[1] * sun[1]! + p[2] * sun[2]!) / pR;
      const ts = transmittanceTo(a, luts.transmittance, pR, muSun);
      const ms = multiScatteringAt(a, luts.multiScattering, pR - a.bottom, muSun);
      for (let c = 0; c < 3; c += 1) {
        const ext = Math.max(1e-9, m.extinction[c]!);
        const step = Math.exp(-ext * dt);
        const S = E[c]! * ((m.rayleigh[c]! * pr + m.mie * pm) * ts[c]! + ms[c]! * (m.rayleigh[c]! + m.mie));
        L[c]! += throughput[c]! * ((S - S * step) / ext);
        throughput[c]! *= step;
      }
    }
    t = Math.max(t, end);
    inscatter.push([...L]);
    transmittance.push([...throughput]);
  }
  return { inscatter, transmittance };
}

/**
 * The aerial-perspective LUT for a camera, as the GPU builds it: per froxel
 * (x fastest, then y down the screen, then the slice) its in-scattered RGB and
 * mean transmittance, four floats.
 */
export function bakeAerialPerspective(luts: AtmosphereLuts, camera: AerialCamera, sun: readonly number[], sunRadiance: readonly number[]): Float32Array {
  const n = AERIAL_SIZE;
  const out = new Float32Array(n * n * AERIAL_SLICES * 4);
  for (let y = 0; y < n; y += 1) {
    for (let x = 0; x < n; x += 1) {
      const column = aerialColumn(luts, aerialDirection(camera, (x + 0.5) / n, (y + 0.5) / n), sun, sunRadiance);
      for (let z = 0; z < AERIAL_SLICES; z += 1) {
        const T = column.transmittance[z]!;
        out.set([...column.inscatter[z]!, (T[0] + T[1] + T[2]) / 3], ((z * n + y) * n + x) * 4);
      }
    }
  }
  return out;
}

/**
 * A LUT's aerial perspective at screen point (u, v) and a distance (km),
 * filtered as the scene shader filters it: trilinearly between froxel
 * centres, faded toward none (no light, all passing) nearer than the first
 * slice's centre. Returns the in-scattered RGB and the transmittance.
 */
export function sampleAerialPerspective(lut: Float32Array, u: number, v: number, t: number): { inscatter: V3; transmittance: number } {
  const n = AERIAL_SIZE;
  const first = aerialDistance(0.5 / AERIAL_SLICES);
  const fade = Math.min(1, Math.max(0, t) / first);
  const fx = Math.min(n - 1, Math.max(0, u * n - 0.5));
  const fy = Math.min(n - 1, Math.max(0, v * n - 0.5));
  const fz = Math.min(AERIAL_SLICES - 1, Math.max(0, aerialSlice(t) * AERIAL_SLICES - 0.5));
  const x0 = Math.floor(fx), y0 = Math.floor(fy), z0 = Math.floor(fz);
  const x1 = Math.min(n - 1, x0 + 1), y1 = Math.min(n - 1, y0 + 1), z1 = Math.min(AERIAL_SLICES - 1, z0 + 1);
  const out = [0, 0, 0, 0];
  for (const [z, wz] of [[z0, 1 - (fz - z0)], [z1, fz - z0]] as const) {
    for (const [y, wy] of [[y0, 1 - (fy - y0)], [y1, fy - y0]] as const) {
      for (const [x, wx] of [[x0, 1 - (fx - x0)], [x1, fx - x0]] as const) {
        const i = ((z * n + y) * n + x) * 4;
        for (let c = 0; c < 4; c += 1) out[c]! += lut[i + c]! * wx * wy * wz;
      }
    }
  }
  return { inscatter: [out[0]! * fade, out[1]! * fade, out[2]! * fade], transmittance: 1 - (1 - out[3]!) * fade };
}

// --- The sun ---------------------------------------------------------------------

/** Authored colour into linear light (the renderers' toLinear). */
const toLinear = (c: number) => (c <= 0.04045 ? Math.max(0, c) / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

/**
 * A rig's physical sky and its sun, or null when its sky is painted: the
 * medium, and the sun as the key light (its first directional light) stands
 * above the atmosphere, toward it and its linear colour × intensity. A rig
 * without a key has the sky's own sun direction at unit radiance.
 */
export function atmosphereSun(lighting: SceneLighting): { atmosphere: Atmosphere; direction: V3; radiance: V3 } | null {
  const settings = lighting.sky?.atmosphere;
  if (!lighting.sky || !settings) return null;
  const key = lighting.lights.find((l) => l.kind === "directional" && l.direction);
  const d = key?.direction ?? lighting.sky.sunDirection;
  const l = Math.hypot(d[0], d[1], d[2]) || 1;
  const c = key ? lightColor(key) : ([1, 1, 1] as const);
  const intensity = key ? key.intensity : 1;
  return {
    atmosphere: resolveAtmosphere(settings),
    direction: [d[0] / l, d[1] / l, d[2] / l],
    radiance: [toLinear(c[0]) * intensity, toLinear(c[1]) * intensity, toLinear(c[2]) * intensity],
  };
}

const tinted = new WeakMap<SceneLighting, SceneLighting>();

/**
 * The rig as its physical sky lights it (F5a): the key light tinted by the
 * transmittance of the air between it and the scene, so the noon sun is a
 * little warm, a low one orange, and a set one dark. Its temperature (F2e) is
 * folded into the colour, and the sky's own sun (the shafts' and the lens
 * flare's) is aimed along it. A rig with a painted sky is returned as it is.
 */
export function atmosphereLighting(lighting: SceneLighting): SceneLighting {
  const sun = atmosphereSun(lighting);
  if (!sun) return lighting;
  const cached = tinted.get(lighting);
  if (cached) return cached;
  const t = sunTransmittance(atmosphereLuts(sun.atmosphere), sun.direction);
  const at = lighting.lights.findIndex((l) => l.kind === "directional" && l.direction);
  if (at < 0) return lighting;
  const key = lighting.lights[at]!;
  const c = lightColor(key);
  const { temperature: _temperature, ...rest } = key;
  const lit: SceneLight = { ...rest, color: [0, 1, 2].map((k) => linearToAuthored(toLinear(c[k]!) * t[k]!)) as V3 };
  const out = { ...lighting, lights: lighting.lights.map((l, i) => (i === at ? lit : l)), sky: { ...lighting.sky!, sunDirection: sun.direction } };
  tinted.set(lighting, out);
  return out;
}
