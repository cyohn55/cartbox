/**
 * Albedos re-measured for linear light (AAA_FIDELITY_ROADMAP.md F11a-13).
 *
 * The shipped maps were tuned on the byte path, which shades a material's
 * encoded colour as if it were its reflectance (F11a-7). Decoded into linear
 * light, as the AAA tier shades it, some of that art lands outside what any
 * real surface reflects: a recess at 0.4%, mountain rock darker than charcoal,
 * "metal" with a base colour of 2% where every real metal reflects at least
 * half the light. Under a physical re-light (F11a-11) those read wrong however
 * the light is set.
 *
 * So the AAA tier calibrates each opaque material at load: its base colour
 * factor is scaled so the material's mean linear albedo (each texel × the
 * factor, decoded, as the renderers shade it) lands in the physical range, or
 * on a target a map names for it.
 * Scaling the factor keeps the map's detail (a per-pixel clamp would flatten
 * it), and every other tier keeps the material as authored.
 *
 * The range is the usual physically based one (the "PBR albedo" charts used
 * by Frostbite, Unreal and DONTNOD): no dielectric darker than charcoal (3%)
 * or brighter than fresh snow (90%), and a metal's reflectance at least 50%
 * (iron, the darkest common metal, is about 53%). Partly metallic materials
 * (wear masks) take the floor in proportion.
 *
 * Pure and DOM-free.
 */

import type { DecodedTexture } from "../render/meshRasterizer";
import type { MeshMaterial } from "./MeshAsset";

/** How the AAA tier calibrates materials' albedos (`SceneLighting.materialAlbedo`). */
export interface AlbedoCalibration {
  /** The darkest a dielectric's mean linear albedo may be. */
  readonly min: number;
  /** The brightest a material's mean linear albedo may be. */
  readonly max: number;
  /** The darkest a fully metallic material's mean reflectance may be. */
  readonly metalMin: number;
  /** Mean linear albedos by material name, measured references the map names (fresh snow, granite), in place of the range. */
  readonly targets?: Readonly<Record<string, number>>;
}

/** The physical range: charcoal to fresh snow, and a metal at least half reflective. */
export const PHYSICAL_ALBEDO: AlbedoCalibration = { min: 0.03, max: 0.9, metalMin: 0.5 };

const toLinear = (c: number) => (c <= 0.04045 ? Math.max(0, c) / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
/** Rec. 709 luminance of a linear colour. */
export const albedoLuminance = (c: readonly number[]) => 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;

/** A stored calibration, read defensively; null when absent. */
export function parseAlbedoCalibration(value: unknown): AlbedoCalibration | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const num = (v: unknown, fallback: number) => (typeof v === "number" && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : fallback);
  const min = num(raw.min, PHYSICAL_ALBEDO.min);
  const max = Math.max(min, num(raw.max, PHYSICAL_ALBEDO.max));
  const metalMin = num(raw.metalMin, PHYSICAL_ALBEDO.metalMin);
  const targets: Record<string, number> = {};
  if (raw.targets && typeof raw.targets === "object" && !Array.isArray(raw.targets)) {
    for (const [name, v] of Object.entries(raw.targets as Record<string, unknown>)) if (typeof v === "number" && Number.isFinite(v) && v > 0) targets[name] = Math.min(1, v);
  }
  return { min, max, metalMin, ...(Object.keys(targets).length > 0 ? { targets } : {}) };
}

/**
 * A material's mean linear albedo, as the renderers shade it: each texel's
 * encoded colour × the factor (`scale` times it), then decoded to linear light,
 * see-through texels left out; and its largest encoded product, per channel
 * (1 is a perfect reflector).
 */
