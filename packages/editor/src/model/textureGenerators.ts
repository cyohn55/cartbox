/**
 * Texture generators (EDITOR_PRO_ROADMAP.md P1c): Substance-style procedural
 * surfaces — rock, cliff strata, grass, dirt, mud, sand, worn stone blocks and
 * Forerunner metal panels — each a recipe (kind, seed, scale, tint, size)
 * that bakes a matching set of tileable maps: albedo, tangent-space normal,
 * metallic-roughness (G roughness, B metal) and relief (R height, G curvature).
 *
 * A material keeps the recipe ({@link MeshMaterial.generator}), not the
 * pictures: they are baked when it loads (memoised, so every material sharing
 * a recipe shares one set of images) and left out when it's saved. A few
 * bytes on the sidecar stand in for four 256² maps. Pure and deterministic.
 */

import type { EncodedImage } from "./MeshAsset";
import { reliefFromHeight } from "./materialLayers";
import { encodeRgbaPng } from "./png";

export type GeneratorKind = "rock" | "cliff" | "grass" | "dirt" | "mud" | "sand" | "stone" | "forerunner";

/** Every generator, in the order the editor offers them, with what it makes. */
export const GENERATOR_KINDS: readonly { readonly kind: GeneratorKind; readonly label: string; readonly hint: string }[] = [
  { kind: "rock", label: "Rock", hint: "Weathered grey rock, cracked and mottled" },
  { kind: "cliff", label: "Cliff strata", hint: "Banded sedimentary rock: lay it on cliffs with triplanar mapping so the bands run level" },
  { kind: "grass", label: "Grass", hint: "Meadow grass in clumps, with earth showing through" },
  { kind: "dirt", label: "Dirt", hint: "Packed earth strewn with pebbles" },
  { kind: "mud", label: "Mud", hint: "Dark wet mud, glossy where puddles stand" },
  { kind: "sand", label: "Sand", hint: "Fine sand in wind ripples" },
  { kind: "stone", label: "Worn stone", hint: "Stone blocks in mortar, their edges rounded and chipped (old walls, a base)" },
  { kind: "forerunner", label: "Forerunner metal", hint: "Smooth alloy panels with recessed seams and inset lines" },
];

/** A recipe: which surface, its variation, how many features per tile, a colour it's multiplied by, and the maps' size. */
export interface TextureGenerator {
  readonly kind: GeneratorKind;
  readonly seed: number;
  /** Features per tile, 0.5..8 (default 1): larger is busier, smaller is broader. */
  readonly scale: number;
  /** Multiplies the albedo (default white). */
  readonly tint: readonly [number, number, number];
  /** Edge of each map, a power of two 64..512 (default 256). */
  readonly size: number;
}

export interface GeneratedMaps {
  readonly albedo: EncodedImage;
  readonly normal: EncodedImage;
  readonly metallicRoughness: EncodedImage;
  readonly relief: EncodedImage;
}

const KINDS = new Set<string>(GENERATOR_KINDS.map((k) => k.kind));
const SIZES = [64, 128, 256, 512];
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** Read a stored recipe defensively (undefined when absent or malformed). */
export function readGenerator(raw: unknown): TextureGenerator | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r.kind !== "string" || !KINDS.has(r.kind)) return undefined;
  const tint = Array.isArray(r.tint) && r.tint.length === 3 && r.tint.every(finite) ? (r.tint.map((c) => clamp(c as number, 0, 4)) as [number, number, number]) : ([1, 1, 1] as [number, number, number]);
  const size = finite(r.size) ? SIZES.reduce((best, s) => (Math.abs(s - (r.size as number)) < Math.abs(best - (r.size as number)) ? s : best), 256) : 256;
  return { kind: r.kind as GeneratorKind, seed: finite(r.seed) ? Math.floor(r.seed) : 1, scale: finite(r.scale) ? clamp(r.scale, 0.5, 8) : 1, tint, size };
}

// --- Tileable noise -------------------------------------------------------------------------

