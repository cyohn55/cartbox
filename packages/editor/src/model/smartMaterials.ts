/**
 * Smart materials (AAA_FIDELITY_ROADMAP.md F9b): layer-based texturing in the
 * Mesh tab, a Substance Painter-class workflow over the P1 texture generators
 * and the I15 and F9a bakes.
 *
 * A stack of layers paints a texture set (base colour, metal/roughness,
 * normal, emissive) from the bottom up. Each layer fills the channels it sets
 * (a colour, a metalness, a roughness, a height, a glow) through its opacity
 * and its mask:
 *
 * - **Generated masks**, from the bakes: edge wear from curvature (convex
 *   edges), dirt from occlusion and cavities, rust from position and gravity
 *   (streaks running down from the low ground and the crevices), a pick of the
 *   ID map's colour, and noise. Each has a level, a width (its softness), a
 *   break-up by noise and an invert.
 * - **Brush strokes**: discs painted in texture space, hard or soft, adding or
 *   erasing.
 * - **Anchors**: a layer's mask can be another, earlier layer's (or its
 *   inverse), so rust grows where the paint wore off.
 *
 * Heights add up into one field whose slopes bend the baked normal map, so a
 * chipped paint layer has an edge. The result is any size up to 4096², and a
 * mesh whose texture coordinates span several unit tiles (UDIM, for hero
 * assets) is split into one primitive a tile, each with its own set, named
 * 1001 + u + 10·v as the tools expect.
 *
 * Pure and DOM-free; deterministic.
 */

import type { EncodedImage, MeshAsset, MeshMaterial, MeshPrimitive } from "./MeshAsset";
import type { DecodedTexture } from "../render/meshRasterizer";
import { encodeRgbaPng } from "./png";

/** What a layer's mask is made from. */
export type SmartMaskKind = "full" | "edgeWear" | "dirt" | "rust" | "id" | "noise" | "paint" | "anchor";

/** A brush stroke's dab, in texture space (0..1). */
export interface BrushDab {
  readonly u: number;
  readonly v: number;
  /** Radius, in texture space. */
  readonly radius: number;
  /** 0 soft (a smooth falloff) .. 1 hard. */
  readonly hardness: number;
  /** Positive paints the mask in, negative erases it. */
  readonly strength: number;
}

export interface SmartMask {
  readonly kind: SmartMaskKind;
  /** Where the mask's ramp sits (0..1, in its source's terms). */
  readonly level?: number;
  /** How soft the ramp is (0.005..0.5). */
  readonly width?: number;
  readonly invert?: boolean;
  /** How much noise breaks the mask up (0..1). */
  readonly breakup?: number;
  /** The noise's scale: cells across the texture. */
  readonly scale?: number;
  readonly seed?: number;
  /** An ID map colour this mask picks (kind "id"), 0..255. */
  readonly idColour?: readonly [number, number, number];
  /** The layer whose mask this one is (kind "anchor"). */
  readonly anchor?: string;
  /** Strokes, painted over the generated mask (and the whole of a "paint" mask). */
  readonly strokes?: readonly BrushDab[];
}

/** A layer: what it fills, how much, and where. */
export interface SmartLayer {
  readonly id: string;
  readonly name: string;
  readonly visible?: boolean;
  readonly opacity?: number;
  /** sRGB 0..1. */
  readonly baseColor?: readonly [number, number, number];
  readonly metallic?: number;
  readonly roughness?: number;
  /** Height it adds (−1..1), which bends the normal map at its edges. */
  readonly height?: number;
  /** Glow, linear. */
  readonly emissive?: readonly [number, number, number];
  readonly mask?: SmartMask | null;
}

/** A material's stack, as stored on it. */
export interface SmartStack {
  readonly layers: readonly SmartLayer[];
  /** How strongly heights bend the normals. */
  readonly heightStrength?: number;
}

