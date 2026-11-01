/**
 * Volumetric clouds (AAA_FIDELITY_ROADMAP.md F5c): a layer of cloud in the
 * physical sky's air (F5a), raymarched, and the CPU reference the GPU's pass
 * (clouds.ts in @cartbox/player) mirrors step for step.
 *
 * - **The shape** is Nubis's (Schneider 2015, 2017): a tileable Perlin–Worley
 *   base noise with three Worley octaves over it, remapped by a weather map's
 *   coverage and a height gradient that runs from flat stratus to towering
 *   cumulus by the layer's type; then a finer Worley noise erodes its edges.
 *   The noises are baked once (a 32³ shape volume, a 16³ detail volume, a 64²
 *   weather map) and tiled over the sky.
 * - **The light** at each step is the sun's, through the air above it (the
 *   transmittance LUT) and through the cloud toward it (a short march), under
 *   a two-lobed Henyey–Greenstein phase, with Wrenninge's octaves standing in
 *   for multiple scattering; and the sky's, from its mean radiance, dimmer
 *   toward the layer's floor.
 * - **The march** goes through the spherical shell the layer fills on the
 *   planet of the atmosphere, with the energy-conserving step (as the sky's),
 *   into the light the cloud sends toward the eye and its transmittance.
 * - **Shadows**: the transmittance of the layer along the sun from a point on
 *   the ground, which dims the sun on the scene.
 *
 * Units are the atmosphere's: kilometres, and the renderer's luminance units
 * (a sun of 1 lights a white Lambertian surface at 1).
 *
 * Pure and DOM-free.
 */

import { hitsGround, raySphere, resolveAtmosphere, transmittanceTo, type AtmosphereLuts } from "./atmosphere";
import type { SceneLighting } from "./SceneLighting";

type V3 = [number, number, number];

/** What a creator sets. */
export interface CloudSettings {
  /** How much of the sky the layer covers, 0 (clear) .. 1 (overcast). */
  readonly coverage?: number;
  /** The layer's floor above the ground, km. */
  readonly base?: number;
  /** The layer's depth, km. */
  readonly thickness?: number;
  /** The extinction of the densest cloud, per km (cumulus is about 50–100). */
  readonly density?: number;
  /** 0 flat stratus .. 1 towering cumulus. */
  readonly type?: number;
  /** The size of the cloud features across, km (the shape noise's tile). */
  readonly scale?: number;
  /** The wind, metres a second, and where it blows toward (degrees about y from +x). */
  readonly windSpeed?: number;
  readonly windDirection?: number;
  /** How dark the clouds' shadows fall on the scene, 0 .. 1. */
  readonly shadows?: number;
}

/** A layer resolved, in km. */
export interface Clouds {
  readonly coverage: number;
  readonly base: number;
  readonly thickness: number;
  readonly density: number;
  readonly type: number;
  readonly scale: number;
  /** The wind's drift, km a second, in x and z. */
  readonly wind: readonly [number, number];
  readonly shadows: number;
}

export const CLOUD_DEFAULTS = { coverage: 0.45, base: 1.5, thickness: 1.8, density: 60, type: 0.65, scale: 12, windSpeed: 12, windDirection: 30, shadows: 0.85 } as const;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Settings read defensively, kept sparse; null for anything that isn't an object. */
export function parseClouds(value: unknown): CloudSettings | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const out: Record<string, number> = {};
  const take = (key: keyof CloudSettings, lo: number, hi: number) => {
    const v = raw[key];
    if (typeof v === "number" && Number.isFinite(v)) out[key] = clamp(v, lo, hi);
  };
  take("coverage", 0, 1);
  take("base", 0.1, 12);
  take("thickness", 0.1, 10);
  take("density", 0.5, 500);
  take("type", 0, 1);
  take("scale", 1, 100);
  take("windSpeed", 0, 100);
  take("windDirection", -360, 360);
  take("shadows", 0, 1);
  return out as CloudSettings;
}

