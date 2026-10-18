/**
 * Temporal anti-aliasing (HALO_INFINITE_STYLE_ROADMAP.md I2), what the two GPU
 * scene renderers share.
 *
 * Each frame the projection is nudged by a sub-pixel offset (a Halton 2,3
 * sequence of eight), so over eight frames every pixel samples eight points
 * inside itself. A resolve pass after the scene blends the new frame into a
 * history image: each pixel finds where it was last frame from its depth and
 * the two cameras (the history is reprojected, so a turning or walking camera
 * keeps it), and the history is clamped to the new frame's 3×3 neighbourhood
 * so whatever moved or came into view replaces it rather than ghosting. The
 * blend is the new frame at {@link TEMPORAL_BLEND}, so the history is an
 * average of the last dozen or so frames: thin trim, specular sparkle and
 * cut-out edges that multisampling can't reach stop crawling. A sharpening
 * pass (contrast-limited to the neighbourhood, so it adds no halos) gives back
 * the crispness the averaging softens; it reads the history but never writes
 * it, so the sharpening doesn't compound.
 *
 * The resolve runs on the GPU before the frame is read back, so the readback's
 * lag (the frame shown is one or two behind) doesn't touch it: the history,
 * the depth and the cameras are all the same frame's. The software rasteriser
 * ignores it, like multisampling, and with it off the GPU renderers still match
 * the software rasteriser pixel for pixel.
 *
 * Both renderers draw the image top row first (WebGPU natively, WebGL2 by
 * flipping in the vertex stage), so the shaders below share their maths: a
 * pixel's position in the projection's NDC is `(2x/w − 1, 1 − 2y/h)`, and NDC
 * maps back to texture coordinates as `(x/2 + ½, ½ − y/2)`. They differ only in
 * how depth is stored: WebGPU keeps z/w, GL maps it to 0..1.
 */

import { multiplyMat4, type Mat4 } from "@cartbox/editor";

/** Frames in the jitter sequence. */
export const TEMPORAL_SAMPLES = 8;
/** The new frame's weight in the history (the rest is the reprojected history). */
export const TEMPORAL_BLEND = 0.1;
/** How strongly the output is sharpened (0 none). */
export const TEMPORAL_SHARPEN = 0.25;
/** The reactive mask's gain (F4a): a see-through change this strong (tone mapped) or more takes the new frame whole. */
export const REACTIVE_SCALE = 4;
/** Floats in the resolve's uniforms: the reprojection matrix, then the params vec4. */
export const TEMPORAL_UNIFORM_FLOATS = 20;

/** The `index`th (from 1) term of the Halton sequence in `base`. */
export function halton(index: number, base: number): number {
  let result = 0;
  let f = 1;
  for (let i = index; i > 0; i = Math.floor(i / base)) {
    f /= base;
    result += f * (i % base);
  }
  return result;
}

/** Frame `frame`'s sub-pixel offset, in pixels, each axis in −½..½. */
export function temporalJitter(frame: number): [number, number] {
  const i = (((frame % TEMPORAL_SAMPLES) + TEMPORAL_SAMPLES) % TEMPORAL_SAMPLES) + 1;
  return [halton(i, 2) - 0.5, halton(i, 3) - 0.5];
}

/** The projection moved by `jitter` pixels on a `width × height` frame (perspective or orthographic). */
export function jitterProjection(projection: Mat4, jitter: readonly [number, number], width: number, height: number): Mat4 {
  const dx = (2 * jitter[0]) / width;
  const dy = (2 * jitter[1]) / height;
  // translate(dx, dy, 0) × projection: clip x += dx·w, clip y += dy·w.
  const out = projection.slice() as Mat4;
  for (let c = 0; c < 4; c += 1) {
    const w = projection[c * 4 + 3]!;
    out[c * 4] = projection[c * 4]! + dx * w;
    out[c * 4 + 1] = projection[c * 4 + 1]! + dy * w;
  }
  return out;
}

