/**
 * Reflections on the AAA tier (AAA_FIDELITY_ROADMAP.md F3f), in place of the
 * I3 mirror march (reflections.ts), which the other tiers keep.
 *
 * - **Hi-Z.** The prepass's depths are copied to an r32float chain whose every
 *   mip holds the nearest depth of the four texels under it (and of the odd
 *   row or column at an edge), so a ray can skip a whole block of the screen
 *   in one step where nothing stands in front of it.
 * - **Trace** (full resolution, one ray a pixel). Each reflective pixel's
 *   normal and roughness come from the G-buffer. Its ray is the view reflected
 *   about a microfacet normal drawn from GGX's distribution of visible normals
 *   (Heitz 2018) for its roughness, turned per pixel and per frame; a mirror's
 *   is the plain reflection. The ray is projected to the screen, where NDC
 *   depth runs linear along it, and walked down and up the Hi-Z chain
 *   (Uludag, GPU Pro 5): up a level past a cell it is wholly in front of, down
 *   a level into one it may pass behind, until at the finest level it passes
 *   behind a surface by no more than a thickness. It takes that pixel's colour,
 *   with a confidence that fades toward the screen's edges, the ray's reach,
 *   rays turning back to the camera, a hit on a surface's back and roughness.
 * - **Off screen** (Epic, with the still scene's BVH): what the screen can't
 *   show is traced through the BVH at half resolution (dynamicGi.ts,
 *   `giReflect`) and lit as the GI lights its hits, so it fills in the rest of
 *   the confidence.
 * - **Denoise.** The trace is blended into a history reprojected through the
 *   velocity buffer, held to the neighbourhood's spread, taking more frames
 *   the rougher the surface; then filtered over a disc that grows with the
 *   roughness, weighted by depth, normal, roughness and each tap's confidence.
 * - **Composite.** As I3's: `colour − confidence · env + confidence · weight ·
 *   hit`, the probes' reflection (F3b) giving way where the trace is sure, and
 *   staying where it isn't — so rough reflections blend into the probes.
 *
 * Both renderers draw the image top row first, so a pixel's NDC is
 * `(2x/w − 1, 1 − 2y/h)`; WebGPU stores depth as z/w, 0 at the near plane.
 */

import type { Mat4 } from "@cartbox/editor";

import { invertMat4 } from "./temporal.js";

/** The longest a reflected ray reaches, in world units. */
export const HIZ_MAX_DISTANCE = 120;
/** How thick the depth buffer's surfaces are taken to be (world units), plus a share of the distance. */
export const HIZ_THICKNESS = 0.3;
/** Rougher surfaces than this keep the probes' reflection alone; the trace fades out from 70% of it. */
export const HIZ_MAX_ROUGHNESS = 0.8;
/** Steps a ray takes through the chain at most. */
export const HIZ_MAX_ITERATIONS = 96;
/** Mips in the chain at most. */
export const HIZ_MAX_LEVELS = 10;
/** Floats in the passes' uniforms: projection, inverse projection, view, params, params2. */
export const HIZ_UNIFORM_FLOATS = 56;

/** The chain's mip count for a frame of `width × height`. */
export function hizLevels(width: number, height: number): number {
  return Math.min(HIZ_MAX_LEVELS, Math.floor(Math.log2(Math.max(1, width, height))) + 1);
}

/**
 * The passes' uniforms for a frame drawn with `view` and `projection` (the
 * jittered one, when temporal), `frame` turning the rays; `levels` in the
 * Hi-Z chain; `traced` when the BVH's half-resolution trace (Epic) is bound;
 * `history` when last frame's accumulation is there to blend into.
 */
export function hizUniforms(view: Mat4, projection: Mat4, frame: number, levels: number, traced: boolean, history: boolean, out: Float32Array<ArrayBuffer> = new Float32Array(HIZ_UNIFORM_FLOATS)): Float32Array<ArrayBuffer> {
  out.set(projection, 0);
  out.set(invertMat4(projection) ?? projection, 16);
  out.set(view, 32);
  out.set([HIZ_MAX_DISTANCE, HIZ_THICKNESS, HIZ_MAX_ROUGHNESS, frame % 1024], 48);
  out.set([levels, traced ? 1 : 0, history ? 1 : 0, HIZ_MAX_ITERATIONS], 52);
  return out;
}

const VS = /* wgsl */ `
@vertex
fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4<f32> {
  let p = vec2<f32>(f32((i << 1u) & 2u), f32(i & 2u));
  return vec4<f32>(p * 2.0 - 1.0, 0.0, 1.0);
}
`;