export function resolveClouds(settings: CloudSettings = {}): Clouds {
  const d = CLOUD_DEFAULTS;
  const speed = (settings.windSpeed ?? d.windSpeed) / 1000;
  const angle = ((settings.windDirection ?? d.windDirection) * Math.PI) / 180;
  return {
    coverage: settings.coverage ?? d.coverage,
    base: settings.base ?? d.base,
    thickness: settings.thickness ?? d.thickness,
    density: settings.density ?? d.density,
    type: settings.type ?? d.type,
    scale: settings.scale ?? d.scale,
    wind: [Math.cos(angle) * speed, Math.sin(angle) * speed],
    shadows: settings.shadows ?? d.shadows,
  };
}

// --- The noises -----------------------------------------------------------------

/** A 32-bit integer hash of three cells (PCG-style), to [0, 1). */
export function hash3(x: number, y: number, z: number, seed = 0): number {
  let h = (Math.imul(x | 0, 0x8da6b343) ^ Math.imul(y | 0, 0xd8163841) ^ Math.imul(z | 0, 0xcb1ab31f) ^ Math.imul(seed | 0, 0x165667b1)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  return h / 4294967296;
}

const wrap = (i: number, n: number) => ((i % n) + n) % n;

/** Tileable value noise (smoothstep-interpolated lattice) of period `n` cells, 0..1. */
export function valueNoise(x: number, y: number, z: number, n: number, seed: number): number {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
  const fx = x - ix, fy = y - iy, fz = z - iz;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy), sz = fz * fz * (3 - 2 * fz);
  const at = (dx: number, dy: number, dz: number) => hash3(wrap(ix + dx, n), wrap(iy + dy, n), wrap(iz + dz, n), seed);
  const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
  return lerp(
    lerp(lerp(at(0, 0, 0), at(1, 0, 0), sx), lerp(at(0, 1, 0), at(1, 1, 0), sx), sy),
    lerp(lerp(at(0, 0, 1), at(1, 0, 1), sx), lerp(at(0, 1, 1), at(1, 1, 1), sx), sy),
    sz,
  );
}

/** Tileable Worley noise of period `n` cells, inverted (1 at a feature point, 0 a cell away): billowy. */
export function worley(x: number, y: number, z: number, n: number, seed: number): number {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
  let best = 1e9;
  for (let dz = -1; dz <= 1; dz += 1) {
    for (let dy = -1; dy <= 1; dy += 1) {
      for (let dx = -1; dx <= 1; dx += 1) {
        const cx = ix + dx, cy = iy + dy, cz = iz + dz;
        const wx = wrap(cx, n), wy = wrap(cy, n), wz = wrap(cz, n);
        const px = cx + hash3(wx, wy, wz, seed);
        const py = cy + hash3(wx, wy, wz, seed + 1);
        const pz = cz + hash3(wx, wy, wz, seed + 2);
        const d = (px - x) ** 2 + (py - y) ** 2 + (pz - z) ** 2;
        if (d < best) best = d;
      }
    }
  }
  return 1 - clamp(Math.sqrt(best), 0, 1);
}

/** Map v from [lo0, hi0] onto [lo1, hi1] (Nubis's remap), unclamped. */
export function remap(v: number, lo0: number, hi0: number, lo1: number, hi1: number): number {
  return lo1 + ((v - lo0) / Math.max(1e-6, hi0 - lo0)) * (hi1 - lo1);
}

export const SHAPE_SIZE = 32;
export const DETAIL_SIZE = 16;
export const WEATHER_SIZE = 64;

/** The baked noises, RGBA bytes, x fastest then y then z. */
export interface CloudNoise {
  /** Perlin–Worley in r, Worley at three frequencies in gba. */
  readonly shape: Uint8Array;
  /** Worley at three frequencies in rgb (a unused). */
  readonly detail: Uint8Array;
  /** Coverage variation in r, 0..1 (a 2D map, RGBA for upload). */
  readonly weather: Uint8Array;
}

