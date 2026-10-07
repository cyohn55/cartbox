/**
 * Screen-space reflections (HALO_INFINITE_STYLE_ROADMAP.md I3), what the two
 * GPU scene renderers share.
 *
 * In a frame with reflections the scene shader writes two more targets beside
 * the colour, for every Modern-tier (PBR) surface:
 *
 * - **reflect**: rgb, how much of a reflected colour reaches the screen at this
 *   pixel (the specular weight — f0 × reflectivity × occlusion — carried
 *   through the tone map and fog); a, the roughness.
 * - **env**: rgb, what the environment or reflection-probe reflection added to
 *   the pixel, on screen. Taking it away leaves the pixel without its
 *   reflection.
 *
 * A pass after the scene then, for each reflective pixel, rebuilds its
 * position and normal from the depth buffer, reflects the view ray about the
 * normal and marches it across the screen against the depth buffer. Where it
 * meets something, that pixel's colour replaces the probe's reflection:
 * `colour − confidence · env + confidence · reflect · hit`. The confidence
 * fades toward the screen's edges, with distance, with roughness and for rays
 * turning back toward the camera, so where the screen has nothing to show the
 * probe reflection stays (that is the fall-back). Surfaces seen through glass
 * keep a share of their reflection in proportion to what shows through.
 *
 * It runs on the GPU before the frame is read back (and before the temporal
 * resolve, which calms its noise). The software rasteriser ignores it; with it
 * off the GPU renderers still match the software rasteriser pixel for pixel.
 *
 * Both renderers draw the image top row first, so as in temporal.ts a pixel's
 * NDC is `(2x/w − 1, 1 − 2y/h)` on both; they differ in how depth is stored.
 */

import type { Mat4 } from "@cartbox/editor";

import { invertMat4, type DepthStorage } from "./temporal.js";

/** Steps a reflected ray takes across the screen before a binary refinement. */
export const SSR_STEPS = 64;
/** How far, in view units, a reflected ray travels. */
export const SSR_MAX_DISTANCE = 24;
/** How thick the depth buffer's surfaces are taken to be, in view units, plus a share of the distance. */
export const SSR_THICKNESS = 0.4;
/** Surfaces rougher than this keep their probe reflection (a blurry reflection isn't worth marching). */
export const SSR_MAX_ROUGHNESS = 0.65;
/** Floats in the pass's uniforms: projection, inverse projection, params, params2. */
export const SSR_UNIFORM_FLOATS = 40;

/** The pass's uniforms for a frame drawn with `projection` (the jittered one, when temporal). */
export function reflectionUniforms(projection: Mat4, depth: DepthStorage, out: Float32Array<ArrayBuffer> = new Float32Array(SSR_UNIFORM_FLOATS)): Float32Array<ArrayBuffer> {
  out.set(projection, 0);
  out.set(invertMat4(projection) ?? projection, 16);
  out.set([SSR_MAX_DISTANCE, SSR_THICKNESS, SSR_STEPS, depth === "unit" ? 1 : 0], 32);
  out.set([SSR_MAX_ROUGHNESS, 0, 0, 0], 36);
  return out;
}