/** The inverse of a 4×4 column-major matrix, or null when it has none. */
export function invertMat4(m: Mat4): Mat4 | null {
  const [a00, a01, a02, a03, a10, a11, a12, a13, a20, a21, a22, a23, a30, a31, a32, a33] = m as unknown as number[];
  const b00 = a00! * a11! - a01! * a10!;
  const b01 = a00! * a12! - a02! * a10!;
  const b02 = a00! * a13! - a03! * a10!;
  const b03 = a01! * a12! - a02! * a11!;
  const b04 = a01! * a13! - a03! * a11!;
  const b05 = a02! * a13! - a03! * a12!;
  const b06 = a20! * a31! - a21! * a30!;
  const b07 = a20! * a32! - a22! * a30!;
  const b08 = a20! * a33! - a23! * a30!;
  const b09 = a21! * a32! - a22! * a31!;
  const b10 = a21! * a33! - a23! * a31!;
  const b11 = a22! * a33! - a23! * a32!;
  const det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-300) return null;
  const k = 1 / det;
  return [
    (a11! * b11 - a12! * b10 + a13! * b09) * k,
    (a02! * b10 - a01! * b11 - a03! * b09) * k,
    (a31! * b05 - a32! * b04 + a33! * b03) * k,
    (a22! * b04 - a21! * b05 - a23! * b03) * k,
    (a12! * b08 - a10! * b11 - a13! * b07) * k,
    (a00! * b11 - a02! * b08 + a03! * b07) * k,
    (a32! * b02 - a30! * b05 - a33! * b01) * k,
    (a20! * b05 - a22! * b02 + a23! * b01) * k,
    (a10! * b10 - a11! * b08 + a13! * b06) * k,
    (a01! * b08 - a00! * b10 - a03! * b06) * k,
    (a30! * b04 - a31! * b02 + a33! * b00) * k,
    (a21! * b02 - a20! * b04 - a23! * b00) * k,
    (a11! * b07 - a10! * b09 - a12! * b06) * k,
    (a00! * b09 - a01! * b07 + a02! * b06) * k,
    (a31! * b01 - a30! * b03 - a32! * b00) * k,
    (a20! * b03 - a21! * b01 + a22! * b00) * k,
  ] as unknown as Mat4;
}

/** How a renderer's depth buffer holds depth: z/w as drawn (WebGPU), or mapped to 0..1 (GL). */
export type DepthStorage = "ndc" | "unit";

/** One temporal frame: the projection to draw with and the resolve's uniforms. */
export interface TemporalFrame {
  readonly projection: Mat4;
  /** The reprojection (this frame's NDC → last frame's clip space), then [blend, sharpen, history valid, depth is 0..1]. */
  readonly uniforms: Float32Array;
}

/**
 * A renderer's temporal history between frames: the jitter step and the last
 * frame's camera. A frame drawn without temporal anti-aliasing (or at a new
 * size) forgets it, so the next temporal frame starts from its own image.
 */
export class TemporalState {
  private frame = 0;
  private previous: Mat4 | null = null;
  private readonly uniforms = new Float32Array(TEMPORAL_UNIFORM_FLOATS);

  constructor(private readonly depth: DepthStorage) {}

  /** Start a temporal frame of `width × height` seen through `view` and `projection`. */
  begin(view: Mat4, projection: Mat4, width: number, height: number): TemporalFrame {
    const viewProj = multiplyMat4(projection, view);
    const inverse = invertMat4(viewProj);
    const reprojection = this.previous && inverse ? multiplyMat4(this.previous, inverse) : null;
    this.uniforms.set(reprojection ?? IDENTITY, 0);
    this.uniforms.set([TEMPORAL_BLEND, TEMPORAL_SHARPEN, reprojection ? 1 : 0, this.depth === "unit" ? 1 : 0], 16);
    const jittered = jitterProjection(projection, temporalJitter(this.frame), width, height);
    this.frame += 1;
    this.previous = viewProj;
    return { projection: jittered, uniforms: this.uniforms };
  }

