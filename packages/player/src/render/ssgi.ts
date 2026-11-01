/**
 * Screen-space global illumination on the AAA tier (AAA_FIDELITY_ROADMAP.md
 * F3e-2): the near-field bounce the probe volume (F3d-3, F3e-1) is too coarse
 * to hold — a red wall's light on the floor beside it, the glow of a lit
 * panel on the crate in front of it.
 *
 * From the depth prepass, its G-buffer normals and the last frame's resolved
 * HDR image (the TAA history, linear light before any tone map), at half
 * resolution:
 *
 * - **Trace.** Each pixel casts {@link SSGI_RAYS} rays over the cosine-weighted
 *   hemisphere about its normal, turned per pixel and per frame, and marches
 *   each across the screen against the depths, out to {@link SSGI_RADIUS}
 *   metres, as the reflections and contact shadows march theirs.
 * - **Hits.** A ray that passes behind a surface by no more than a thickness
 *   has hit it. It takes the light that surface sent the camera last frame
 *   (found by the velocity buffer), so what it sees includes last frame's
 *   bounce: light bounces once more each frame. A hit on a surface's back is
 *   dark. Rays that leave the screen or the radius miss.
 * - **What it returns.** rgb: the mean radiance the rays brought back (misses
 *   count as none), which for cosine-weighted rays is the irradiance over π
 *   from what they hit — the convention the scene shader lights its diffuse
 *   by. a: the share of rays that hit.
 *
 * The scene shader then takes, for an opaque or cut-out surface, its far-field
 * irradiance (the sky's, the light map's or the probe volume's) only from the
 * share of directions the rays left open, and the rays' own light from the
 * rest: `irr × (1 − a) + rgb`. Since that share already holds the near-field
 * occlusion GTAO measures, GTAO then darkens only the specular.
 *
 * The accumulation pass blends each frame into a history reprojected through
 * the velocity buffer, held to the current frame's neighbourhood (its mean
 * and spread, generously, as two rays a pixel are noisy). The resolve pass
 * brings it to full resolution with a joint bilateral filter over the 3×3
 * half-resolution texels round each pixel, weighted by depth and normal, into
 * the screen-shading target's second layer.
 */

import type { Mat4 } from "@cartbox/editor";

import { invertMat4 } from "./temporal.js";

/** How far, in world units, a ray looks for what lights the point. */
export const SSGI_RADIUS = 4;
/** Rays each half-resolution pixel casts a frame. */
export const SSGI_RAYS = 2;
/** Steps along each ray. */
export const SSGI_STEPS = 12;
/** How thick the depth buffer's surfaces are taken to be (world units), plus the step and a share of the distance. */
export const SSGI_THICKNESS = 0.35;
/** How much of each new frame the history takes. */
export const SSGI_BLEND = 0.1;
/** The brightest radiance a ray brings back (a sun glint on chrome would otherwise speckle). */
export const SSGI_MAX_RADIANCE = 32;
/** Floats in the passes' uniforms: projection, inverse projection, view, params, params2. */
export const SSGI_UNIFORM_FLOATS = 56;

/** What a frame's SSGI is set to (`SceneLighting.screenSpaceGi`, resolved). */
export interface SsgiFrame {
  /** World units a ray reaches. */
  readonly radius: number;
  /** Scales the light the rays bring back. */
  readonly intensity: number;
}

/**
 * The passes' uniforms for a frame drawn with `view` and `projection` (the
 * jittered one, when temporal), `frame` turning its rays from frame to frame;
 * `history` says whether last frame's accumulation is there to blend into.
 */
export function ssgiUniforms(view: Mat4, projection: Mat4, frame: number, history: boolean, settings: SsgiFrame, out: Float32Array<ArrayBuffer> = new Float32Array(SSGI_UNIFORM_FLOATS)): Float32Array<ArrayBuffer> {
  out.set(projection, 0);
  out.set(invertMat4(projection) ?? projection, 16);
  out.set(view, 32);
  out.set([settings.radius, SSGI_RAYS, SSGI_STEPS, frame % 1024], 48);
  out.set([SSGI_THICKNESS, SSGI_BLEND, history ? 1 : 0, settings.intensity], 52);
  return out;
}

