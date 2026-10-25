/**
 * What a surface gives back to the light bake (AAA_FIDELITY_ROADMAP.md F3d-4):
 * each triangle's albedo read from its base-colour map, and its metalness and
 * roughness, so a textured wall bleeds its own colour and a polished metal
 * none, where the bake once took a textured material's factor × 0.55.
 *
 * - **The albedo** is the map's mean over the triangle's footprint in it: the
 *   map's mip level whose texel is about the footprint's size, read at the
 *   triangle's centroid (trilinearly, wrapping as the renderers do). A
 *   triangle that spans the whole map, or tiles it, reads its 1×1 mean; a
 *   small one in a trim sheet reads the strip it sits on.
 * - **The means are in linear light**: a base-colour map is decoded from sRGB
 *   before it is averaged, a metal/roughness map (G roughness, B metal) is
 *   data and is not.
 *
 * Pure and DOM-free: the caller decodes the maps.
 */

import type { DecodedTexture } from "../render/meshRasterizer";

/** A primitive's surface as the bake reads it; see {@link Occluder.surfaces}. */
export interface OccluderSurface {
  /** Its base-colour map, decoded (RGBA, sRGB). */
  readonly base?: DecodedTexture | null;
  /** Metalness and perceptual roughness as the renderer resolves them (default 0 and 1). */
  readonly metallic?: number;
  readonly roughness?: number;
  /** Its metal/roughness map, decoded (G roughness, B metal), which scales them. */
  readonly metallicRoughness?: DecodedTexture | null;
}

/** A map's mip chain in linear light: RGBA floats per level, level 0 the map itself. */
interface Mips {
  readonly widths: number[];
  readonly heights: number[];
  readonly levels: Float32Array[];
}

const srgbToLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const SRGB_TABLE = Float32Array.from({ length: 256 }, (_, i) => srgbToLinear(i / 255));

const chains = { srgb: new WeakMap<DecodedTexture, Mips>(), data: new WeakMap<DecodedTexture, Mips>() };

/** A map's box-filtered mip chain, down to 1×1, built once per map. */
function mipsOf(texture: DecodedTexture, srgb: boolean): Mips {
  const cache = srgb ? chains.srgb : chains.data;
  const hit = cache.get(texture);
  if (hit) return hit;
  let w = Math.max(1, texture.width);
  let h = Math.max(1, texture.height);
  const first = new Float32Array(w * h * 4);
  for (let i = 0; i < w * h * 4; i += 1) {
    const byte = texture.data[i] ?? 255;
    first[i] = srgb && i % 4 !== 3 ? SRGB_TABLE[byte]! : byte / 255;
  }
  const mips: Mips = { widths: [w], heights: [h], levels: [first] };
  while (w > 1 || h > 1) {
    const nw = Math.max(1, w >> 1);
    const nh = Math.max(1, h >> 1);
    const src = mips.levels[mips.levels.length - 1]!;
    const out = new Float32Array(nw * nh * 4);
    // Each texel the mean of the block it covers (three wide where an odd side halves).
    for (let y = 0; y < nh; y += 1) {
      const y0 = Math.floor((y * h) / nh), y1 = Math.max(y0 + 1, Math.floor(((y + 1) * h) / nh));
      for (let x = 0; x < nw; x += 1) {
        const x0 = Math.floor((x * w) / nw), x1 = Math.max(x0 + 1, Math.floor(((x + 1) * w) / nw));
        const n = (y1 - y0) * (x1 - x0);
        for (let c = 0; c < 4; c += 1) {
          let sum = 0;
          for (let sy = y0; sy < y1; sy += 1) for (let sx = x0; sx < x1; sx += 1) sum += src[(sy * w + sx) * 4 + c]!;
          out[(y * nw + x) * 4 + c] = sum / n;
        }
      }
    }
    mips.widths.push(nw);
    mips.heights.push(nh);
    mips.levels.push(out);
    w = nw;
    h = nh;
  }
  cache.set(texture, mips);
  return mips;
}

/** One level read bilinearly at (u, v), wrapping, with v up from the image's bottom row as the renderers read it (meshRasterizer's sampleTexture). */
function bilinear(mips: Mips, level: number, u: number, v: number, out: number[]): void {
  const w = mips.widths[level]!;
  const h = mips.heights[level]!;
  const data = mips.levels[level]!;
  const x = u * w - 0.5;
  const y = (1 - v) * h - 0.5;
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const fx = x - x0, fy = y - y0;
  const wrap = (i: number, n: number) => ((i % n) + n) % n;
  const xa = wrap(x0, w), xb = wrap(x0 + 1, w), ya = wrap(y0, h), yb = wrap(y0 + 1, h);
  for (let c = 0; c < 4; c += 1) {
    const top = data[(ya * w + xa) * 4 + c]! * (1 - fx) + data[(ya * w + xb) * 4 + c]! * fx;
    const bottom = data[(yb * w + xa) * 4 + c]! * (1 - fx) + data[(yb * w + xb) * 4 + c]! * fx;
    out[c] = top * (1 - fy) + bottom * fy;
  }
}

/**
 * A map's mean over a triangle's UV footprint (corners `a`, `b`, `c`), in
 * linear light when `srgb` (see the module comment): RGBA.
 */
export function footprintMean(texture: DecodedTexture, srgb: boolean, a: readonly [number, number], b: readonly [number, number], c: readonly [number, number]): [number, number, number, number] {
  const mips = mipsOf(texture, srgb);
  const top = mips.levels.length - 1;
  const area = Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1])) / 2;
  // The footprint's side in texels picks the level: one texel there is about the whole triangle.
  const texels = area * mips.widths[0]! * mips.heights[0]!;
  const level = Math.min(top, Math.max(0, 0.5 * Math.log2(Math.max(1, texels))));
  const u = (a[0] + b[0] + c[0]) / 3;
  const v = (a[1] + b[1] + c[1]) / 3;
  const lo = Math.floor(level);
  const hi = Math.min(top, lo + 1);
  const t = level - lo;
  const p = [0, 0, 0, 0];
  const q = [0, 0, 0, 0];
  bilinear(mips, lo, u, v, p);
  if (t > 0) bilinear(mips, hi, u, v, q);
  return [0, 1, 2, 3].map((k) => p[k]! * (1 - t) + q[k]! * t) as [number, number, number, number];
}

/** Linear light back into authored colour, so a bake that decodes it (toLinear) reads the linear value again. */
export function linearToAuthored(c: number): number {
  const v = Math.max(0, c);
  return v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055;
}