let baked: CloudNoise | null = null;

/** The noises, baked once (about 0.3 s). */
export function cloudNoise(): CloudNoise {
  if (baked) return baked;
  const s = SHAPE_SIZE;
  const shape = new Uint8Array(s * s * s * 4);
  for (let z = 0; z < s; z += 1) {
    for (let y = 0; y < s; y += 1) {
      for (let x = 0; x < s; x += 1) {
        const o = ((z * s + y) * s + x) * 4;
        // Perlin–Worley: value fbm (three octaves) remapped by billowy Worley.
        let fbm = 0;
        let amp = 0.5;
        let norm = 0;
        for (let k = 0; k < 3; k += 1) {
          const f = 4 << k;
          fbm += amp * valueNoise(((x + 0.5) / s) * f, ((y + 0.5) / s) * f, ((z + 0.5) / s) * f, f, 11 + k);
          norm += amp;
          amp *= 0.5;
        }
        fbm /= norm;
        const w0 = worley(((x + 0.5) / s) * 4, ((y + 0.5) / s) * 4, ((z + 0.5) / s) * 4, 4, 3);
        const pw = clamp(remap(fbm, w0 - 1, 1, 0, 1), 0, 1);
        shape[o] = Math.round(pw * 255);
        for (let k = 0; k < 3; k += 1) {
          const f = 4 << k;
          shape[o + 1 + k] = Math.round(worley(((x + 0.5) / s) * f, ((y + 0.5) / s) * f, ((z + 0.5) / s) * f, f, 23 + k * 3) * 255);
        }
      }
    }
  }
  const d = DETAIL_SIZE;
  const detail = new Uint8Array(d * d * d * 4);
  for (let z = 0; z < d; z += 1) {
    for (let y = 0; y < d; y += 1) {
      for (let x = 0; x < d; x += 1) {
        const o = ((z * d + y) * d + x) * 4;
        for (let k = 0; k < 3; k += 1) {
          const f = 2 << k;
          detail[o + k] = Math.round(worley(((x + 0.5) / d) * f, ((y + 0.5) / d) * f, ((z + 0.5) / d) * f, f, 41 + k * 3) * 255);
        }
        detail[o + 3] = 255;
      }
    }
  }
  const w = WEATHER_SIZE;
  const weather = new Uint8Array(w * w * 4);
  for (let y = 0; y < w; y += 1) {
    for (let x = 0; x < w; x += 1) {
      let v = 0;
      let amp = 0.5;
      let norm = 0;
      for (let k = 0; k < 4; k += 1) {
        const f = 2 << k;
        v += amp * valueNoise(((x + 0.5) / w) * f, ((y + 0.5) / w) * f, 0.5, f, 61 + k);
        norm += amp;
        amp *= 0.5;
      }
      const o = (y * w + x) * 4;
      weather[o] = Math.round(clamp(v / norm, 0, 1) * 255);
      weather[o + 1] = weather[o];
      weather[o + 2] = weather[o];
      weather[o + 3] = 255;
    }
  }
  baked = { shape, detail, weather };
  return baked;
}

/** Trilinear sample of a baked RGBA volume of `n`³ at (u, v, w) in tiles (wrapping), channel c, 0..1 — as a GPU's linear filter reads it. */
export function sampleVolume(data: Uint8Array, n: number, u: number, v: number, w: number, c: number): number {
  const x = u * n - 0.5, y = v * n - 0.5, z = w * n - 0.5;
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
  const fx = x - ix, fy = y - iy, fz = z - iz;
  const at = (dx: number, dy: number, dz: number) => data[((wrap(iz + dz, n) * n + wrap(iy + dy, n)) * n + wrap(ix + dx, n)) * 4 + c]! / 255;
  const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
  return lerp(
    lerp(lerp(at(0, 0, 0), at(1, 0, 0), fx), lerp(at(0, 1, 0), at(1, 1, 0), fx), fy),
    lerp(lerp(at(0, 0, 1), at(1, 0, 1), fx), lerp(at(0, 1, 1), at(1, 1, 1), fx), fy),
    fz,
  );
}