/** The chain's first level: the depths as r32float. */
export function hizCopyWgsl(multisampled: boolean): string {
  return /* wgsl */ `${VS}
@group(0) @binding(0) var depth: ${multisampled ? "texture_depth_multisampled_2d" : "texture_depth_2d"};
@fragment
fn copyDepth(@builtin(position) frag: vec4<f32>) -> @location(0) vec4<f32> {
  return vec4<f32>(textureLoad(depth, vec2<i32>(frag.xy), 0), 0.0, 0.0, 1.0);
}
`;
}

/** Each further level: the nearest of the texels under it in the level above (bound as that one mip). */
export const HIZ_REDUCE_WGSL = /* wgsl */ `${VS}
@group(0) @binding(0) var above: texture_2d<f32>;
@fragment
fn reduce(@builtin(position) frag: vec4<f32>) -> @location(0) vec4<f32> {
  let size = vec2<i32>(textureDimensions(above));
  let p = vec2<i32>(frag.xy) * 2;
  // An odd row or column at the edge belongs to the last texel, so nothing falls between the cells.
  let ex = select(1, 2, p.x + 3 == size.x);
  let ey = select(1, 2, p.y + 3 == size.y);
  var z = 1.0;
  for (var y = 0; y <= ey; y += 1) {
    for (var x = 0; x <= ex; x += 1) {
      z = min(z, textureLoad(above, min(p + vec2<i32>(x, y), size - 1), 0).r);
    }
  }
  return vec4<f32>(z, 0.0, 0.0, 1.0);
}
`;

const SHARED = /* wgsl */ `
struct Hiz { proj: mat4x4<f32>, invProj: mat4x4<f32>, view: mat4x4<f32>, params: vec4<f32>, params2: vec4<f32> };
@group(0) @binding(0) var<uniform> hz: Hiz;
${VS}
fn octDecode(e: vec2<f32>) -> vec3<f32> {
  var n = vec3<f32>(e.x, e.y, 1.0 - abs(e.x) - abs(e.y));
  let t = max(-n.z, 0.0);
  n.x = n.x + select(t, -t, n.x >= 0.0);
  n.y = n.y + select(t, -t, n.y >= 0.0);
  return normalize(n);
}
// A pixel's position in view space, from a screen point (pixels) and its NDC depth.
fn unproject(s: vec2<f32>, z: f32, size: vec2<f32>) -> vec3<f32> {
  let ndc = vec2<f32>(s.x / size.x * 2.0 - 1.0, 1.0 - s.y / size.y * 2.0);
  let v = hz.invProj * vec4<f32>(ndc, z, 1.0);
  return v.xyz / v.w;
}
`;

