/**
 * Weather (AAA_FIDELITY_ROADMAP.md F5e): wetness, puddles and snow as layers
 * over every material, driven by one weather state, and the rain and snow that
 * fall. The CPU reference the AAA scene shader (WebgpuSceneRenderer.ts)
 * mirrors term for term.
 *
 * - **Wet** (Lagarde, "Water drop 2b – Dynamic rain and its effects", 2013):
 *   a porous surface darkens as water fills its pores (its albedo raised to a
 *   power, toward the square, by how porous — rough — it is) and turns glossy;
 *   a metal only turns glossy. Water's own Fresnel (f0 0.02) replaces a
 *   dielectric's where it pools.
 * - **Puddles** gather on what faces up, in the hollows a world-space noise
 *   lays out, more of them the more it has rained: water over the surface,
 *   flat, mirror-smooth, its albedo darkened through the water, and rain's
 *   rings rippling it.
 * - **Snow** settles on what faces up above the snow line, deepest where the
 *   surface is flattest, broken at its edge by the same noise: a white,
 *   rough, flat-normalled layer over the surface.
 * - **Shelter.** What the sky can't see stays dry and bare: each layer is
 *   scaled by the surface's sky visibility (the HDR light map's, or the probe
 *   volume's), from none under cover to all of it in the open.
 * - **Falling**: rain streaks and snowflakes are GPU particle emitters (F8a)
 *   in a box that follows the eye, falling, drifting and colliding with the
 *   depth buffer.
 *
 * Pure and DOM-free.
 */

import type { EmitterSpec } from "./particleGraph";

type V3 = [number, number, number];

/** What a creator (or a cart, at run time) sets, each 0..1 unless noted. */
export interface WeatherSettings {
  /** How wet every exposed surface is. */
  readonly wetness?: number;
  /** How much of the up-facing ground is under puddles. */
  readonly puddles?: number;
  /** How much snow lies on what faces up. */
  readonly snow?: number;
  /** How hard it is raining (the streaks, and the rings in the puddles). */
  readonly rain?: number;
  /** How hard it is snowing. */
  readonly snowfall?: number;
  /** Snow lies only above this height (metres). */
  readonly snowLine?: number;
  /** The size of the puddles' and snow's patches (metres). */
  readonly scale?: number;
}

export interface Weather {
  readonly wetness: number;
  readonly puddles: number;
  readonly snow: number;
  readonly rain: number;
  readonly snowfall: number;
  readonly snowLine: number;
  readonly scale: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const clamp01 = (v: number) => clamp(v, 0, 1);
const smoothstep = (a: number, b: number, x: number) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};

export const WEATHER_DEFAULTS: Weather = { wetness: 0, puddles: 0, snow: 0, rain: 0, snowfall: 0, snowLine: -1000, scale: 4 };

export function parseWeather(value: unknown): WeatherSettings | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const out: Record<string, number> = {};
  const take = (key: keyof WeatherSettings, lo: number, hi: number) => {
    const v = raw[key];
    if (typeof v === "number" && Number.isFinite(v)) out[key] = clamp(v, lo, hi);
  };
  for (const key of ["wetness", "puddles", "snow", "rain", "snowfall"] as const) take(key, 0, 1);
  take("snowLine", -10000, 10000);
  take("scale", 0.25, 100);
  return out as WeatherSettings;
}

export function resolveWeather(settings: WeatherSettings | null | undefined): Weather {
  return { ...WEATHER_DEFAULTS, ...(settings ?? {}) };
}

/** Whether a weather state changes how anything looks (all zero, it is skipped). */
export function weatherActive(w: Weather): boolean {
  return w.wetness > 0 || w.puddles > 0 || w.snow > 0 || w.rain > 0 || w.snowfall > 0;
}

// --- The layers -------------------------------------------------------------------

