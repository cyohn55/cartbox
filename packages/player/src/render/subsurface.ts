/**
 * Screen-space subsurface scattering (AAA_FIDELITY_ROADMAP.md F1d-2) on the
 * linear-light renderer: the separable SSS of Jimenez et al. (2015) with
 * Burley's normalised diffusion profile, split as HDRP splits it when it has no
 * spare target.
 *
 * - **The split.** On a scattering surface the opaque pass writes, in a
 *   checkerboard, the diffuse light that scatters (the material's share of it)
 *   on the even pixels and everything else (the specular, the rest of the
 *   diffuse, emission) on the odd ones. No extra target is needed.
 * - **The blur** runs in two passes after the opaque scene, before the
 *   see-through pass copies it: across, then down. Each gathers the even
 *   pixels' diffuse within three radii of the profile (the material's radius
 *   × its scatter colour, per channel), sized on screen by the pixel's depth,
 *   and weighs them by Burley's profile along the line, `e^(−r/d) + e^(−r/3d)`,
 *   normalised per channel so the light is spread, never gained or lost.
 *   Samples on another material, or farther in depth than the profile
 *   reaches, are left out, so the light does not bleed across silhouettes.
 * - **The rebuild.** The second pass adds the blurred diffuse to the pixel's
 *   remainder: its own on an odd pixel, the mean of its odd neighbours' on an
 *   even one.
 *
 * Profiles are kept per material ID (the G-buffer's, F0c): the scatter colour
 * and the radius.
 */

/** Material IDs a frame's profiles cover; a later material scatters as a plain diffuse one. */
export const SSS_MAX_PROFILES = 256;
/** Samples each side of a pixel, each pass. */
export const SSS_TAPS = 8;
/** How far a kernel reaches, in profile radii. */
export const SSS_REACH = 3;

/** A material's profile: how far each channel scatters (metres), from its colour × its radius. */
export interface SssProfile {
  readonly id: number;
  readonly color: readonly [number, number, number];
  readonly radius: number;
}

/** The profiles as the pass reads them: a vec4 per material ID (rgb distance in metres per channel, w = 1 when it scatters). */
export function packSssProfiles(profiles: readonly SssProfile[]): Float32Array {
  const out = new Float32Array(SSS_MAX_PROFILES * 4);
  for (const p of profiles) {
    if (p.id <= 0 || p.id >= SSS_MAX_PROFILES || !(p.radius > 0)) continue;
    out.set([p.color[0] * p.radius, p.color[1] * p.radius, p.color[2] * p.radius, 1], p.id * 4);
  }
  return out;
}

/** Burley's profile along a line at distance r for a scatter distance d (unnormalised; the pass normalises per channel). */
export function burleyWeight(r: number, d: number): number {
  if (!(d > 0)) return r === 0 ? 1 : 0;
  return Math.exp(-r / d) + Math.exp(-r / (3 * d));
}

/** Whether a pixel holds the diffuse half of the checkerboard (the other holds the rest). */
export function holdsDiffuse(x: number, y: number): boolean {
  return ((x + y) & 1) === 0;
}

/**
 * The pass's WGSL. Bindings: 0 the uniforms (x, y = the blur's direction in
 * pixels; z = 1 on the second pass; w = pixels a metre spans at a distance of
 * one; then the depth terms, distance = y / (z + x)); 1 the frame (the split
 * colour); 2 the first pass's blur (on the second pass); 3 the depths; 4 the
 * G-buffer (w = material ID); 5 the profiles.
 */
