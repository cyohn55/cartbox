/**
 * Volumetric fog (AAA_FIDELITY_ROADMAP.md F5b): the scene's fog as a medium
 * the light scatters in, rather than a colour the far scene fades toward. The
 * CPU reference the AAA tier's froxel passes (volumetricFog.ts in
 * @cartbox/player) mirror, step for step.
 *
 * - **The medium** is the fog the rig already authors, read as extinction per
 *   metre: its distance fog's density everywhere, its height fog's density
 *   thinning above the base, and each fog box's density thinning above its
 *   floor. A creator turns it on per rig and sets its albedo (what share of
 *   what it takes out it scatters, and in what colour), its anisotropy and how
 *   far the volume reaches.
 * - **The froxels** are a grid over the camera's frustum: a column for every
 *   few pixels, each a view ray through its centre, and 64 slices along it
 *   spaced quadratically out to the reach (as the aerial perspective's are).
 * - **The light** each froxel scatters toward the eye is the sun's, through
 *   Henyey–Greenstein's phase and the sun's shadow, and the sky's, the mean
 *   radiance of its light scattered evenly.
 * - **The volume** the scene samples is that light integrated front to back
 *   along each column with the energy-conserving step: at each slice's
 *   centre, what the fog has scattered toward the eye so far and the share of
 *   what lies beyond that still reaches it. Shafts of light (god rays) are the
 *   sun's shadow seen through it.
 *
 * Units are the renderer's: a sun of 1 lights a white Lambertian surface at 1,
 * so its illuminance is π, and the sky's radiance lights white at itself.
 *
 * Pure and DOM-free.
 */

import { distanceFalloff, lightChannelMask, lightColor, spotCone, type SceneLight } from "../render/meshRasterizer";
import { aerialDirection, type AerialCamera } from "./atmosphere";
import type { SceneFog } from "../render/skyDome";

type V3 = [number, number, number];
type Rgb = readonly [number, number, number];

/** What a creator sets to make the fog volumetric (on the AAA tier). */
export interface VolumetricFogSettings {
  /** The share of the light the fog takes out that it scatters, per channel (authored colour). */
  readonly albedo?: Rgb;
  /** Henyey–Greenstein's anisotropy: 0 scatters evenly, toward 1 forward (bright toward the sun). */
  readonly anisotropy?: number;
  /** How far the volume reaches from the eye, metres. Past it, the fog is as it is at the far end. */
  readonly distance?: number;
  /** How strongly the sky's light scatters in it, against the sky itself (1). */
  readonly ambient?: number;
}

/** Volumetric fog resolved: its medium (the rig's fog) and its settings with their defaults. */
export interface VolumetricFog {
  readonly fog: SceneFog;
  /** Single-scattering albedo, linear. */
  readonly albedo: V3;
  readonly anisotropy: number;
  readonly distance: number;
  readonly ambient: number;
}

/** The froxels along a column, and the most across and down. */
export const FOG_SLICES = 64;
export const FOG_MAX_X = 160;
export const FOG_MAX_Y = 90;
/** Frame pixels a froxel column spans, at most (fewer at small sizes, so a column count of at least 8). */
export const FOG_TILE = 12;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const toLinear = (c: number) => (c <= 0.04045 ? Math.max(0, c) / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

/** Settings as stored, read defensively; null when absent (the fog stays as painted). */
export function parseVolumetricFog(value: unknown): VolumetricFogSettings | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const out: { albedo?: Rgb; anisotropy?: number; distance?: number; ambient?: number } = {};
  if (Array.isArray(raw.albedo) && raw.albedo.length === 3 && raw.albedo.every((v) => typeof v === "number" && Number.isFinite(v))) {
    out.albedo = raw.albedo.map((v: number) => clamp(v, 0, 1)) as unknown as Rgb;
  }
  const take = (key: "anisotropy" | "distance" | "ambient", lo: number, hi: number) => {
    const v = raw[key];
    if (typeof v === "number" && Number.isFinite(v)) out[key] = clamp(v, lo, hi);
  };
  take("anisotropy", -0.9, 0.95);
  take("distance", 8, 1000);
  take("ambient", 0, 4);
  return out;
}

/** A rig's fog as a volume, or null when it has no fog or its fog isn't volumetric. */
export function resolveVolumetricFog(fog: SceneFog | null | undefined): VolumetricFog | null {
  const settings = fog?.volumetric;
  if (!fog || !settings) return null;
  const albedo = settings.albedo ?? [1, 1, 1];
  return {
    fog,
    albedo: [toLinear(albedo[0]), toLinear(albedo[1]), toLinear(albedo[2])],
    anisotropy: settings.anisotropy ?? 0.6,
    distance: settings.distance ?? 96,
    ambient: settings.ambient ?? 1,
  };
}