/** The trace pass's WGSL: rgb what the ray met, a the confidence in it. */
export const HIZ_TRACE_WGSL = /* wgsl */ `${SHARED}
@group(0) @binding(1) var colour: texture_2d<f32>;
@group(0) @binding(2) var hiz: texture_2d<f32>;
@group(0) @binding(3) var gbuffer: texture_2d<f32>;
@group(0) @binding(4) var reflectMap: texture_2d<f32>;
@group(0) @binding(5) var traced: texture_2d<f32>;

// Where a view-space point lands: pixels (x, y) and NDC depth, w < 0 behind the camera.
fn screenOf(q: vec3<f32>, size: vec2<f32>) -> vec4<f32> {
  let c = hz.proj * vec4<f32>(q, 1.0);
  if (c.w <= 1e-5) { return vec4<f32>(0.0, 0.0, 0.0, -1.0); }
  return vec4<f32>((c.x / c.w * 0.5 + 0.5) * size.x, (0.5 - c.y / c.w * 0.5) * size.y, c.z / c.w, 1.0);
}

// A microfacet normal from GGX's visible normals (Heitz 2018), in the frame where the normal is +z.
fn sampleVndf(Ve: vec3<f32>, alpha: f32, u1: f32, u2: f32) -> vec3<f32> {
  let Vh = normalize(vec3<f32>(alpha * Ve.x, alpha * Ve.y, Ve.z));
  let lensq = Vh.x * Vh.x + Vh.y * Vh.y;
  let T1 = select(vec3<f32>(1.0, 0.0, 0.0), vec3<f32>(-Vh.y, Vh.x, 0.0) / sqrt(max(lensq, 1e-12)), lensq > 1e-12);
  let T2 = cross(Vh, T1);
  let r = sqrt(u1);
  let phi = 6.2831853 * u2;
  let t1 = r * cos(phi);
  let s = 0.5 * (1.0 + Vh.z);
  let t2 = (1.0 - s) * sqrt(max(0.0, 1.0 - t1 * t1)) + s * (r * sin(phi));
  let Nh = t1 * T1 + t2 * T2 + sqrt(max(0.0, 1.0 - t1 * t1 - t2 * t2)) * Vh;
  return normalize(vec3<f32>(alpha * Nh.x, alpha * Nh.y, max(0.0, Nh.z)));
}

@fragment
fn trace(@builtin(position) frag: vec4<f32>) -> @location(0) vec4<f32> {
  let isize = vec2<i32>(textureDimensions(colour));
  let size = vec2<f32>(isize);
  let p = vec2<i32>(frag.xy);
  let refl = textureLoad(reflectMap, p, 0);
  let rough = refl.a;
  let maxRough = hz.params.z;
  var fallback = vec4<f32>(0.0);
  if (hz.params2.y > 0.5) { fallback = vec4<f32>(textureLoad(traced, p / 2, 0).rgb, 1.0); }
  if (max(refl.r, max(refl.g, refl.b)) < 0.002 || rough > maxRough) { return vec4<f32>(0.0); }
  let z0 = textureLoad(hiz, p, 0).r;
  if (z0 >= 1.0) { return vec4<f32>(0.0); }
  let P = unproject(frag.xy, z0, size);
  let rot = mat3x3<f32>(hz.view[0].xyz, hz.view[1].xyz, hz.view[2].xyz);
  var N = normalize(rot * octDecode(textureLoad(gbuffer, p, 0).xy));
  let V = normalize(-P);
  if (dot(N, V) < 0.0) { N = -N; }
  // The ray: the view reflected about a visible microfacet normal for the roughness.
  var H = N;
  let alpha = rough * rough;
  if (alpha > 0.0025) {
    let shift = hz.params.w * 5.588238;
    let u1 = fract(52.9829189 * fract(dot(frag.xy + shift, vec2<f32>(0.06711056, 0.00583715))));
    let u2 = fract(52.9829189 * fract(dot(frag.xy + vec2<f32>(23.0, 71.0) + shift * 1.3, vec2<f32>(0.06711056, 0.00583715))));
    let up = select(vec3<f32>(0.0, 1.0, 0.0), vec3<f32>(1.0, 0.0, 0.0), abs(N.y) > 0.9);
    let T = normalize(cross(up, N));
    let B = cross(N, T);
    let Ve = vec3<f32>(dot(V, T), dot(V, B), dot(V, N));
    let h = sampleVndf(Ve, alpha, u1, u2);
    H = normalize(T * h.x + B * h.y + N * h.z);
  }
  let R = reflect(-V, H);
  if (dot(R, N) <= 0.0) { return fallback; }
  // The ray's end: its reach, or short of the near plane (the camera looks down −z).
  let near = -unproject(size * 0.5, 0.0, size).z;
  var reach = hz.params.x;
  if (R.z > 1e-4) { reach = min(reach, (-near * 1.001 - P.z) / R.z); }
  let s0 = vec4<f32>(frag.xy, z0, 1.0);
  let s1 = screenOf(P + R * reach, size);
  if (s1.w < 0.0) { return fallback; }
  // In screen space NDC depth runs linear along the ray; clip it to the screen.
  var d = s1.xyz - s0.xyz;
  var tEnd = 1.0;
  if (d.x > 1e-4) { tEnd = min(tEnd, (size.x - 0.5 - s0.x) / d.x); }
  if (d.x < -1e-4) { tEnd = min(tEnd, (0.5 - s0.x) / d.x); }
  if (d.y > 1e-4) { tEnd = min(tEnd, (size.y - 0.5 - s0.y) / d.y); }
  if (d.y < -1e-4) { tEnd = min(tEnd, (0.5 - s0.y) / d.y); }
  let span = length(d.xy);
  if (span < 1.0) { return fallback; }
  let levels = i32(hz.params2.x);
  // Off its own pixel before testing.
  var t = 1.5 / span;
  var level = 0;
  var hitT = -1.0;
  let iterations = i32(hz.params2.w);
  for (var i = 0; i < iterations; i += 1) {
    if (t > tEnd) { break; }
    let pos = s0.xyz + d * t;
    let cell = f32(1 << u32(level));
    let c = floor(pos.xy / cell);
    // The ray's leaving this cell: the nearer of its x and y walls.
    var tx = 1e9;
    var ty = 1e9;
    if (abs(d.x) > 1e-6) { tx = ((c.x + select(0.0, 1.0, d.x > 0.0)) * cell - s0.x) / d.x; }
    if (abs(d.y) > 1e-6) { ty = ((c.y + select(0.0, 1.0, d.y > 0.0)) * cell - s0.y) / d.y; }
    let tExit = min(min(tx, ty) + 1e-4 / span, tEnd);
    let mip = vec2<i32>(textureDimensions(hiz, level));
    let zMin = textureLoad(hiz, clamp(vec2<i32>(c), vec2<i32>(0), mip - 1), level).r;
    let zOut = s0.z + d.z * tExit;
    if (max(pos.z, zOut) < zMin) {
      // Wholly in front of everything in the cell: past it, and coarser.
      t = tExit;
      level = min(level + 1, levels - 1);
      continue;
    }
    if (level > 0) { level -= 1; continue; }
    // At the finest level the ray reaches the surface's depth here: in front of it by no more than a thickness?
    let tz = select(t, clamp((zMin - s0.z) / d.z, t, tExit), d.z > 1e-9);
    let at = s0.xyz + d * tz;
    let surface = unproject(at.xy, zMin, size);
    let ray = unproject(at.xy, at.z, size);
    let behind = surface.z - ray.z;
    if (behind > -1e-3 && behind < hz.params.y + 0.01 * length(ray)) { hitT = tz; break; }
    t = tExit;
  }
  if (hitT < 0.0) { return fallback; }
  let hitAt = s0.xyz + d * hitT;
  let hit = clamp(vec2<i32>(hitAt.xy), vec2<i32>(0), isize - 1);
  // A hit on a surface's back shows nothing true.
  let hitN = normalize(rot * octDecode(textureLoad(gbuffer, hit, 0).xy));
  if (dot(hitN, R) > 0.2) { return fallback; }
  let edge = clamp(min(min(hitAt.x, size.x - hitAt.x) / (0.1 * size.x), min(hitAt.y, size.y - hitAt.y) / (0.1 * size.y)), 0.0, 1.0);
  let travelled = length(unproject(hitAt.xy, hitAt.z, size) - P) / hz.params.x;
  let confidence = edge
    * (1.0 - smoothstep(0.7, 1.0, travelled))
    * (1.0 - smoothstep(0.4, 0.9, R.z));
  let seen = textureLoad(colour, hit, 0).rgb;
  if (hz.params2.y > 0.5) { return vec4<f32>(mix(fallback.rgb, seen, confidence), 1.0); }
  return vec4<f32>(seen, confidence);
}
`;

