/**
 * Packing a {@link TextureAtlas} into the three layered images a GPU samples.
 *
 * The CPU renderers read tiles straight out of the atlas, one texel lookup at a
 * time. A GPU cannot: it wants a small number of textures, every layer the same
 * size, with a mip chain. This module does that conversion, and it is pure —
 * which matters, because the two things that make world art read well or badly
 * both live here and both are testable without a GPU.
 *
 * **Every layer is an exact integer upscale of its tile.** The atlas mixes sizes
 * — hand-authored world tiles are 12 texels square, a cart's own sprites are 8 —
 * and stretching 8 into 12 would make some texels one pixel wide and others two.
 * That unevenness is exactly what makes pixel art look broken, so the layer size
 * is the smallest common multiple of the sizes present (8 and 12 give 24: three
 * and two texels each), and every tile lands on it with square texels.
 *
 * **The mip chain is alpha-weighted.** A tile with holes in it — grass, a ladder,
 * anything drawn with a silhouette — has RGB stored under its transparent texels
 * that means nothing. Averaging that in darkens the edges of every sprite as it
 * recedes; weighting by coverage does not. Without mips at all, a twelve-texel
 * tile squeezed into three pixels picks an arbitrary texel per frame and the
 * whole landscape crawls with noise, which is the other half of "crisp from any
 * angle".
 */

import { MATERIAL_TOP_THRESHOLD, type FaceTexture, type TextureAtlas } from "./faceTexture";
import { withDerivedSurface, MATTE_FINISH, type SurfaceFinish } from "./faceRelief";

/** The three face groups a material names, in the order a layer table stores them. */
export const FACE_GROUPS = ["top", "side", "bottom"] as const;
export type FaceGroup = (typeof FACE_GROUPS)[number];

/** One level of the packed mip chain. Each image is layer-major, RGBA8. */
export interface AtlasTextureLevel {
  /** Edge length of a layer at this level. */
  readonly size: number;
  /** Albedo: straight-alpha RGBA, `layers * size * size * 4` bytes. */
  readonly albedo: Uint8Array;
  /** Surface: rgb = tangent-space normal, a = height. */
  readonly surface: Uint8Array;
  /** Finish: r = specular, g = roughness, b = emissive, a = unused. */
  readonly finish: Uint8Array;
}

/** An atlas as three layered, mipped textures plus the table that indexes them. */
export interface AtlasTexture {
  /** Edge length of a layer at level 0. */
  readonly size: number;
  readonly layers: number;
  /** Level 0 first, each half the previous, down to a single texel. */
  readonly levels: readonly AtlasTextureLevel[];
  /**
   * Layer for `material * 3 + group`, or −1 to draw the face flat. Flattened so
   * the shader can index it as a plain buffer.
   */
  readonly faceLayer: Int32Array;
  /** How many materials {@link faceLayer} covers. */
  readonly materials: number;
}

/** Beyond this, a common multiple costs more than uneven texels do. */
const MAX_LAYER_SIZE = 64;

function greatestCommonDivisor(a: number, b: number): number {
  let x = a;
  let y = b;
  while (y !== 0) {
    const next = x % y;
    x = y;
    y = next;
  }
  return x;
}

/**
 * The layer size that lets every tile upscale by a whole number: the smallest
 * common multiple of the sizes present. Falls back to the largest size when that
 * multiple would be extravagant — a few uneven texels beat a megabyte per tile.
 */
export function commonTileSize(sizes: readonly number[]): number {
  const distinct = [...new Set(sizes.filter((size) => size > 0))];
  if (distinct.length === 0) return 1;
  let multiple = distinct[0]!;
  for (const size of distinct.slice(1)) {
    multiple = (multiple / greatestCommonDivisor(multiple, size)) * size;
    if (multiple > MAX_LAYER_SIZE) return Math.max(...distinct);
  }
  return multiple;
}

/** Nearest-neighbour resample of one channel-group into a `size` square. */
function upscale(
  source: ArrayLike<number> | undefined,
  sourceSize: number,
  channels: number,
  size: number,
  target: Uint8Array,
  offset: number,
  fallback: readonly number[],
): void {
  for (let y = 0; y < size; y += 1) {
    const sy = Math.min(sourceSize - 1, Math.floor((y * sourceSize) / size));
    for (let x = 0; x < size; x += 1) {
      const sx = Math.min(sourceSize - 1, Math.floor((x * sourceSize) / size));
      const to = offset + (y * size + x) * 4;
      for (let c = 0; c < 4; c += 1) {
        target[to + c] =
          source && c < channels ? source[(sy * sourceSize + sx) * channels + c]! : fallback[c]!;
      }
    }
  }
}