  /** Forget the history: the next temporal frame starts fresh. */
  reset(): void {
    this.previous = null;
  }
}

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/** The resolve's WGSL. `multisampled` reads a multisampled depth (its first sample). */
export function temporalShaderWgsl(multisampled: boolean): string {
  return /* wgsl */ `
struct Temporal { reproject: mat4x4<f32>, params: vec4<f32> };
@group(0) @binding(0) var<uniform> taa: Temporal;
@group(0) @binding(1) var current: texture_2d<f32>;
@group(0) @binding(2) var history: texture_2d<f32>;
@group(0) @binding(3) var historySampler: sampler;
@group(0) @binding(4) var depth: ${multisampled ? "texture_depth_multisampled_2d" : "texture_depth_2d"};

@vertex
fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4<f32> {
  let p = vec2<f32>(f32((i << 1u) & 2u), f32(i & 2u));
  return vec4<f32>(p * 2.0 - 1.0, 0.0, 1.0);
}

@fragment
fn resolve(@builtin(position) frag: vec4<f32>) -> @location(0) vec4<f32> {
  let size = vec2<i32>(textureDimensions(current));
  let p = vec2<i32>(frag.xy);
  let c = textureLoad(current, p, 0);
  if (taa.params.z < 0.5) { return c; }
  var lo = c;
  var hi = c;
  for (var dy = -1; dy <= 1; dy += 1) {
    for (var dx = -1; dx <= 1; dx += 1) {
      let s = textureLoad(current, clamp(p + vec2<i32>(dx, dy), vec2<i32>(0, 0), size - 1), 0);
      lo = min(lo, s);
      hi = max(hi, s);
    }
  }
  var z = textureLoad(depth, p, 0);
  if (taa.params.w > 0.5) { z = z * 2.0 - 1.0; }
  let ndc = vec2<f32>(frag.x / f32(size.x) * 2.0 - 1.0, 1.0 - frag.y / f32(size.y) * 2.0);
  let prev = taa.reproject * vec4<f32>(ndc, z, 1.0);
  if (prev.w <= 0.0) { return c; }
  let uv = vec2<f32>(prev.x / prev.w * 0.5 + 0.5, 0.5 - prev.y / prev.w * 0.5);
  if (any(uv < vec2<f32>(0.0, 0.0)) || any(uv > vec2<f32>(1.0, 1.0))) { return c; }
  let h = clamp(textureSampleLevel(history, historySampler, uv, 0.0), lo, hi);
  return mix(h, c, taa.params.x);
}
`;
}

/** The sharpening pass's WGSL: the resolved history in, the frame to read back out. */
export const TEMPORAL_SHARPEN_WGSL = /* wgsl */ `
struct Temporal { reproject: mat4x4<f32>, params: vec4<f32> };
@group(0) @binding(0) var<uniform> taa: Temporal;
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
  return clamp(c + (4.0 * c - n - s - w - e) * taa.params.y, lo, hi);
}
`;

