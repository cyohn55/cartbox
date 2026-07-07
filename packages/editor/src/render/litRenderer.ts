/**
 * The CPU lit renderer: albedo + an encoded normal buffer (+ an optional
 * material buffer) + a light -> lit RGBA. Pure and DOM-free, so it's unit-tested
 * and used as the fallback when WebGPU is unavailable. The WebGPU renderer
 * uploads the same buffers and runs the same maths in a shader, so the two paths
 * agree by construction.
 *
 * Normals are a tangent-space normal map (RGB encodes the unit normal as
 * v*0.5+0.5). The optional material buffer is RGBA per pixel: R = height,
 * G = specular strength, B = roughness, A = emissive (each 0..255). With a
 * material the renderer adds Blinn-Phong specular glints, a height self-shadow,
 * a rim term, and lifts each pixel to at least `albedo * emissive` so
 * self-illuminated pixels stay bright in shadow — the same model the runtime
 * lighting uses — so the preview is WYSIWYG. Without a material it is exactly
 * Lambert diffuse over an ambient floor.
 *
 * With a `fog` option it also adds volumetric light shafts (god rays): each pixel
 * marches the same horizon the cast shadow uses toward the light and scatters
 * fog light back in proportion to how much of that path stays in open air. A
 * clear path glows (a bright shaft); a path cut short behind a taller silhouette
 * stays dim (a dark shaft), so the rays fall out of the same geometry as the
 * shadows and line up with them.
 */

import { shade } from "../model/lighting";
import type { Vec3 } from "../model/normals";

/** A point light over the tile, positioned in pixel-grid units. */
export interface Light {
  col: number;
  row: number;
  height: number;
  ambient: number;
}

/** Volumetric fog / god-ray in-scattering. Needs the height field (material), so
 * it only takes effect on the material path. */
export interface FogOptions {
  /** Fog / in-scattered light colour, each channel 0..1. */
  color: readonly [number, number, number];
  /** In-scatter strength, 0..1. 0 disables the shafts. */
  density: number;
}

/** Optional inputs: the per-pixel material, a fog volume, and/or a reused buffer. */
export interface LitOptions {
  /** RGBA per pixel: R=height, G=specular, B=roughness, A=emissive (0..255). */
  material?: Uint8ClampedArray;
  /** Volumetric light shafts through fog. Omit (or density 0) to disable. */
  fog?: FogOptions;
  /** Reuse this output buffer instead of allocating. */
  out?: Uint8ClampedArray;
}

/** Full-white height maps to this many pixel units for the self-shadow march. */
const HEIGHT_MAX = 2.5;
/** View direction for specular/rim: straight at the flat sprite. */
const VIEW: Vec3 = [0, 0, 1];
/** How far (pixels) the shadow march looks toward the light. */
const SHADOW_MAX_RANGE = 16;
/** Fine, ~1px march steps make the shadow edge follow the true projected line
 * instead of the coarse staircase a few big steps produce. */
const SHADOW_STEPS = 16;
/** Max darkening of a fully shadowed pixel (0.6 -> floor of 0.4). */
const SHADOW_STRENGTH = 0.6;
/** Penumbra hardness: higher = sharper shadow edge. */
const SHADOW_SOFTNESS = 2.5;

/** Decode a tangent-space normal-map RGB byte triple to a unit-ish vector. */
function decodeNormal(r: number, g: number, b: number): Vec3 {
  return [r / 127.5 - 1, g / 127.5 - 1, b / 127.5 - 1];
}

function normalize(v: Vec3): Vec3 {
  const length = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / length, v[1] / length, v[2] / length];
}

const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

