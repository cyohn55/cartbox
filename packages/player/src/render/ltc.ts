/**
 * Area lights shaded with linearly transformed cosines on the AAA tier
 * (AAA_FIDELITY_ROADMAP.md F2e-2; Heitz, Dupuy, Hill and Neubelt, "Real-Time
 * Polygonal-Light Shading with Linearly Transformed Cosines", 2016).
 *
 * A clamped cosine integrates over a polygon in closed form: the polygon's
 * edges, projected onto the unit sphere, sum to a vector form factor whose
 * height is the cosine-weighted solid angle when the polygon is wholly above
 * the horizon. When it dips below, Heitz's clipped-sphere approximation of the
 * horizon takes its length and height instead. The lobe always takes the
 * sphere, as its tables were fitted to be read: read exactly, it comes out up
 * to 23% off a brute-force integral. A linear transform turns
 * that cosine into a GGX lobe. So transforming the polygon by the lobe's
 * inverse, looked up in a fitted table by roughness and N·V, integrates the
 * lobe over the light as exactly as the fit allows.
 *
 * - **The diffuse** is the polygon's form factor in the shading point's frame
 *   (the transform is the identity), times the albedo, times the luminance.
 *   The renderer's diffuse carries no 1/π, and a form factor is already over π.
 * - **The specular** is the lobe's integral, scaled by the fitted norm and
 *   Fresnel terms, (f0·n + (1 − f0)·f), as Karis splits them.
 * - **The shapes.**
 *   - A rectangle is its four corners.
 *   - A disk is an area-matched octagon, which is within a few percent of the
 *     circle at any distance a light is seen from.
 *   - A tube is the rectangle that faces the point: its length plus a cap's
 *     worth (πr/4 a side) by its diameter. That holds its side-on area.
 *
 * Corners go clockwise as the lit side sees them. In the shading point's frame
 * (T1 toward V, T2 = N × T1, N), right-handed, that puts the polygon's form
 * factor up the normal, as the clipped sphere wants. This module mirrors the
 * WGSL in {@link ltcWgsl} on the CPU, so the tests can hold one to the other
 * and both to a brute-force integral.
 */

import { areaFrame, areaSize, type SceneLight } from "@cartbox/editor";

import { LTC_1, LTC_2, LTC_SIZE } from "./ltcTables.js";

type V3 = [number, number, number];

/** Light kinds as the packed record's d0.w reads them: 3 rectangle, 4 disk, 5 tube. */
export const AREA_KIND: Record<"rect" | "disk" | "tube", number> = { rect: 3, disk: 4, tube: 5 };
/** How far out a disk's octagon reaches: its area is the disk's. */
export const DISK_OCTAGON_SCALE = Math.sqrt(Math.PI / (2 * Math.SQRT2));

function halfToFloat(h: number): number {
  const s = h & 0x8000 ? -1 : 1;
  const e = (h >> 10) & 0x1f;
  const f = h & 0x3ff;
  if (e === 0) return s * f * 2 ** -24;
  if (e === 31) return f ? NaN : s * Infinity;
  return s * (1 + f / 1024) * 2 ** (e - 15);
}