/** The accumulation pass's WGSL: the trace blended into the history reprojected through the velocity buffer. */
export const HIZ_TEMPORAL_WGSL = /* wgsl */ `${SHARED}
@group(0) @binding(1) var current: texture_2d<f32>;
@group(0) @binding(2) var history: texture_2d<f32>;
@group(0) @binding(3) var velocity: texture_2d<f32>;
@group(0) @binding(4) var reflectMap: texture_2d<f32>;
@group(0) @binding(5) var linearSamp: sampler;

fn toneMap(c: vec4<f32>) -> vec4<f32> { return vec4<f32>(c.rgb / (1.0 + max(c.r, max(c.g, c.b))), c.a); }
fn untoneMap(c: vec4<f32>) -> vec4<f32> { return vec4<f32>(c.rgb / max(1e-5, 1.0 - max(c.r, max(c.g, c.b))), c.a); }

@fragment
fn accumulate(@builtin(position) frag: vec4<f32>) -> @location(0) vec4<f32> {
  let size = vec2<i32>(textureDimensions(current));
  let p = vec2<i32>(frag.xy);
  // Tone mapped (Karis), so one bright hit neither rules the average nor flickers.
  let now = toneMap(textureLoad(current, p, 0));
  var m1 = vec4<f32>(0.0);
  var m2 = vec4<f32>(0.0);
  for (var y = -1; y <= 1; y += 1) {
    for (var x = -1; x <= 1; x += 1) {
      let s = toneMap(textureLoad(current, clamp(p + vec2<i32>(x, y), vec2<i32>(0), size - 1), 0));
      m1 = m1 + s;
      m2 = m2 + s * s;
    }
  }
  let mean = m1 / 9.0;
  let spread = sqrt(max(m2 / 9.0 - mean * mean, vec4<f32>(0.0)));
  let uv = (vec2<f32>(p) + 0.5) / vec2<f32>(size) - textureLoad(velocity, p, 0).xy;
  if (hz.params2.z < 0.5 || any(uv < vec2<f32>(0.0)) || any(uv > vec2<f32>(1.0))) { return untoneMap(now); }
  let then = toneMap(textureSampleLevel(history, linearSamp, uv, 0.0));
  let rough = textureLoad(reflectMap, p, 0).a;
  // Rougher surfaces are noisier and change less with the view: they keep more frames, and a wider box.
  let gamma = mix(1.0, 2.5, smoothstep(0.05, 0.5, rough));
  let held = clamp(then, min(mean - gamma * spread, now), max(mean + gamma * spread, now));
  let blend = mix(0.3, 0.06, smoothstep(0.05, 0.5, rough));
  return untoneMap(mix(held, now, blend));
}
`;

