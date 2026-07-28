/**
 * Giving a flat tile a surface.
 *
 * A {@link FaceTexture} on its own is albedo: the colour of a wall, with no
 * answer to "which way is this bit of it facing?". A renderer with nothing but
 * albedo can only shade a face by its *cell's* normal, so every texel of a brick
 * wall takes exactly the same light and the wall reads as a photograph of brick
 * pasted onto a box. Give the same tile a height field and normals derived from
 * it and the mortar lines catch the light on one side and lose it on the other,
 * which is what makes a surface legible at a glance — and legible from *any*
 * angle, since the response changes as you walk past.
 *
 * Art authored in the editor may carry these channels already (the Material layer
 * paints normal, height, specular and roughness per pixel). This module is for
 * the art that does not: it reads relief out of the pixels themselves, because a
 * pixel artist has already drawn the relief — that is what the light and dark
 * texels *are*. Luminance becomes height, the height's gradient becomes the
 * normal, and the material's own finish supplies how glossy the result is.
 *
 * Pure and DOM-free; the tests drive it with authored art and assert on the
 * channels it produces.
 */

import type { FaceTexture } from "./faceTexture";

/**
 * How a material takes light, independent of what is drawn on it. Two tiles can
 * share art and differ entirely in finish — the same grey pixels are dull stone
 * at one setting and polished metal at another.
 */
export interface SurfaceFinish {
  /** Specular strength, 0..1: how much of a highlight the surface returns. */
  readonly specular: number;
  /** Roughness, 0..1: 0 is a tight mirror glint, 1 is a broad matte sheen. */
  readonly roughness: number;
  /**
   * How strongly the art's own light and shade is read as relief, 0..1. Zero
   * leaves the tile flat (right for something genuinely smooth, like water or
   * glass); high values make a rough surface visibly bumpy.
   */
  readonly relief: number;
  /**
   * Self-emissive strength, 0..1, applied where the art is brightest. This is the
   * "glowing pixels light the scene" channel: a lamp tile lit at 1 keeps its glow
   * in shadow and feeds the bloom pass.
   */
  readonly emissive?: number;
}

/** A plain matte surface — the sensible default for terrain and stone. */
export const MATTE_FINISH: SurfaceFinish = { specular: 0.08, roughness: 0.85, relief: 0.6 };

/**
 * Perceptual luminance of a texel, 0..1. Weighted rather than a flat average
 * because the eye reads green as far brighter than blue, and a height field that
 * disagrees with the eye produces relief that looks wrong beside its own art.
 */
export function luminance(r: number, g: number, b: number): number {
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

/**
 * The height field a tile's own art implies: its luminance, softened toward the
 * tile's mean so a merely *colourful* tile does not become a mountain range.
 *
 * Fully transparent texels take the mean rather than zero. A hole has no height,
 * and letting it read as a pit would carve a trench around every sprite's
 * silhouette when the gradient is taken.
 */
export function heightFromArt(texture: FaceTexture, relief: number): Uint8Array {
  const { size, data } = texture;
  const count = size * size;
  const height = new Uint8Array(count);
  const strength = Math.max(0, Math.min(1, relief));

  let total = 0;
  let opaque = 0;
  const raw = new Float32Array(count);
  for (let i = 0; i < count; i += 1) {
    const base = i * 4;
    if (data[base + 3]! === 0) {
      raw[i] = -1;
      continue;
    }
    const value = luminance(data[base]!, data[base + 1]!, data[base + 2]!);
    raw[i] = value;
    total += value;
    opaque += 1;
  }
  const mean = opaque > 0 ? total / opaque : 0.5;

  for (let i = 0; i < count; i += 1) {
    const value = raw[i]! < 0 ? mean : raw[i]!;
    height[i] = Math.round(Math.max(0, Math.min(1, mean + (value - mean) * strength)) * 255);
  }
  return height;
}

/**
 * Tangent-space normals for a height field, by central difference.
 *
 * The gradient is taken with the tile wrapping, because a tile *does* wrap: it is
 * laid edge to edge across a face and across the faces beside it, so treating its
 * border as a cliff would draw a bright seam around every cell in the world.
 *
 * `scale` converts a height step into a slope. It is expressed per texel, so a
 * 16x16 tile and an 8x8 one carrying the same drawing come out with the same
 * apparent steepness rather than the smaller one looking twice as rugged.
 */
export function normalsFromHeight(height: Uint8Array, size: number, scale: number): Uint8Array {
  const normals = new Uint8Array(size * size * 3);
  const at = (x: number, y: number): number =>
    height[(((y % size) + size) % size) * size + (((x % size) + size) % size)]! / 255;
  const steepness = scale * size;

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      // Along the tile's own u and v. v runs down the image, and the surface
      // basis the renderer builds runs the same way, so no flip belongs here.
      const dx = (at(x + 1, y) - at(x - 1, y)) * 0.5 * steepness;
      const dy = (at(x, y + 1) - at(x, y - 1)) * 0.5 * steepness;
      const length = Math.hypot(dx, dy, 1) || 1;
      const base = (y * size + x) * 3;
      normals[base] = Math.round((-dx / length) * 127.5 + 127.5);
      normals[base + 1] = Math.round((-dy / length) * 127.5 + 127.5);
      normals[base + 2] = Math.round((1 / length) * 127.5 + 127.5);
    }
  }
  return normals;
}

/** How much slope one unit of height buys. Tuned by eye against the world tiles. */
const RELIEF_SLOPE = 0.11;

/**
 * The emissive channel a finish implies: the art's own brightest texels glow.
 * Ramped from the tile's midpoint so a lamp's bright core lights up while its
 * darker housing does not.
 */
function emissiveFromArt(texture: FaceTexture, strength: number): Uint8Array {
  const { size, data } = texture;
  const glow = new Uint8Array(size * size);
  for (let i = 0; i < size * size; i += 1) {
    const base = i * 4;
    if (data[base + 3]! === 0) continue;
    const value = luminance(data[base]!, data[base + 1]!, data[base + 2]!);
    glow[i] = Math.round(Math.max(0, Math.min(1, (value - 0.45) / 0.55)) * strength * 255);
  }
  return glow;
}

/**
 * Complete a tile's material channels from its art and its finish, leaving any
 * channel the art already carries untouched.
 *
 * Authored channels win by design: this is the fallback for art that has none,
 * not an override of an artist's decisions. Painting a normal in the Material
 * layer must be the last word on that texel.
 */
export function withDerivedSurface(texture: FaceTexture, finish: SurfaceFinish): FaceTexture {
  const count = texture.size * texture.size;
  const height = texture.height ?? heightFromArt(texture, finish.relief);
  const normal =
    texture.normal ??
    (finish.relief > 0 ? normalsFromHeight(height, texture.size, RELIEF_SLOPE * finish.relief) : undefined);
  const specular = texture.specular ?? fill(count, finish.specular);
  const roughness = texture.roughness ?? fill(count, finish.roughness);
  const emissive =
    texture.emissive ?? (finish.emissive && finish.emissive > 0 ? emissiveFromArt(texture, finish.emissive) : undefined);

  return { ...texture, height, normal, specular, roughness, ...(emissive ? { emissive } : {}) };
}

/** A constant channel, from a 0..1 level. */
function fill(count: number, level: number): Uint8Array {
  const channel = new Uint8Array(count);
  channel.fill(Math.round(Math.max(0, Math.min(1, level)) * 255));
  return channel;
}
