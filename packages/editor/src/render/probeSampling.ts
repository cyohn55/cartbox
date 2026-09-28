/**
 * Sampling baked reflection probes (HALO2_STYLE_ROADMAP.md, H2) — the software
 * rasteriser's reference, mirrored by the WebGPU and WebGL2 shaders.
 *
 * A {@link ReflectionProbeSet} is every probe's panorama stacked in one atlas
 * (probe i fills rows i·h … (i+1)·h, h = width / 2, equirectangular like the
 * environment map), and each probe's box, capture point and mean colour. A
 * surface point takes the first probe whose box holds it — the set is ordered
 * smallest box first, so a small room wins over the hall around it — fading to
 * the sky over {@link PROBE_FADE} units inside the box's faces. Its reflection
 * ray is box-projected: traced to the box's walls from the point, then looked
 * up from the capture point, so what it reflects sits where the room's walls
 * are rather than infinitely far away.
 */

import type { DecodedTexture } from "./meshRasterizer";

type V3 = readonly [number, number, number];

/** One baked probe's placement and mean radiance (already scaled by {@link PROBE_RANGE}). */
export interface ProbeBox {
  readonly min: V3;
  readonly max: V3;
  readonly position: V3;
  readonly average: V3;
}

export interface ReflectionProbeSet {
  /** The panoramas, stacked: width × (width / 2 · probes.length), RGBA. */
  readonly atlas: DecodedTexture;
  /** Smallest box first. */
  readonly probes: readonly ProbeBox[];
}

/**
 * A probe texel of 255 is this much radiance: panoramas are baked at 1/range
 * so sunlit surfaces brighter than 1 survive 8 bits (like LIGHTMAP_RANGE).
 */
export const PROBE_RANGE = 2;

/** How far inside its box a probe fades in from the sky, world units. */
export const PROBE_FADE = 1;

/** How much a probe applies at a point: 0 outside its box, rising to 1 at {@link PROBE_FADE} inside. */
export function probeWeight(box: ProbeBox, x: number, y: number, z: number): number {
  const inside = Math.min(x - box.min[0], box.max[0] - x, y - box.min[1], box.max[1] - y, z - box.min[2], box.max[2] - z);
  return Math.max(0, Math.min(1, inside / PROBE_FADE));
}

/** The probe that covers a point — the first (smallest) whose box holds it — and its weight, or null. */
export function pickProbe(set: ReflectionProbeSet, x: number, y: number, z: number): { index: number; weight: number } | null {
  for (let i = 0; i < set.probes.length; i += 1) {
    const weight = probeWeight(set.probes[i]!, x, y, z);
    if (weight > 0) return { index: i, weight };
  }
  return null;
}

/**
 * Box-project a reflection ray: trace it from point P to the box's walls and
 * return the direction from the capture point to where it lands.
 */
export function boxProject(box: ProbeBox, px: number, py: number, pz: number, rx: number, ry: number, rz: number): [number, number, number] {
  const far = (p: number, r: number, lo: number, hi: number): number => (Math.abs(r) < 1e-6 ? Infinity : ((r > 0 ? hi : lo) - p) / r);
  const t = Math.max(0, Math.min(far(px, rx, box.min[0], box.max[0]), far(py, ry, box.min[1], box.max[1]), far(pz, rz, box.min[2], box.max[2])));
  return [px + rx * t - box.position[0], py + ry * t - box.position[1], pz + rz * t - box.position[2]];
}

/** Nearest-sample probe `index`'s panorama along a direction (radiance, 0..{@link PROBE_RANGE}). */
export function sampleProbe(set: ReflectionProbeSet, index: number, dx: number, dy: number, dz: number): [number, number, number] {
  const { atlas } = set;
  const w = atlas.width;
  const h = w >> 1;
  const len = Math.hypot(dx, dy, dz) || 1;
  const u = Math.atan2(dz / len, dx / len) / (2 * Math.PI) + 0.5;
  const v = Math.acos(Math.min(1, Math.max(-1, dy / len))) / Math.PI;
  const tx = Math.min(w - 1, Math.floor((u - Math.floor(u)) * w));
  const ty = Math.min(h - 1, Math.floor(v * h)) + index * h;
  const at = (ty * w + tx) * 4;
  const k = PROBE_RANGE / 255;
  return [atlas.data[at]! * k, atlas.data[at + 1]! * k, atlas.data[at + 2]! * k];
}