/** The reflection pass's WGSL. `multisampled` reads a multisampled depth (its first sample). */
export function reflectionShaderWgsl(multisampled: boolean): string {
  return /* wgsl */ `
struct Ssr { proj: mat4x4<f32>, invProj: mat4x4<f32>, params: vec4<f32>, params2: vec4<f32> };
@group(0) @binding(0) var<uniform> ssr: Ssr;
@group(0) @binding(1) var colour: texture_2d<f32>;
@group(0) @binding(2) var depth: ${multisampled ? "texture_depth_multisampled_2d" : "texture_depth_2d"};
@group(0) @binding(3) var reflectMap: texture_2d<f32>;
@group(0) @binding(4) var envMap: texture_2d<f32>;

@vertex
fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4<f32> {
  let p = vec2<f32>(f32((i << 1u) & 2u), f32(i & 2u));
  return vec4<f32>(p * 2.0 - 1.0, 0.0, 1.0);
}

// A pixel's position in view space, from its depth.
fn viewAt(p: vec2<i32>, size: vec2<i32>) -> vec3<f32> {
  let q = clamp(p, vec2<i32>(0, 0), size - 1);
  var z = textureLoad(depth, q, 0);
  if (ssr.params.w > 0.5) { z = z * 2.0 - 1.0; }
  let ndc = vec2<f32>((f32(q.x) + 0.5) / f32(size.x) * 2.0 - 1.0, 1.0 - (f32(q.y) + 0.5) / f32(size.y) * 2.0);
  let v = ssr.invProj * vec4<f32>(ndc, z, 1.0);
  return v.xyz / v.w;
}

// Where a view-space point lands on screen, in pixels (x, y), or w < 0 behind the camera.
fn screenOf(q: vec3<f32>, size: vec2<i32>) -> vec3<f32> {
  let c = ssr.proj * vec4<f32>(q, 1.0);
  if (c.w <= 1e-4) { return vec3<f32>(0.0, 0.0, -1.0); }
  return vec3<f32>((c.x / c.w * 0.5 + 0.5) * f32(size.x), (0.5 - c.y / c.w * 0.5) * f32(size.y), 1.0);
}

@fragment
fn reflectPass(@builtin(position) frag: vec4<f32>) -> @location(0) vec4<f32> {
  let size = vec2<i32>(textureDimensions(colour));
  let p = vec2<i32>(frag.xy);
  let c = textureLoad(colour, p, 0);
  let refl = textureLoad(reflectMap, p, 0);
  let w = refl.rgb;
  let rough = refl.a;
  if (max(w.r, max(w.g, w.b)) < 0.002 || rough > ssr.params2.x) { return c; }
  let P = viewAt(p, size);
  // The normal from the depth: the neighbour on each axis nearer in depth (so an edge doesn't bend it).
  let l = viewAt(p - vec2<i32>(1, 0), size);
  let r = viewAt(p + vec2<i32>(1, 0), size);
  let u = viewAt(p - vec2<i32>(0, 1), size);
  let d = viewAt(p + vec2<i32>(0, 1), size);
  let dx = select(r - P, P - l, abs(l.z - P.z) < abs(r.z - P.z));
  let dy = select(d - P, P - u, abs(u.z - P.z) < abs(d.z - P.z));
  var N = normalize(cross(dx, dy));
  if (dot(N, P) > 0.0) { N = -N; }
  let V = normalize(P);
  let R = reflect(V, N);
  let steps = i32(ssr.params.z);
  let reach = ssr.params.x;
  var before = 0.0;
  var after = -1.0;
  for (var i = 1; i <= steps; i += 1) {
    let f = f32(i) / f32(steps);
    let t = reach * f * f;
    let q = P + R * t;
    let s = screenOf(q, size);
    if (s.z < 0.0 || s.x < 0.0 || s.y < 0.0 || s.x >= f32(size.x) || s.y >= f32(size.y)) { break; }
    // Within a couple of pixels of where it started the ray is still over its own surface.
    if (distance(s.xy, frag.xy) < 2.0) { before = t; continue; }
    // A hit: this step went behind the surface on screen, by no more than its thickness plus
    // the step's own depth (so a thin surface passed between two steps still counts).
    let surface = viewAt(vec2<i32>(s.xy), size).z;
    let last = (P + R * before).z;
    if (surface > q.z && surface - q.z < ssr.params.y + abs(last - q.z)) { after = t; break; }
    before = t;
  }
  if (after < 0.0) { return c; }
  // Refine between the last step in front and the first behind.
  for (var j = 0; j < 6; j += 1) {
    let mid = 0.5 * (before + after);
    let s = screenOf(P + R * mid, size);
    let behind = viewAt(vec2<i32>(s.xy), size).z - (P + R * mid).z;
    if (behind > 0.0) { after = mid; } else { before = mid; }
  }
  let hitAt = screenOf(P + R * after, size);
  let hit = vec2<i32>(hitAt.xy);
  let edge = min(min(hitAt.x, f32(size.x) - hitAt.x) / (0.12 * f32(size.x)), min(hitAt.y, f32(size.y) - hitAt.y) / (0.12 * f32(size.y)));
  let confidence = clamp(edge, 0.0, 1.0)
    * (1.0 - after / reach)
    * (1.0 - smoothstep(ssr.params2.x * 0.6, ssr.params2.x, rough))
    * (1.0 - smoothstep(0.15, 0.55, R.z));
  let seen = textureLoad(colour, hit, 0).rgb;
  let env = textureLoad(envMap, p, 0).rgb;
  return vec4<f32>(clamp(c.rgb + confidence * (w * seen - env), vec3<f32>(0.0), vec3<f32>(1.0)), c.a);
}
`;
}