function decodeHalves(text: string): Float32Array {
  const bytes = atob(text);
  const out = new Float32Array(bytes.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = halfToFloat(bytes.charCodeAt(2 * i) | (bytes.charCodeAt(2 * i + 1) << 8));
  return out;
}

let tables: Float32Array | null = null;

/** Both tables as the shader reads them: `LTC_SIZE²` vec4s of the inverse transform, then as many of the norm and Fresnel. */
export function ltcTables(): Float32Array {
  if (tables) return tables;
  const out = new Float32Array(2 * LTC_SIZE * LTC_SIZE * 4);
  out.set(decodeHalves(LTC_1), 0);
  out.set(decodeHalves(LTC_2), LTC_SIZE * LTC_SIZE * 4);
  tables = out;
  return out;
}

/** One table's entry at N·V and perceptual roughness, bilinearly between texel centres: `which` 0 the transform, 1 the norm and Fresnel. */
export function ltcAt(lut: Float32Array, which: 0 | 1, ndv: number, rough: number): [number, number, number, number] {
  const n = LTC_SIZE;
  const x = Math.min(n - 1, Math.max(0, rough * (n - 1)));
  const y = Math.min(n - 1, Math.max(0, Math.sqrt(Math.max(0, 1 - ndv)) * (n - 1)));
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(x0 + 1, n - 1);
  const y1 = Math.min(y0 + 1, n - 1);
  const fx = x - x0;
  const fy = y - y0;
  const base = which * n * n * 4;
  const at = (cx: number, cy: number, k: number) => lut[base + (cy * n + cx) * 4 + k]!;
  const out: [number, number, number, number] = [0, 0, 0, 0];
  for (let k = 0; k < 4; k += 1) {
    const top = at(x0, y0, k) + (at(x1, y0, k) - at(x0, y0, k)) * fx;
    const bottom = at(x0, y1, k) + (at(x1, y1, k) - at(x0, y1, k)) * fx;
    out[k] = top + (bottom - top) * fy;
  }
  return out;
}

const dot = (a: readonly number[], b: readonly number[]) => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
const cross = (a: readonly number[], b: readonly number[]): V3 => [a[1]! * b[2]! - a[2]! * b[1]!, a[2]! * b[0]! - a[0]! * b[2]!, a[0]! * b[1]! - a[1]! * b[0]!];
const normalize = (a: readonly number[]): V3 => {
  const l = Math.hypot(a[0]!, a[1]!, a[2]!) || 1;
  return [a[0]! / l, a[1]! / l, a[2]! / l];
};

/**
 * An area light's polygon as `point` sees it, its corners clockwise from the lit
 * side. Null when the point is behind a rectangle's or disk's lit face.
 */
export function areaPolygon(light: SceneLight, point: readonly [number, number, number]): V3[] | null {
  const c = light.position ?? [0, 0, 0];
  const [w, h] = areaSize(light);
  const frame = areaFrame(light);
  const toPoint: V3 = [point[0] - c[0], point[1] - c[1], point[2] - c[2]];
  let normal = frame.normal;
  let tangent = frame.tangent;
  let hw = w / 2;
  const hh = h / 2;
  if (light.shape === "tube") {
    // The rectangle through the tube's axis that faces the point.
    const a = frame.tangent;
    const along = dot(toPoint, a);
    const off: V3 = [toPoint[0] - a[0] * along, toPoint[1] - a[1] * along, toPoint[2] - a[2] * along];
    normal = Math.hypot(...off) > 1e-5 ? normalize(off) : normalize(cross(a, Math.abs(a[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0]));
    tangent = a;
    hw = w / 2 + (Math.PI * h) / 8;
  } else if (dot(toPoint, normal) <= 0) {
    return null;
  }
  const bitangent = cross(normal, tangent);
  const corner = (x: number, y: number): V3 => [
    c[0] + tangent[0] * x + bitangent[0] * y,
    c[1] + tangent[1] * x + bitangent[1] * y,
    c[2] + tangent[2] * x + bitangent[2] * y,
  ];
  if (light.shape === "disk") {
    const r = hw * DISK_OCTAGON_SCALE;
    return Array.from({ length: 8 }, (_, k) => corner(r * Math.cos((-k * Math.PI) / 4), r * Math.sin((-k * Math.PI) / 4)));
  }
  return [corner(-hw, -hh), corner(-hw, hh), corner(hw, hh), corner(hw, -hh)];
}

/** An edge's share of the vector form factor (the rational fit to θ / sin θ, three.js's). */
function edgeFactor(v1: V3, v2: V3): V3 {
  const x = dot(v1, v2);
  const y = Math.abs(x);
  const a = 0.8543985 + (0.4965155 + 0.0145206 * y) * y;
  const b = 3.417594 + (4.1616724 + y) * y;
  const v = a / b;
  const thetaSinTheta = x > 0 ? v : 0.5 / Math.sqrt(Math.max(1 - x * x, 1e-7)) - v;
  const c = cross(v1, v2);
  return [c[0] * thetaSinTheta, c[1] * thetaSinTheta, c[2] * thetaSinTheta];
}

/**
 * The polygon's integral against a clamped cosine transformed by `m` (row-major
 * 3×3, in the frame (T1, T2, N) about `point`), with the horizon clipped by
 * Heitz's sphere: 0 to 1, the share of a cosine lobe's energy the polygon holds.
 */
export function ltcIntegrate(corners: readonly V3[], point: readonly number[], frame: readonly [V3, V3, V3], m: readonly number[] | null, exact = false): number {
  const local = corners.map((p) => {
    const d = [p[0] - point[0]!, p[1] - point[1]!, p[2] - point[2]!];
    const f: V3 = [dot(frame[0], d), dot(frame[1], d), dot(frame[2], d)];
    return normalize(m ? [m[0]! * f[0] + m[1]! * f[1] + m[2]! * f[2], m[3]! * f[0] + m[4]! * f[1] + m[5]! * f[2], m[6]! * f[0] + m[7]! * f[1] + m[8]! * f[2]] : f);
  });
  const sum: V3 = [0, 0, 0];
  let lowest = Infinity;
  for (let i = 0; i < local.length; i += 1) {
    lowest = Math.min(lowest, local[i]![2]);
    const e = edgeFactor(local[(i + local.length - 1) % local.length]!, local[i]!);
    sum[0] += e[0];
    sum[1] += e[1];
    sum[2] += e[2];
  }
  // Wholly above the horizon the form factor is the vector's height, exactly (the diffuse); else, and for the
  // lobe, whose tables were fitted to be read so, Heitz's clipped sphere.
  if (exact && lowest >= 0) return Math.max(sum[2], 0);
  const l = Math.hypot(...sum);
  return Math.max((l * l + sum[2]) / (l + 1), 0);
}

/** The shading frame about N with T1 toward V: (T1, N × T1, N). */
export function shadingFrame(n: readonly number[], v: readonly number[]): [V3, V3, V3] {
  const N = normalize(n);
  const d = dot(v, N);
  let t1: V3 = [v[0]! - N[0] * d, v[1]! - N[1] * d, v[2]! - N[2] * d];
  if (Math.hypot(...t1) < 1e-4) t1 = Math.abs(N[1]) < 0.9 ? cross([0, 1, 0], N) : cross([1, 0, 0], N);
  t1 = normalize(t1);
  return [t1, cross(N, t1), N];
}

/**
 * An area light's diffuse and specular form factors at a point (CPU mirror of
 * the shader's): `diffuse` the polygon's cosine-weighted share, `spec` the
 * GGX lobe's, before its norm and Fresnel, and those two terms.
 */
export function areaFactors(
  light: SceneLight,
  point: readonly [number, number, number],
  normal: readonly number[],
  view: readonly number[],
  roughness: number,
): { diffuse: number; spec: number; norm: number; fresnel: number } {
  const corners = areaPolygon(light, point);
  if (!corners) return { diffuse: 0, spec: 0, norm: 0, fresnel: 0 };
  const frame = shadingFrame(normal, view);
  const ndv = Math.max(1e-4, dot(normalize(normal), normalize(view)));
  const lut = ltcTables();
  const t1 = ltcAt(lut, 0, ndv, roughness);
  const t2 = ltcAt(lut, 1, ndv, roughness);
  // M⁻¹ = [[a, 0, b], [0, 1, 0], [c, 0, d]] (three.js's column-major mat3(t1.x, 0, t1.y; 0, 1, 0; t1.z, 0, t1.w)).
  const mInv = [t1[0], 0, t1[2], 0, 1, 0, t1[1], 0, t1[3]];
  return { diffuse: ltcIntegrate(corners, point, frame, null, true), spec: ltcIntegrate(corners, point, frame, mInv), norm: t2[0], fresnel: t2[1] };
}

/**
 * The WGSL the linear-light shader declares: the tables' binding, and
 * `areaTerm`, an area light's direct light (the packed record's d0.w 3, 4 or 5).
 * It reads `lgt.d4.xyz` as the tangent, and needs `kdm`, `albedo`, `f0`, `eComp`
 * as the scene shader has them.
 */
export function ltcWgsl(group: number, binding: number): string {
  const n = LTC_SIZE;
  return /* wgsl */ `
// The linearly transformed cosines' tables (F2e-2, ltc.ts): the inverse transform, then norm and Fresnel.
@group(${group}) @binding(${binding}) var<storage, read> ltcLut: array<vec4<f32>>;
fn ltcAt(which: u32, ndv: f32, rough: f32) -> vec4<f32> {
  let x = clamp(rough * ${n - 1}.0, 0.0, ${n - 1}.0);
  let y = clamp(sqrt(max(0.0, 1.0 - ndv)) * ${n - 1}.0, 0.0, ${n - 1}.0);
  let x0 = u32(x);
  let y0 = u32(y);
  let x1 = min(x0 + 1u, ${n - 1}u);
  let y1 = min(y0 + 1u, ${n - 1}u);
  let fx = x - f32(x0);
  let fy = y - f32(y0);
  let b = which * ${n * n}u;
  let top = mix(ltcLut[b + y0 * ${n}u + x0], ltcLut[b + y0 * ${n}u + x1], fx);
  let bottom = mix(ltcLut[b + y1 * ${n}u + x0], ltcLut[b + y1 * ${n}u + x1], fx);
  return mix(top, bottom, fy);
}
fn ltcEdge(v1: vec3<f32>, v2: vec3<f32>) -> vec3<f32> {
  let x = dot(v1, v2);
  let y = abs(x);
  let a = 0.8543985 + (0.4965155 + 0.0145206 * y) * y;
  let b = 3.417594 + (4.1616724 + y) * y;
  let v = a / b;
  let ts = select(0.5 * inverseSqrt(max(1.0 - x * x, 1e-7)) - v, v, x > 0.0);
  return cross(v1, v2) * ts;
}
// The polygon (count corners, P-relative) through mat, onto the sphere, its form factor with the horizon clipped.
fn ltcIntegrate(mat: mat3x3<f32>, rel: array<vec3<f32>, 8>, count: i32, exact: bool) -> f32 {
  var f = vec3<f32>(0.0);
  var prev = normalize(mat * rel[count - 1]);
  var lowest = prev.z;
  for (var i = 0; i < count; i = i + 1) {
    let c = normalize(mat * rel[i]);
    f = f + ltcEdge(prev, c);
    prev = c;
    lowest = min(lowest, c.z);
  }
  // Wholly above the horizon the form factor is the vector's height, exactly (the diffuse); else, and for the
  // lobe, whose tables were fitted to be read so, Heitz's clipped sphere.
  if (exact && lowest >= 0.0) { return max(f.z, 0.0); }
  let l = length(f);
  return max((l * l + f.z) / (l + 1.0), 0.0);
}
fn areaTerm(lgt: Light, P: vec3<f32>, N: vec3<f32>, V: vec3<f32>, ndv: f32, rough: f32, f0: vec3<f32>, kdm: f32, albedo: vec3<f32>) -> vec3<f32> {
  let C = lgt.d0.xyz;
  let kind = i32(lgt.d0.w + 0.5);
  let toP = P - C;
  var nrm = lgt.d3.xyz;
  let tan = lgt.d4.xyz;
  var hw = lgt.d2.y;
  let hh = lgt.d2.z;
  if (kind == 5) {
    // A tube: the rectangle through its axis that faces the point, a cap's worth longer each end.
    let off = toP - tan * dot(toP, tan);
    nrm = select(normalize(cross(tan, select(vec3<f32>(1.0, 0.0, 0.0), vec3<f32>(0.0, 1.0, 0.0), abs(tan.y) < 0.9))), normalize(off), length(off) > 1e-5);
    hw = hw + 0.78539816 * hh;
  } else if (dot(toP, nrm) <= 0.0) {
    return vec3<f32>(0.0);
  }
  let bt = cross(nrm, tan);
  var rel: array<vec3<f32>, 8>;
  var count = 4;
  if (kind == 4) {
    // A disk: the octagon of its area, clockwise from the lit side.
    let r = hw * ${DISK_OCTAGON_SCALE.toFixed(7)};
    for (var k = 0; k < 8; k = k + 1) {
      let a = -f32(k) * 0.78539816;
      rel[k] = C + tan * (r * cos(a)) + bt * (r * sin(a)) - P;
    }
    count = 8;
  } else {
    rel[0] = C - tan * hw - bt * hh - P;
    rel[1] = C - tan * hw + bt * hh - P;
    rel[2] = C + tan * hw + bt * hh - P;
    rel[3] = C + tan * hw - bt * hh - P;
  }
  // The shading frame: T1 toward V, T2 = N × T1, N (as rows, world into it).
  var t1 = V - N * dot(V, N);
  if (length(t1) < 1e-4) { t1 = cross(select(vec3<f32>(1.0, 0.0, 0.0), vec3<f32>(0.0, 1.0, 0.0), abs(N.y) < 0.9), N); }
  t1 = normalize(t1);
  let frameT = transpose(mat3x3<f32>(t1, cross(N, t1), N));
  let m1 = ltcAt(0u, ndv, rough);
  let m2 = ltcAt(1u, ndv, rough);
  // M⁻¹ by columns: (a, 0, b), (0, 1, 0), (c, 0, d) for the table's (a, b, c, d).
  let mInv = mat3x3<f32>(vec3<f32>(m1.x, 0.0, m1.y), vec3<f32>(0.0, 1.0, 0.0), vec3<f32>(m1.z, 0.0, m1.w));
  let diffuse = ltcIntegrate(frameT, rel, count, true);
  let spec = ltcIntegrate(mInv * frameT, rel, count, false);
  let Fs = f0 * m2.x + (vec3<f32>(1.0) - f0) * m2.y;
  // The diffuse under the Fresnel the view sees (Schlick at N·V).
  let Fv = f0 + (vec3<f32>(1.0) - f0) * pow(1.0 - ndv, 5.0);
  return (kdm * (vec3<f32>(1.0) - Fv) * albedo * diffuse + Fs * spec * eComp) * toLinear(lgt.d1.rgb) * lgt.d1.w;
}
`;
}