export function renderLitRgba(
  albedo: Uint8ClampedArray,
  normal: Uint8ClampedArray,
  width: number,
  height: number,
  light: Light,
  options?: LitOptions,
): Uint8ClampedArray {
  const target = options?.out ?? new Uint8ClampedArray(width * height * 4);
  const material = options?.material;
  const fog = options?.fog && options.fog.density > 0 ? options.fog : undefined;

  // Fast path with no material: exactly Lambert diffuse + ambient (unchanged).
  if (!material) {
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const i = (y * width + x) * 4;
        const n = decodeNormal(normal[i] ?? 128, normal[i + 1] ?? 128, normal[i + 2] ?? 255);
        const toLight: Vec3 = [light.col - (x + 0.5), light.row - (y + 0.5), light.height];
        const [r, g, b] = shade([albedo[i] ?? 0, albedo[i + 1] ?? 0, albedo[i + 2] ?? 0], n, toLight, light.ambient);
        target[i] = r;
        target[i + 1] = g;
        target[i + 2] = b;
        target[i + 3] = albedo[i + 3] ?? 255;
      }
    }
    return target;
  }

  const sampleHeight = (ix: number, iy: number): number => {
    const cx = ix < 0 ? 0 : ix >= width ? width - 1 : ix;
    const cy = iy < 0 ? 0 : iy >= height ? height - 1 : iy;
    return ((material[(cy * width + cx) * 4] ?? 0) / 255) * HEIGHT_MAX;
  };
  // Bilinear height at a floating pixel-space point, so the marched height field
  // is smooth and the shadow edge doesn't snap to the sample grid.
  const heightAt = (fx: number, fy: number): number => {
    const gx = fx - 0.5;
    const gy = fy - 0.5;
    const x0 = Math.floor(gx);
    const y0 = Math.floor(gy);
    const tx = gx - x0;
    const ty = gy - y0;
    const top = sampleHeight(x0, y0) * (1 - tx) + sampleHeight(x0 + 1, y0) * tx;
    const bottom = sampleHeight(x0, y0 + 1) * (1 - tx) + sampleHeight(x0 + 1, y0 + 1) * tx;
    return top * (1 - ty) + bottom * ty;
  };

  // Soft horizon shadow: march toward the light and track how far the terrain
  // rises above the line of sight. A gentle penumbra reads as a real cast shadow
  // rather than a hard staircase.
  const shadowFactor = (px: number, py: number, h0: number): number => {
    const dx = light.col - px;
    const dy = light.row - py;
    const distToLight = Math.hypot(dx, dy);
    if (distToLight < 1e-3) return 1;
    const ux = dx / distToLight;
    const uy = dy / distToLight;
    const lightSlope = (light.height - h0) / distToLight;
    const range = Math.min(distToLight, SHADOW_MAX_RANGE);
    let maxExcess = 0;
    for (let s = 1; s <= SHADOW_STEPS; s += 1) {
      const d = (s / SHADOW_STEPS) * range;
      const slope = (heightAt(px + ux * d, py + uy * d) - h0) / d;
      if (slope - lightSlope > maxExcess) maxExcess = slope - lightSlope;
    }
    return 1 - Math.min(1, maxExcess * SHADOW_SOFTNESS) * SHADOW_STRENGTH;
  };

  // Volumetric light shaft: march the same ray the shadow uses and return the
  // fraction of it that stays in open air before the terrain first rises above
  // the light's line of sight. 1 = an unobstructed path (a bright god ray); a low
  // value = the path is cut short behind a silhouette (a dark shaft). The horizon
  // only ever rises as we march, so this is the reach to first occlusion.
  const lightShaftVisibility = (px: number, py: number, h0: number): number => {
    const dx = light.col - px;
    const dy = light.row - py;
    const distToLight = Math.hypot(dx, dy);
    if (distToLight < 1e-3) return 1;
    const ux = dx / distToLight;
    const uy = dy / distToLight;
    const lightSlope = (light.height - h0) / distToLight;
    const range = Math.min(distToLight, SHADOW_MAX_RANGE);
    let maxSlope = -Infinity;
    let litSteps = 0;
    for (let s = 1; s <= SHADOW_STEPS; s += 1) {
      const d = (s / SHADOW_STEPS) * range;
      const slope = (heightAt(px + ux * d, py + uy * d) - h0) / d;
      if (slope > maxSlope) maxSlope = slope;
      if (maxSlope <= lightSlope) litSteps += 1;
    }
    return litSteps / SHADOW_STEPS;
  };

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      const n = normalize(decodeNormal(normal[i] ?? 128, normal[i + 1] ?? 128, normal[i + 2] ?? 255));
      const px = x + 0.5;
      const py = y + 0.5;
      const toLight = normalize([light.col - px, light.row - py, light.height]);

      const h0 = ((material[i] ?? 0) / 255) * HEIGHT_MAX;
      const specStrength = (material[i + 1] ?? 0) / 255;
      const roughness = (material[i + 2] ?? 255) / 255;
      const emissive = (material[i + 3] ?? 0) / 255;

      const shadow = shadowFactor(px, py, h0);
      const diffuse = Math.max(0, dot(n, toLight)) * shadow;
      const intensity = light.ambient + (1 - light.ambient) * diffuse;

      const shininess = 6 + (120 - 6) * (1 - roughness);
      const half = normalize([toLight[0] + VIEW[0], toLight[1] + VIEW[1], toLight[2] + VIEW[2]]);
      const specular = Math.pow(Math.max(0, dot(n, half)), shininess) * specStrength * shadow;
      const rim = Math.pow(1 - Math.max(0, dot(n, VIEW)), 3) * 0.15;

      const lift = intensity + rim;
      const glint = 255 * specular; // white specular highlight
      // Fog light scattered back along the path to the light: bright where the
      // path is open, dim behind a silhouette. Added on top of the surface, so
      // shafts only ever brighten (in 0..255 to match the byte target).
      const inscatter = fog ? fog.density * lightShaftVisibility(px, py, h0) : 0;
      const shaftR = fog ? fog.color[0] * 255 * inscatter : 0;
      const shaftG = fog ? fog.color[1] * 255 * inscatter : 0;
      const shaftB = fog ? fog.color[2] * 255 * inscatter : 0;
      // A self-illuminated pixel never drops below its own colour scaled by the
      // emissive level, so it stays bright even when the light turns away.
      // Uint8ClampedArray clamps + rounds on assignment.
      target[i] = Math.max((albedo[i] ?? 0) * lift + glint, (albedo[i] ?? 0) * emissive) + shaftR;
      target[i + 1] = Math.max((albedo[i + 1] ?? 0) * lift + glint, (albedo[i + 1] ?? 0) * emissive) + shaftG;
      target[i + 2] = Math.max((albedo[i + 2] ?? 0) * lift + glint, (albedo[i + 2] ?? 0) * emissive) + shaftB;
      target[i + 3] = albedo[i + 3] ?? 255;
    }
  }
  return target;
}