/** The full-screen triangle both GLSL passes draw (no vertex buffers). */
export const TEMPORAL_VERTEX_GLSL = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}
`;

/** The resolve's GLSL (as {@link temporalShaderWgsl}; the depth is already resolved). */
export const TEMPORAL_RESOLVE_GLSL = `#version 300 es
precision highp float;
precision highp sampler2D;
uniform mat4 uReproject;
uniform vec4 uParams;
uniform sampler2D uCurrent;
uniform sampler2D uHistory;
uniform sampler2D uDepth;
out vec4 colour;
void main() {
  ivec2 size = textureSize(uCurrent, 0);
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 c = texelFetch(uCurrent, p, 0);
  if (uParams.z < 0.5) { colour = c; return; }
  vec4 lo = c;
  vec4 hi = c;
  for (int dy = -1; dy <= 1; dy++) {
    for (int dx = -1; dx <= 1; dx++) {
      vec4 s = texelFetch(uCurrent, clamp(p + ivec2(dx, dy), ivec2(0), size - 1), 0);
      lo = min(lo, s);
      hi = max(hi, s);
    }
  }
  float z = texelFetch(uDepth, p, 0).r;
  if (uParams.w > 0.5) z = z * 2.0 - 1.0;
  vec2 ndc = vec2(gl_FragCoord.x / float(size.x) * 2.0 - 1.0, 1.0 - gl_FragCoord.y / float(size.y) * 2.0);
  vec4 prev = uReproject * vec4(ndc, z, 1.0);
  if (prev.w <= 0.0) { colour = c; return; }
  vec2 uv = vec2(prev.x / prev.w * 0.5 + 0.5, 0.5 - prev.y / prev.w * 0.5);
  if (any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0)))) { colour = c; return; }
  vec4 h = clamp(textureLod(uHistory, uv, 0.0), lo, hi);
  colour = mix(h, c, uParams.x);
}
`;

/** The sharpening pass's GLSL (as {@link TEMPORAL_SHARPEN_WGSL}). */
export const TEMPORAL_SHARPEN_GLSL = `#version 300 es
precision highp float;
precision highp sampler2D;
uniform vec4 uParams;
uniform sampler2D uResolved;
out vec4 colour;
void main() {
  ivec2 size = textureSize(uResolved, 0);
  ivec2 p = ivec2(gl_FragCoord.xy);
  ivec2 top = size - 1;
  vec4 c = texelFetch(uResolved, p, 0);
  vec4 n = texelFetch(uResolved, clamp(p + ivec2(0, -1), ivec2(0), top), 0);
  vec4 s = texelFetch(uResolved, clamp(p + ivec2(0, 1), ivec2(0), top), 0);
  vec4 w = texelFetch(uResolved, clamp(p + ivec2(-1, 0), ivec2(0), top), 0);
  vec4 e = texelFetch(uResolved, clamp(p + ivec2(1, 0), ivec2(0), top), 0);
  vec4 lo = min(c, min(min(n, s), min(w, e)));
  vec4 hi = max(c, max(max(n, s), max(w, e)));
  colour = clamp(c + (4.0 * c - n - s - w - e) * uParams.y, lo, hi);
}
`;

/**
 * The AAA tier's resolve (AAA_FIDELITY_ROADMAP.md F4a), in linear HDR before
 * the presenter's tone map. Over {@link temporalShaderWgsl} it:
 *
 * - **reprojects with the velocity buffer** (F0c), so a moving object's
 *   history follows it rather than the camera's, taking the velocity of the
 *   nearest surface in the 3×3 so an edge moves with what is in front;
 *   nothing drawn (the sky behind) still reprojects by depth and the cameras;
 * - **reads the history Catmull-Rom** (five bilinear taps), so it doesn't
 *   soften a little more every frame;
 * - **clips it to the neighbourhood's variance box in YCoCg** (Salvi), toward
 *   the box's centre rather than clamping per channel, which colour-shifts;
 *   the box is grown to hold the pixel's own colour, so a lone highlight
 *   keeps its history instead of being clipped toward the wall around it;
 * - works on Karis's reversible tone map of the colour, so one HDR sparkle
 *   (a highlight of 40 beside a wall of 0.5) neither dominates the average nor
 *   flickers;
 * - and takes more of the new frame where the reactive mask says something
 *   see-through (particles, water) changed this pixel: their motion is not in
 *   the velocity buffer, so the history under them is the surface behind.
 *
 * The mask (binding 6, {@link REACTIVE_MASK_WGSL}) is 1×1 when the frame has
 * nothing see-through; the shader reads it only at the frame's size.
 */
export function hdrTemporalShaderWgsl(multisampled: boolean): string {
  return /* wgsl */ `
struct Temporal { reproject: mat4x4<f32>, params: vec4<f32> };
@group(0) @binding(0) var<uniform> taa: Temporal;
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

// Karis's reversible tone map, and YCoCg.
fn toneMap(c: vec3<f32>) -> vec3<f32> { return c / (1.0 + max(c.r, max(c.g, c.b))); }
fn untoneMap(c: vec3<f32>) -> vec3<f32> { return c / max(1e-5, 1.0 - max(c.r, max(c.g, c.b))); }
fn toYCoCg(c: vec3<f32>) -> vec3<f32> { return vec3<f32>(0.25 * c.r + 0.5 * c.g + 0.25 * c.b, 0.5 * c.r - 0.5 * c.b, -0.25 * c.r + 0.5 * c.g - 0.25 * c.b); }
fn fromYCoCg(c: vec3<f32>) -> vec3<f32> { let t = c.x - c.z; return vec3<f32>(t + c.y, c.x + c.z, t - c.y); }