const SHARED = (multisampled: boolean) => /* wgsl */ `
struct Ssgi { proj: mat4x4<f32>, invProj: mat4x4<f32>, view: mat4x4<f32>, params: vec4<f32>, params2: vec4<f32> };
@group(0) @binding(0) var<uniform> gi: Ssgi;
@group(0) @binding(1) var depth: ${multisampled ? "texture_depth_multisampled_2d" : "texture_depth_2d"};
@group(0) @binding(2) var gbuffer: texture_2d<f32>;

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
  let v = gi.invProj * vec4<f32>(ndc, z, 1.0);
  return v.xyz / v.w;
}

fn octDecode(e: vec2<f32>) -> vec3<f32> {
  var n = vec3<f32>(e.x, e.y, 1.0 - abs(e.x) - abs(e.y));
  let t = max(-n.z, 0.0);
  n.x = n.x + select(t, -t, n.x >= 0.0);
  n.y = n.y + select(t, -t, n.y >= 0.0);
  return normalize(n);
}

// A full-resolution pixel's world normal, from the prepass's G-buffer.
fn normalAt(p: vec2<i32>, size: vec2<i32>) -> vec3<f32> {
  return octDecode(textureLoad(gbuffer, clamp(p, vec2<i32>(0, 0), size - 1), 0).xy);
}
`;

/** The trace pass's WGSL, drawn at half resolution: rgb the rays' mean radiance, a the share that hit. */
export function ssgiTraceWgsl(multisampled: boolean): string {
  return /* wgsl */ `${SHARED(multisampled)}
@group(0) @binding(3) var velocity: texture_2d<f32>;
@group(0) @binding(4) var radiance: texture_2d<f32>;
@group(0) @binding(5) var linearSamp: sampler;

// Where a view-space point lands on screen, in pixels (x, y), or w < 0 behind the camera.
fn screenOf(q: vec3<f32>, size: vec2<i32>) -> vec3<f32> {
  let c = gi.proj * vec4<f32>(q, 1.0);
  if (c.w <= 1e-4) { return vec3<f32>(0.0, 0.0, -1.0); }
  return vec3<f32>((c.x / c.w * 0.5 + 0.5) * f32(size.x), (0.5 - c.y / c.w * 0.5) * f32(size.y), 1.0);
}

@fragment
fn ssgiTrace(@builtin(position) frag: vec4<f32>) -> @location(0) vec4<f32> {
  let full = vec2<i32>(textureDimensions(depth));
  let p = min(vec2<i32>(frag.xy) * 2, full - 1);
  if (textureLoad(depth, p, 0) >= 1.0) { return vec4<f32>(0.0); }
  let P = viewAt(p, full);
  let V = normalize(-P);
  let rot = mat3x3<f32>(gi.view[0].xyz, gi.view[1].xyz, gi.view[2].xyz);
  var N = normalize(rot * normalAt(p, full));
  if (dot(N, V) < 0.0) { N = -N; }
  // A frame about the normal.
  let up = select(vec3<f32>(0.0, 1.0, 0.0), vec3<f32>(1.0, 0.0, 0.0), abs(N.y) > 0.9);
  let T = normalize(cross(up, N));
  let B = cross(N, T);
  let radius = gi.params.x;
  let rays = i32(gi.params.y);
  let steps = i32(gi.params.z);
  let thickness = gi.params2.x;
  // Interleaved gradient noise, shifted each frame, picks the rays and staggers their steps.
  let shift = gi.params.w * 5.588238;
  let n1 = fract(52.9829189 * fract(dot(frag.xy + shift, vec2<f32>(0.06711056, 0.00583715))));
  let n2 = fract(52.9829189 * fract(dot(frag.xy + vec2<f32>(17.0, 59.0) + shift * 1.7, vec2<f32>(0.06711056, 0.00583715))));
  let away = length(P);
  let start = 0.02 + away * 0.002;
  var sum = vec3<f32>(0.0);
  var hits = 0.0;
  for (var r = 0; r < rays; r += 1) {
    // Cosine-weighted over the hemisphere: the rays' mean radiance is the irradiance over π.
    let u1 = fract(n1 + f32(r) * 0.6180340);
    let u2 = fract(n2 + f32(r) * 0.7548777);
    let phi = 6.2831853 * u1;
    let s2 = sqrt(u2);
    let dir = T * (s2 * cos(phi)) + B * (s2 * sin(phi)) + N * sqrt(max(0.0, 1.0 - u2));
    let jitter = fract(n2 * 3.7 + f32(r) * 0.381966);
    var last = 0.0;
    for (var i = 0; i < steps; i += 1) {
      let f = (f32(i) + jitter) / f32(steps);
      let t = start + radius * f * f;
      let q = P + dir * t;
      let s = screenOf(q, full);
      if (s.z < 0.0 || s.x < 0.0 || s.y < 0.0 || s.x >= f32(full.x) || s.y >= f32(full.y)) { break; }
      // Within a couple of pixels of where it started the ray is still over its own surface.
      if (distance(s.xy, vec2<f32>(p)) < 2.0) { last = t; continue; }
      let at = vec2<i32>(s.xy);
      let surface = viewAt(at, full).z;
      // Behind a surface on screen (nearer the camera, which looks down −z), by no more than its thickness.
      let gap = surface - q.z;
      if (gap > 0.0 && gap < thickness + (t - last) + away * 0.01) {
        // The light it sent the camera last frame, where it stood then: unless the ray met its back.
        let hitN = normalize(rot * normalAt(at, full));
        if (dot(hitN, dir) < 0.0) {
          let uv = (vec2<f32>(at) + 0.5) / vec2<f32>(full) - textureLoad(velocity, at, 0).xy;
          if (all(uv >= vec2<f32>(0.0)) && all(uv <= vec2<f32>(1.0))) {
            var L = textureSampleLevel(radiance, linearSamp, uv, 0.0).rgb;
            let peak = max(L.r, max(L.g, L.b));
            if (peak > ${SSGI_MAX_RADIANCE.toFixed(1)}) { L = L * (${SSGI_MAX_RADIANCE.toFixed(1)} / peak); }
            // The screen's edge, where the image runs out, and the radius's end soften the hit.
            let edge = clamp(min(min(s.x, f32(full.x) - s.x), min(s.y, f32(full.y) - s.y)) / (0.05 * f32(full.x)), 0.0, 1.0);
            let w = edge * (1.0 - smoothstep(0.75, 1.0, t / (start + radius)));
            sum = sum + L * w;
            hits = hits + w;
          }
        } else {
          hits = hits + 1.0;
        }
        break;
      }
      last = t;
    }
  }
  return vec4<f32>(sum / f32(rays), hits / f32(rays));
}
`;
}