/** Bilinear sample of the weather map at (u, v) in tiles, 0..1. */
export function sampleWeather(data: Uint8Array, u: number, v: number): number {
  const n = WEATHER_SIZE;
  const x = u * n - 0.5, y = v * n - 0.5;
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy;
  const at = (dx: number, dy: number) => data[(wrap(iy + dy, n) * n + wrap(ix + dx, n)) * 4]! / 255;
  return (at(0, 0) * (1 - fx) + at(1, 0) * fx) * (1 - fy) + (at(0, 1) * (1 - fx) + at(1, 1) * fx) * fy;
}

// --- The density ----------------------------------------------------------------

/** How the layer's density runs with height, 0 at the floor .. 1 at the top, for its type (stratus → cumulus). */
export function heightGradient(h: number, type: number): number {
  const rise = clamp(remap(h, 0, 0.08, 0, 1), 0, 1);
  const stratus = clamp(remap(h, 0.18, 0.3, 1, 0), 0, 1);
  const cumulus = clamp(remap(h, 0.55, 1, 1, 0), 0, 1);
  return rise * (stratus + (cumulus - stratus) * type);
}

/** The weather map's tiles span this many shape tiles: broad patches of cloud and clear sky. */
export const WEATHER_TILES = 6;
/** The detail noise's tiles across a shape tile. */
export const DETAIL_TILES = 5;

/**
 * The cloud's extinction (per km) at a point p in the planet's frame (km, the
 * planet's centre at (0, −bottom, 0), so the ground under the scene is the
 * origin), at time `time` seconds, under the layer `c`. `cheap` skips the
 * erosion (the light march, as Nubis does).
 */
export function cloudDensity(c: Clouds, noise: CloudNoise, bottom: number, p: readonly number[], time: number, cheap = false): number {
  const r = Math.hypot(p[0]!, p[1]! + bottom, p[2]!);
  const h = (r - bottom - c.base) / c.thickness;
  if (h <= 0 || h >= 1) return 0;
  // The wind drifts the shape; the tops lean ahead of the floor a little.
  const x = p[0]! - c.wind[0] * time * (1 + 0.5 * h);
  const z = p[2]! - c.wind[1] * time * (1 + 0.5 * h);
  const tile = c.scale;
  // The weather map breaks the cover into patches, less so toward overcast; nothing at all at 0.
  const weather = sampleWeather(noise.weather, x / (tile * WEATHER_TILES), z / (tile * WEATHER_TILES));
  const local = clamp(c.coverage + (weather - 0.5) * 0.9 * (1 - 0.6 * c.coverage), 0, 1) * Math.min(1, c.coverage * 4);
  if (local <= 0) return 0;
  const u = x / tile, v = (h * c.thickness) / tile, w = z / tile;
  const base = sampleVolume(noise.shape, SHAPE_SIZE, u, v, w, 0);
  const fbm = 0.625 * sampleVolume(noise.shape, SHAPE_SIZE, u, v, w, 1) + 0.25 * sampleVolume(noise.shape, SHAPE_SIZE, u, v, w, 2) + 0.125 * sampleVolume(noise.shape, SHAPE_SIZE, u, v, w, 3);
  const shaped = remap(base, fbm - 1, 1, 0, 1) * heightGradient(h, c.type);
  let d = clamp(remap(shaped, 1 - local, 1, 0, 1), 0, 1) * local;
  if (d <= 0) return 0;
  if (!cheap) {
    const du = u * DETAIL_TILES, dv = v * DETAIL_TILES, dw = w * DETAIL_TILES;
    const detail = 0.625 * sampleVolume(noise.detail, DETAIL_SIZE, du, dv, dw, 0) + 0.25 * sampleVolume(noise.detail, DETAIL_SIZE, du, dv, dw, 1) + 0.125 * sampleVolume(noise.detail, DETAIL_SIZE, du, dv, dw, 2);
    // Wispy at the floor, billowy above (Nubis's inverted detail toward the top).
    const modifier = detail + (1 - 2 * detail) * clamp(h * 10, 0, 1);
    d = clamp(remap(d, modifier * 0.35, 1, 0, 1), 0, 1);
  }
  return d * c.density;
}