/** The reflection pass's GLSL (as {@link reflectionShaderWgsl}; the depth is already resolved). */
export const REFLECTION_GLSL = `#version 300 es
precision highp float;
precision highp sampler2D;
uniform mat4 uProj;
uniform mat4 uInvProj;
uniform vec4 uParams;
uniform vec4 uParams2;
uniform sampler2D uColour;
uniform sampler2D uDepth;
uniform sampler2D uReflect;
uniform sampler2D uEnv;
out vec4 colour;

vec3 viewAt(ivec2 p, ivec2 size) {
  ivec2 q = clamp(p, ivec2(0), size - 1);
  float z = texelFetch(uDepth, q, 0).r;
  if (uParams.w > 0.5) z = z * 2.0 - 1.0;
  vec2 ndc = vec2((float(q.x) + 0.5) / float(size.x) * 2.0 - 1.0, 1.0 - (float(q.y) + 0.5) / float(size.y) * 2.0);
  vec4 v = uInvProj * vec4(ndc, z, 1.0);
  return v.xyz / v.w;
}

vec3 screenOf(vec3 q, ivec2 size) {
  vec4 c = uProj * vec4(q, 1.0);
  if (c.w <= 1e-4) return vec3(0.0, 0.0, -1.0);
  return vec3((c.x / c.w * 0.5 + 0.5) * float(size.x), (0.5 - c.y / c.w * 0.5) * float(size.y), 1.0);
}

void main() {
  ivec2 size = textureSize(uColour, 0);
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 c = texelFetch(uColour, p, 0);
  vec4 refl = texelFetch(uReflect, p, 0);
  vec3 w = refl.rgb;
  float rough = refl.a;
  if (max(w.r, max(w.g, w.b)) < 0.002 || rough > uParams2.x) { colour = c; return; }
  vec3 P = viewAt(p, size);
  vec3 l = viewAt(p - ivec2(1, 0), size);
  vec3 r = viewAt(p + ivec2(1, 0), size);
  vec3 u = viewAt(p - ivec2(0, 1), size);
  vec3 d = viewAt(p + ivec2(0, 1), size);
  vec3 dx = abs(l.z - P.z) < abs(r.z - P.z) ? P - l : r - P;
  vec3 dy = abs(u.z - P.z) < abs(d.z - P.z) ? P - u : d - P;
  vec3 N = normalize(cross(dx, dy));
  if (dot(N, P) > 0.0) N = -N;
  vec3 V = normalize(P);
  vec3 R = reflect(V, N);
  int steps = int(uParams.z);
  float reach = uParams.x;
  float before = 0.0;
  float after = -1.0;
  for (int i = 1; i <= 64; i++) {
    if (i > steps) break;
    float f = float(i) / float(steps);
    float t = reach * f * f;
    vec3 q = P + R * t;
    vec3 s = screenOf(q, size);
    if (s.z < 0.0 || s.x < 0.0 || s.y < 0.0 || s.x >= float(size.x) || s.y >= float(size.y)) break;
    if (distance(s.xy, gl_FragCoord.xy) < 2.0) { before = t; continue; }
    float surface = viewAt(ivec2(s.xy), size).z;
    float last = (P + R * before).z;
    if (surface > q.z && surface - q.z < uParams.y + abs(last - q.z)) { after = t; break; }
    before = t;
  }
  if (after < 0.0) { colour = c; return; }
  for (int j = 0; j < 6; j++) {
    float mid = 0.5 * (before + after);
    vec3 s = screenOf(P + R * mid, size);
    float behind = viewAt(ivec2(s.xy), size).z - (P + R * mid).z;
    if (behind > 0.0) after = mid; else before = mid;
  }
  vec3 hitAt = screenOf(P + R * after, size);
  ivec2 hit = ivec2(hitAt.xy);
  float edge = min(min(hitAt.x, float(size.x) - hitAt.x) / (0.12 * float(size.x)), min(hitAt.y, float(size.y) - hitAt.y) / (0.12 * float(size.y)));
  float confidence = clamp(edge, 0.0, 1.0)
    * (1.0 - after / reach)
    * (1.0 - smoothstep(uParams2.x * 0.6, uParams2.x, rough))
    * (1.0 - smoothstep(0.15, 0.55, R.z));
  vec3 seen = texelFetch(uColour, hit, 0).rgb;
  vec3 env = texelFetch(uEnv, p, 0).rgb;
  colour = vec4(clamp(c.rgb + confidence * (w * seen - env), vec3(0.0), vec3(1.0)), c.a);
}
`;
