/**
 * Contact shadows on the AAA tier (AAA_FIDELITY_ROADMAP.md F2c), and the
 * full-resolution resolve of its ambient occlusion (F3c): a short ray
 * marched from each pixel toward the sun across the depth prepass, so what the
 * cascades are too coarse to resolve (feet on a floor, a crate's foot, grass
 * against a wall) still grounds it.
 *
 * The pass runs after the prepass (and GTAO, gtao.ts) and writes one
 * `rgba16float` texel a pixel, which the linear-light scene shader reads in its
 * SSAO slot:
 *
 * - **r**: the ambient occlusion: GTAO's, brought up from half resolution by
 *   the four nearest texels weighted by how near their depths are to this
 *   pixel's; or, without it, the CPU's when a caller hands one over (1
 *   otherwise), so the slot still serves it;
 * - **g**: how much of the sun reaches the pixel past what the march met, 1
 *   (nothing) to 0, which the shader multiplies into the sun's shadow (1 when
 *   the frame has no contact shadows);
 * - **ba**: GTAO's bent normal, octahedron-encoded in world space.
 *
 * A ray steps a fixed length in view space (world units, as the view is
 * rigid), starting a little off its surface and jittered per pixel so the steps
 * band into noise TAA resolves. A step is in shadow when the depth buffer has a
 * surface in front of it by no more than a thickness, so it neither misses a
 * thin caster nor shadows a pixel behind a wall it passes. The term fades out
 * toward the screen's edges, where the depth buffer runs out, and with
 * distance, where the cascades already resolve contact.
 *
 * Both renderers draw the image top row first, so as in reflections.ts a
 * pixel's NDC is `(2x/w − 1, 1 − 2y/h)`.
 */

import type { Mat4 } from "@cartbox/editor";

import { invertMat4 } from "./temporal.js";

/** Steps a contact ray takes toward the sun. */
export const CONTACT_STEPS = 16;
/** How far a contact ray reaches, in world units. */
export const CONTACT_LENGTH = 0.6;
/** How thick the depth buffer's surfaces are taken to be (world units), plus a share of the distance. */
export const CONTACT_THICKNESS = 0.2;
/** Where contact shadows start to fade out, and where they are gone (view distance, world units). */
export const CONTACT_FADE: readonly [number, number] = [30, 50];
/** Floats in the pass's uniforms: projection, inverse projection, the sun, params, params2. */
export const CONTACT_UNIFORM_FLOATS = 44;
/** The resolve's target: AO, contact, and the bent normal (F3c). */
export const SCREEN_SHADING_FORMAT = "rgba16float";

/**
 * The pass's uniforms for a frame drawn with `view` and `projection` (the
 * jittered one, when temporal), lit by a sun toward `toLight` (null: no
 * contact shadows this frame); `ao` says whether a CPU occlusion buffer is
 * bound to carry through, and `gtao` whether GTAO's is there to resolve.
 */
export function contactUniforms(
  view: Mat4,
  projection: Mat4,
  toLight: readonly [number, number, number] | null,
  ao: boolean,
  gtao = false,
  out: Float32Array<ArrayBuffer> = new Float32Array(CONTACT_UNIFORM_FLOATS),
): Float32Array<ArrayBuffer> {
  out.set(projection, 0);
  out.set(invertMat4(projection) ?? projection, 16);
  // The sun's direction in view space (the view's rotation alone), normalised.
  const [x, y, z] = toLight ?? [0, 1, 0];
  const l = [0, 1, 2].map((r) => view[r]! * x + view[4 + r]! * y + view[8 + r]! * z);
  const n = Math.hypot(l[0]!, l[1]!, l[2]!) || 1;
  out.set([l[0]! / n, l[1]! / n, l[2]! / n, toLight ? 1 : 0], 32);
  out.set([CONTACT_LENGTH, CONTACT_THICKNESS, CONTACT_STEPS, ao ? 1 : 0], 36);
  out.set([CONTACT_FADE[0], CONTACT_FADE[1], gtao ? 1 : 0, 0], 40);
  return out;
}