export const SSS_WGSL = /* wgsl */ `
struct Params {
  dir: vec4<f32>,   // xy = the step's direction, z = 1 on the second pass, w = pixels a metre spans at distance 1
  terms: vec4<f32>, // xy = depth → distance terms (d = y / (z + x))
};
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var frameTex: texture_2d<f32>;
@group(0) @binding(2) var blurTex: texture_2d<f32>;
@group(0) @binding(3) var depthTex: texture_depth_2d;
@group(0) @binding(4) var gbufferTex: texture_2d<f32>;
@group(0) @binding(5) var<storage, read> profiles: array<vec4<f32>>;
@vertex
fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4<f32> {
  let p = vec2<f32>(f32((i << 1u) & 2u), f32(i & 2u));
  return vec4<f32>(p * 2.0 - 1.0, 0.0, 1.0);
}
fn idAt(p: vec2<i32>) -> u32 {
  return u32(textureLoad(gbufferTex, p, 0).w + 0.5);
}
fn distanceAt(p: vec2<i32>) -> f32 {
  return params.terms.y / (textureLoad(depthTex, p, 0) + params.terms.x);
}
fn profileOf(id: u32) -> vec4<f32> {
  if (id == 0u || id >= ${SSS_MAX_PROFILES}u) { return vec4<f32>(0.0); }
  return profiles[id];
}
fn evenAt(p: vec2<i32>) -> bool {
  return ((p.x + p.y) & 1) == 0;
}
// The diffuse half at p: its own on an even pixel, its even neighbour's along the row otherwise.
fn diffuseAt(p: vec2<i32>, dims: vec2<i32>) -> vec3<f32> {
  if (evenAt(p)) { return textureLoad(frameTex, p, 0).rgb; }
  let q = vec2<i32>(select(p.x - 1, p.x + 1, p.x == 0), p.y);
  return textureLoad(frameTex, clamp(q, vec2<i32>(0), dims - vec2<i32>(1)), 0).rgb;
}
// The remainder at p: its own on an odd pixel, the mean of its odd neighbours' (on the same material) otherwise.
fn restAt(p: vec2<i32>, dims: vec2<i32>, id: u32) -> vec3<f32> {
  if (!evenAt(p)) { return textureLoad(frameTex, p, 0).rgb; }
  var sum = vec3<f32>(0.0);
  var n = 0.0;
  let offsets = array<vec2<i32>, 4>(vec2<i32>(1, 0), vec2<i32>(-1, 0), vec2<i32>(0, 1), vec2<i32>(0, -1));
  for (var k = 0; k < 4; k = k + 1) {
    let q = p + offsets[k];
    if (any(q < vec2<i32>(0)) || any(q >= dims) || idAt(q) != id) { continue; }
    sum = sum + textureLoad(frameTex, q, 0).rgb;
    n = n + 1.0;
  }
  return select(vec3<f32>(0.0), sum / max(n, 1.0), n > 0.0);
}
@fragment
fn blur(@builtin(position) pos: vec4<f32>) -> @location(0) vec4<f32> {
  let p = vec2<i32>(pos.xy);
  let dims = vec2<i32>(textureDimensions(frameTex));
  let own = textureLoad(frameTex, p, 0);
  let id = idAt(p);
  let profile = profileOf(id);
  if (profile.w < 0.5) { return own; }
  let second = params.dir.z > 0.5;
  let dist = max(distanceAt(p), 1e-3);
  // How many pixels the widest channel's reach spans here, and a step that covers it in the taps.
  let reach = ${SSS_REACH}.0 * max(profile.r, max(profile.g, profile.b));
  let pixels = reach * params.dir.w / dist;
  let step = max(1.0, pixels / ${SSS_TAPS}.0);
  var sum = vec3<f32>(0.0);
  var weights = vec3<f32>(0.0);
  for (var i = -${SSS_TAPS}; i <= ${SSS_TAPS}; i = i + 1) {
    let q = p + vec2<i32>(round(params.dir.xy * f32(i) * step));
    if (any(q < vec2<i32>(0)) || any(q >= dims) || idAt(q) != id) { continue; }
    // The sample's distance along the surface in metres, and in depth.
    let r = abs(f32(i)) * step * dist / params.dir.w;
    if (abs(distanceAt(q) - dist) > reach) { continue; }
    let w = exp(-r / profile.rgb) + exp(-r / (3.0 * profile.rgb));
    var c: vec3<f32>;
    if (second) { c = textureLoad(blurTex, q, 0).rgb; } else { c = diffuseAt(q, dims); }
    sum = sum + c * w;
    weights = weights + w;
  }
  let scattered = sum / max(weights, vec3<f32>(1e-6));
  if (!second) { return vec4<f32>(scattered, own.a); }
  return vec4<f32>(scattered + restAt(p, dims, id), own.a);
}
`;
