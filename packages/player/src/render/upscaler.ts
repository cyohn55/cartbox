/**
 * Temporal upscaling on the AAA tier (AAA_FIDELITY_ROADMAP.md F4b): an FSR
 * 2-class reconstruction built on F4a's HDR TAA. The scene renders at a share
 * of the display's pixels (50–77% across, or wherever dynamic resolution has
 * it, F0d), its projection jittered over a sequence long enough to land
 * samples on every display pixel; the resolve accumulates them at the
 * display's size.
 *
 * - **Where each sample really is.** The jitter moves what a render pixel
 *   shows by (jx, −jy) pixels on screen, so render pixel q's sample stands at
 *   q + ½ − (jx, −jy) in the unjittered render frame. Each display pixel
 *   gathers the 3×3 render samples round its own position, each weighted by a
 *   Gaussian of its distance from the display pixel's centre (in render
 *   pixels), so a sample counts most at the display pixels it actually fell
 *   on.
 * - **How much the frame adds.** The new frame's share is the base blend
 *   times the nearest sample's weight: a display pixel no sample came near
 *   this frame keeps its history, one a sample fell right on takes the full
 *   share. With no history (a disocclusion, the first frame) the gathered
 *   samples stand alone, a plain filtered upsample.
 * - **The history** (display-sized, linear HDR) is reprojected through the
 *   velocity of the nearest surface in the 3×3 (as F4a's), read Catmull-Rom,
 *   and clipped to the render samples' variance box in YCoCg on Karis's tone
 *   map, grown to hold the gathered colour. It is blended in linear light: a
 *   display pixel's samples come and go over the sequence, and a mean on the
 *   tone map would lose the bright ones' light. The reactive mask (F4a) takes
 *   more of the new frame where something see-through changed it.
 * - **Sharpening** is F4a's contrast-limited pass, at the display's size.
 */

import { TEMPORAL_SAMPLES } from "./temporal.js";

/** The render scales the upscaler's modes stand for: quality, balanced and performance (FSR 2's). */
export const UPSCALE_MODES = { quality: 1 / 1.5, balanced: 1 / 1.7, performance: 0.5 } as const;
/** Floats in the resolve's uniforms. */
export const UPSCALE_UNIFORM_FLOATS = 12;
/** The new frame's share at a display pixel a sample fell right on. */
export const UPSCALE_BLEND = 0.1;
/** How much the sharpening pass sharpens at the display's size. */
export const UPSCALE_SHARPEN = 0.3;

/**
 * Frames in the jitter sequence when rendering at `renderWidth` of a
 * `displayWidth` frame: TAA's eight, times the display pixels each render
 * pixel covers (FSR 2's rule), so every display pixel gets samples.
 */
export function upscaleJitterPhases(renderWidth: number, displayWidth: number): number {
  const ratio = Math.max(1, displayWidth / Math.max(1, renderWidth));
  return Math.ceil(TEMPORAL_SAMPLES * ratio * ratio);
}

/**
 * The resolve's uniforms: [blend, sharpen, history valid, depth is 0..1],
 * [the frame's jitter on screen (x, y) in render pixels, render width, height],
 * [display width, height, 0, 0].
 */
export function upscaleUniforms(jitter: readonly [number, number], render: { width: number; height: number }, display: { width: number; height: number }, history: boolean, out: Float32Array<ArrayBuffer> = new Float32Array(UPSCALE_UNIFORM_FLOATS)): Float32Array<ArrayBuffer> {
  out.set([UPSCALE_BLEND, UPSCALE_SHARPEN, history ? 1 : 0, 0], 0);
  // The jitter moves the image (jx, −jy) on screen (temporal.ts's jitterProjection: clip y up, pixels down).
  out.set([jitter[0], -jitter[1], render.width, render.height], 4);
  out.set([display.width, display.height, 0, 0], 8);
  return out;
}