export function meanAlbedo(
  material: Pick<MeshMaterial, "baseColorFactor">,
  texture: DecodedTexture | null | undefined,
  scale = 1,
): { mean: [number, number, number]; peak: [number, number, number] } {
  const f = [0, 1, 2].map((c) => material.baseColorFactor[c]! * scale);
  if (!texture || texture.data.length < 4) {
    return { mean: f.map((v) => toLinear(Math.min(1, v))) as [number, number, number], peak: f as [number, number, number] };
  }
  const sum = [0, 0, 0];
  const peak = [0, 0, 0];
  const texels = texture.width * texture.height;
  // About 4096 samples, whatever the map's size.
  const stride = Math.max(1, Math.floor(texels / 4096));
  let n = 0;
  for (let t = 0; t < texels; t += stride) {
    const o = t * 4;
    if (texture.data[o + 3]! < 128) continue;
    for (let c = 0; c < 3; c += 1) {
      const v = (texture.data[o + c]! / 255) * f[c]!;
      sum[c]! += toLinear(Math.min(1, v));
      peak[c] = Math.max(peak[c]!, v);
    }
    n += 1;
  }
  if (n === 0) return { mean: [0, 0, 0], peak: [0, 0, 0] };
  return { mean: sum.map((v) => v / n) as [number, number, number], peak: peak as [number, number, number] };
}

/** A material's mean metalness: its factor (glTF's default 1) × its metal-roughness map's mean blue channel. */
export function meanMetalness(material: Pick<MeshMaterial, "metallicFactor">, metalRoughness: DecodedTexture | null | undefined): number {
  const factor = material.metallicFactor ?? 1;
  if (!metalRoughness || metalRoughness.data.length < 4) return factor;
  const texels = metalRoughness.width * metalRoughness.height;
  const stride = Math.max(1, Math.floor(texels / 4096));
  let sum = 0;
  let n = 0;
  for (let t = 0; t < texels; t += stride) {
    sum += metalRoughness.data[t * 4 + 2]! / 255;
    n += 1;
  }
  return factor * (sum / Math.max(1, n));
}

/**
 * The base colour factor that brings a material's mean albedo into the
 * calibration's range (or onto its named target), or null when it needs no
 * change: it is see-through or added light (an effect, not a surface), black
 * (an effect's stand-in), or already within 1% of it. The factor is scaled as
 * a whole (its hue kept) and never so far that a texel would reflect more
 * than all the light.
 */
export function calibratedBaseFactor(
  material: Pick<MeshMaterial, "name" | "baseColorFactor" | "metallicFactor" | "alphaMode">,
  texture: DecodedTexture | null | undefined,
  metalRoughness: DecodedTexture | null | undefined,
  calibration: AlbedoCalibration,
): [number, number, number, number] | null {
  if (material.alphaMode === "blend" || material.alphaMode === "additive") return null;
  const at = (scale: number) => meanAlbedo(material, texture, scale);
  const { peak } = at(1);
  const lum = albedoLuminance(at(1).mean);
  if (!(lum > 1e-4)) return null;
  const metal = Math.min(1, Math.max(0, meanMetalness(material, metalRoughness)));
  const floor = calibration.min + (calibration.metalMin - calibration.min) * metal;
  // A blended primitive ("rock+snow") takes its first surface's target: the blend's own map is laid over it.
  const named = calibration.targets?.[material.name] ?? calibration.targets?.[material.name.split("+")[0]!];
  const target = named ?? Math.min(calibration.max, Math.max(floor, lum));
  if (Math.abs(target / lum - 1) < 0.01) return null;
  // The scale whose mean is the target (the decode makes it monotonic, not linear): bisected, up to the
  // scale at which the brightest texel reaches a perfect reflector.
  const brightest = Math.max(peak[0], peak[1], peak[2]);
  const lumAt = (scale: number) => albedoLuminance(at(scale).mean);
  let lo: number;
  let hi: number;
  let scale: number;
  if (target > lum) {
    lo = 1;
    hi = Math.max(1, brightest > 0 ? 1 / brightest : 1);
    // Held at a perfect reflector when even that falls short.
    if (lumAt(hi) <= target) scale = hi;
    else {
      for (let i = 0; i < 40; i += 1) {
        const mid = (lo + hi) / 2;
        if (lumAt(mid) < target) lo = mid;
        else hi = mid;
      }
      scale = (lo + hi) / 2;
    }
  } else {
    lo = 0;
    hi = 1;
    for (let i = 0; i < 40; i += 1) {
      const mid = (lo + hi) / 2;
      if (lumAt(mid) < target) lo = mid;
      else hi = mid;
    }
    scale = (lo + hi) / 2;
  }
  if (Math.abs(scale - 1) < 0.005) return null;
  const f = material.baseColorFactor;
  return [f[0] * scale, f[1] * scale, f[2] * scale, f[3]];
}