/** Read a single-channel map into one component of an RGBA target. */
function upscaleChannel(
  source: ArrayLike<number> | undefined,
  sourceSize: number,
  size: number,
  target: Uint8Array,
  offset: number,
  component: number,
  fallback: number,
): void {
  for (let y = 0; y < size; y += 1) {
    const sy = Math.min(sourceSize - 1, Math.floor((y * sourceSize) / size));
    for (let x = 0; x < size; x += 1) {
      const sx = Math.min(sourceSize - 1, Math.floor((x * sourceSize) / size));
      target[offset + (y * size + x) * 4 + component] = source
        ? source[sy * sourceSize + sx]!
        : fallback;
    }
  }
}

/**
 * Halve one level, weighting colour by coverage so a tile's holes do not bleed
 * into its edges. Alpha itself is a plain average — half-covered is half-covered.
 */
function halveAlphaWeighted(source: Uint8Array, size: number, layers: number): { data: Uint8Array; size: number } {
  const next = Math.max(1, size >> 1);
  const data = new Uint8Array(layers * next * next * 4);
  const span = Math.max(1, Math.floor(size / next));

  for (let layer = 0; layer < layers; layer += 1) {
    const from = layer * size * size * 4;
    const to = layer * next * next * 4;
    for (let y = 0; y < next; y += 1) {
      for (let x = 0; x < next; x += 1) {
        let weight = 0;
        let r = 0;
        let g = 0;
        let b = 0;
        let a = 0;
        let samples = 0;
        for (let dy = 0; dy < span; dy += 1) {
          const sy = Math.min(size - 1, y * span + dy);
          for (let dx = 0; dx < span; dx += 1) {
            const sx = Math.min(size - 1, x * span + dx);
            const base = from + (sy * size + sx) * 4;
            const alpha = source[base + 3]!;
            r += source[base]! * alpha;
            g += source[base + 1]! * alpha;
            b += source[base + 2]! * alpha;
            a += alpha;
            weight += alpha;
            samples += 1;
          }
        }
        const out = to + (y * next + x) * 4;
        if (weight > 0) {
          data[out] = Math.round(r / weight);
          data[out + 1] = Math.round(g / weight);
          data[out + 2] = Math.round(b / weight);
        }
        data[out + 3] = Math.round(a / samples);
      }
    }
  }
  return { data, size: next };
}

/** Halve one level by a plain box average — right for channels with no alpha. */
function halvePlain(source: Uint8Array, size: number, layers: number): { data: Uint8Array; size: number } {
  const next = Math.max(1, size >> 1);
  const data = new Uint8Array(layers * next * next * 4);
  const span = Math.max(1, Math.floor(size / next));

  for (let layer = 0; layer < layers; layer += 1) {
    const from = layer * size * size * 4;
    const to = layer * next * next * 4;
    for (let y = 0; y < next; y += 1) {
      for (let x = 0; x < next; x += 1) {
        const totals = [0, 0, 0, 0];
        let samples = 0;
        for (let dy = 0; dy < span; dy += 1) {
          const sy = Math.min(size - 1, y * span + dy);
          for (let dx = 0; dx < span; dx += 1) {
            const sx = Math.min(size - 1, x * span + dx);
            const base = from + (sy * size + sx) * 4;
            for (let c = 0; c < 4; c += 1) totals[c]! += source[base + c]!;
            samples += 1;
          }
        }
        const out = to + (y * next + x) * 4;
        for (let c = 0; c < 4; c += 1) data[out + c] = Math.round(totals[c]! / samples);
      }
    }
  }
  return { data, size: next };
}