/** The upscaling resolve's WGSL, drawn at the display's size. */
export function upscaleShaderWgsl(multisampled: boolean): string {
  return /* wgsl */ `
struct Upscale { params: vec4<f32>, jitter: vec4<f32>, display: vec4<f32> };
@group(0) @binding(0) var<uniform> up: Upscale;
@group(0) @binding(1) var current: texture_2d<f32>;
@group(0) @binding(2) var history: texture_2d<f32>;
@group(0) @binding(3) var historySampler: sampler;
@group(0) @binding(4) var depth: ${multisampled ? "texture_depth_multisampled_2d" : "texture_depth_2d"};
@group(0) @binding(5) var velocity: texture_2d<f32>;
@group(0) @binding(6) var reactive: texture_2d<f32>;

@vertex
fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4<f32> {
  let p = vec2<f32>(f32((i << 1u) & 2u), f32(i & 2u));
  return vec4<f32>(p * 2.0 - 1.0, 0.0, 1.0);
}

fn toneMap(c: vec3<f32>) -> vec3<f32> { return c / (1.0 + max(c.r, max(c.g, c.b))); }
fn untoneMap(c: vec3<f32>) -> vec3<f32> { return c / max(1e-5, 1.0 - max(c.r, max(c.g, c.b))); }
fn toYCoCg(c: vec3<f32>) -> vec3<f32> { return vec3<f32>(0.25 * c.r + 0.5 * c.g + 0.25 * c.b, 0.5 * c.r - 0.5 * c.b, -0.25 * c.r + 0.5 * c.g - 0.25 * c.b); }
fn fromYCoCg(c: vec3<f32>) -> vec3<f32> { let t = c.x - c.z; return vec3<f32>(t + c.y, c.x + c.z, t - c.y); }

// The history at uv by Catmull-Rom, in five bilinear taps (as F4a's).
fn historyAt(uv: vec2<f32>, size: vec2<f32>) -> vec4<f32> {
  let pos = uv * size;
  let centre = floor(pos - 0.5) + 0.5;
  let f = pos - centre;
  let w0 = f * (-0.5 + f * (1.0 - 0.5 * f));
  let w1 = 1.0 + f * f * (-2.5 + 1.5 * f);
  let w2 = f * (0.5 + f * (2.0 - 1.5 * f));
  let w3 = f * f * (-0.5 + 0.5 * f);
  let w12 = w1 + w2;
  let t0 = (centre - 1.0) / size;
  let t3 = (centre + 2.0) / size;
  let t12 = (centre + w2 / w12) / size;
  let a = textureSampleLevel(history, historySampler, vec2<f32>(t12.x, t0.y), 0.0) * (w12.x * w0.y);
  let b = textureSampleLevel(history, historySampler, vec2<f32>(t0.x, t12.y), 0.0) * (w0.x * w12.y);
  let c = textureSampleLevel(history, historySampler, t12, 0.0) * (w12.x * w12.y);
  let d = textureSampleLevel(history, historySampler, vec2<f32>(t3.x, t12.y), 0.0) * (w3.x * w12.y);
  let e = textureSampleLevel(history, historySampler, vec2<f32>(t12.x, t3.y), 0.0) * (w12.x * w3.y);
  let weight = w12.x * w0.y + w0.x * w12.y + w12.x * w12.y + w3.x * w12.y + w12.x * w3.y;
  return max((a + b + c + d + e) / weight, vec4<f32>(0.0));
}

@fragment
fn resolve(@builtin(position) frag: vec4<f32>) -> @location(0) vec4<f32> {
  let rsize = vec2<i32>(textureDimensions(current));
  let dsize = up.display.xy;
  let uv = frag.xy / dsize;
  // This display pixel's centre in the unjittered render frame, and the render pixel the jittered frame put nearest it.
  let pr = uv * vec2<f32>(rsize);
  let base = vec2<i32>(floor(pr + up.jitter.xy));
  var sum = vec3<f32>(0.0);
  var wsum = 0.0;
  var wmax = 0.0;
  var m1 = vec3<f32>(0.0);
  var m2 = vec3<f32>(0.0);
  var nearest = 2.0;
  var at = clamp(base, vec2<i32>(0), rsize - 1);
  var alpha = 0.0;
  for (var dy = -1; dy <= 1; dy += 1) {
    for (var dx = -1; dx <= 1; dx += 1) {
      let q = clamp(base + vec2<i32>(dx, dy), vec2<i32>(0), rsize - 1);
      let s = textureLoad(current, q, 0);
      // Where this sample really stands, and how far from the display pixel's centre (render pixels).
      let d = vec2<f32>(q) + 0.5 - up.jitter.xy - pr;
      let w = exp(-2.0 * dot(d, d));
      sum = sum + s.rgb * w;
      alpha = alpha + s.a * w;
      wsum = wsum + w;
      wmax = max(wmax, w);
      let y = toYCoCg(toneMap(s.rgb));
      m1 = m1 + y;
      m2 = m2 + y * y;
      let z = textureLoad(depth, q, 0);
      if (z < nearest) { nearest = z; at = q; }
    }
  }
  let gathered = sum / max(wsum, 1e-6);
  let coverage = alpha / max(wsum, 1e-6);
  let mean = m1 / 9.0;
  let sigma = sqrt(max(m2 / 9.0 - mean * mean, vec3<f32>(0.0)));
  let now = toYCoCg(toneMap(gathered));
  let prevUv = uv - textureLoad(velocity, at, 0).xy;
  if (up.params.z < 0.5 || any(prevUv < vec2<f32>(0.0)) || any(prevUv > vec2<f32>(1.0))) {
    return vec4<f32>(gathered, coverage);
  }
  let past = historyAt(prevUv, dsize);
  // Clip the history toward the box's centre (Salvi's variance box), grown to hold the gathered colour.
  let lo = min(mean - 1.25 * sigma, now);
  let hi = max(mean + 1.25 * sigma, now);
  let centre = (lo + hi) * 0.5;
  let extent = (hi - lo) * 0.5 + vec3<f32>(1e-5);
  var h = toYCoCg(toneMap(past.rgb));
  let offset = h - centre;
  let units = abs(offset / extent);
  let reach = max(units.x, max(units.y, units.z));
  if (reach > 1.0) { h = centre + offset / reach; }
  // The new frame counts as much as its nearest sample is near this display pixel.
  var blend = up.params.x * wmax;
  if (all(vec2<i32>(textureDimensions(reactive)) == rsize)) { blend = max(blend, textureLoad(reactive, at, 0).r); }
  // Blended in linear light: a display pixel's samples come and go over the sequence, and a mean taken on
  // the tone map would lose the light of the bright ones.
  let rgb = mix(untoneMap(fromYCoCg(h)), gathered, blend);
  return vec4<f32>(max(rgb, vec3<f32>(0.0)), mix(past.a, coverage, max(blend, 0.5)));
}
`;
}

