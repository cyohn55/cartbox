/**
 * Ground-truth ambient occlusion with bent normals on the AAA tier
 * (AAA_FIDELITY_ROADMAP.md F3c; Jimenez et al., "Practical Real-Time
 * Strategies for Accurate Indirect Occlusion", 2016).
 *
 * From the depth prepass and its G-buffer normals, at half resolution:
 *
 * - **Slices.** Each pixel takes {@link GTAO_SLICES} screen directions, turned
 *   per pixel and per frame. Along each it walks out both ways to
 *   {@link GTAO_RADIUS} metres (in pixels, by the pixel's depth) and keeps
 *   the highest horizon either side, each sample past 0.6 of the radius
 *   fading out toward it so a distant wall doesn't occlude.
 * - **Visibility.** The arc between the two horizons, clamped to the
 *   hemisphere about the normal projected into the slice, integrated with the
 *   cosine weight in closed form, is the slice's share of the light from the
 *   sky that reaches the point.
 * - **Bent normal.** The middle of each slice's open arc, weighted by its
 *   width, averaged over the slices: the direction the sky reaches the point
 *   from, which lights it in place of the surface's normal.
 *
 * The accumulation pass blends each frame into a history reprojected through
 * the velocity buffer, the history clamped to what the current frame's
 * neighbourhood allows so a moving object leaves no ghost. The contact pass
 * (contactShadows.ts) then brings it up to full resolution, weighting the four
 * nearest texels by how close their depths are to the pixel's.
 */

import type { Mat4 } from "@cartbox/editor";

import { invertMat4 } from "./temporal.js";

/** How far, in world units, a point looks for what occludes it. */
export const GTAO_RADIUS = 1.2;
/** Screen directions each pixel takes a frame. */
export const GTAO_SLICES = 2;
/** Steps each way along a slice. */
export const GTAO_STEPS = 6;
/** How much of each new frame the history takes (about a 1/α-frame average). */
export const GTAO_BLEND = 0.12;
/** Floats in the pass's uniforms: projection, inverse projection, view, params, params2. */
export const GTAO_UNIFORM_FLOATS = 56;

/**
 * The GTAO pass's uniforms for a frame drawn with `view` and `projection` (the
 * jittered one, when temporal), `frame` turning its slices from frame to frame;
 * `history` says whether last frame's accumulation is there to blend into.
 */
export function gtaoUniforms(view: Mat4, projection: Mat4, frame: number, history: boolean, out: Float32Array<ArrayBuffer> = new Float32Array(GTAO_UNIFORM_FLOATS)): Float32Array<ArrayBuffer> {
  out.set(projection, 0);
  out.set(invertMat4(projection) ?? projection, 16);
  out.set(view, 32);
  out.set([GTAO_RADIUS, GTAO_SLICES, GTAO_STEPS, frame % 64], 48);
  out.set([GTAO_BLEND, history ? 1 : 0, 0, 0], 52);
  return out;
}

const SHARED = (multisampled: boolean) => /* wgsl */ `
struct Gtao { proj: mat4x4<f32>, invProj: mat4x4<f32>, view: mat4x4<f32>, params: vec4<f32>, params2: vec4<f32> };
@group(0) @binding(0) var<uniform> ga: Gtao;
@group(0) @binding(1) var depth: ${multisampled ? "texture_depth_multisampled_2d" : "texture_depth_2d"};

@vertex
fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4<f32> {
  let p = vec2<f32>(f32((i << 1u) & 2u), f32(i & 2u));
  return vec4<f32>(p * 2.0 - 1.0, 0.0, 1.0);
}

// A full-resolution pixel's position in view space, from its depth (as drawn).
fn viewAt(p: vec2<i32>, size: vec2<i32>) -> vec3<f32> {
  let q = clamp(p, vec2<i32>(0, 0), size - 1);
  let z = textureLoad(depth, q, 0);
  let ndc = vec2<f32>((f32(q.x) + 0.5) / f32(size.x) * 2.0 - 1.0, 1.0 - (f32(q.y) + 0.5) / f32(size.y) * 2.0);
  let v = ga.invProj * vec4<f32>(ndc, z, 1.0);
  return v.xyz / v.w;
}
`;