/** The bakes a stack reads (any may be absent; masks from a missing one read flat). */
export interface SmartBakes {
  /** White open. */
  readonly occlusion?: DecodedTexture | null;
  /** G curvature (mid-grey flat), R height, B thinness. */
  readonly relief?: DecodedTexture | null;
  /** The surface's position over its bounds. */
  readonly position?: DecodedTexture | null;
  /** A colour per part. */
  readonly id?: DecodedTexture | null;
  /** A tangent-space normal map to bend (else flat). */
  readonly normal?: DecodedTexture | null;
}

/** What a stack paints. */
export interface SmartTextureSet {
  readonly size: number;
  /** sRGB, alpha 255. */
  readonly baseColor: DecodedTexture;
  /** G roughness, B metalness (glTF's). */
  readonly metallicRoughness: DecodedTexture;
  /** Tangent space. */
  readonly normal: DecodedTexture;
  /** sRGB-encoded glow (black without one). */
  readonly emissive: DecodedTexture;
  /** Each layer's mask, by layer ID (0..1), at the set's size. */
  readonly masks: ReadonlyMap<string, Float32Array>;
}

// --- Noise ------------------------------------------------------------------

function hash2(x: number, y: number, seed: number): number {
  let h = Math.imul(x, 0x27d4eb2d) ^ Math.imul(y, 0x165667b1) ^ Math.imul(seed + 1, 0x9e3779b9);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Tileable value noise at (u, v) over `cells` cells, four octaves (0..1). */
export function fbm(u: number, v: number, cells: number, seed: number): number {
  let sum = 0;
  let amp = 0.5;
  let total = 0;
  let n = Math.max(1, Math.round(cells));
  for (let o = 0; o < 4; o += 1, n *= 2, amp *= 0.5) {
    const x = u * n, y = v * n;
    const x0 = Math.floor(x), y0 = Math.floor(y);
    const fx = x - x0, fy = y - y0;
    const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
    const w = (a: number) => ((a % n) + n) % n;
    const a = hash2(w(x0), w(y0), seed + o);
    const b = hash2(w(x0 + 1), w(y0), seed + o);
    const c = hash2(w(x0), w(y0 + 1), seed + o);
    const d = hash2(w(x0 + 1), w(y0 + 1), seed + o);
    sum += amp * ((a * (1 - sx) + b * sx) * (1 - sy) + (c * (1 - sx) + d * sx) * sy);
    total += amp;
  }
  return sum / total;
}

// --- Sampling ----------------------------------------------------------------

/** A bake's channel at (u, v) in 0..1, bilinear (texel centres), or `fallback` without one. */
function sample(t: DecodedTexture | null | undefined, u: number, v: number, channel: number, fallback: number): number {
  if (!t) return fallback;
  const x = Math.min(t.width - 1, Math.max(0, u * t.width - 0.5));
  const y = Math.min(t.height - 1, Math.max(0, v * t.height - 0.5));
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const x1 = Math.min(t.width - 1, x0 + 1), y1 = Math.min(t.height - 1, y0 + 1);
  const fx = x - x0, fy = y - y0;
  const at = (xx: number, yy: number) => t.data[(yy * t.width + xx) * 4 + channel]! / 255;
  return (at(x0, y0) * (1 - fx) + at(x1, y0) * fx) * (1 - fy) + (at(x0, y1) * (1 - fx) + at(x1, y1) * fx) * fy;
}

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a || 1e-9)));
  return t * t * (3 - 2 * t);
};

