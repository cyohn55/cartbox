/**
 * The lighting model, in pure TypeScript. This is the exact formula the CPU
 * preview and the WebGPU shader both run — Lambert diffuse with an ambient
 * floor — so it can be unit-tested independently of any renderer.
 */

import type { Vec3 } from "./normals";

export type Rgb = readonly [number, number, number];

function normalize([x, y, z]: Vec3): Vec3 {
  const length = Math.hypot(x, y, z) || 1;
  return [x / length, y / length, z / length];
}

/**
 * Shade an albedo colour by a surface normal and a light direction.
 *
 * @param albedo    Base colour, each channel 0..255.
 * @param normal    Surface normal (need not be unit length).
 * @param toLight   Direction from the surface toward the light.
 * @param ambient   Minimum brightness in shadow, 0..1.
 * @returns The lit colour, each channel clamped to 0..255.
 */
export function shade(albedo: Rgb, normal: Vec3, toLight: Vec3, ambient: number): Rgb {
  const n = normalize(normal);
  const l = normalize(toLight);
  const diffuse = Math.max(0, n[0] * l[0] + n[1] * l[1] + n[2] * l[2]);
  const intensity = ambient + (1 - ambient) * diffuse;
  const clamp = (value: number) => Math.max(0, Math.min(255, Math.round(value * intensity)));
  return [clamp(albedo[0]), clamp(albedo[1]), clamp(albedo[2])];
}
