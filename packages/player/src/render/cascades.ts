/**
 * The sun's shadow cascades on the AAA tier (AAA_FIDELITY_ROADMAP.md F2a):
 * the view frustum cut into slices by practical (log-linear) splits, each
 * slice shadowed by its own orthographic map from the sun, rendered on the
 * GPU. The CPU shadow rasteriser of the other tiers stops at one map and a
 * near cascade, at most 1024² each.
 *
 * - **Stable as the camera turns.** Each cascade covers the bounding sphere of
 *   its slice, whose size depends only on the slice's depths and the lens, so
 *   turning the camera never resizes a cascade (which would make every edge
 *   crawl).
 * - **Stable as the camera moves.** The sphere's centre is snapped to the
 *   cascade's texel grid in the light's frame, so a shadow edge moves only by
 *   whole texels and never shimmers.
 * - **Casters behind the slice.** Each light's near plane is backed off by
 *   `reach`, so what stands between the sun and the slice (a tower beyond the
 *   view) still casts into it.
 *
 * Depth is WebGPU's, 0 at the light and 1 at its far plane, so the maps are
 * rendered and compared without remapping.
 */

import { viewMatrix } from "@cartbox/editor";

type Mat4 = Float64Array;
type Vec3 = readonly [number, number, number];

/** Cascades the AAA tier renders (F2a). */
export const CASCADE_COUNT = 4;

/** How far toward a logarithmic split the practical scheme leans (Nvidia's, PSSM): 0 linear, 1 logarithmic. */
export const CASCADE_LAMBDA = 0.75;

/** The share of each cascade, at its outer edge, that fades into the next. */
export const CASCADE_BLEND = 0.1;

/** One cascade: the world → light-clip transform, the view depth it covers to, and the world size of one of its texels. */
export interface Cascade {
  /** Column-major world → light clip; x, y in −1..1 over the cascade, z (depth) in 0..1. */
  readonly viewProj: Mat4;
  /** The view depth this cascade's slice ends at. */
  readonly far: number;
  /** One texel's edge, in world units (for normal-offset bias). */
  readonly texel: number;
}

/**
 * The practical split of `near`..`far` into `count` slices (Zhang et al.,
 * "Parallel-Split Shadow Maps"): each split `lambda` of the way from the
 * uniform split to the logarithmic one. Returns each slice's far depth.
 */
export function cascadeSplits(near: number, far: number, count = CASCADE_COUNT, lambda = CASCADE_LAMBDA): number[] {
  const n = Math.max(1e-3, near);
  const f = Math.max(n * 1.001, far);
  const out: number[] = [];
  for (let i = 1; i <= count; i += 1) {
    const t = i / count;
    out.push(lambda * n * (f / n) ** t + (1 - lambda) * (n + (f - n) * t));
  }
  out[count - 1] = f;
  return out;
}

/** A GL-style perspective projection's near and far planes and the tangents of its half-angles. */
export function perspectiveLens(projection: Mat4): { near: number; far: number; tanX: number; tanY: number } {
  const p10 = projection[10]!;
  const p14 = projection[14]!;
  return { near: p14 / (p10 - 1), far: p14 / (p10 + 1), tanX: 1 / projection[0]!, tanY: 1 / projection[5]! };
}

/**
 * The bounding sphere of the view slice from depth `d0` to `d1`, in view
 * space: its centre's depth along the view axis, and its radius. It depends
 * on the depths and the lens alone, never on where the camera looks.
 */
export function sliceSphere(d0: number, d1: number, tanX: number, tanY: number): { depth: number; radius: number } {
  // The slice's corners lie at distance² (d·k)² + d² from the axis point at depth d, with k² = tanX² + tanY².
  const k2 = tanX * tanX + tanY * tanY;
  // The centre c on the axis equidistant from a near and a far corner (clamped into the slice).
  const c = Math.min(d1, Math.max(d0, ((d1 * d1 - d0 * d0) * (1 + k2)) / (2 * (d1 - d0))));
  const near = Math.hypot(d0 * Math.sqrt(k2), c - d0);
  const far = Math.hypot(d1 * Math.sqrt(k2), d1 - c);
  return { depth: c, radius: Math.max(near, far) };
}

/** The camera's world position and forward axis, from a view matrix. */
function cameraFrame(view: Mat4): { eye: [number, number, number]; forward: [number, number, number] } {
  // view = [R | −R·eye]: the rows of R are the camera's axes; forward is −Z.
  const r = (i: number, j: number) => view[j * 4 + i]!;
  const t = [view[12]!, view[13]!, view[14]!];
  const eye: [number, number, number] = [0, 1, 2].map((j) => -(r(0, j) * t[0]! + r(1, j) * t[1]! + r(2, j) * t[2]!)) as [number, number, number];
  return { eye, forward: [-r(2, 0), -r(2, 1), -r(2, 2)] };
}

function normalize(v: Vec3): [number, number, number] {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}

/** WebGPU's orthographic projection: x, y in −r..r to −1..1, view depth 0..`far` to 0..1. */
function orthographic(r: number, far: number): Mat4 {
  return Float64Array.from([1 / r, 0, 0, 0, 0, 1 / r, 0, 0, 0, 0, -1 / far, 0, 0, 0, 0, 1]);
}

function multiply(a: Mat4, b: Mat4): Mat4 {
  const out = new Float64Array(16);
  for (let c = 0; c < 4; c += 1) {
    for (let r = 0; r < 4; r += 1) {
      let s = 0;
      for (let k = 0; k < 4; k += 1) s += a[k * 4 + r]! * b[c * 4 + k]!;
      out[c * 4 + r] = s;
    }
  }
  return out;
}