/** The mask's source value at a texel (0..1, before its ramp), by kind. */
function maskSource(mask: SmartMask, u: number, v: number, bakes: SmartBakes): number {
  switch (mask.kind) {
    case "edgeWear":
      // Convex edges: curvature above flat.
      return Math.max(0, sample(bakes.relief, u, v, 1, 0.5) * 2 - 1);
    case "dirt": {
      // Occluded and concave places.
      const ao = sample(bakes.occlusion, u, v, 0, 1);
      const cavity = Math.max(0, 1 - sample(bakes.relief, u, v, 1, 0.5) * 2);
      return Math.min(1, (1 - ao) + cavity * 0.5);
    }
    case "rust": {
      // Low on the part (gravity pulls the water down) and in its crevices, streaked downward.
      const low = 1 - sample(bakes.position, u, v, 1, 0.5);
      const ao = 1 - sample(bakes.occlusion, u, v, 0, 1);
      const streak = fbm(u * 0.25, v * 4, (mask.scale ?? 8) , (mask.seed ?? 0) + 101);
      return Math.min(1, low * 0.6 + ao * 0.6) * (0.4 + 0.6 * streak);
    }
    case "id": {
      const want = mask.idColour ?? [255, 255, 255];
      if (!bakes.id) return 0;
      const d = Math.hypot(sample(bakes.id, u, v, 0, 0) * 255 - want[0], sample(bakes.id, u, v, 1, 0) * 255 - want[1], sample(bakes.id, u, v, 2, 0) * 255 - want[2]);
      return d < 24 ? 1 : 0;
    }
    case "noise":
      return fbm(u, v, mask.scale ?? 8, mask.seed ?? 0);
    case "paint":
      return 0;
    case "full":
    case "anchor":
      return 1;
  }
}

/** A mask over the texture set (see the module comment); `anchors` holds the masks of the layers below. */
export function evaluateMask(mask: SmartMask | null | undefined, size: number, bakes: SmartBakes, anchors: ReadonlyMap<string, Float32Array>): Float32Array {
  const out = new Float32Array(size * size).fill(1);
  if (!mask || mask.kind === "full") return applyStrokes(out, mask?.strokes, size);
  const level = mask.level ?? 0.5;
  const width = Math.max(0.005, Math.min(0.5, mask.width ?? 0.1));
  const breakup = Math.max(0, Math.min(1, mask.breakup ?? 0));
  const anchor = mask.kind === "anchor" && mask.anchor ? anchors.get(mask.anchor) ?? null : null;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const i = y * size + x;
      const u = (x + 0.5) / size, v = (y + 0.5) / size;
      let m: number;
      if (mask.kind === "anchor") m = anchor ? anchor[i]! : 0;
      else if (mask.kind === "paint") m = 0;
      else if (mask.kind === "id") m = maskSource(mask, u, v, bakes);
      else m = smoothstep(level - width, level + width, maskSource(mask, u, v, bakes));
      if (breakup > 0 && mask.kind !== "paint") {
        // Noise pushes the ramp about, so a worn edge isn't an even band.
        const n = fbm(u, v, mask.scale ?? 16, (mask.seed ?? 0) + 7);
        m = Math.max(0, Math.min(1, m * (1 - breakup) + m * breakup * smoothstep(0.35, 0.65, n) * 2));
      }
      out[i] = mask.invert ? 1 - m : m;
    }
  }
  return applyStrokes(out, mask.strokes, size);
}

/** Paint a stroke's dabs into a mask (adding or erasing, clamped to 0..1). */
function applyStrokes(mask: Float32Array, strokes: readonly BrushDab[] | undefined, size: number): Float32Array {
  for (const d of strokes ?? []) {
    const r = Math.max(1e-4, d.radius);
    const x0 = Math.max(0, Math.floor((d.u - r) * size)), x1 = Math.min(size - 1, Math.ceil((d.u + r) * size));
    const y0 = Math.max(0, Math.floor((d.v - r) * size)), y1 = Math.min(size - 1, Math.ceil((d.v + r) * size));
    const hard = Math.max(0, Math.min(0.999, d.hardness));
    for (let y = y0; y <= y1; y += 1) {
      for (let x = x0; x <= x1; x += 1) {
        const dist = Math.hypot((x + 0.5) / size - d.u, (y + 0.5) / size - d.v) / r;
        if (dist >= 1) continue;
        const fall = dist <= hard ? 1 : 1 - smoothstep(hard, 1, dist);
        const i = y * size + x;
        mask[i] = Math.max(0, Math.min(1, mask[i]! + d.strength * fall));
      }
    }
  }
  return mask;
}

