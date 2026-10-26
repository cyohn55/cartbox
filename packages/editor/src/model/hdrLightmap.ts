/**
 * HDR directional light maps (AAA_FIDELITY_ROADMAP.md F3d): what the GPU
 * lightmapper bakes for the AAA tier, beside the 8-bit ambient scale
 * (lightmap.ts) every other tier keeps reading.
 *
 * Per texel it holds:
 * - **the irradiance** over π in linear light (what a white Lambertian surface
 *   there reflects, the sky's SH irradiance's units, F3a): sky, bounced sun and
 *   sky, and emissive surfaces, any number of bounces deep;
 * - **the dominant direction**: the luminance-weighted mean of the directions
 *   the light came from (cosine-weighted about the baked normal). Its length
 *   is how directional the light is: ⅔ (along the normal) for light from all
 *   round the hemisphere, 1 for light from one direction;
 * - **the sky's visibility**: the share of the sky's light that reaches the
 *   texel unblocked, which occludes the environment's reflection.
 *
 * Stored as one 8-bit RGBA PNG twice the atlas's height: the top half is the
 * irradiance as Radiance RGBE (a shared exponent in alpha), the bottom half
 * the direction (xyz · 0.5 + 0.5) and the visibility in alpha. It is decoded
 * by {@link decodePngRgba}, never by a browser, whose premultiplied alpha
 * would wreck the exponent. Pure and DOM-free.
 */

import { decodePngRgba, encodeRgbaPng } from "./png";
import type { EncodedImage } from "./MeshAsset";

/** A decoded HDR directional light map: `width × height` texels. */
export interface HdrLightmap {
  readonly width: number;
  readonly height: number;
  /** Irradiance over π per texel, linear RGB (3 floats). */
  readonly irradiance: Float32Array;
  /** Per texel: the dominant direction (xyz, length ≤ 1) and the sky's visibility (w), 4 floats. */
  readonly direction: Float32Array;
}

/** A float RGB as Radiance's RGBE bytes: three mantissas over one shared exponent. */
export function toRgbe(r: number, g: number, b: number, out: Uint8Array, o: number): void {
  const m = Math.max(r, g, b);
  if (!(m > 1e-32)) {
    out[o] = out[o + 1] = out[o + 2] = out[o + 3] = 0;
    return;
  }
  // m = f · 2^e with f in [0.5, 1): each channel's mantissa is c / 2^e · 256.
  const e = Math.floor(Math.log2(m)) + 1;
  const scale = 256 / 2 ** e;
  out[o] = Math.min(255, Math.max(0, Math.floor(r * scale)));
  out[o + 1] = Math.min(255, Math.max(0, Math.floor(g * scale)));
  out[o + 2] = Math.min(255, Math.max(0, Math.floor(b * scale)));
  out[o + 3] = Math.min(255, Math.max(0, e + 128));
}

/** RGBE bytes back to linear RGB (the centre of the mantissa's step, as Radiance reads it). */
export function fromRgbe(bytes: ArrayLike<number>, o: number, out: Float32Array, k: number): void {
  const e = bytes[o + 3]!;
  if (e === 0) {
    out[k] = out[k + 1] = out[k + 2] = 0;
    return;
  }
  const f = 2 ** (e - 136);
  out[k] = (bytes[o]! + 0.5) * f;
  out[k + 1] = (bytes[o + 1]! + 0.5) * f;
  out[k + 2] = (bytes[o + 2]! + 0.5) * f;
}

/** Encode a baked HDR light map (see the module comment) as its stored PNG. */
export function encodeHdrLightmap(map: HdrLightmap): EncodedImage {
  const { width, height } = map;
  const rgba = new Uint8Array(width * height * 2 * 4);
  const below = width * height * 4;
  for (let i = 0; i < width * height; i += 1) {
    toRgbe(map.irradiance[i * 3]!, map.irradiance[i * 3 + 1]!, map.irradiance[i * 3 + 2]!, rgba, i * 4);
    for (let a = 0; a < 3; a += 1) rgba[below + i * 4 + a] = Math.round(Math.min(1, Math.max(-1, map.direction[i * 4 + a]!)) * 127.5 + 127.5);
    rgba[below + i * 4 + 3] = Math.round(Math.min(1, Math.max(0, map.direction[i * 4 + 3]!)) * 255);
  }
  return { mime: "image/png", bytes: encodeRgbaPng(rgba, width, height * 2, { compress: true }) };
}

/** Decode a stored HDR light map; throws when the image isn't one (an odd height, or not an 8-bit PNG). */
export async function decodeHdrLightmap(bytes: Uint8Array): Promise<HdrLightmap> {
  const png = await decodePngRgba(bytes);
  if (png.height % 2 !== 0) throw new Error("Not an HDR light map (its height must be even)");
  const width = png.width;
  const height = png.height / 2;
  const irradiance = new Float32Array(width * height * 3);
  const direction = new Float32Array(width * height * 4);
  const below = width * height * 4;
  for (let i = 0; i < width * height; i += 1) {
    fromRgbe(png.data, i * 4, irradiance, i * 3);
    for (let a = 0; a < 3; a += 1) direction[i * 4 + a] = (png.data[below + i * 4 + a]! - 127.5) / 127.5;
    direction[i * 4 + 3] = png.data[below + i * 4 + 3]! / 255;
  }
  return { width, height, irradiance, direction };
}

/** The half-Lambert at the baked normal is floored here, so light from behind it can't blow the ratio up. */
export const LIGHTMAP_DIRECTION_FLOOR = 0.05;

/**
 * The irradiance a directional light map gives a shading normal `n` that may
 * lean off the normal `ng` it was baked for (a normal map's): the baked
 * irradiance rebalanced by a half-Lambert about the dominant direction `d`,
 * exact at `ng`, and unchanged where no light came in (`d` = 0). The AAA shader's
 * `lightmapIrradiance` mirrors it.
 */
export function directionalIrradiance(
  e: readonly [number, number, number],
  d: readonly [number, number, number],
  n: readonly [number, number, number],
  ng: readonly [number, number, number],
): [number, number, number] {
  const k = (0.5 + 0.5 * (n[0] * d[0] + n[1] * d[1] + n[2] * d[2])) / Math.max(LIGHTMAP_DIRECTION_FLOOR, 0.5 + 0.5 * (ng[0] * d[0] + ng[1] * d[1] + ng[2] * d[2]));
  return [e[0] * k, e[1] * k, e[2] * k];
}
