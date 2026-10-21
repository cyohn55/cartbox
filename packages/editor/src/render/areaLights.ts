/**
 * Area lights (AAA_FIDELITY_ROADMAP.md F2e-2): a rectangle, a disk or a tube
 * that glows with a luminance, rather than a point that shines with an
 * intensity.
 *
 * The linear-light GPU shader shades them exactly, with linearly transformed
 * cosines (see ltc.ts in @cartbox/player). Every other renderer, the software
 * rasteriser among them, shades each as the punctual light it is
 * photometrically from far off ({@link areaAsPunctual}):
 *
 * - **A rectangle or disk** of area A and luminance L is a Lambertian emitter.
 *   It is a spot of intensity L·A/π (in the renderer's units, where a sun of 1 is
 *   π times a luminance of 1, physicalLight.ts), falling as 1/d², and its
 *   cosine is held by a cone open to 89° with no inner part. The cone's smooth
 *   fade, ct²(3 − 2ct) with ct ≈ cos θ, is within 0.1 of cos θ everywhere (of 1
 *   on the axis): a little dim toward the edge, a little bright near the axis.
 * - **A tube** (a capsule) glows all round: a point light of L × its side-on
 *   area (2r·length + πr²) / π.
 *
 * Its size reads in metres:
 * - a rectangle's is its width (along `tangent`) by its height;
 * - a disk's is its diameter;
 * - a tube's is its length (along `tangent`) by its diameter.
 *
 * A rectangle and a disk glow from the face that `direction` points out of. A
 * tube glows from every side.
 */

import type { SceneLight } from "./meshRasterizer";

/** An area light's shape. */
export type AreaShape = "rect" | "disk" | "tube";

/** The smallest size an area light keeps, so it never degenerates (1 cm). */
export const MIN_AREA_SIZE = 0.01;

/** An area light's size, each side held to at least {@link MIN_AREA_SIZE}: rect width × height, disk diameter (twice), tube length × diameter. */
export function areaSize(light: Pick<SceneLight, "shape" | "size">): readonly [number, number] {
  const [w, h] = light.size ?? [1, 0.5];
  const width = Math.max(MIN_AREA_SIZE, w);
  if (light.shape === "disk") return [width, width];
  return [width, Math.max(MIN_AREA_SIZE, h)];
}

/** The area of an area light's glowing surface as seen face-on (side-on, for a tube), m². */
export function areaOf(light: Pick<SceneLight, "shape" | "size">): number {
  const [w, h] = areaSize(light);
  if (light.shape === "disk") return (Math.PI * w * w) / 4;
  if (light.shape === "tube") return w * h + (Math.PI * h * h) / 4;
  return w * h;
}

/** The punctual light an area light is from far off, for the renderers that don't shade area lights; any other light as it is. */
export function areaAsPunctual(light: SceneLight): SceneLight {
  if (light.kind !== "area") return light;
  const { shape, size: _size, tangent: _tangent, kind: _kind, ...rest } = light;
  const intensity = (light.intensity * areaOf(light)) / Math.PI;
  const base = { ...rest, position: light.position ?? [0, 0, 0], intensity, falloff: "inverseSquare" as const };
  if (shape === "tube") {
    const { direction: _direction, ...point } = base;
    return { ...point, kind: "point" };
  }
  return { ...base, kind: "spot", direction: light.direction ?? [0, -1, 0], innerAngle: 0, outerAngle: 89 };
}

/** A unit vector at right angles to `n`, along `t` where it can be (`t` made perpendicular), else any. */
export function perpendicularTo(n: readonly [number, number, number], t: readonly [number, number, number] | undefined): [number, number, number] {
  const along = t ?? (Math.abs(n[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0]);
  const d = along[0] * n[0] + along[1] * n[1] + along[2] * n[2];
  let x = along[0] - n[0] * d;
  let y = along[1] - n[1] * d;
  let z = along[2] - n[2] * d;
  let l = Math.hypot(x, y, z);
  if (l < 1e-4) {
    const other: readonly [number, number, number] = Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 0, 1];
    const e = other[0] * n[0] + other[1] * n[1] + other[2] * n[2];
    x = other[0] - n[0] * e;
    y = other[1] - n[1] * e;
    z = other[2] - n[2] * e;
    l = Math.hypot(x, y, z);
  }
  return [x / l, y / l, z / l];
}

/**
 * An area light's frame: its unit emission direction (`direction`; a tube's is
 * unused), and its unit tangent (a rectangle's width axis, a tube's length), at
 * right angles to it.
 */
export function areaFrame(light: Pick<SceneLight, "direction" | "tangent" | "shape">): { normal: [number, number, number]; tangent: [number, number, number] } {
  const d = light.direction ?? [0, -1, 0];
  const l = Math.hypot(d[0], d[1], d[2]) || 1;
  const normal: [number, number, number] = [d[0] / l, d[1] / l, d[2] / l];
  if (light.shape === "tube") {
    const t = light.tangent ?? [1, 0, 0];
    const tl = Math.hypot(t[0], t[1], t[2]) || 1;
    return { normal, tangent: [t[0] / tl, t[1] / tl, t[2] / tl] };
  }
  return { normal, tangent: perpendicularTo(normal, light.tangent) };
}