/** The accumulation pass's WGSL: this frame's trace into the history reprojected through the velocity buffer. */
export function ssgiTemporalWgsl(): string {
  return /* wgsl */ `
struct Ssgi { proj: mat4x4<f32>, invProj: mat4x4<f32>, view: mat4x4<f32>, params: vec4<f32>, params2: vec4<f32> };
@group(0) @binding(0) var<uniform> gi: Ssgi;
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
  // The neighbourhood's mean and spread: the history is held within two spreads of the mean.
  var m1 = vec4<f32>(0.0);
  var m2 = vec4<f32>(0.0);
  for (var y = -1; y <= 1; y += 1) {
    for (var x = -1; x <= 1; x += 1) {
      let s = textureLoad(current, clamp(p + vec2<i32>(x, y), vec2<i32>(0), size - 1), 0);
      m1 = m1 + s;
      m2 = m2 + s * s;
    }
  }
  let mean = m1 / 9.0;
  let spread = sqrt(max(m2 / 9.0 - mean * mean, vec4<f32>(0.0)));
  let full = vec2<i32>(textureDimensions(velocity));
  let motion = textureLoad(velocity, min(p * 2, full - 1), 0).xy;
  let uv = (vec2<f32>(p) + 0.5) / vec2<f32>(size) - motion;
  if (gi.params2.z < 0.5 || any(uv < vec2<f32>(0.0)) || any(uv > vec2<f32>(1.0))) { return now; }
  let then = textureSampleLevel(history, linearSamp, uv, 0.0);
  let held = clamp(then, mean - 2.0 * spread - 0.02, mean + 2.0 * spread + 0.02);
  return max(mix(held, now, gi.params2.y), vec4<f32>(0.0));
}
`;
}

/** The resolve pass's WGSL, at full resolution: the accumulation, filtered by depth and normal, times the intensity. */
export function ssgiResolveWgsl(multisampled: boolean): string {
  return /* wgsl */ `${SHARED(multisampled)}
@group(0) @binding(3) var accumulated: texture_2d<f32>;

@fragment
fn resolve(@builtin(position) frag: vec4<f32>) -> @location(0) vec4<f32> {
  let size = vec2<i32>(textureDimensions(depth));
  let p = vec2<i32>(frag.xy);
  if (textureLoad(depth, p, 0) >= 1.0) { return vec4<f32>(0.0); }
  let P = viewAt(p, size);
  let N = normalAt(p, size);
  let half = vec2<i32>(textureDimensions(accumulated));
  let f = (vec2<f32>(p) + 0.5) * 0.5 - 0.5;
  let centre = vec2<i32>(round(f));
  var sum = vec4<f32>(0.0);
  var total = 0.0;
  for (var y = -1; y <= 1; y += 1) {
    for (var x = -1; x <= 1; x += 1) {
      let h = clamp(centre + vec2<i32>(x, y), vec2<i32>(0), half - 1);
      let d = vec2<f32>(h) - f;
      let spatial = exp(-dot(d, d) * 0.5);
      let zh = viewAt(h * 2, size).z;
      let near = exp(-abs(zh - P.z) / (0.02 * abs(P.z) + 0.02));
      let facing = pow(max(dot(normalAt(h * 2, size), N), 0.0), 8.0);
      let w = spatial * near * facing + 1e-5 * spatial;
      sum = sum + textureLoad(accumulated, h, 0) * w;
      total = total + w;
    }
  }
  let g = sum / max(total, 1e-6);
  return vec4<f32>(g.rgb * gi.params2.w, clamp(g.a, 0.0, 1.0));
}
`;
}