// --- The light ------------------------------------------------------------------

/** Henyey–Greenstein's phase at the cosine between the view and the light. */
export function hgPhase(cos: number, g: number): number {
  const g2 = g * g;
  return (1 - g2) / (4 * Math.PI * Math.pow(Math.max(1e-6, 1 + g2 - 2 * g * cos), 1.5));
}

/** The cloud's phase: a strong forward lobe (the silver lining) and a weaker back lobe. */
export function cloudPhase(cos: number, octave: number): number {
  const k = 0.5 ** octave;
  return 0.75 * hgPhase(cos, 0.8 * k) + 0.25 * hgPhase(cos, -0.3 * k);
}

/**
 * How much of the sun a point inside a cloud passes on toward the eye, per unit
 * of scattering, behind optical depth `od` toward the sun: Wrenninge's octaves
 * for the first few orders (the phase's lobes, sharp to soft), and the light
 * that has diffused through the rest, isotropic, by the two-stream slab's
 * transmission 1 / (1 + ¾(1 − g)τ) less what came straight through. Without
 * it a thick cloud's interior would see only the blue sky and come out blue.
 */
export function sunBeam(cos: number, od: number): number {
  let beam = 0;
  for (let o = 0; o < SCATTER_OCTAVES; o += 1) beam += 0.5 ** o * cloudPhase(cos, o) * Math.exp(-od * 0.5 ** o);
  const diffused = Math.max(0, 1 / (1 + 0.75 * (1 - DIFFUSION_G) * od) - Math.exp(-od));
  return beam + diffused / (4 * Math.PI);
}

/** The mean cosine the two-stream diffusion takes for cloud droplets. */
export const DIFFUSION_G = 0.85;

/** The light march toward the sun: its steps (km, as shares of the layer's depth), growing. */
export const LIGHT_STEPS = [0.04, 0.08, 0.14, 0.22, 0.34, 0.5] as const;
/** Wrenninge's octaves of multiple scattering: each a = b = c = 0.5. */
export const SCATTER_OCTAVES = 3;
/** The view march's steps through the shell, and how far a ray looks (km). */
export const VIEW_STEPS = 48;
export const CLOUD_RANGE = 60;

/**
 * The sky's light a point in the cloud scatters, from the upper sky's mean
 * radiance: half the sphere is sky (an isotropic phase takes half its mean),
 * and it reaches a point h of the way up a layer of extinction `sigma` only by
 * diffusing down through the cloud above it, the two-stream slab's
 * 1 / (1 + ¾(1 − g)τ) — so a thick cloud's floor is grey, not sky-blue.
 */
export function cloudAmbient(top: readonly number[], h: number, sigma: number, thickness: number): V3 {
  const tau = sigma * (1 - clamp(h, 0, 1)) * thickness;
  const k = 0.5 / (1 + 0.75 * (1 - DIFFUSION_G) * tau);
  return [top[0]! * k, top[1]! * k, top[2]! * k];
}

/**
 * The light a cloud layer sends toward the eye along unit direction `d` from
 * the scene, and the share of what's behind it that gets through. `sun` is
 * toward the sun, `sunRadiance` its light above the air (the key light's);
 * `ambient` the upper sky's mean radiance; `jitter` (0..1) offsets the first
 * step, as the GPU's per-pixel noise does.
 */
