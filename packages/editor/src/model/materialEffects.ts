/**
 * Surface effects on a PBR material (HALO2_STYLE_ROADMAP.md, H3): a detail map
 * blended in up close, an emissive glow that scrolls and pulses, a fresnel rim,
 * and a reflectivity (optionally masked per texel). The fields live on
 * {@link MeshMaterial}; this module holds their defaults, their defensive
 * reading, and the per-frame maths every renderer shares — the software
 * rasteriser evaluates it per primitive, the GPU paths write the results into
 * each draw's uniforms, so all three agree.
 */

import type { EncodedImage, MeshMaterial } from "./MeshAsset";
import { encodeRgbaPng } from "./png";

/** Detail tiles per base UV unit when a material doesn't say. */
export const DEFAULT_DETAIL_SCALE = 8;
/** Detail strength when a material doesn't say. */
export const DEFAULT_DETAIL_STRENGTH = 0.5;
/** The detail map is at full strength nearer than this (view depth, world units)… */
export const DETAIL_NEAR = 3;
/** …and gone beyond this. */
export const DETAIL_FAR = 12;

type SurfaceEffects = Pick<MeshMaterial, "detailScale" | "detailStrength" | "emissiveScroll" | "emissivePulse" | "rim" | "reflectivity" | "reflectionMask">;

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

/** Read a stored material's effect fields, clamping each and dropping anything malformed. */
export function readSurfaceEffects(raw: Record<string, unknown> | object): SurfaceEffects {
  const r = raw as Record<string, unknown>;
  const out: { -readonly [K in keyof SurfaceEffects]: SurfaceEffects[K] } = {};
  if (finite(r.detailScale)) out.detailScale = clamp(r.detailScale, 0.01, 256);
  if (finite(r.detailStrength)) out.detailStrength = clamp(r.detailStrength, 0, 1);
  const scroll = r.emissiveScroll;
  if (Array.isArray(scroll) && scroll.length === 2 && scroll.every(finite)) out.emissiveScroll = [clamp(scroll[0] as number, -64, 64), clamp(scroll[1] as number, -64, 64)];
  const pulse = r.emissivePulse as Record<string, unknown> | undefined;
  if (pulse && typeof pulse === "object" && finite(pulse.rate) && finite(pulse.depth)) out.emissivePulse = { rate: clamp(pulse.rate, 0, 30), depth: clamp(pulse.depth, 0, 1) };
  const rim = r.rim as Record<string, unknown> | undefined;
  const color = rim?.color;
  if (rim && typeof rim === "object" && Array.isArray(color) && color.length === 3 && color.every(finite) && finite(rim.power) && finite(rim.strength)) {
    out.rim = { color: [clamp(color[0] as number, 0, 1), clamp(color[1] as number, 0, 1), clamp(color[2] as number, 0, 1)], power: clamp(rim.power, 0.1, 16), strength: clamp(rim.strength, 0, 4) };
  }
  if (finite(r.reflectivity)) out.reflectivity = clamp(r.reflectivity, 0, 4);
  if (r.reflectionMask === true) out.reflectionMask = true;
  return out;
}

/** The effect fields in stored form (only those a material sets). */
export function writeSurfaceEffects(material: MeshMaterial): Record<string, unknown> {
  return JSON.parse(JSON.stringify(readSurfaceEffects(material))) as Record<string, unknown>;
}

/**
 * The emissive map's animation at `time` seconds: the UV offset to sample it
 * at (wrapped to 0..1, so it stays precise however long a scene runs) and the
 * glow's gain (1 at the pulse's peak, 1 − depth at its trough).
 */
export function emissiveAnimation(material: MeshMaterial, time: number): { offset: [number, number]; gain: number } {
  const scroll = material.emissiveScroll;
  const wrap = (v: number) => v - Math.floor(v);
  const offset: [number, number] = scroll ? [wrap(scroll[0] * time), wrap(scroll[1] * time)] : [0, 0];
  const pulse = material.emissivePulse;
  const gain = pulse ? 1 - pulse.depth * (0.5 - 0.5 * Math.cos(2 * Math.PI * pulse.rate * time)) : 1;
  return { offset, gain };
}

/** How much of the detail map shows at a view depth: 1 up close, fading to 0 by {@link DETAIL_FAR}. */
export function detailFade(depth: number): number {
  return clamp((DETAIL_FAR - depth) / (DETAIL_FAR - DETAIL_NEAR), 0, 1);
}

let grain: EncodedImage | null = null;

/**
 * A built-in detail map: a 64² tileable grain (metal mottle and pitting around
 * mid-grey). One shared image object, so however many materials use it a
 * mesh stores it once.
 */
export function builtinDetailGrain(): EncodedImage {
  if (grain) return grain;
  const size = 64;
  const hash = (x: number, y: number, seed: number): number => {
    let h = (Math.imul(((x % size) + size) % size, 374761393) + Math.imul(((y % size) + size) % size, 668265263) + Math.imul(seed, 1442695041)) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
  };
  // Smooth value noise with `cells` cells across the tile (so it wraps seamlessly).
  const noise = (x: number, y: number, cells: number, seed: number): number => {
    const step = size / cells;
    const gx = x / step;
    const gy = y / step;
    const x0 = Math.floor(gx);
    const y0 = Math.floor(gy);
    const fx = gx - x0;
    const fy = gy - y0;
    const sx = fx * fx * (3 - 2 * fx);
    const sy = fy * fy * (3 - 2 * fy);
    const at = (i: number, j: number) => hash(((i % cells) + cells) % cells, ((j % cells) + cells) % cells, seed);
    const top = at(x0, y0) + (at(x0 + 1, y0) - at(x0, y0)) * sx;
    const bottom = at(x0, y0 + 1) + (at(x0 + 1, y0 + 1) - at(x0, y0 + 1)) * sx;
    return top + (bottom - top) * sy;
  };
  const rgba = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const n = 0.55 * noise(x, y, 16, 91) + 0.3 * noise(x, y, 32, 97) + 0.15 * hash(x, y, 101);
      const pit = hash(x, y, 103) > 0.985 ? -40 : 0;
      const v = Math.max(0, Math.min(255, Math.round(128 + (n - 0.5) * 110 + pit)));
      rgba.set([v, v, v, 255], (y * size + x) * 4);
    }
  }
  grain = { mime: "image/png", bytes: encodeRgbaPng(rgba, size, size, { compress: true }) };
  return grain;
}