/** The sharpening pass at the display's size (F4a's contrast-limited one, reading its own strength). */
export const UPSCALE_SHARPEN_WGSL = /* wgsl */ `
struct Upscale { params: vec4<f32>, jitter: vec4<f32>, display: vec4<f32> };
@group(0) @binding(0) var<uniform> up: Upscale;
@group(0) @binding(1) var resolved: texture_2d<f32>;

@vertex
fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4<f32> {
  let p = vec2<f32>(f32((i << 1u) & 2u), f32(i & 2u));
  return vec4<f32>(p * 2.0 - 1.0, 0.0, 1.0);
}

@fragment
fn sharpen(@builtin(position) frag: vec4<f32>) -> @location(0) vec4<f32> {
  let size = vec2<i32>(textureDimensions(resolved));
  let p = vec2<i32>(frag.xy);
  let top = size - 1;
  let c = textureLoad(resolved, p, 0);
  let n = textureLoad(resolved, clamp(p + vec2<i32>(0, -1), vec2<i32>(0, 0), top), 0);
  let s = textureLoad(resolved, clamp(p + vec2<i32>(0, 1), vec2<i32>(0, 0), top), 0);
  let w = textureLoad(resolved, clamp(p + vec2<i32>(-1, 0), vec2<i32>(0, 0), top), 0);
  let e = textureLoad(resolved, clamp(p + vec2<i32>(1, 0), vec2<i32>(0, 0), top), 0);
  let lo = min(c, min(min(n, s), min(w, e)));
  let hi = max(c, max(max(n, s), max(w, e)));
  return clamp(c + (4.0 * c - n - s - w - e) * up.params.y, lo, hi);
}
`;