/** The GTAO pass's WGSL, drawn at half resolution: rgb the bent normal (world space), a the visibility. */
export function gtaoShaderWgsl(multisampled: boolean): string {
  return /* wgsl */ `${SHARED(multisampled)}
@group(0) @binding(2) var gbuffer: texture_2d<f32>;

fn octDecode(e: vec2<f32>) -> vec3<f32> {
  var n = vec3<f32>(e.x, e.y, 1.0 - abs(e.x) - abs(e.y));
  let t = max(-n.z, 0.0);
  n.x = n.x + select(t, -t, n.x >= 0.0);
  n.y = n.y + select(t, -t, n.y >= 0.0);
  return normalize(n);
}

@fragment
fn gtaoPass(@builtin(position) frag: vec4<f32>) -> @location(0) vec4<f32> {
  let full = vec2<i32>(textureDimensions(depth));
  // This half-resolution texel's full-resolution pixel.
  let p = min(vec2<i32>(frag.xy) * 2, full - 1);
  if (textureLoad(depth, p, 0) >= 1.0) { return vec4<f32>(0.0, 1.0, 0.0, 1.0); }
  let P = viewAt(p, full);
  let V = normalize(-P);
  let Nw = octDecode(textureLoad(gbuffer, p, 0).xy);
  var N = normalize((ga.view * vec4<f32>(Nw, 0.0)).xyz);
  if (dot(N, V) < 0.0) { N = -N; }
  let radius = ga.params.x;
  // The radius on screen, in full-resolution pixels, at this depth.
  let reach = radius * ga.proj[0][0] * 0.5 * f32(full.x) / max(-P.z, 1e-3);
  if (reach < 1.0) { return vec4<f32>(Nw, 1.0); }
  let slices = i32(ga.params.y);
  let steps = i32(ga.params.z);
  // Interleaved gradient noise, shifted each frame, turns the slices and staggers the steps.
  let shift = ga.params.w * 5.588238;
  let spin = fract(52.9829189 * fract(dot(frag.xy + shift, vec2<f32>(0.06711056, 0.00583715))));
  let jitter = fract(spin * 7.31 + 0.5);
  var visibility = 0.0;
  var bent = vec3<f32>(0.0);
  for (var s = 0; s < slices; s += 1) {
    let phi = (f32(s) + spin) / f32(slices) * 3.14159265;
    let dir = vec2<f32>(cos(phi), sin(phi));
    // The slice's plane: the view vector and the screen direction (y up in view space, down on screen).
    let d3 = vec3<f32>(dir.x, -dir.y, 0.0);
    let ortho = normalize(d3 - V * dot(d3, V));
    let axis = cross(ortho, V);
    let projN = N - axis * dot(N, axis);
    let projLen = length(projN);
    if (projLen < 1e-4) { continue; }
    let cosN = clamp(dot(projN, V) / projLen, -1.0, 1.0);
    let n = sign(dot(projN, ortho)) * acos(cosN);
    // The highest horizon each way, as a cosine to V (−1 open), each sample fading toward the radius.
    var hc = vec2<f32>(-1.0, -1.0);
    for (var side = 0; side < 2; side += 1) {
      let sgn = select(-1.0, 1.0, side == 1);
      for (var k = 0; k < steps; k += 1) {
        let t = (f32(k) + jitter) / f32(steps);
        let off = dir * sgn * max(1.0, t * t * reach);
        let q = vec2<i32>(vec2<f32>(p) + off);
        if (q.x < 0 || q.y < 0 || q.x >= full.x || q.y >= full.y) { break; }
        let delta = viewAt(q, full) - P;
        let len = length(delta);
        if (len < 1e-4) { continue; }
        let c = dot(delta / len, V);
        // Full weight to 0.6 of the radius, then falling to none at it (XeGTAO's).
        let falloff = clamp((radius - len) / (0.4 * radius), 0.0, 1.0);
        let h = mix(-1.0, c, falloff);
        if (side == 0) { hc.x = max(hc.x, h); } else { hc.y = max(hc.y, h); }
      }
    }
    // The open arc, clamped to the hemisphere about the projected normal.
    let h0 = n + max(-acos(hc.x) - n, -1.5707963);
    let h1 = n + min(acos(hc.y) - n, 1.5707963);
    let sinN = sin(n);
    let arc = 0.25 * (-cos(2.0 * h0 - n) + cosN + 2.0 * h0 * sinN) + 0.25 * (-cos(2.0 * h1 - n) + cosN + 2.0 * h1 * sinN);
    visibility = visibility + projLen * arc;
    // The middle of the open arc, from V toward the slice's direction, weighted by its width.
    let mid = 0.5 * (h0 + h1);
    bent = bent + (V * cos(mid) + ortho * sin(mid)) * projLen * (h1 - h0);
  }
  let ao = clamp(visibility / f32(slices), 0.0, 1.0);
  var bw = Nw;
  if (length(bent) > 1e-4) {
    // Back to world space: the view's rotation, transposed.
    let bv = normalize(bent);
    let r = mat3x3<f32>(ga.view[0].xyz, ga.view[1].xyz, ga.view[2].xyz);
    bw = normalize(transpose(r) * bv);
  }
  return vec4<f32>(bw, ao);
}
`;
}