/** sRGB ↔ linear, for mixing colours in light. */
const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const toSrgb = (c: number) => (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055);

/**
 * Paint a stack into a texture set of `size`² (up to 4096), over `base` (the
 * material's own factors), reading `bakes`.
 */
export function paintSmartStack(stack: SmartStack, size: number, bakes: SmartBakes, base: Pick<MeshMaterial, "baseColorFactor" | "metallicFactor" | "roughnessFactor">): SmartTextureSet {
  const s = Math.max(8, Math.min(4096, Math.round(size)));
  const n = s * s;
  const col = new Float32Array(n * 3);
  const metal = new Float32Array(n).fill(base.metallicFactor ?? 0);
  const rough = new Float32Array(n).fill(base.roughnessFactor ?? 1);
  const height = new Float32Array(n);
  const glow = new Float32Array(n * 3);
  const baseLinear = [0, 1, 2].map((c) => toLinear(base.baseColorFactor[c]!));
  for (let i = 0; i < n; i += 1) col.set(baseLinear, i * 3);
  const masks = new Map<string, Float32Array>();
  for (const layer of stack.layers) {
    const mask = evaluateMask(layer.mask, s, bakes, masks);
    masks.set(layer.id, mask);
    if (layer.visible === false) continue;
    const opacity = Math.max(0, Math.min(1, layer.opacity ?? 1));
    const lc = layer.baseColor ? [0, 1, 2].map((c) => toLinear(layer.baseColor![c]!)) : null;
    for (let i = 0; i < n; i += 1) {
      const a = mask[i]! * opacity;
      if (a <= 0) continue;
      if (lc) for (let c = 0; c < 3; c += 1) col[i * 3 + c] = col[i * 3 + c]! + (lc[c]! - col[i * 3 + c]!) * a;
      if (layer.metallic !== undefined) metal[i] = metal[i]! + (layer.metallic - metal[i]!) * a;
      if (layer.roughness !== undefined) rough[i] = rough[i]! + (layer.roughness - rough[i]!) * a;
      if (layer.height !== undefined) height[i] = height[i]! + layer.height * a;
      if (layer.emissive) for (let c = 0; c < 3; c += 1) glow[i * 3 + c] = glow[i * 3 + c]! + (layer.emissive[c]! - glow[i * 3 + c]!) * a;
    }
  }
  const byte = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 255);
  const baseColor = new Uint8ClampedArray(n * 4);
  const mr = new Uint8ClampedArray(n * 4);
  const normal = new Uint8ClampedArray(n * 4);
  const emissive = new Uint8ClampedArray(n * 4);
  // Heights bend the normals by their slope over a texel (in texels of a 1024² map, so strength doesn't change with size).
  const strength = (stack.heightStrength ?? 1) * (s / 1024) * 8;
  for (let y = 0; y < s; y += 1) {
    for (let x = 0; x < s; x += 1) {
      const i = y * s + x;
      baseColor.set([byte(toSrgb(col[i * 3]!)), byte(toSrgb(col[i * 3 + 1]!)), byte(toSrgb(col[i * 3 + 2]!)), 255], i * 4);
      mr.set([0, byte(rough[i]!), byte(metal[i]!), 255], i * 4);
      emissive.set([byte(toSrgb(glow[i * 3]!)), byte(toSrgb(glow[i * 3 + 1]!)), byte(toSrgb(glow[i * 3 + 2]!)), 255], i * 4);
      const u = (x + 0.5) / s, v = (y + 0.5) / s;
      let nx = bakes.normal ? sample(bakes.normal, u, v, 0, 0.5) * 2 - 1 : 0;
      let ny = bakes.normal ? sample(bakes.normal, u, v, 1, 0.5) * 2 - 1 : 0;
      let nz = bakes.normal ? sample(bakes.normal, u, v, 2, 1) * 2 - 1 : 1;
      // The height's slope (x right, y up the image: rows run down), as a detail normal over the base (whiteout).
      const hx = (height[y * s + Math.min(s - 1, x + 1)]! - height[y * s + Math.max(0, x - 1)]!) * 0.5 * strength;
      const hy = (height[Math.max(0, y - 1) * s + x]! - height[Math.min(s - 1, y + 1) * s + x]!) * 0.5 * strength;
      nx -= hx;
      ny -= hy;
      const l = Math.hypot(nx, ny, nz) || 1;
      nx /= l;
      ny /= l;
      nz /= l;
      normal.set([byte(0.5 + 0.5 * nx), byte(0.5 + 0.5 * ny), byte(0.5 + 0.5 * nz), 255], i * 4);
    }
  }
  const tex = (data: Uint8ClampedArray): DecodedTexture => ({ width: s, height: s, data });
  return { size: s, baseColor: tex(baseColor), metallicRoughness: tex(mr), normal: tex(normal), emissive: tex(emissive), masks };
}

