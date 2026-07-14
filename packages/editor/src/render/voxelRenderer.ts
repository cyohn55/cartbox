/**
 * The voxel core: a pure heightfield voxel renderer.
 *
 * Where the 2.5D lit renderer (litRenderer.ts) shades a flat sprite by its
 * normal map, this treats each pixel as a voxel column whose height comes from
 * the material height channel, and draws the columns as real 3D blocks: a lit
 * top face plus the exposed front wall that the raised column reveals. The same
 * directional light that lights the tops (via the normal map) rakes across the
 * side walls, so changing the lighting conditions visibly re-lights the model —
 * that is the whole point of the preview.
 *
 * Pure and DOM-free (like litRenderer), so the browser preview and the unit
 * tests drive it identically and assert on the actual output pixels. Columns are
 * drawn back-to-front (painter's algorithm), so a nearer, taller column
 * correctly occludes a farther one.
 */

import type { Vec3 } from "../model/normals";

/** A directional light in screen space (x right, y down, z toward the viewer). */
export interface VoxelLight {
  /** Unit vector from the surface toward the light (see directionFromConditions). */
  direction: Vec3;
  /** Light colour, each channel 0..1. */
  color: readonly [number, number, number];
  /** Direct-light strength multiplier (0 = ambient only). */
  intensity: number;
  /** Minimum brightness in shadow, 0..1. */
  ambient: number;
}

export interface VoxelOptions {
  /** RGBA per pixel: R=height, G=specular, B=roughness, A=emissive (0..255). Height 0 = flat. */
  material?: Uint8ClampedArray;
  /** Output pixels per source pixel (integer upscale). Default 8. */
  cell?: number;
  /** Screen pixels a full-height (255) column rises above the ground plane. Default 3×cell. */
  heightScale?: number;
  /** Reuse this output buffer (must be sized for the returned width×height). */
  out?: Uint8ClampedArray;
}

export interface VoxelImage {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

/**
 * The exposed front wall of a column faces the viewer and tilts downward, so it
 * catches low, head-on light and stays darker under pure overhead light.
 */
const SIDE_NORMAL: Vec3 = normalize([0, 1, 0.5]);
/** Walls read as slightly recessed from their top face. */
const SIDE_SHADE = 0.78;

function normalize([x, y, z]: Vec3): Vec3 {
  const length = Math.hypot(x, y, z) || 1;
  return [x / length, y / length, z / length];
}

const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** Decode a tangent-space normal-map RGB byte triple to a unit-ish vector. */
function decodeNormal(r: number, g: number, b: number): Vec3 {
  return [r / 127.5 - 1, g / 127.5 - 1, b / 127.5 - 1];
}

/**
 * Renders a heightfield of voxel columns from albedo + normal (+ material) under
 * one directional light. Returns the lit RGBA and its dimensions — taller than
 * the input grid, because raised columns rise above the top row.
 */
export function renderVoxelRgba(
  albedo: Uint8ClampedArray,
  normal: Uint8ClampedArray,
  width: number,
  height: number,
  light: VoxelLight,
  options?: VoxelOptions,
): VoxelImage {
  const material = options?.material;
  const cell = Math.max(1, Math.floor(options?.cell ?? 8));
  const heightScale = options?.heightScale ?? cell * 3;
  const headroom = Math.ceil(heightScale);

  const outWidth = width * cell;
  const outHeight = height * cell + headroom;
  const out = options?.out ?? new Uint8ClampedArray(outWidth * outHeight * 4);
  if (options?.out) out.fill(0);

  const lightDir = normalize(light.direction);
  const topSide = Math.max(0, dot(SIDE_NORMAL, lightDir));

  const fillRect = (x: number, y: number, w: number, h: number, r: number, g: number, b: number): void => {
    const x0 = Math.max(0, Math.floor(x));
    const y0 = Math.max(0, Math.floor(y));
    const x1 = Math.min(outWidth, Math.ceil(x + w));
    const y1 = Math.min(outHeight, Math.ceil(y + h));
    for (let py = y0; py < y1; py += 1) {
      for (let px = x0; px < x1; px += 1) {
        const t = (py * outWidth + px) * 4;
        out[t] = r;
        out[t + 1] = g;
        out[t + 2] = b;
        out[t + 3] = 255;
      }
    }
  };

  // Back (row 0) to front (row height-1): nearer columns overpaint farther ones.
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      if ((albedo[i + 3] ?? 0) === 0) continue; // transparent pixel = empty column

      const ar = albedo[i] ?? 0;
      const ag = albedo[i + 1] ?? 0;
      const ab = albedo[i + 2] ?? 0;
      const emissive = material ? (material[i + 3] ?? 0) / 255 : 0;
      const risePx = material ? ((material[i] ?? 0) / 255) * heightScale : 0;

      const n = decodeNormal(normal[i] ?? 128, normal[i + 1] ?? 128, normal[i + 2] ?? 255);
      const topDiffuse = Math.max(0, dot(normalize(n), lightDir));
      const topFactor = light.ambient + (1 - light.ambient) * topDiffuse * light.intensity;
      const sideFactor = (light.ambient + (1 - light.ambient) * topSide * light.intensity) * SIDE_SHADE;

      const baseY = headroom + y * cell; // top of this cell's ground footprint
      const topY = baseY - risePx;

      // Top face: lit by the surface normal, floored by self-illumination.
      fillRect(
        x * cell,
        topY,
        cell,
        cell,
        litChannel(ar, topFactor, light.color[0], emissive),
        litChannel(ag, topFactor, light.color[1], emissive),
        litChannel(ab, topFactor, light.color[2], emissive),
      );

      // Front wall the raised column exposes, lit by the fixed side normal.
      if (risePx > 0.5) {
        fillRect(
          x * cell,
          topY + cell,
          cell,
          risePx,
          litChannel(ar, sideFactor, light.color[0], emissive * 0.6),
          litChannel(ag, sideFactor, light.color[1], emissive * 0.6),
          litChannel(ab, sideFactor, light.color[2], emissive * 0.6),
        );
      }
    }
  }

  return { data: out, width: outWidth, height: outHeight };
}

/**
 * One channel of a lit face: the albedo scaled by the light (factor × coloured),
 * but never below its own emissive glow, so self-lit pixels survive shadow.
 */
function litChannel(albedo: number, factor: number, lightColor: number, emissive: number): number {
  const lit = albedo * factor * lightColor;
  const glow = albedo * emissive;
  return Math.max(lit, glow);
}