/** The accumulation pass's WGSL: this frame's GTAO into the history reprojected through the velocity buffer. */
export function gtaoTemporalWgsl(): string {
  return /* wgsl */ `
struct Gtao { proj: mat4x4<f32>, invProj: mat4x4<f32>, view: mat4x4<f32>, params: vec4<f32>, params2: vec4<f32> };
@group(0) @binding(0) var<uniform> ga: Gtao;
@group(0) @binding(1) var current: texture_2d<f32>;
@group(0) @binding(2) var history: texture_2d<f32>;
@group(0) @binding(3) var velocity: texture_2d<f32>;
@group(0) @binding(4) var linearSamp: sampler;

@vertex
fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4<f32> {
  let p = vec2<f32>(f32((i << 1u) & 2u), f32(i & 2u));
  return vec4<f32>(p * 2.0 - 1.0, 0.0, 1.0);
}

@fragment
fn accumulate(@builtin(position) frag: vec4<f32>) -> @location(0) vec4<f32> {
  let size = vec2<i32>(textureDimensions(current));
  let p = vec2<i32>(frag.xy);
  let now = textureLoad(current, p, 0);
  // The range of this frame's visibility round the texel: the history is held inside it.
  var lo = now.a;
  var hi = now.a;
  for (var y = -1; y <= 1; y += 1) {
    for (var x = -1; x <= 1; x += 1) {
      let a = textureLoad(current, clamp(p + vec2<i32>(x, y), vec2<i32>(0), size - 1), 0).a;
      lo = min(lo, a);
      hi = max(hi, a);
    }
  }
  let full = vec2<i32>(textureDimensions(velocity));
  let motion = textureLoad(velocity, min(p * 2, full - 1), 0).xy;
  let uv = (vec2<f32>(p) + 0.5) / vec2<f32>(size) - motion;
  if (ga.params2.y < 0.5 || any(uv < vec2<f32>(0.0)) || any(uv > vec2<f32>(1.0))) { return now; }
  let then = textureSampleLevel(history, linearSamp, uv, 0.0);
  let held = clamp(then.a, lo, hi);
  let k = ga.params2.x;
  let bent = normalize(mix(then.rgb, now.rgb, k) + vec3<f32>(1e-6));
  return vec4<f32>(bent, mix(held, now.a, k));
}
`;
}