/** A painted set on a material: its maps in the slots, the factors that would scale them at one. */
export function applyTextureSet(material: MeshMaterial, set: SmartTextureSet, stack: SmartStack): MeshMaterial {
  const png = (t: DecodedTexture): EncodedImage => ({ mime: "image/png", bytes: encodeRgbaPng(t.data, t.width, t.height, { compress: true }) });
  const glows = set.emissive.data.some((v, i) => i % 4 !== 3 && v > 0);
  return {
    ...material,
    smartStack: stack,
    baseColorFactor: [1, 1, 1, material.baseColorFactor[3]],
    baseColorImage: png(set.baseColor),
    metallicFactor: 1,
    roughnessFactor: 1,
    metallicRoughnessImage: png(set.metallicRoughness),
    normalImage: png(set.normal),
    ...(glows ? { emissiveFactor: [1, 1, 1] as [number, number, number], emissiveImage: png(set.emissive) } : {}),
  };
}

// --- UDIM -------------------------------------------------------------------

/** The UDIM tile number of texture coordinates (u, v): 1001 + ⌊u⌋ + 10·⌊v⌋. */
export function udimTile(u: number, v: number): number {
  return 1001 + Math.max(0, Math.min(9, Math.floor(u))) + 10 * Math.max(0, Math.floor(v));
}

/** The UDIM tiles a primitive's triangles lie in (by each triangle's centroid). */
export function udimTiles(primitive: MeshPrimitive): number[] {
  const uvs = primitive.uvs;
  if (!uvs) return [];
  const tiles = new Set<number>();
  for (let t = 0; t < primitive.indices.length; t += 3) {
    const ids = [primitive.indices[t]!, primitive.indices[t + 1]!, primitive.indices[t + 2]!];
    tiles.add(udimTile(ids.reduce((s, i) => s + uvs[i * 2]!, 0) / 3, ids.reduce((s, i) => s + uvs[i * 2 + 1]!, 0) / 3));
  }
  return [...tiles].sort((a, b) => a - b);
}

/**
 * A mesh with each primitive that spans several UDIM tiles split into one a
 * tile, its coordinates moved into 0..1, its material named for the tile (so
 * each takes its own texture set). Primitives in one tile come back as they are.
 */
