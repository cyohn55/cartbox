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
import { readMaterialGraph, valueNoise } from "./materialGraph";
import { encodeRgbaPng } from "./png";

/** Detail tiles per base UV unit when a material doesn't say. */
export const DEFAULT_DETAIL_SCALE = 8;
/** Detail strength when a material doesn't say. */
export const DEFAULT_DETAIL_STRENGTH = 0.5;
/** The detail map is at full strength nearer than this (view depth, world units)… */
export const DETAIL_NEAR = 3;
/** …and gone beyond this. */
export const DETAIL_FAR = 12;

type SurfaceEffects = Pick<
  MeshMaterial,
  "detailScale" | "detailStrength" | "emissiveScroll" | "emissivePulse" | "rim" | "reflectivity" | "reflectionMask" | "blendColor" | "blendRoughness" | "alphaMode" | "alphaCutoff" | "softDepth" | "refraction" | "distortion" | "water" | "triplanar" | "blendSharpness" | "graph"
>;

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
  const blendColor = r.blendColor;
  if (Array.isArray(blendColor) && blendColor.length === 3 && blendColor.every(finite)) {
    out.blendColor = [clamp(blendColor[0] as number, 0, 1), clamp(blendColor[1] as number, 0, 1), clamp(blendColor[2] as number, 0, 1)];
  }
  if (finite(r.blendRoughness)) out.blendRoughness = clamp(r.blendRoughness, 0, 1);
  if (r.alphaMode === "mask" || r.alphaMode === "blend" || r.alphaMode === "additive") out.alphaMode = r.alphaMode;
  if (finite(r.alphaCutoff)) out.alphaCutoff = clamp(r.alphaCutoff, 0, 1);
  if (finite(r.softDepth) && r.softDepth > 0) out.softDepth = Math.min(r.softDepth, 100);
  if (finite(r.refraction) && r.refraction > 0) out.refraction = clamp(r.refraction, 0, 1);
  if (finite(r.distortion) && r.distortion > 0) out.distortion = clamp(r.distortion, 0, 1);
  const water = r.water as Record<string, unknown> | undefined;
  if (water && typeof water === "object" && finite(water.strength) && water.strength > 0 && finite(water.scale) && finite(water.speed) && finite(water.flow)) {
    out.water = { strength: clamp(water.strength, 0, 2), scale: clamp(water.scale, 0.05, 8), speed: clamp(water.speed, 0, 4), flow: clamp(water.flow, -Math.PI, Math.PI) };
  }
  if (finite(r.triplanar) && r.triplanar > 0) out.triplanar = clamp(r.triplanar, 0.05, 1000);
  if (finite(r.blendSharpness) && r.blendSharpness > 0) out.blendSharpness = clamp(r.blendSharpness, 0, 1);
  const graph = readMaterialGraph(r.graph);
  if (graph) out.graph = graph;
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

// --- Water (BEAVER_CREEK_ROADMAP.md B5) -----------------------------------------------------

/** How far (in ripple cells) a water layer drifts before it fades out and restarts. */
export const WATER_PERIOD = 32;
/** The finite-difference step the ripples' slope is measured over, in ripple cells. */
export const WATER_STEP = 0.2;
/** How steep a ripple of strength 1 is (its slope per unit of the noise's gradient). */
export const WATER_TILT = 0.5;

/** Whether a material has moving water. */
export function materialHasWater(material: Pick<MeshMaterial, "water">): boolean {
  return material.water !== undefined && material.water.strength > 0;
}

/**
 * A water material's uniform at `time` seconds: [strength, scale, phase, flow],
 * the phase being how far through its {@link WATER_PERIOD} the first layer has
 * drifted (0..1) — wrapped here, in double precision, so a GPU's float32 never
 * sees a large time. Zeros when the material has no water.
 */
export function waterUniform(material: Pick<MeshMaterial, "water">, time: number): [number, number, number, number] {
  const w = material.water;
  if (!w || !(w.strength > 0)) return [0, 0, 0, 0];
  const t = (time * w.speed) / WATER_PERIOD;
  return [w.strength, w.scale, t - Math.floor(t), w.flow];
}