export function cloudRadiance(
  luts: AtmosphereLuts,
  c: Clouds,
  noise: CloudNoise,
  d: readonly number[],
  sun: readonly number[],
  sunRadiance: readonly number[],
  ambient: readonly number[],
  time: number,
  jitter = 0.5,
): { inscatter: V3; transmittance: number; distance: number } {
  const a = luts.atmosphere;
  const r = a.bottom + a.viewHeight;
  const mu = d[1]!;
  const none = { inscatter: [0, 0, 0] as V3, transmittance: 1, distance: -1 };
  if (hitsGround(a, r, mu)) return none;
  const lo = a.bottom + c.base;
  const hi = lo + c.thickness;
  // The shell's span along the ray, from below it (the usual case), inside it, or above it.
  let t0: number;
  let t1: number;
  if (r < lo) {
    t0 = raySphere(r, mu, lo);
    t1 = raySphere(r, mu, hi);
  } else if (r < hi) {
    t0 = 0;
    const down = mu < 0 && r * r * (mu * mu - 1) + lo * lo >= 0;
    t1 = down ? raySphere(r, mu, lo) : raySphere(r, mu, hi);
  } else {
    if (mu >= 0) return none;
    t0 = raySphere(r, mu, hi);
    t1 = r * r * (mu * mu - 1) + lo * lo >= 0 ? raySphere(r, mu, lo) : t0;
  }
  if (t0 < 0 || t1 <= t0) return none;
  t1 = Math.min(t1, CLOUD_RANGE);
  if (t1 <= t0) return none;
  const dt = (t1 - t0) / VIEW_STEPS;
  const cos = d[0]! * sun[0]! + d[1]! * sun[1]! + d[2]! * sun[2]!;
  const E = sunRadiance.map((s) => s * Math.PI);
  const L: V3 = [0, 0, 0];
  let T = 1;
  let weighted = 0;
  let weight = 0;
  for (let i = 0; i < VIEW_STEPS; i += 1) {
    const t = t0 + (i + jitter) * dt;
    const p = [d[0]! * t, a.viewHeight + d[1]! * t, d[2]! * t];
    const sigma = cloudDensity(c, noise, a.bottom, p, time);
    if (sigma <= 0) continue;
    const pR = Math.hypot(p[0]!, p[1]! + a.bottom, p[2]!);
    const h = (pR - a.bottom - c.base) / c.thickness;
    // Through the cloud toward the sun.
    let od = 0;
    let along = 0;
    for (const share of LIGHT_STEPS) {
      const step = share * c.thickness;
      const at = along + step * 0.5;
      along += step;
      od += cloudDensity(c, noise, a.bottom, [p[0]! + sun[0]! * at, p[1]! + sun[1]! * at, p[2]! + sun[2]! * at], time, true) * step;
    }
    const muSun = (p[0]! * sun[0]! + (p[1]! + a.bottom) * sun[1]! + p[2]! * sun[2]!) / pR;
    const ts = transmittanceTo(a, luts.transmittance, pR, muSun);
    const beam = sunBeam(cos, od);
    // Beer–powder: the dark edges of a sunlit cloud's near side.
    const powder = 1 - 0.6 * Math.exp(-2 * sigma * dt);
    const amb = cloudAmbient(ambient, h, sigma, c.thickness);
    const step = Math.exp(-sigma * dt);
    for (let k = 0; k < 3; k += 1) {
      const S = sigma * (E[k]! * ts[k]! * beam * powder + amb[k]!);
      L[k]! += T * ((S - S * step) / sigma);
    }
    weighted += t * T * (1 - step);
    weight += T * (1 - step);
    T *= step;
    if (T < 0.01) break;
  }
  return { inscatter: L, transmittance: T, distance: weight > 0 ? weighted / weight : -1 };
}