export function splitUdim(mesh: MeshAsset): MeshAsset {
  const primitives: MeshPrimitive[] = [];
  for (const p of mesh.primitives) {
    const tiles = udimTiles(p);
    if (tiles.length <= 1) {
      primitives.push(p);
      continue;
    }
    for (const tile of tiles) {
      const du = (tile - 1001) % 10;
      const dv = Math.floor((tile - 1001) / 10);
      const remap = new Map<number, number>();
      const positions: number[] = [];
      const normals: number[] = [];
      const uvs: number[] = [];
      const tangents: number[] = [];
      const indices: number[] = [];
      for (let t = 0; t < p.indices.length; t += 3) {
        const ids = [p.indices[t]!, p.indices[t + 1]!, p.indices[t + 2]!];
        const cu = ids.reduce((s, i) => s + p.uvs![i * 2]!, 0) / 3;
        const cv = ids.reduce((s, i) => s + p.uvs![i * 2 + 1]!, 0) / 3;
        if (udimTile(cu, cv) !== tile) continue;
        for (const i of ids) {
          let k = remap.get(i);
          if (k === undefined) {
            k = positions.length / 3;
            remap.set(i, k);
            positions.push(p.positions[i * 3]!, p.positions[i * 3 + 1]!, p.positions[i * 3 + 2]!);
            if (p.normals) normals.push(p.normals[i * 3]!, p.normals[i * 3 + 1]!, p.normals[i * 3 + 2]!);
            if (p.tangents) tangents.push(p.tangents[i * 4]!, p.tangents[i * 4 + 1]!, p.tangents[i * 4 + 2]!, p.tangents[i * 4 + 3]!);
            uvs.push(p.uvs![i * 2]! - du, p.uvs![i * 2 + 1]! - dv);
          }
          indices.push(k);
        }
      }
      primitives.push({
        ...p,
        positions: Float32Array.from(positions),
        normals: p.normals ? Float32Array.from(normals) : null,
        uvs: Float32Array.from(uvs),
        ...(p.tangents ? { tangents: Float32Array.from(tangents) } : {}),
        uvs2: null,
        indices: Uint32Array.from(indices),
        material: { ...p.material, name: `${p.material.name}.${tile}` },
      } as MeshPrimitive);
    }
  }
  return { ...mesh, primitives };
}

/** A texture set's files, named as texturing tools name UDIM sets: `name_channel.1001.png`. */
export function textureSetFiles(name: string, set: SmartTextureSet, tile = 1001): { readonly name: string; readonly bytes: Uint8Array }[] {
  const files: [string, DecodedTexture][] = [["BaseColor", set.baseColor], ["MetallicRoughness", set.metallicRoughness], ["Normal", set.normal], ["Emissive", set.emissive]];
  return files.map(([channel, t]) => ({ name: `${name}_${channel}.${tile}.png`, bytes: encodeRgbaPng(t.data, t.width, t.height, { compress: true }) }));
}

// --- Storage ----------------------------------------------------------------

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const colour = (v: unknown): [number, number, number] | undefined => {
  if (!Array.isArray(v) || v.length !== 3 || !v.every(finite)) return undefined;
  const c = v as number[];
  return [clamp(c[0]!, 0, 1), clamp(c[1]!, 0, 1), clamp(c[2]!, 0, 1)];
};
const KINDS: readonly SmartMaskKind[] = ["full", "edgeWear", "dirt", "rust", "id", "noise", "paint", "anchor"];

function readMask(raw: unknown): SmartMask | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (!KINDS.includes(r.kind as SmartMaskKind)) return null;
  const strokes = Array.isArray(r.strokes)
    ? r.strokes.slice(0, 4096).flatMap((d) => {
        const s = (d ?? {}) as Record<string, unknown>;
        return finite(s.u) && finite(s.v) && finite(s.radius) ? [{ u: s.u, v: s.v, radius: clamp(s.radius, 1e-4, 1), hardness: finite(s.hardness) ? clamp(s.hardness, 0, 1) : 0.5, strength: finite(s.strength) ? clamp(s.strength, -1, 1) : 1 }] : [];
      })
    : undefined;
  const id = Array.isArray(r.idColour) && r.idColour.length === 3 && r.idColour.every(finite) ? (r.idColour.map((c: number) => clamp(Math.round(c), 0, 255)) as [number, number, number]) : undefined;
  return {
    kind: r.kind as SmartMaskKind,
    ...(finite(r.level) ? { level: clamp(r.level, 0, 1) } : {}),
    ...(finite(r.width) ? { width: clamp(r.width, 0.005, 0.5) } : {}),
    ...(r.invert === true ? { invert: true } : {}),
    ...(finite(r.breakup) ? { breakup: clamp(r.breakup, 0, 1) } : {}),
    ...(finite(r.scale) ? { scale: clamp(r.scale, 1, 256) } : {}),
    ...(finite(r.seed) ? { seed: Math.round(r.seed) } : {}),
    ...(id ? { idColour: id } : {}),
    ...(typeof r.anchor === "string" ? { anchor: r.anchor } : {}),
    ...(strokes && strokes.length > 0 ? { strokes } : {}),
  };
}