/** The medium's extinction per metre at a world point: the distance fog, the height fog and the fog boxes. */
export function fogExtinction(fog: SceneFog, p: readonly number[]): number {
  let sigma = Math.max(0, fog.density);
  const h = fog.height;
  if (h && h.density > 0) sigma += h.density * Math.exp(-h.falloff * Math.max(0, p[1]! - h.base));
  for (const v of fog.volumes ?? []) {
    if (v.density <= 0) continue;
    if (p[0]! < v.min[0] || p[0]! > v.max[0] || p[1]! < v.min[1] || p[1]! > v.max[1] || p[2]! < v.min[2] || p[2]! > v.max[2]) continue;
    sigma += v.density * Math.exp(-v.falloff * Math.max(0, p[1]! - v.min[1]));
  }
  return sigma;
}

/** Henyey–Greenstein's phase at the cosine between the view ray and the light's way, anisotropy g. */
export function henyeyGreenstein(cos: number, g: number): number {
  const g2 = g * g;
  return (1 - g2) / (4 * Math.PI * Math.pow(Math.max(1e-6, 1 + g2 - 2 * g * cos), 1.5));
}

/** The froxel grid for a frame of `width × height` pixels: columns across, rows down and slices along. */
export function fogGrid(width: number, height: number): [number, number, number] {
  return [clamp(Math.ceil(width / FOG_TILE), 8, FOG_MAX_X), clamp(Math.ceil(height / FOG_TILE), 8, FOG_MAX_Y), FOG_SLICES];
}

/** A slice coordinate (0..1) into its distance from the eye, for a volume reaching `reach`. */
export function fogSliceDistance(w: number, reach: number): number {
  return w * w * reach;
}

/** A distance from the eye into its slice coordinate (clamped to the volume). */
export function fogSlice(t: number, reach: number): number {
  return Math.sqrt(clamp(t / reach, 0, 1));
}

/**
 * The sun as the fog sees it: toward it, and its radiance in the renderer's
 * units (the key light's linear colour × intensity); null without a key light.
 */
export function fogSun(lights: readonly SceneLight[] | null | undefined): { direction: V3; radiance: V3 } | null {
  const key = (lights ?? []).find((l) => l.kind === "directional" && l.direction);
  if (!key) return null;
  const d = key.direction!;
  const l = Math.hypot(d[0], d[1], d[2]) || 1;
  const c = lightColor(key);
  return { direction: [d[0] / l, d[1] / l, d[2] / l], radiance: [toLinear(c[0]) * key.intensity, toLinear(c[1]) * key.intensity, toLinear(c[2]) * key.intensity] };
}

/** What lights the fog: the sun (with what of it reaches a point), and the sky's mean radiance. */
export interface FogLight {
  readonly sun: { readonly direction: readonly number[]; readonly radiance: readonly number[] } | null;
  /** The sun's shadow at a world point (1: lit), or none. */
  readonly shadow?: (p: readonly number[]) => number;
  /** The sky's mean radiance over the sphere (its L0 irradiance over π). */
  readonly sky: readonly number[];
  /** Spot and point lights (F5b-2), in the default lighting channel; others are passed over. */
  readonly locals?: readonly SceneLight[];
  /** A local light's shadow at a world point (1: lit), by its index in {@link locals}, or none. */
  readonly localShadow?: (light: number, p: readonly number[]) => number;
}

/**
 * The radiance (the renderer's units) a spot or point light brings a point of
 * fog from along the view ray `d`, through the phase: its π × linear colour ×
 * intensity, its falloff and cone, as the scene shader lights a surface.
 * Zero for any other light, or one outside the default channel.
 */
export function fogLocalLight(light: SceneLight, p: readonly number[], d: readonly number[], g: number): V3 {
  if ((light.kind !== "point" && light.kind !== "spot") || !light.position || (lightChannelMask(light.channels ?? 1) & 1) === 0) return [0, 0, 0];
  const to = [light.position[0] - p[0]!, light.position[1] - p[1]!, light.position[2] - p[2]!];
  const dist = Math.max(1e-4, Math.hypot(to[0]!, to[1]!, to[2]!));
  const L = to.map((c) => c / dist);
  let atten = distanceFalloff(light, dist);
  if (light.kind === "spot") {
    const [cosOuter, cosInner] = spotCone(light);
    const axis = light.direction ?? [0, -1, 0];
    const len = Math.hypot(axis[0], axis[1], axis[2]) || 1;
    const ct = clamp((-(L[0]! * axis[0] + L[1]! * axis[1] + L[2]! * axis[2]) / len - cosOuter) / (cosInner - cosOuter), 0, 1);
    atten *= ct * ct * (3 - 2 * ct);
  }
  if (atten <= 0) return [0, 0, 0];
  const phase = henyeyGreenstein(L[0]! * d[0]! + L[1]! * d[1]! + L[2]! * d[2]!, g);
  const c = lightColor(light);
  return [0, 1, 2].map((k) => Math.PI * toLinear(c[k]!) * light.intensity * atten * phase) as V3;
}

/**
 * The light a unit of fog at `p` scatters toward the eye along the unit view
 * ray `d` (from the eye), per unit extinction: σ_s/σ_t × (the sun's π E
 * through the phase and its shadow, plus the sky's mean radiance scaled by
 * the ambient setting).
 */