/**
 * Fit `count` cascades of `size`² texels to the camera (`view`, a GL-style
 * perspective `projection`) for a sun shining from `toLight`, out to
 * `distance` from the camera, each light backed off `reach` beyond its slice
 * for the casters between it and the sun.
 */
export function fitCascades(options: {
  readonly view: Mat4;
  readonly projection: Mat4;
  readonly toLight: Vec3;
  readonly distance: number;
  readonly size: number;
  readonly reach: number;
  readonly count?: number;
  readonly lambda?: number;
}): Cascade[] {
  const count = options.count ?? CASCADE_COUNT;
  const lens = perspectiveLens(options.projection);
  const far = Math.min(lens.far, options.distance);
  const splits = cascadeSplits(lens.near, far, count, options.lambda ?? CASCADE_LAMBDA);
  const { eye, forward } = cameraFrame(options.view);
  const l = normalize(options.toLight);
  const up: Vec3 = Math.abs(l[1]) > 0.99 ? [0, 0, 1] : [0, 1, 0];
  // The light's rotation alone (at the origin), for snapping centres to its texel grid.
  const rotation = viewMatrix([l[0], l[1], l[2]], [0, 0, 0], up);
  const out: Cascade[] = [];
  let d0 = lens.near;
  for (const d1 of splits) {
    const sphere = sliceSphere(d0, d1, lens.tanX, lens.tanY);
    // A radius rounded up to a whole number of texel steps' worth keeps a cascade's size fixed against float noise.
    const radius = Math.ceil(sphere.radius * 16) / 16;
    const texel = (2 * radius) / options.size;
    const centre = [0, 1, 2].map((i) => eye[i]! + forward[i]! * sphere.depth);
    // Into the light's frame, snapped to whole texels across it, and back.
    const lx = rotation[0]! * centre[0]! + rotation[4]! * centre[1]! + rotation[8]! * centre[2]!;
    const ly = rotation[1]! * centre[0]! + rotation[5]! * centre[1]! + rotation[9]! * centre[2]!;
    const lz = rotation[2]! * centre[0]! + rotation[6]! * centre[1]! + rotation[10]! * centre[2]!;
    const sx = Math.round(lx / texel) * texel;
    const sy = Math.round(ly / texel) * texel;
    // R is orthonormal: its transpose takes the snapped point back to world space.
    const snapped: [number, number, number] = [0, 1, 2].map((j) => rotation[j * 4]! * sx + rotation[j * 4 + 1]! * sy + rotation[j * 4 + 2]! * lz) as [number, number, number];
    const back = radius + options.reach;
    const lightEye: [number, number, number] = [snapped[0] + l[0] * back, snapped[1] + l[1] * back, snapped[2] + l[2] * back];
    const view = viewMatrix(lightEye, snapped, up);
    out.push({ viewProj: multiply(orthographic(radius, back + radius), view), far: d1, texel });
    d0 = d1;
  }
  return out;
}

/**
 * The cascades' test in WGSL (the linear-light scene shader's; reads `frame`,
 * `u.light`, `cascadeMap` and `cascadeSamp`). The point is tested in the
 * first cascade whose map holds it, pushed toward the sun by a texel or more
 * as the light grazes so a surface never shadows itself, and filtered over a
 * 3×3 grid of hardware comparisons (each itself a bilinear 2×2). Toward a
 * cascade's edge it fades into the next, and past the last into full light.
 */
export const CASCADE_SHADOW_WGSL = /* wgsl */ `
fn cascadeTest(i: i32, p: vec3<f32>, cosL: f32) -> f32 {
  let c = clamp(cosL, 0.05, 1.0);
  let push = frame.cascadeTexel[i] * (1.0 + 2.0 * min(4.0, sqrt(1.0 - c * c) / c));
  let q = frame.cascadeVp[i] * vec4<f32>(p + normalize(u.light.xyz) * push, 1.0);
  let uv = vec2<f32>(q.x * 0.5 + 0.5, 0.5 - q.y * 0.5);
  let step = 1.0 / frame.cascadeInfo.y;
  var lit = 0.0;
  for (var y = -1; y <= 1; y = y + 1) {
    for (var x = -1; x <= 1; x = x + 1) {
      lit = lit + textureSampleCompareLevel(cascadeMap, cascadeSamp, uv + vec2<f32>(f32(x), f32(y)) * step, i, q.z);
    }
  }
  return lit / 9.0;
}
fn cascadeShadow(p: vec3<f32>, cosL: f32) -> f32 {
  let inner = 1.0 - 2.0 / frame.cascadeInfo.y;
  for (var i = 0; i < ${CASCADE_COUNT}; i = i + 1) {
    let q = frame.cascadeVp[i] * vec4<f32>(p, 1.0);
    let m = max(abs(q.x), abs(q.y));
    if (m < inner && q.z > 0.0 && q.z < 1.0) {
      var v = cascadeTest(i, p, cosL);
      let edge = inner - ${CASCADE_BLEND};
      if (m > edge) {
        var next = 1.0;
        if (i + 1 < ${CASCADE_COUNT}) { next = cascadeTest(i + 1, p, cosL); }
        v = mix(v, next, (m - edge) / ${CASCADE_BLEND});
      }
      return 1.0 - frame.cascadeInfo.z * (1.0 - v);
    }
  }
  return 1.0;
}
`;