/** Integer hash → 0..1, wrapped to `period` cells so the noise tiles. */
function hash(x: number, y: number, seed: number, period: number): number {
  const xi = ((x % period) + period) % period;
  const yi = ((y % period) + period) % period;
  let h = (Math.imul(xi, 374761393) + Math.imul(yi, 668265263) + Math.imul(seed, 1442695041)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

/** Smooth value noise at (u, v) in tile units (0..1 wraps), `cells` lattice cells across. */
function noise(u: number, v: number, cells: number, seed: number): number {
  const x = u * cells;
  const y = v * cells;
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const fx = x - xi;
  const fy = y - yi;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const a = hash(xi, yi, seed, cells);
  const b = hash(xi + 1, yi, seed, cells);
  const c = hash(xi, yi + 1, seed, cells);
  const d = hash(xi + 1, yi + 1, seed, cells);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}

/** Fractal noise: `octaves` of value noise, each twice as fine and half as strong. */
function fbm(u: number, v: number, cells: number, seed: number, octaves = 4): number {
  let sum = 0;
  let amp = 0.5;
  let norm = 0;
  for (let i = 0; i < octaves; i += 1) {
    sum += noise(u, v, cells << i, seed + i * 7) * amp;
    norm += amp;
    amp *= 0.5;
  }
  return sum / norm;
}

/** Cellular noise: the distance to the nearest and second-nearest of one jittered point per cell (tile units × cells). */
function cells2(u: number, v: number, cells: number, seed: number): [number, number] {
  const x = u * cells;
  const y = v * cells;
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  let d1 = Infinity;
  let d2 = Infinity;
  for (let j = -1; j <= 1; j += 1) {
    for (let i = -1; i <= 1; i += 1) {
      const px = xi + i + hash(xi + i, yi + j, seed, cells);
      const py = yi + j + hash(xi + i, yi + j, seed + 31, cells);
      const d = Math.hypot(px - x, py - y);
      if (d < d1) {
        d2 = d1;
        d1 = d;
      } else if (d < d2) d2 = d;
    }
  }
  return [d1, d2];
}

const smooth = (e0: number, e1: number, x: number) => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};

// --- The surfaces ---------------------------------------------------------------------------

/** One texel: colour 0..1, height 0..1, roughness and metalness 0..1. */
interface Sample {
  r: number;
  g: number;
  b: number;
  h: number;
  rough: number;
  metal: number;
}

type Surface = (u: number, v: number, s: number, seed: number) => Sample;

const SURFACES: Record<GeneratorKind, Surface> = {
  rock: (u, v, s, seed) => {
    const warp = fbm(u, v, Math.round(3 * s), seed + 1, 3) * 0.08;
    const body = fbm(u + warp, v, Math.round(6 * s), seed, 5);
    const [d1, d2] = cells2(u + warp, v - warp, Math.round(5 * s), seed + 9);
    // Cracks only where a second noise lets them run, so they break off rather than tile like paving.
    const crack = (1 - smooth(0.0, 0.05, d2 - d1)) * smooth(0.45, 0.6, fbm(u, v, Math.round(4 * s), seed + 13, 3));
    const h = body * 0.85 - crack * 0.45 + 0.2;
    const k = 0.42 + (body - 0.5) * 0.35 - crack * 0.18;
    return { r: k * 1.02, g: k, b: k * 0.96, h, rough: 0.88 + crack * 0.1, metal: 0 };
  },
  cliff: (u, v, s, seed) => {
    const warp = fbm(u, v, Math.round(3 * s), seed + 2, 3) * 0.12;
    const bands = Math.sin((v + warp) * Math.PI * 2 * Math.round(6 * s)) * 0.5 + 0.5;
    const fine = Math.sin((v + warp * 0.6) * Math.PI * 2 * Math.round(19 * s)) * 0.5 + 0.5;
    const grain = fbm(u, v, Math.round(24 * s), seed, 3);
    const k = 0.62 + (bands - 0.5) * 0.24 + (fine - 0.5) * 0.06 + (grain - 0.5) * 0.25;
    return { r: k * 1.08, g: k * 0.93, b: k * 0.76, h: bands * 0.55 + grain * 0.35 + fine * 0.1, rough: 0.9, metal: 0 };
  },
  grass: (u, v, s, seed) => {
    const blades = fbm(u, v, Math.round(48 * s), seed, 2);
    const clumps = fbm(u, v, Math.round(8 * s), seed + 3, 3);
    const earth = smooth(0.6, 0.72, fbm(u, v, Math.round(3 * s), seed + 5, 3));
    const g = 0.8 + (blades - 0.5) * 0.55 + (clumps - 0.5) * 0.35;
    return {
      r: 0.27 * g * (1 - earth) + 0.45 * earth,
      g: 0.42 * g * (1 - earth) + 0.37 * earth,
      b: 0.17 * g * (1 - earth) + 0.26 * earth,
      h: clumps * 0.6 + blades * 0.4 - earth * 0.3,
      rough: 0.92,
      metal: 0,
    };
  },
  dirt: (u, v, s, seed) => {
    const body = fbm(u, v, Math.round(8 * s), seed, 4);
    const [d1] = cells2(u, v, Math.round(14 * s), seed + 4);
    const pebble = (1 - smooth(0.12, 0.22, d1)) * smooth(0.4, 0.55, fbm(u, v, Math.round(5 * s), seed + 14, 2));
    const k = 0.42 + (body - 0.5) * 0.3 + pebble * 0.12;
    return { r: k * 1.12, g: k * 0.9, b: k * 0.66, h: body * 0.5 + pebble * 0.6, rough: 0.95 - pebble * 0.15, metal: 0 };
  },
  mud: (u, v, s, seed) => {
    const body = fbm(u, v, Math.round(5 * s), seed, 4);
    const puddle = smooth(0.58, 0.66, fbm(u, v, Math.round(3 * s), seed + 6, 3));
    const k = 0.26 + (body - 0.5) * 0.18 - puddle * 0.06;
    return { r: k * 1.1, g: k * 0.92, b: k * 0.72, h: body * (1 - puddle) * 0.7 + 0.15, rough: 0.8 - puddle * 0.62, metal: 0 };
  },
  sand: (u, v, s, seed) => {
    const warp = fbm(u, v, Math.round(4 * s), seed + 1, 2) * 0.06;
    // Whole cycles across both axes, so the slanted ripples wrap.
    const across = Math.round(14 * s);
    const ripple = Math.sin((u * Math.round(4 * s) + (v + warp) * across) * Math.PI * 2) * 0.5 + 0.5;
    const grain = fbm(u, v, Math.round(64 * s), seed, 2);
    const k = 0.74 + (ripple - 0.5) * 0.06 + (grain - 0.5) * 0.12;
    return { r: k * 1.05, g: k * 0.94, b: k * 0.74, h: ripple * 0.25 + grain * 0.15, rough: 0.9, metal: 0 };
  },
  stone: (u, v, s, seed) => {
    // Blocks laid in courses, every other course offset by half a block.
    const rows = Math.max(1, Math.round(4 * s));
    const cols = Math.max(1, Math.round(2 * s));
    const ry = v * rows;
    const row = Math.floor(ry);
    const rx = u * cols + (row % 2) * 0.5;
    const fx = rx - Math.floor(rx);
    const fy = ry - row;
    const edge = Math.min(fx, 1 - fx, (fy * cols) / rows, ((1 - fy) * cols) / rows);
    const mortar = 1 - smooth(0.015, 0.05, edge);
    const block = hash(Math.floor(rx), row, seed, cols * 2 * rows);
    const wear = fbm(u, v, Math.round(10 * s), seed + 8, 4);
    const chip = smooth(0.7, 0.76, fbm(u, v, Math.round(18 * s), seed + 12, 3)) * smooth(0.0, 0.12, edge);
    const k = (0.5 + (block - 0.5) * 0.14 + (wear - 0.5) * 0.22) * (1 - mortar * 0.35) - chip * 0.08;
    const bevel = smooth(0.0, 0.08, edge);
    return { r: k * 1.03, g: k, b: k * 0.93, h: bevel * 0.75 + wear * 0.25 - chip * 0.25, rough: 0.85 + mortar * 0.1, metal: 0 };
  },
  forerunner: (u, v, s, seed) => {
    const panels = Math.max(1, Math.round(2 * s));
    const px = u * panels;
    const py = v * panels;
    const fx = px - Math.floor(px);
    const fy = py - Math.floor(py);
    const edge = Math.min(fx, 1 - fx, fy, 1 - fy);
    const seam = 1 - smooth(0.012, 0.03, edge);
    // An inset line round each panel, a little in from its seam.
    const inset = 1 - smooth(0.006, 0.014, Math.abs(edge - 0.12));
    const tone = hash(Math.floor(px), Math.floor(py), seed, panels);
    const wear = fbm(u, v, Math.round(12 * s), seed + 3, 3);
    const k = 0.56 + (tone - 0.5) * 0.06 + (wear - 0.5) * 0.08 - seam * 0.3 - inset * 0.1;
    return { r: k * 0.97, g: k * 0.99, b: k * 1.04, h: (1 - seam) * 0.8 - inset * 0.25 + wear * 0.05, rough: 0.3 + (wear - 0.5) * 0.2 + seam * 0.4, metal: 0.85 - seam * 0.4 };
  },
};

// --- Baking ---------------------------------------------------------------------------------

const cache = new Map<string, GeneratedMaps>();

/** The cache key of a recipe (its maps are shared by every material with the same key). */
export function generatorKey(g: TextureGenerator): string {
  return `${g.kind}|${g.seed}|${g.scale}|${g.tint.join(",")}|${g.size}`;
}

const byte = (v: number) => Math.max(0, Math.min(255, Math.round(v * 255)));

/** Bake (or fetch the memoised) maps of a recipe. */
export function generateTextures(g: TextureGenerator): GeneratedMaps {
  const key = generatorKey(g);
  const hit = cache.get(key);
  if (hit) return hit;
  const n = g.size;
  const surface = SURFACES[g.kind];
  const samples: Sample[] = new Array(n * n);
  for (let y = 0; y < n; y += 1) for (let x = 0; x < n; x += 1) samples[y * n + x] = surface(x / n, y / n, g.scale, g.seed);
  const at = (x: number, y: number) => samples[((y + n) % n) * n + ((x + n) % n)]!;
  const albedo = new Uint8ClampedArray(n * n * 4);
  const normal = new Uint8ClampedArray(n * n * 4);
  const mr = new Uint8ClampedArray(n * n * 4);
  // The bumps' strength scales with the map's resolution, so a texel's slope reads the same at every size.
  const strength = (n / 256) * 6;
  for (let y = 0; y < n; y += 1) {
    for (let x = 0; x < n; x += 1) {
      const o = (y * n + x) * 4;
      const s = at(x, y);
      albedo[o] = byte(s.r * g.tint[0]);
      albedo[o + 1] = byte(s.g * g.tint[1]);
      albedo[o + 2] = byte(s.b * g.tint[2]);
      albedo[o + 3] = 255;
      // From the height's slope, by the same convention as the editor's other baked maps (bakeSurface).
      const nx = -(at(x + 1, y).h - at(x - 1, y).h) * strength;
      const ny = -(at(x, y + 1).h - at(x, y - 1).h) * strength;
      const l = Math.hypot(nx, ny, 1);
      normal[o] = byte((nx / l) * 0.5 + 0.5);
      normal[o + 1] = byte((ny / l) * 0.5 + 0.5);
      normal[o + 2] = byte((1 / l) * 0.5 + 0.5);
      normal[o + 3] = 255;
      mr[o] = 0;
      mr[o + 1] = byte(clamp(s.rough, 0.04, 1));
      mr[o + 2] = byte(clamp(s.metal, 0, 1));
      mr[o + 3] = 255;
    }
  }
  const relief = reliefFromHeight(samples.map((s) => s.h), n, n, 8);
  const png = (rgba: Uint8ClampedArray): EncodedImage => ({ mime: "image/png", bytes: encodeRgbaPng(rgba, n, n, { compress: true }) });
  const maps: GeneratedMaps = { albedo: png(albedo), normal: png(normal), metallicRoughness: png(mr), relief: png(relief) };
  cache.set(key, maps);
  return maps;
}

/** Whether an image is one a generator baked (so saving a material leaves it out: the recipe stands in for it). */
export function isGeneratedImage(image: EncodedImage | null | undefined): boolean {
  if (!image) return false;
  for (const maps of cache.values()) if (maps.albedo === image || maps.normal === image || maps.metallicRoughness === image || maps.relief === image) return true;
  return false;
}