export function fogScattered(v: VolumetricFog, light: FogLight, p: readonly number[], d: readonly number[]): V3 {
  const out: V3 = [0, 0, 0];
  let sun: number[] = [0, 0, 0];
  if (light.sun) {
    const s = light.sun.direction;
    const phase = henyeyGreenstein(d[0]! * s[0]! + d[1]! * s[1]! + d[2]! * s[2]!, v.anisotropy);
    const shadow = light.shadow ? light.shadow(p) : 1;
    sun = light.sun.radiance.map((r) => Math.PI * r * phase * shadow);
  }
  (light.locals ?? []).forEach((l, i) => {
    const lit = fogLocalLight(l, p, d, v.anisotropy);
    if (lit[0] === 0 && lit[1] === 0 && lit[2] === 0) return;
    const shadow = light.localShadow ? light.localShadow(i, p) : 1;
    for (let c = 0; c < 3; c += 1) sun[c]! += lit[c]! * shadow;
  });
  for (let c = 0; c < 3; c += 1) out[c] = v.albedo[c]! * (sun[c]! + light.sky[c]! * v.ambient);
  return out;
}

/**
 * One froxel column: from the eye along the unit direction `d`, the fog's
 * in-scattered light (RGB) and transmittance at each slice's centre. Each
 * slice's medium and light are taken at its centre and held from the slice
 * before's centre (the eye, for the first), integrated with the
 * energy-conserving step.
 */
export function fogColumn(v: VolumetricFog, light: FogLight, eye: readonly number[], d: readonly number[]): { inscatter: V3[]; transmittance: number[] } {
  const L: V3 = [0, 0, 0];
  let T = 1;
  let t = 0;
  const inscatter: V3[] = [];
  const transmittance: number[] = [];
  for (let z = 0; z < FOG_SLICES; z += 1) {
    const end = fogSliceDistance((z + 0.5) / FOG_SLICES, v.distance);
    const p = [eye[0]! + d[0]! * end, eye[1]! + d[1]! * end, eye[2]! + d[2]! * end];
    const sigma = fogExtinction(v.fog, p);
    const S = fogScattered(v, light, p, d).map((s) => s * sigma);
    const dt = end - t;
    const step = Math.exp(-sigma * dt);
    for (let c = 0; c < 3; c += 1) L[c]! += T * (sigma > 1e-9 ? (S[c]! - S[c]! * step) / sigma : S[c]! * dt);
    T *= step;
    t = end;
    inscatter.push([...L]);
    transmittance.push(T);
  }
  return { inscatter, transmittance };
}

/**
 * A whole volume as the GPU builds it without jitter or history, for a camera
 * whose froxel columns are {@link aerialDirection}'s through each column's
 * centre: per froxel (x fastest, then down the screen, then out) the
 * in-scattered RGB and the transmittance, four floats.
 */
export function bakeFogVolume(v: VolumetricFog, light: FogLight, camera: AerialCamera, eye: readonly number[], grid: readonly [number, number, number]): Float32Array {
  const [nx, ny, nz] = grid;
  const out = new Float32Array(nx * ny * nz * 4);
  for (let y = 0; y < ny; y += 1) {
    for (let x = 0; x < nx; x += 1) {
      const column = fogColumn(v, light, eye, aerialDirection(camera, (x + 0.5) / nx, (y + 0.5) / ny));
      for (let z = 0; z < nz; z += 1) out.set([...column.inscatter[z]!, column.transmittance[z]!], ((z * ny + y) * nx + x) * 4);
    }
  }
  return out;
}

/**
 * A volume sampled as the scene shader samples it: at screen point (u, v) and
 * a distance from the eye, trilinearly between froxel centres (clamped), and
 * faded toward clear air nearer than the first slice's centre.
 */
export function sampleFogVolume(volume: Float32Array, grid: readonly [number, number, number], reach: number, u: number, v: number, t: number): { inscatter: V3; transmittance: number } {
  const [nx, ny, nz] = grid;
  const f = [clamp(u * nx - 0.5, 0, nx - 1), clamp(v * ny - 0.5, 0, ny - 1), clamp(fogSlice(t, reach) * nz - 0.5, 0, nz - 1)];
  const a = f.map(Math.floor);
  const b = [Math.min(nx - 1, a[0]! + 1), Math.min(ny - 1, a[1]! + 1), Math.min(nz - 1, a[2]! + 1)];
  const w = f.map((x, i) => x - a[i]!);
  const s = [0, 0, 0, 0];
  for (let k = 0; k < 8; k += 1) {
    const x = k & 1 ? b[0]! : a[0]!, y = k & 2 ? b[1]! : a[1]!, z = k & 4 ? b[2]! : a[2]!;
    const weight = (k & 1 ? w[0]! : 1 - w[0]!) * (k & 2 ? w[1]! : 1 - w[1]!) * (k & 4 ? w[2]! : 1 - w[2]!);
    for (let c = 0; c < 4; c += 1) s[c]! += volume[((z * ny + y) * nx + x) * 4 + c]! * weight;
  }
  const fade = clamp(t / fogSliceDistance(0.5 / nz, reach), 0, 1);
  return { inscatter: [s[0]! * fade, s[1]! * fade, s[2]! * fade], transmittance: 1 - (1 - s[3]!) * fade };
}