/** A hash of a 2D lattice point to [0, 1) (the shader's, bit for bit). */
export function hash2(x: number, y: number): number {
  let h = (Math.imul(x | 0, 0x8da6b343) ^ Math.imul(y | 0, 0xd8163841)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Smooth value noise in 2D, 0..1. */
export function noise2(x: number, y: number): number {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
  const a = hash2(ix, iy), b = hash2(ix + 1, iy), c = hash2(ix, iy + 1), d = hash2(ix + 1, iy + 1);
  return (a + (b - a) * sx) * (1 - sy) + (c + (d - c) * sx) * sy;
}

/** Two octaves of it: the patches puddles and snow lie in. */
export function patchNoise(x: number, z: number, scale: number): number {
  return (noise2(x / scale, z / scale) * 2 + noise2((x / scale) * 2.7 + 13.1, (z / scale) * 2.7 + 7.7)) / 3;
}

/**
 * How much of the weather reaches a surface: its sky visibility (0 under
 * cover .. 1 in the open), sharpened so a little shelter keeps it dry.
 */
export function exposure(skyVisibility: number): number {
  return smoothstep(0.35, 0.85, skyVisibility);
}

/** A surface wet by `wet` (0..1): its albedo darkened by how porous it is, its roughness lowered (Lagarde). */
export function wetSurface(albedo: readonly number[], roughness: number, metallic: number, wet: number): { albedo: V3; roughness: number } {
  // Rough (porous) dielectrics soak up the most; metals don't soak at all.
  const porosity = clamp01((roughness - 0.1) / 0.6) * (1 - metallic);
  const k = wet * porosity;
  const power = 1 + k; // up to the square
  const dark = 1 - 0.25 * k;
  return {
    albedo: [0, 1, 2].map((c) => Math.pow(Math.max(0, albedo[c]!), power) * dark) as V3,
    roughness: roughness + (Math.min(roughness, 0.3) - roughness) * wet,
  };
}

/** How deep in a puddle a point is, 0..1: up-facing, in a hollow of the patch noise, as much as has rained, where the sky reaches. */
export function puddleDepth(w: Weather, x: number, z: number, normalY: number, skyVisibility: number): number {
  if (w.puddles <= 0) return 0;
  const flat = smoothstep(0.92, 0.985, normalY);
  if (flat <= 0) return 0;
  const hollow = 1 - patchNoise(x, z, w.scale);
  // The more the cover, the higher up the hollows' sides the water reaches.
  return flat * exposure(skyVisibility) * smoothstep(1 - w.puddles, 1 - w.puddles + 0.12, hollow);
}

/** How much snow covers a point, 0..1: up-facing, above the snow line, broken at its edges by the patch noise, where the sky reaches. */
export function snowCover(w: Weather, x: number, y: number, z: number, normalY: number, skyVisibility: number): number {
  if (w.snow <= 0 || y < w.snowLine) return 0;
  const facing = smoothstep(0.55 - 0.35 * w.snow, 0.8 - 0.3 * w.snow, normalY);
  if (facing <= 0) return 0;
  const patch = patchNoise(x + 101, z + 37, w.scale);
  return facing * exposure(skyVisibility) * smoothstep(1 - w.snow * 1.15, 1 - w.snow * 1.15 + 0.15, patch);
}

/** Rain's rings in a puddle at (x, z), `time` seconds: the slope they add to its flat surface (dh/dx, dh/dz). */
export function rainRipples(x: number, z: number, time: number, rain: number): [number, number] {
  if (rain <= 0) return [0, 0];
  let gx = 0;
  let gz = 0;
  // Two staggered grids of drops, 0.4 m apart; each cell's drop lands at a random place and time and rings out over 0.6 s.
  for (let layer = 0; layer < 2; layer += 1) {
    const size = 0.4;
    const ox = layer * 0.21, oz = layer * 0.13;
    const cx = Math.floor((x + ox) / size), cz = Math.floor((z + oz) / size);
    for (let j = -1; j <= 1; j += 1) {
      for (let i = -1; i <= 1; i += 1) {
        const ix = cx + i, iz = cz + j;
        const seed = hash2(ix + layer * 1013, iz);
        const px = (ix + 0.2 + 0.6 * hash2(ix, iz + 77)) * size - ox;
        const pz = (iz + 0.2 + 0.6 * hash2(ix + 31, iz)) * size - oz;
        const phase = time / 0.6 + seed * 10;
        const age = phase - Math.floor(phase);
        // Fewer drops in lighter rain: a cell rings only in its share of cycles.
        if (hash2(ix + Math.floor(phase) * 7, iz + layer) > rain) continue;
        const dx = x - px, dz = z - pz;
        const d = Math.hypot(dx, dz);
        const radius = age * 0.25;
        const ring = d - radius;
        if (Math.abs(ring) > 0.04 || d < 1e-5) continue;
        const amplitude = (1 - age) * Math.cos((ring / 0.04) * Math.PI * 0.5);
        const slope = amplitude * Math.sin((ring / 0.04) * Math.PI) * 0.6;
        gx += (slope * dx) / d;
        gz += (slope * dz) / d;
      }
    }
  }
  return [gx, gz];
}

/** Snow's colour (linear albedo) and roughness. */
export const SNOW_ALBEDO: V3 = [0.86, 0.88, 0.92];
export const SNOW_ROUGHNESS = 0.6;
/** Water's reflectance at normal incidence, and a puddle's roughness. */
export const WATER_F0 = 0.02;
export const PUDDLE_ROUGHNESS = 0.03;

/**
 * The weather over one surface point (what the shader does): its albedo,
 * roughness, metalness, normal and reflectance at normal incidence (f0), in
 * place of the material's. `n` is the shading normal; `time` drives the rain.
 */
export function weatherSurface(
  w: Weather,
  p: readonly number[],
  n: readonly number[],
  skyVisibility: number,
  time: number,
  surface: { readonly albedo: readonly number[]; readonly roughness: number; readonly metallic: number; readonly f0: number },
): { albedo: V3; roughness: number; metallic: number; normal: V3; f0: number } {
  const open = exposure(skyVisibility);
  let { albedo, roughness } = wetSurface(surface.albedo, surface.roughness, surface.metallic, w.wetness * open);
  let metallic = surface.metallic;
  let normal: V3 = [n[0]!, n[1]!, n[2]!];
  let f0 = surface.f0;
  const puddle = puddleDepth(w, p[0]!, p[2]!, n[1]!, skyVisibility);
  if (puddle > 0) {
    // Under water: darker through it, mirror-smooth, flat (up) and rippling, a dielectric with water's Fresnel.
    const [gx, gz] = rainRipples(p[0]!, p[2]!, time, w.rain);
    const flat = [-gx, 1, -gz];
    const l = Math.hypot(flat[0]!, flat[1]!, flat[2]!);
    normal = [0, 1, 2].map((c) => normal[c]! + (flat[c]! / l - normal[c]!) * puddle) as V3;
    const nl = Math.hypot(normal[0], normal[1], normal[2]) || 1;
    normal = [normal[0] / nl, normal[1] / nl, normal[2] / nl];
    albedo = albedo.map((c) => c * (1 - 0.35 * puddle)) as V3;
    roughness = roughness + (PUDDLE_ROUGHNESS - roughness) * puddle;
    metallic = metallic * (1 - puddle);
    f0 = f0 + (WATER_F0 - f0) * puddle;
  }
  const snow = snowCover(w, p[0]!, p[1]!, p[2]!, n[1]!, skyVisibility);
  if (snow > 0) {
    albedo = albedo.map((c, i) => c + (SNOW_ALBEDO[i]! - c) * snow) as V3;
    roughness = roughness + (SNOW_ROUGHNESS - roughness) * snow;
    metallic = metallic * (1 - snow);
    f0 = f0 + (0.04 - f0) * snow;
    const up: V3 = [normal[0] * (1 - snow), normal[1] * (1 - snow) + snow, normal[2] * (1 - snow)];
    const ul = Math.hypot(up[0], up[1], up[2]) || 1;
    normal = [up[0] / ul, up[1] / ul, up[2] / ul];
  }
  return { albedo, roughness, metallic, normal, f0 };
}

// --- Falling --------------------------------------------------------------------------

/** The box round the eye that rain and snow fall in (half extents, metres). */
export const PRECIPITATION_BOX: V3 = [14, 9, 14];

/**
 * Rain and snow as GPU particle emitters (F8a): spawned over the top of a box
 * that follows the eye (the player moves their origin each frame), falling,
 * and stopped by the depth buffer. None when nothing falls.
 */
export function weatherEmitters(w: Weather): EmitterSpec[] {
  const out: EmitterSpec[] = [];
  const [bx, by, bz] = PRECIPITATION_BOX;
  if (w.rain > 0) {
    // Heavy rain is some 4000 drops a second over this box, falling at about 9 m/s.
    out.push({
      name: "weather:rain",
      capacity: 8192,
      modules: [
        { type: "spawnRate", rate: Math.round(4000 * w.rain) },
        { type: "shape", kind: "box", extents: [bx, 0.5, bz] },
        { type: "velocity", speed: 0 },
        { type: "lifetime", seconds: (2 * by) / 9, jitter: 0.1 },
        { type: "size", start: 0.012 },
        { type: "color", start: [0.75, 0.8, 0.9, 0.35], end: [0.75, 0.8, 0.9, 0.35] },
        { type: "gravity", acceleration: [0.4, -9, 0.2] },
        { type: "drag", amount: 0 },
        { type: "collideDepth", restitution: 0, friction: 1 },
        { type: "render", mode: "sprite", blend: "alpha", stretch: 0.08 },
      ],
    });
  }
  if (w.snowfall > 0) {
    // Snow drifts down at about 1 m/s, swirling.
    out.push({
      name: "weather:snow",
      capacity: 8192,
      modules: [
        { type: "spawnRate", rate: Math.round(800 * w.snowfall) },
        { type: "shape", kind: "box", extents: [bx, 0.5, bz] },
        { type: "velocity", speed: 0 },
        { type: "lifetime", seconds: (2 * by) / 1, jitter: 0.2 },
        { type: "size", start: 0.03 },
        { type: "color", start: [0.95, 0.96, 1, 0.9], end: [0.95, 0.96, 1, 0.9] },
        { type: "gravity", acceleration: [0, -1, 0] },
        { type: "drag", amount: 1 },
        { type: "curlNoise", strength: 0.8, scale: 1.5, speed: 0.3 },
        { type: "collideDepth", restitution: 0, friction: 1 },
        { type: "render", mode: "sprite", blend: "alpha" },
      ],
    });
  }
  return out;
}

/** Where the precipitation box's top is for an eye at `eye`: what the emitters' origin follows. */
export function precipitationOrigin(eye: readonly number[]): V3 {
  return [eye[0]!, eye[1]! + PRECIPITATION_BOX[1], eye[2]!];
}