/** The share of the sun that gets through the layer to a point on the ground at (x, z) km under the scene. */
export function cloudShadow(c: Clouds, noise: CloudNoise, bottom: number, x: number, z: number, sun: readonly number[], time: number, steps = 8): number {
  if (sun[1]! <= 0.01) return 1;
  // Up the sun's ray from the ground to the shell's floor and through it (flat over the scene's few km).
  const t0 = c.base / sun[1]!;
  const t1 = (c.base + c.thickness) / sun[1]!;
  const dt = (t1 - t0) / steps;
  let od = 0;
  for (let i = 0; i < steps; i += 1) {
    const t = t0 + (i + 0.5) * dt;
    od += cloudDensity(c, noise, bottom, [x + sun[0]! * t, sun[1]! * t, z + sun[2]! * t], time, true) * dt;
  }
  return 1 - c.shadows * (1 - Math.exp(-od));
}

/** The air between the eye and a point `t` km along unit `d`: the ratio of their transmittances to the top of the air. */
export function airTransmittance(luts: AtmosphereLuts, d: readonly number[], t: number): V3 {
  const a = luts.atmosphere;
  const r = a.bottom + a.viewHeight;
  const p = [d[0]! * t, r + d[1]! * t, d[2]! * t];
  const pR = Math.hypot(p[0]!, p[1]!, p[2]!);
  const from = transmittanceTo(a, luts.transmittance, r, d[1]!);
  const to = transmittanceTo(a, luts.transmittance, pR, (p[0]! * d[0]! + p[1]! * d[1]! + p[2]! * d[2]!) / pR);
  return [0, 1, 2].map((c) => clamp(from[c]! / Math.max(1e-6, to[c]!), 0, 1)) as V3;
}

/**
 * The sky behind a cloud layer as the eye sees it (what the AAA presenter
 * draws): the sky (its sun, moon and stars included) through the cloud, and
 * the cloud's own light through the air in front of it.
 */
export function cloudOverSky(luts: AtmosphereLuts, sky: readonly number[], cloud: { readonly inscatter: readonly number[]; readonly transmittance: number; readonly distance: number }, d: readonly number[]): V3 {
  const air = cloud.distance > 0 ? airTransmittance(luts, d, cloud.distance) : [1, 1, 1];
  return [0, 1, 2].map((c) => sky[c]! * cloud.transmittance + cloud.inscatter[c]! * air[c]!) as V3;
}

/** Cloud shadow is applied in steps of this much (so a lit rig is remade only when the shade visibly changes). */
const SHADE_STEP = 1 / 64;
const shaded = new WeakMap<SceneLighting, { key: number; lighting: SceneLighting }>();

/**
 * A rig whose sky has clouds, its key light dimmed by their shadow where the
 * eye stands (`x`, `z` in metres), `time` seconds into the wind. A cloud is
 * kilometres across and an arena a few hundred metres, so one shade over the
 * whole scene is what a passing cloud looks like there. The rig itself when
 * there are no clouds or no shade.
 */
export function cloudShadedLighting(lighting: SceneLighting, x: number, z: number, time: number): SceneLighting {
  const settings = lighting.sky?.atmosphere?.clouds;
  if (!settings) return lighting;
  const index = lighting.lights.findIndex((l) => l.kind === "directional" && l.direction);
  const key = index >= 0 ? lighting.lights[index]! : null;
  if (!key?.direction) return lighting;
  const d = key.direction;
  const l = Math.hypot(d[0], d[1], d[2]) || 1;
  const c = resolveClouds(settings);
  const scale = lighting.sky?.atmosphere?.aerialScale ?? 1;
  const shade = cloudShadow(c, cloudNoise(), resolveAtmosphere(lighting.sky!.atmosphere!).bottom, (x / 1000) * scale, (z / 1000) * scale, [d[0] / l, d[1] / l, d[2] / l], time);
  const q = Math.round(shade / SHADE_STEP);
  if (q >= Math.round(1 / SHADE_STEP)) return lighting;
  const known = shaded.get(lighting);
  if (known && known.key === q) return known.lighting;
  const lights = lighting.lights.slice();
  lights[index] = { ...key, intensity: key.intensity * q * SHADE_STEP };
  const out = { ...lighting, lights };
  shaded.set(lighting, { key: q, lighting: out });
  return out;
}