/** The resolve's WGSL: the accumulation filtered by roughness, then laid over the frame in place of the probes' reflection. */
export const HIZ_RESOLVE_WGSL = /* wgsl */ `${SHARED}
@group(0) @binding(1) var colour: texture_2d<f32>;
@group(0) @binding(2) var accumulated: texture_2d<f32>;
@group(0) @binding(3) var hiz: texture_2d<f32>;
@group(0) @binding(4) var gbuffer: texture_2d<f32>;
@group(0) @binding(5) var reflectMap: texture_2d<f32>;
@group(0) @binding(6) var envMap: texture_2d<f32>;

const TAPS = array<vec2<f32>, 8>(
  vec2<f32>(-0.326, -0.406), vec2<f32>(-0.840, -0.074), vec2<f32>(-0.696, 0.457), vec2<f32>(-0.203, 0.621),
  vec2<f32>(0.962, -0.195), vec2<f32>(0.473, -0.480), vec2<f32>(0.519, 0.767), vec2<f32>(0.185, -0.893),
);

@fragment
fn resolve(@builtin(position) frag: vec4<f32>) -> @location(0) vec4<f32> {
  let isize = vec2<i32>(textureDimensions(colour));
  let size = vec2<f32>(isize);
  let p = vec2<i32>(frag.xy);
  let c = textureLoad(colour, p, 0);
  let refl = textureLoad(reflectMap, p, 0);
  let w = refl.rgb;
  let rough = refl.a;
  if (max(w.r, max(w.g, w.b)) < 0.002 || rough > hz.params.z) { return c; }
  let z = textureLoad(hiz, p, 0).r;
  let P = unproject(frag.xy, z, size);
  let N = octDecode(textureLoad(gbuffer, p, 0).xy);
  var sum = textureLoad(accumulated, p, 0);
  var rgb = sum.rgb * sum.a;
  var conf = sum.a;
  var total = 1.0;
  // A disc that grows with the roughness, turned per pixel.
  let radius = min(rough * 14.0, 7.0);
  if (radius >= 0.75) {
    let spin = 6.2831853 * fract(52.9829189 * fract(dot(frag.xy, vec2<f32>(0.06711056, 0.00583715))));
    let cs = vec2<f32>(cos(spin), sin(spin));
    for (var k = 0; k < 8; k += 1) {
      let o = TAPS[k];
      let q = clamp(vec2<i32>(frag.xy + vec2<f32>(o.x * cs.x - o.y * cs.y, o.x * cs.y + o.y * cs.x) * radius), vec2<i32>(0), isize - 1);
      let qz = textureLoad(hiz, q, 0).r;
      if (qz >= 1.0) { continue; }
      let Q = unproject(vec2<f32>(q) + 0.5, qz, size);
      let near = exp(-abs(Q.z - P.z) / (0.02 * abs(P.z) + 0.02));
      let facing = pow(max(dot(octDecode(textureLoad(gbuffer, q, 0).xy), N), 0.0), 16.0);
      let alike = exp(-abs(textureLoad(reflectMap, q, 0).a - rough) * 8.0);
      let s = textureLoad(accumulated, q, 0);
      let wt = near * facing * alike;
      rgb = rgb + s.rgb * s.a * wt;
      conf = conf + s.a * wt;
      total = total + wt;
    }
  }
  let L = rgb / max(conf, 1e-4);
  let confidence = clamp(conf / total, 0.0, 1.0) * (1.0 - smoothstep(hz.params.z * 0.7, hz.params.z, rough));
  let env = textureLoad(envMap, p, 0).rgb;
  return vec4<f32>(max(c.rgb + confidence * (w * L - env), vec3<f32>(0.0)), c.a);
}
`;