/** A stored stack, read defensively; null when absent or empty. */
export function readSmartStack(raw: unknown): SmartStack | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r.layers)) return null;
  const layers: SmartLayer[] = r.layers.slice(0, 64).flatMap((l) => {
    const x = (l ?? {}) as Record<string, unknown>;
    if (typeof x.id !== "string") return [];
    const base = colour(x.baseColor);
    const glow = Array.isArray(x.emissive) && x.emissive.length === 3 && x.emissive.every(finite) ? (x.emissive.map((c: number) => clamp(c, 0, 100)) as [number, number, number]) : undefined;
    const mask = readMask(x.mask);
    return [
      {
        id: x.id,
        name: typeof x.name === "string" ? x.name.slice(0, 64) : "Layer",
        ...(x.visible === false ? { visible: false } : {}),
        ...(finite(x.opacity) ? { opacity: clamp(x.opacity, 0, 1) } : {}),
        ...(base ? { baseColor: base } : {}),
        ...(finite(x.metallic) ? { metallic: clamp(x.metallic, 0, 1) } : {}),
        ...(finite(x.roughness) ? { roughness: clamp(x.roughness, 0, 1) } : {}),
        ...(finite(x.height) ? { height: clamp(x.height, -1, 1) } : {}),
        ...(glow ? { emissive: glow } : {}),
        ...(mask ? { mask } : {}),
      },
    ];
  });
  if (layers.length === 0) return null;
  return { layers, ...(finite(r.heightStrength) ? { heightStrength: clamp(r.heightStrength, 0, 8) } : {}) };
}

/** The stack field in stored form (only when a material has one). */
export function writeSmartStack(material: Pick<MeshMaterial, "smartStack">): Record<string, unknown> {
  return material.smartStack ? { smartStack: JSON.parse(JSON.stringify(material.smartStack)) as unknown } : {};
}

/** Ready-made stacks: painted steel worn at its edges and dirty in its creases, and rusted iron. */
export const SMART_PRESETS: readonly { readonly name: string; readonly stack: SmartStack }[] = [
  {
    name: "Worn painted metal",
    stack: {
      layers: [
        { id: "steel", name: "Steel", baseColor: [0.56, 0.57, 0.58], metallic: 1, roughness: 0.35 },
        // Hidden: only its mask, which the paint is anchored to (worn through at the edges).
        { id: "wear", name: "Edge wear", visible: false, mask: { kind: "edgeWear", level: 0.25, width: 0.1, breakup: 0.6, scale: 24 } },
        { id: "paint", name: "Paint", baseColor: [0.18, 0.32, 0.22], metallic: 0, roughness: 0.55, height: 0.15, mask: { kind: "anchor", anchor: "wear", invert: true } },
        { id: "dirt", name: "Dirt", baseColor: [0.2, 0.17, 0.13], roughness: 0.9, opacity: 0.8, mask: { kind: "dirt", level: 0.35, width: 0.2, breakup: 0.4, scale: 12 } },
      ],
    },
  },
  {
    name: "Rusted iron",
    stack: {
      layers: [
        { id: "iron", name: "Iron", baseColor: [0.4, 0.4, 0.42], metallic: 1, roughness: 0.5 },
        { id: "rust", name: "Rust", baseColor: [0.42, 0.18, 0.07], metallic: 0, roughness: 0.85, height: 0.08, mask: { kind: "rust", level: 0.3, width: 0.15, breakup: 0.5, scale: 10 } },
      ],
    },
  },
];