export interface PackAtlasOptions {
  /**
   * The finish to complete a tile's missing channels with, by tile index. Lets
   * the caller say "this one is polished metal, that one is matte grass" without
   * this module knowing anything about materials.
   */
  readonly finishFor?: (tile: number) => SurfaceFinish;
  /** Override the layer size; defaults to {@link commonTileSize}. */
  readonly size?: number;
  /**
   * Cap on how many layers may be packed.
   *
   * A GPU has a hard limit here — a cart's own sprite page alone is 256 tiles,
   * and with the world's own art the atlas runs past the 256 layers a device
   * offers by default. Callers raise the device limit where they can and pass it
   * here; anything past the cap is left out and the materials that named it draw
   * flat, which is a far better failure than the whole view going black.
   */
  readonly maxLayers?: number;
}

/**
 * Pack an atlas into layered, mipped textures.
 *
 * Every tile becomes one layer of each of the three images. A material's face
 * table is flattened into {@link AtlasTexture.faceLayer} so the shader can turn
 * "material 7, an upward face" into a layer with one buffer read, exactly as
 * {@link faceTile} does on the CPU.
 */
export function packAtlasTexture(atlas: TextureAtlas, options: PackAtlasOptions = {}): AtlasTexture {
  const cap = Math.max(1, options.maxLayers ?? Number.MAX_SAFE_INTEGER);
  const tiles = atlas.tiles.slice(0, cap);
  const layers = Math.max(1, tiles.length);
  const size = options.size ?? commonTileSize(tiles.map((tile) => tile.size));

  const albedo = new Uint8Array(layers * size * size * 4);
  const surface = new Uint8Array(layers * size * size * 4);
  const finish = new Uint8Array(layers * size * size * 4);

  tiles.forEach((tile, index) => {
    const complete: FaceTexture = withDerivedSurface(tile, options.finishFor?.(index) ?? MATTE_FINISH);
    const offset = index * size * size * 4;
    upscale(complete.data, tile.size, 4, size, albedo, offset, [0, 0, 0, 0]);
    // Flat normal (0, 0, 1) encodes as the familiar pale blue.
    upscale(complete.normal, tile.size, 3, size, surface, offset, [128, 128, 255, 0]);
    upscaleChannel(complete.height, tile.size, size, surface, offset, 3, 0);
    upscaleChannel(complete.specular, tile.size, size, finish, offset, 0, 0);
    upscaleChannel(complete.roughness, tile.size, size, finish, offset, 1, 255);
    upscaleChannel(complete.emissive, tile.size, size, finish, offset, 2, 0);
    upscaleChannel(undefined, tile.size, size, finish, offset, 3, 255);
  });

  const levels: AtlasTextureLevel[] = [{ size, albedo, surface, finish }];
  let current = levels[0]!;
  while (current.size > 1) {
    const nextAlbedo = halveAlphaWeighted(current.albedo, current.size, layers);
    const nextSurface = halvePlain(current.surface, current.size, layers);
    const nextFinish = halvePlain(current.finish, current.size, layers);
    current = {
      size: nextAlbedo.size,
      albedo: nextAlbedo.data,
      surface: nextSurface.data,
      finish: nextFinish.data,
    };
    levels.push(current);
  }

  return {
    size,
    layers,
    levels,
    faceLayer: buildFaceLayers(atlas, tiles.length),
    materials: materialCount(atlas),
  };
}

function materialCount(atlas: TextureAtlas): number {
  return atlas.materials ? atlas.materials.length : atlas.tiles.length;
}

/**
 * The material → layer table, in {@link FACE_GROUPS} order. Mirrors
 * {@link faceTile}'s decision, made once here rather than per fragment.
 */
export function buildFaceLayers(atlas: TextureAtlas, packedLayers = atlas.tiles.length): Int32Array {
  const count = materialCount(atlas);
  const table = new Int32Array(count * 3);
  for (let material = 0; material < count; material += 1) {
    const entry = atlas.materials?.[material];
    const slots = entry ? [entry.top, entry.side, entry.bottom] : [material, material, material];
    for (let group = 0; group < 3; group += 1) {
      const slot = slots[group]!;
      table[material * 3 + group] = slot >= 0 && slot < packedLayers ? slot : -1;
    }
  }
  return table;
}

/**
 * The face group a normal's upward component falls in — the same split
 * {@link faceTile} makes, surfaced so the mesh builder can bake the group into
 * each vertex instead of the shader re-deciding it per fragment.
 */
export function faceGroupOf(normalY: number): number {
  if (normalY > MATERIAL_TOP_THRESHOLD) return 0;
  if (normalY < -MATERIAL_TOP_THRESHOLD) return 2;
  return 1;
}