/**
 * The tilt water adds to a surface's normal at world point (x, z), from its
 * {@link waterUniform}: two drifting layers of ripples, each two octaves of
 * value noise, crossfaded so one restarts while the other is at full strength
 * (a flow map's trick: the ripples drift forever without a jump). The result
 * is added to the normal, which is then renormalised; the scene shaders'
 * `waterTilt` is this, term for term.
 */
export function waterTilt(uniform: readonly [number, number, number, number], x: number, z: number): [number, number] {
  const [strength, scale, a, flow] = uniform;
  if (!(strength > 0)) return [0, 0];
  const dx = Math.cos(flow);
  const dz = Math.sin(flow);
  const qx = x * scale;
  const qz = z * scale;
  const layer = (px: number, pz: number, phase: number): number =>
    valueNoise(px + dx * phase, pz + dz * phase, 0) + 0.5 * valueNoise(2.1 * px - dz * phase * 0.7, 2.1 * pz + dx * phase * 0.7, 7);
  const b = a + 0.5 - Math.floor(a + 0.5);
  const wa = 1 - Math.abs(1 - 2 * a);
  const height = (px: number, pz: number): number => layer(px, pz, a * WATER_PERIOD) * wa + layer(px + 53, pz + 17, b * WATER_PERIOD) * (1 - wa);
  const h = height(qx, qz);
  const k = (-strength * WATER_TILT) / WATER_STEP;
  return [(height(qx + WATER_STEP, qz) - h) * k, (height(qx, qz + WATER_STEP) - h) * k];
}

// --- Living terrain (BEAVER_CREEK_ROADMAP.md B6) --------------------------------------------

/** How sharply triplanar mapping favours the axis a surface faces (the power its normal's components are raised to). */
export const TRIPLANAR_POWER = 4;

/**
 * Triplanar weights for a normal: how much each axis's projection shows (x
 * from the side, y from above, z from the front), summing to 1. A normal along
 * an axis gives that axis alone, so flat ground is pure top-down mapping.
 */
export function triplanarWeights(nx: number, ny: number, nz: number): [number, number, number] {
  const l = Math.hypot(nx, ny, nz) || 1;
  // Squared twice (the TRIPLANAR_POWER), as the shaders do it.
  const ax = (nx / l) * (nx / l);
  const ay = (ny / l) * (ny / l);
  const az = (nz / l) * (nz / l);
  const wx = ax * ax;
  const wy = ay * ay;
  const wz = az * az;
  const s = wx + wy + wz || 1;
  return [wx / s, wy / s, wz / s];
}

/**
 * The three projections' UVs at point (x, y, z) in the mesh's space, one
 * repeat every `repeat` units: from the side (z, y), from above (x, z) — the
 * same as a terrain's planar UVs — and from the front (x, y).
 */
export function triplanarUvs(x: number, y: number, z: number, repeat: number): [[number, number], [number, number], [number, number]] {
  const k = 1 / repeat;
  return [
    [z * k, y * k],
    [x * k, z * k],
    [x * k, y * k],
  ];
}

/** Rec. 601 luma of a colour (0..1 channels): the "height" a height blend compares. */
export function blendHeightOf(r: number, g: number, b: number): number {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

/**
 * A height-blended weight: the vertex weight `w` of the second surface, moved
 * toward whichever of the two is higher (lighter) here and sharpened, by
 * `sharpness` (0 = `w` unchanged, 1 = a tight edge). `base` and `blend` are
 * the two surfaces' heights (0..1).
 */
export function heightBlend(w: number, base: number, blend: number, sharpness: number): number {
  if (!(sharpness > 0)) return w;
  const width = 1 - 0.9 * sharpness;
  return clamp((w - 0.5 + 0.5 * sharpness * (blend - base)) / width + 0.5, 0, 1);
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