// The history at uv by Catmull-Rom, in five bilinear taps (the corners dropped).
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
  let size = vec2<i32>(textureDimensions(current));
  let fsize = vec2<f32>(size);
  let p = vec2<i32>(frag.xy);
  let c = textureLoad(current, p, 0);
  if (taa.params.z < 0.5) { return c; }
  // The neighbourhood's moments in YCoCg of the tone-mapped colour, and its nearest surface.
  var m1 = vec3<f32>(0.0);
  var m2 = vec3<f32>(0.0);
  var nearest = 2.0;
  var at = p;
  for (var dy = -1; dy <= 1; dy += 1) {
    for (var dx = -1; dx <= 1; dx += 1) {
      let q = clamp(p + vec2<i32>(dx, dy), vec2<i32>(0, 0), size - 1);
      let s = toYCoCg(toneMap(textureLoad(current, q, 0).rgb));
      m1 = m1 + s;
      m2 = m2 + s * s;
      let z = textureLoad(depth, q, 0);
      if (z < nearest) { nearest = z; at = q; }
    }
  }
  let mean = m1 / 9.0;
  let sigma = sqrt(max(m2 / 9.0 - mean * mean, vec3<f32>(0.0)));
  // Where it was: by the nearest surface's velocity, or (nothing drawn) by depth and the cameras.
  var uv = frag.xy / fsize;
  if (nearest < 1.0) {
    uv = uv - textureLoad(velocity, at, 0).xy;
  } else {
    var z = textureLoad(depth, p, 0);
    if (taa.params.w > 0.5) { z = z * 2.0 - 1.0; }
    let ndc = vec2<f32>(frag.x / fsize.x * 2.0 - 1.0, 1.0 - frag.y / fsize.y * 2.0);
    let prev = taa.reproject * vec4<f32>(ndc, z, 1.0);
    if (prev.w <= 0.0) { return c; }
    uv = vec2<f32>(prev.x / prev.w * 0.5 + 0.5, 0.5 - prev.y / prev.w * 0.5);
  }
  if (any(uv < vec2<f32>(0.0, 0.0)) || any(uv > vec2<f32>(1.0, 1.0))) { return c; }
  let past = historyAt(uv, fsize);
  // Clip the history toward the box's centre (Salvi's variance box, γ = 1), the box
  // grown to hold this pixel's own colour, so a lone highlight keeps its history.
  let now = toYCoCg(toneMap(c.rgb));
  let lo = min(mean - sigma, now);
  let hi = max(mean + sigma, now);
  let centre = (lo + hi) * 0.5;
  let extent = (hi - lo) * 0.5 + vec3<f32>(1e-5);
  var h = toYCoCg(toneMap(past.rgb));
  let offset = h - centre;
  let units = abs(offset / extent);
  let reach = max(units.x, max(units.y, units.z));
  if (reach > 1.0) { h = centre + offset / reach; }
  // More of the new frame where something see-through changed the pixel (the reactive mask).
  var blend = taa.params.x;
  if (all(vec2<i32>(textureDimensions(reactive)) == size)) { blend = max(blend, textureLoad(reactive, p, 0).r); }
  let rgb = untoneMap(fromYCoCg(mix(h, now, blend)));
  return vec4<f32>(max(rgb, vec3<f32>(0.0)), mix(past.a, c.a, max(blend, 0.5)));
}
`;
}

/**
 * The reactive mask (F4a): how much the see-through pass changed each pixel,
 * the opaque scene's colour (copied before it) against the frame's, tone
 * mapped so a bright wall and a dim one count the same. As FSR 2 makes its
 * own, scaled so a quarter-strength change is fully reactive.
 */
export const REACTIVE_MASK_WGSL = /* wgsl */ `
@group(0) @binding(0) var opaqueOnly: texture_2d<f32>;
@group(0) @binding(1) var composited: texture_2d<f32>;

@vertex
fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4<f32> {
  let p = vec2<f32>(f32((i << 1u) & 2u), f32(i & 2u));
  return vec4<f32>(p * 2.0 - 1.0, 0.0, 1.0);
}
fn toneMap(c: vec3<f32>) -> vec3<f32> { return c / (1.0 + max(c.r, max(c.g, c.b))); }
@fragment
fn mask(@builtin(position) frag: vec4<f32>) -> @location(0) vec4<f32> {
  let p = vec2<i32>(frag.xy);
  let d = abs(toneMap(textureLoad(composited, p, 0).rgb) - toneMap(textureLoad(opaqueOnly, p, 0).rgb));
  return vec4<f32>(clamp(max(d.r, max(d.g, d.b)) * ${REACTIVE_SCALE.toFixed(1)}, 0.0, 1.0), 0.0, 0.0, 1.0);
}
`;