/** The contact pass's WGSL. `multisampled` reads a multisampled depth (its first sample). */
export function contactShaderWgsl(multisampled: boolean): string {
  return /* wgsl */ `
struct Contact { proj: mat4x4<f32>, invProj: mat4x4<f32>, light: vec4<f32>, params: vec4<f32>, params2: vec4<f32> };
@group(0) @binding(0) var<uniform> cs: Contact;
@group(0) @binding(1) var depth: ${multisampled ? "texture_depth_multisampled_2d" : "texture_depth_2d"};
@group(0) @binding(2) var aoMap: texture_2d<f32>;
@group(0) @binding(3) var gtaoMap: texture_2d<f32>;

fn octEncode(n: vec3<f32>) -> vec2<f32> {
  let p = n.xy / (abs(n.x) + abs(n.y) + abs(n.z));
  if (n.z >= 0.0) { return p; }
  return (vec2<f32>(1.0) - abs(p.yx)) * select(vec2<f32>(-1.0), vec2<f32>(1.0), p >= vec2<f32>(0.0));
}

@vertex
fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4<f32> {
  let p = vec2<f32>(f32((i << 1u) & 2u), f32(i & 2u));
  return vec4<f32>(p * 2.0 - 1.0, 0.0, 1.0);
}

// A pixel's position in view space, from its depth (WebGPU's, 0..1).
fn viewAt(p: vec2<i32>, size: vec2<i32>) -> vec3<f32> {
  let q = clamp(p, vec2<i32>(0, 0), size - 1);
  let z = textureLoad(depth, q, 0);
  let ndc = vec2<f32>((f32(q.x) + 0.5) / f32(size.x) * 2.0 - 1.0, 1.0 - (f32(q.y) + 0.5) / f32(size.y) * 2.0);
  let v = cs.invProj * vec4<f32>(ndc, z, 1.0);
  return v.xyz / v.w;
}

// Where a view-space point lands on screen, in pixels (x, y), or w < 0 behind the camera.
fn screenOf(q: vec3<f32>, size: vec2<i32>) -> vec3<f32> {
  let c = cs.proj * vec4<f32>(q, 1.0);
  if (c.w <= 1e-4) { return vec3<f32>(0.0, 0.0, -1.0); }
  return vec3<f32>((c.x / c.w * 0.5 + 0.5) * f32(size.x), (0.5 - c.y / c.w * 0.5) * f32(size.y), 1.0);
}

// GTAO at this pixel, from the four nearest half-resolution texels: bilinear weights, each times
// how near its depth is to this pixel's (so an edge never bleeds), or the nearest when none is.
fn gtaoAt(p: vec2<i32>, size: vec2<i32>, P: vec3<f32>) -> vec4<f32> {
  let half = vec2<i32>(textureDimensions(gtaoMap));
  let f = (vec2<f32>(p) + 0.5) * 0.5 - 0.5;
  let base = vec2<i32>(floor(f));
  let w = f - floor(f);
  var sum = vec4<f32>(0.0);
  var total = 0.0;
  for (var k = 0; k < 4; k += 1) {
    let o = vec2<i32>(k & 1, k >> 1);
    let h = clamp(base + o, vec2<i32>(0), half - 1);
    let zh = viewAt(h * 2, size).z;
    let bil = select(1.0 - w.x, w.x, o.x == 1) * select(1.0 - w.y, w.y, o.y == 1);
    let near = exp(-abs(zh - P.z) / (0.02 * abs(P.z) + 0.02));
    let weight = bil * near + 1e-5 * bil;
    sum = sum + textureLoad(gtaoMap, h, 0) * weight;
    total = total + weight;
  }
  let g = sum / max(total, 1e-6);
  return vec4<f32>(normalize(g.rgb + vec3<f32>(1e-6)), g.a);
}

@fragment
fn contactPass(@builtin(position) frag: vec4<f32>) -> @location(0) vec4<f32> {
  let size = vec2<i32>(textureDimensions(depth));
  let p = vec2<i32>(frag.xy);
  var ao = 1.0;
  if (cs.params.w > 0.5) { ao = textureLoad(aoMap, p, 0).r; }
  // Nothing drawn here (the far plane): nothing to shadow or occlude.
  if (textureLoad(depth, p, 0) >= 1.0) { return vec4<f32>(ao, 1.0, octEncode(vec3<f32>(0.0, 1.0, 0.0))); }
  let P = viewAt(p, size);
  var bentCode = octEncode(vec3<f32>(0.0, 1.0, 0.0));
  if (cs.params2.z > 0.5) {
    let g = gtaoAt(p, size, P);
    ao = g.a;
    bentCode = octEncode(g.rgb);
  }
  if (cs.light.w < 0.5) { return vec4<f32>(ao, 1.0, bentCode); }
  let away = length(P);
  let fade = 1.0 - smoothstep(cs.params2.x, cs.params2.y, away);
  if (fade <= 0.0) { return vec4<f32>(ao, 1.0, bentCode); }
  let L = cs.light.xyz;
  let steps = i32(cs.params.z);
  let stride = cs.params.x / f32(steps);
  // Interleaved gradient noise (Jimenez) staggers each pixel's steps.
  let jitter = fract(52.9829189 * fract(dot(frag.xy, vec2<f32>(0.06711056, 0.00583715))));
  // Off the surface by a share of the distance, so a pixel never finds its own depth in front of it.
  let start = 0.01 + away * 0.002;
  var shadow = 0.0;
  for (var i = 0; i < steps; i += 1) {
    let t = start + (f32(i) + jitter) * stride;
    let q = P + L * t;
    let s = screenOf(q, size);
    if (s.z < 0.0 || s.x < 0.0 || s.y < 0.0 || s.x >= f32(size.x) || s.y >= f32(size.y)) { break; }
    // Within a pixel of where it started the ray is still over its own surface.
    if (distance(s.xy, frag.xy) < 1.5) { continue; }
    let surface = viewAt(vec2<i32>(s.xy), size).z;
    // In front of the step (nearer the camera, which looks down −z), by no more than a thickness.
    let gap = surface - q.z;
    if (gap > 0.0 && gap < cs.params.y + stride + away * 0.01) {
      // The screen's edge, where the depth runs out, softens it.
      let edge = clamp(min(min(s.x, f32(size.x) - s.x), min(s.y, f32(size.y) - s.y)) / (0.05 * f32(size.x)), 0.0, 1.0);
      shadow = edge;
      break;
    }
  }
  return vec4<f32>(ao, 1.0 - shadow * fade, bentCode);
}
`;
}
