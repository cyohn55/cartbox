/**
 * Presenting a 3D frame from the GPU (AAA_FIDELITY_ROADMAP.md F0a).
 *
 * The byte path renders the scene on the GPU, reads it back, then does the rest
 * on the CPU: it paints the sky, composites the scene over it, streaks the sun
 * shafts, draws the held weapon, keys the cart's HUD and the holo UI on top, and
 * measures the frame for the lens flare and eye adaptation. Everything after
 * the scene pass sees 8-bit bytes, a frame or two late.
 *
 * Here every one of those steps is a GPU pass over textures on the same device
 * as the scene renderer, ending in the target the caller gives (a WebGPU
 * canvas's texture):
 *
 * 1. **Sky:** the equirectangular dome, its sun's glow and its drifting cloud
 *    layers, per pixel through the camera (`renderSkyBackground`'s maths).
 * 2. **Sun shafts:** the light-source mask at reduced resolution (open sky that
 *    is bright and near the sun), then the gather along the line to the sun
 *    (`applySunShafts`'s maths).
 * 3. **Compose:** the base (the sky, a flat colour, or the cart's own frame),
 *    the scene over it (premultiplied), the shafts added, the held weapon over
 *    that, the cart's frame keyed on top as a HUD, and the holo UI over all.
 * 4. **Post:** the post-process stack, when one is set, as a port of the WebGL
 *    pass (see gpuPostFx.ts) from the composite into the target.
 * 5. **Measure:** the log-average luminance eye adaptation needs and how much
 *    of the sun is unblocked, reduced in one compute workgroup and read back
 *    as four numbers, asynchronously — the only readback left, sixteen bytes
 *    instead of the frame.
 *
 * The cart's frame and the holo layer are CPU-drawn and uploaded as they are
 * (the cart's core makes its frame on the CPU anyway). What no longer happens
 * is the round trip of the 3D frame. Pure maths stays in the WGSL below and in
 * the exported packers, so the uniform layouts are testable without a device.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { GpuPostFx } from "../fx/gpuPostFx.js";
import type { PostFxUniforms } from "../fx/postfx.js";
import { CLOUD_TILE, MAX_CLOUD_LAYERS, type BakedCloudLayer, type DecodedTexture, type Mat4, type SkySun, type SunShafts } from "@cartbox/editor";

/** Edge of a baked cloud layer's density tile. */
const CLOUD_TILE_SIZE = CLOUD_TILE;
/** The shaft pass runs at most this many cells across (`SHAFT_MAX_WIDTH`). */
export const SHAFT_CELLS_ACROSS = 160;
/** Open sky takes this share of the shafts' light (`SHAFT_SKY_SHARE`). */
const SHAFT_SKY_SHARE = 0.35;

type Rgb = readonly [number, number, number];
type Rgba = readonly [number, number, number, number];

/** The sky dome a frame draws behind its scene. */
export interface PresentSky {
  /** The baked panorama (RGBA8; alpha is how much of the sun's glow shows, see `bakeSceneSky`). */
  readonly map: DecodedTexture;
  readonly view: Mat4;
  readonly projection: Mat4;
  /** The sun whose glow is drawn into it, or null for the panorama as baked. */
  readonly sun: SkySun | null;
  /** Drifting cloud layers (I6), and the seconds they have drifted. */
  readonly clouds: readonly BakedCloudLayer[];
  readonly time: number;
}

/** What a frame's scene draws over. */
export type PresentBase =
  | { readonly kind: "sky"; readonly sky: PresentSky }
  /** A flat colour, RGBA 0..255. */
  | { readonly kind: "colour"; readonly rgba: Rgba }
  /** The cart's own frame (RGBA8, `width × height`), shown wherever the scene drew nothing. */
  | { readonly kind: "frame"; readonly rgba: Uint8Array | Uint8ClampedArray };

/** One frame for {@link GpuPresenter.present}. */
export interface PresentFrame {
  readonly base: PresentBase;
  /** The scene, premultiplied RGBA8 on this device (alpha 0 where nothing drew), or null. */
  readonly scene: any | null;
  /** Sun shafts, over a sky base only: where the sun is (pixels, y down), its colour and the authored shafts. */
  readonly shafts?: { readonly sun: { readonly x: number; readonly y: number }; readonly color: Rgb; readonly shafts: SunShafts } | null;
  /** The front layer (a held weapon), premultiplied RGBA8 on this device, or null. */
  readonly front?: any | null;
  /** The cart's frame as a HUD over everything (first person), or null. */
  readonly hud?: Uint8Array | Uint8ClampedArray | null;
  /** HUD pixels whose channels sum to more than this (0..765) cover the scene; the rest let it show. */
  readonly hudKey?: number;
  /** The holo UI, premultiplied RGBA8 (`width × height`), over everything, or null. */
  readonly holo?: Uint8ClampedArray | null;
  /**
   * A linear HDR frame's tone map (AAA_FIDELITY_ROADMAP.md F0b): its exposure,
   * for ACES over the whole frame, or null to encode it unmapped (clamped). A
   * byte-space frame is tone-mapped as it is shaded, and ignores this.
   */
  readonly tonemap?: { readonly exposure: number } | null;
  /** The post-process stack to finish the frame through (its uniforms, and the clock grain runs on), or null for none. */
  readonly post?: { readonly uniforms: PostFxUniforms; readonly time: number } | null;
  /** What to measure this frame: eye-adaptation luminance, and/or the sun's visibility at a point (pixels). */
  readonly measure?: { readonly luminance: boolean; readonly sun: { readonly x: number; readonly y: number } | null } | null;
}

/** The newest measurements to arrive (see {@link PresentFrame.measure}); `seq` counts arrivals. */
export interface PresentStats {
  /** Log-average linear luminance of the scene over its base, or null when it wasn't measured. */
  readonly luminance: number | null;
  /** Counts the arrivals that measured luminance (eye adaptation steps once per new reading). */
  readonly luminanceSeq: number;
  /** The share of taps round the sun that see open sky (0..1), or null when it wasn't measured. */
  readonly sunVisible: number | null;
  readonly seq: number;
}

/** Frame luminance's fallback when nothing was measured (`frameLuminance`'s). */
const AUTO_KEY_FALLBACK = 0.18;

const USAGE = {
  copySrc: 0x01,
  copyDst: 0x02,
  textureBinding: 0x04,
  storage: 0x08,
  renderAttachment: 0x10,
  mapRead: 0x01,
  uniform: 0x40,
  bufferCopyDst: 0x08,
  bufferCopySrc: 0x04,
  bufferStorage: 0x80,
} as const;
const STAGE_FRAGMENT = 0x2;
const STAGE_COMPUTE = 0x4;

// --- Uniform packing (pure) -------------------------------------------------

/** Floats in the sky pass's uniform block. */
export const SKY_UNIFORM_FLOATS = 4 * (6 + 2 * MAX_CLOUD_LAYERS);

/**
 * The sky pass's uniforms: the camera's right, up and back rows with the
 * projection's reciprocal focal lengths, the cloud count, the sun and its
 * colour, the clock, the frame size, and each cloud layer's scale, wind,
 * opacity and colour.
 */
export function packSkyUniforms(sky: PresentSky, width: number, height: number, out = new Float32Array(SKY_UNIFORM_FLOATS), hdr = false): Float32Array {
  const v = sky.view;
  const p = sky.projection;
  const layers = Math.min(MAX_CLOUD_LAYERS, sky.clouds.length);
  out.set([v[0]!, v[4]!, v[8]!, 1 / p[0]!], 0);
  out.set([v[1]!, v[5]!, v[9]!, 1 / p[5]!], 4);
  out.set([v[2]!, v[6]!, v[10]!, layers], 8);
  const sun = sky.sun;
  const sl = sun ? Math.hypot(sun.direction[0], sun.direction[1], sun.direction[2]) || 1 : 1;
  out.set(sun ? [sun.direction[0] / sl, sun.direction[1] / sl, sun.direction[2] / sl, 1] : [0, 0, 0, 0], 12);
  out.set(sun ? [sun.color[0], sun.color[1], sun.color[2], sky.time] : [0, 0, 0, sky.time], 16);
  out.set([width, height, hdr ? 1 : 0, 0], 20);
  for (let i = 0; i < MAX_CLOUD_LAYERS; i += 1) {
    const layer = i < layers ? sky.clouds[i]!.layer : null;
    out.set(layer ? [layer.scale, layer.wind[0], layer.wind[1], layer.opacity] : [0, 0, 0, 0], 24 + i * 4);
    out.set(layer ? [layer.color[0], layer.color[1], layer.color[2], 0] : [0, 0, 0, 0], 24 + MAX_CLOUD_LAYERS * 4 + i * 4);
  }
  return out;
}

/** The shaft passes' grid: how many frame pixels a cell spans, and the grid's size (`applySunShafts`'s). */
export function shaftGrid(width: number, height: number): { step: number; width: number; height: number } {
  const step = Math.max(1, Math.ceil(width / SHAFT_CELLS_ACROSS));
  return { step, width: Math.ceil(width / step), height: Math.ceil(height / step) };
}

/** Floats in the shaft passes' uniform block. */
export const SHAFT_UNIFORM_FLOATS = 16;

/**
 * The shaft passes' uniforms: the sun (pixels), the screen diagonal and the
 * cell step; the frame and grid sizes; the sun in cell units, the beams' reach
 * (cells) and strength; and the sun's colour.
 */
export function packShaftUniforms(
  sun: { readonly x: number; readonly y: number },
  shafts: SunShafts,
  color: Rgb,
  width: number,
  height: number,
  out = new Float32Array(SHAFT_UNIFORM_FLOATS),
  hdr = false,
): Float32Array {
  const grid = shaftGrid(width, height);
  const reach = Math.max(0.05, Math.min(1, shafts.length)) * Math.hypot(grid.width, grid.height);
  out.set([sun.x, sun.y, Math.hypot(width, height), grid.step], 0);
  out.set([width, height, grid.width, grid.height], 4);
  out.set([sun.x / grid.step - 0.5, sun.y / grid.step - 0.5, reach, shafts.strength], 8);
  out.set([color[0], color[1], color[2], hdr ? 1 : 0], 12);
  return out;
}

/** The base kinds as the compose shader numbers them. */
const BASE_KIND = { colour: 0, sky: 1, frame: 2 } as const;

/** Floats in the compose pass's uniform block. */
export const COMPOSE_UNIFORM_FLOATS = 24;

/** The compose pass's uniforms: which layers are present, the HUD key, the flat base, and the shafts' colour and sampling scale. */
export function packComposeUniforms(
  frame: PresentFrame,
  width: number,
  height: number,
  out = new Float32Array(COMPOSE_UNIFORM_FLOATS),
  hdr = false,
): Float32Array {
  const shafts = frame.base.kind === "sky" && frame.shafts && frame.shafts.shafts.strength > 0 ? frame.shafts : null;
  const grid = shaftGrid(width, height);
  out.set([BASE_KIND[frame.base.kind], frame.scene ? 1 : 0, shafts ? 1 : 0, frame.front ? 1 : 0], 0);
  out.set([frame.hud ? 1 : 0, frame.holo ? 1 : 0, frame.hudKey ?? 30, SHAFT_SKY_SHARE], 4);
  const bg = frame.base.kind === "colour" ? frame.base.rgba : [0, 0, 0, 0];
  out.set([bg[0]! / 255, bg[1]! / 255, bg[2]! / 255, bg[3]! / 255], 8);
  out.set(shafts ? [shafts.color[0], shafts.color[1], shafts.color[2], 0] : [0, 0, 0, 0], 12);
  out.set([1 / (grid.step * grid.width), 1 / (grid.step * grid.height), 0, 0], 16);
  out.set([hdr ? 1 : 0, hdr && frame.tonemap ? 1 : 0, frame.tonemap?.exposure ?? 1, 0], 20);
  return out;
}

/** Floats in the measure pass's uniform block. */
export const MEASURE_UNIFORM_FLOATS = 16;

/** The measure pass's uniforms: frame size, luminance grid step, base kind; the flat base; the sun (pixels), tap radius and whether to tap it. */
export function packMeasureUniforms(frame: PresentFrame, width: number, height: number, out = new Float32Array(MEASURE_UNIFORM_FLOATS), hdr = false): Float32Array {
  const m = frame.measure;
  const step = Math.max(1, Math.floor(Math.sqrt((width * height) / 1024)));
  out.set([width, height, step, BASE_KIND[frame.base.kind] + (m?.luminance ? 0 : 8) + (frame.scene ? 0 : 16)], 0);
  const bg = frame.base.kind === "colour" ? frame.base.rgba : [0, 0, 0, 0];
  out.set([bg[0]! / 255, bg[1]! / 255, bg[2]! / 255, bg[3]! / 255], 4);
  const sun = m?.sun ?? null;
  out.set([sun?.x ?? 0, sun?.y ?? 0, Math.max(1.5, height * 0.012), sun ? 1 : 0], 8);
  // A linear frame measures its light as the tone map will expose it.
  out.set([hdr ? 1 : 0, hdr ? (frame.tonemap?.exposure ?? 1) : 1, 0, 0], 12);
  return out;
}

// --- Shaders ----------------------------------------------------------------

/** The sRGB curves, both ways (F0b's linear frame decodes what was authored and encodes what is shown). */
const SRGB_WGSL = /* wgsl */ `
fn toLinear(c: vec3f) -> vec3f {
  let v = max(c, vec3f(0.0));
  return select(pow((v + vec3f(0.055)) / 1.055, vec3f(2.4)), v / 12.92, v <= vec3f(0.04045));
}
fn toSrgb(c: vec3f) -> vec3f {
  let v = clamp(c, vec3f(0.0), vec3f(1.0));
  return select(1.055 * pow(v, vec3f(1.0 / 2.4)) - vec3f(0.055), v * 12.92, v <= vec3f(0.0031308));
}
fn acesFilmic(x: vec3f) -> vec3f {
  let v = max(x, vec3f(0.0));
  return clamp((v * (2.51 * v + 0.03)) / (v * (2.43 * v + 0.59) + 0.14), vec3f(0.0), vec3f(1.0));
}
`;

const FULLSCREEN_VS = /* wgsl */ `
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  let x = f32((i << 1u) & 2u);
  let y = f32(i & 2u);
  return vec4f(x * 2.0 - 1.0, 1.0 - y * 2.0, 0.0, 1.0);
}
`;

/** The sky dome through the camera, with its sun's glow and cloud layers (`renderSkyBackground`'s maths, per pixel). */
export const SKY_WGSL = /* wgsl */ `
struct Sky {
  right: vec4f,
  up: vec4f,
  back: vec4f,
  sun: vec4f,
  sunColor: vec4f,
  size: vec4f,
  cloud: array<vec4f, ${MAX_CLOUD_LAYERS}>,
  cloudColor: array<vec4f, ${MAX_CLOUD_LAYERS}>,
};
@group(0) @binding(0) var<uniform> s: Sky;
@group(0) @binding(1) var pano: texture_2d<f32>;
@group(0) @binding(2) var panoSampler: sampler;
@group(0) @binding(3) var clouds: texture_2d_array<f32>;
@group(0) @binding(4) var cloudSampler: sampler;
${FULLSCREEN_VS}
${SRGB_WGSL}
fn broadGlow(c: f32) -> f32 {
  if (c <= 0.0) { return 0.0; }
  let c2 = c * c;
  let c6 = c2 * c2 * c2;
  let c8 = c6 * c2;
  let c16 = c8 * c8;
  let c32 = c16 * c16;
  return c6 * 0.18 + c32 * c32 * 0.25;
}
fn coreGlow(c: f32) -> f32 {
  if (c > 0.99) { return pow(c, 1500.0) * 0.6; }
  return 0.0;
}
@fragment fn sky(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  // Rays through pixel corners, as the CPU backdrop casts them.
  let px = floor(pos.xy);
  let ndc = vec2f(px.x / s.size.x * 2.0 - 1.0, 1.0 - px.y / s.size.y * 2.0);
  let d = s.right.xyz * (ndc.x * s.right.w) + s.up.xyz * (ndc.y * s.up.w) - s.back.xyz;
  let len = max(length(d), 1e-6);
  let n = d / len;
  let u = atan2(d.z, d.x) / 6.28318531 + 0.5;
  let v = acos(clamp(n.y, -1.0, 1.0)) / 3.14159265;
  let texel = textureSampleLevel(pano, panoSampler, vec2f(u, v), 0.0);
  var rgb = texel.rgb;
  if (s.sun.w > 0.5) {
    let c = dot(n, s.sun.xyz);
    let here = broadGlow(c) + coreGlow(c);
    if (here > broadGlow(0.4) && texel.a > 0.0) {
      rgb = min(vec3f(1.0), rgb + s.sunColor.rgb * (here * texel.a));
    }
  }
  let layers = i32(s.back.w);
  if (layers > 0) {
    let fade = smoothstep(0.02, 0.25, n.y);
    if (fade > 0.0) {
      let k = 1.0 / (max(n.y, 0.0) + 0.12);
      let t = s.sunColor.w;
      for (var i = 0; i < layers; i = i + 1) {
        let l = s.cloud[i];
        let uv = vec2f((n.x * k + l.y * t) * l.x, (n.z * k + l.z * t) * l.x) + vec2f(0.5 / ${CLOUD_TILE_SIZE}.0);
        let density = textureSampleLevel(clouds, cloudSampler, uv, i, 0.0).r;
        let a = density * l.w * fade;
        if (a > 0.0) {
          rgb = rgb + (s.cloudColor[i].rgb * (1.0 - 0.25 * density) - rgb) * a;
        }
      }
      rgb = clamp(rgb, vec3f(0.0), vec3f(1.0));
    }
  }
  // A linear frame (F0b) takes the painted sky as the light it shows.
  if (s.size.z > 0.5) { rgb = toLinear(rgb); }
  return vec4f(rgb, 1.0);
}
`;

const SHAFT_STRUCT = /* wgsl */ `
struct Shaft {
  sun: vec4f,
  size: vec4f,
  grid: vec4f,
  color: vec4f,
};
@group(0) @binding(0) var<uniform> u: Shaft;
`;

/** The sun shafts' light source: bright open sky near the sun, a cell at a time (`shaftSourceMask`'s maths). */
export const SHAFT_MASK_WGSL = /* wgsl */ `
${SHAFT_STRUCT}
@group(0) @binding(1) var scene: texture_2d<f32>;
@group(0) @binding(2) var skyTex: texture_2d<f32>;
${FULLSCREEN_VS}
${SRGB_WGSL}
@fragment fn mask(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let cell = floor(pos.xy);
  let step = u.sun.w;
  let x = min(u.size.x - 1.0, floor(cell.x * step + step / 2.0));
  let y = min(u.size.y - 1.0, floor(cell.y * step + step / 2.0));
  let at = vec2i(i32(x), i32(y));
  if (any(textureLoad(scene, at, 0) != vec4f(0.0))) { return vec4f(0.0); }
  var sky = textureLoad(skyTex, at, 0).rgb;
  // The source is the sky as it shows: a linear frame's is encoded back first.
  if (u.color.w > 0.5) { sky = toSrgb(sky); }
  let lum = dot(sky, vec3f(0.2126, 0.7152, 0.0722));
  let bright = max(0.0, lum - 0.55) / 0.45;
  let near = max(0.0, 1.0 - distance(vec2f(x, y), u.sun.xy) / (u.sun.z * 0.35));
  return vec4f(bright * near * near, 0.0, 0.0, 0.0);
}
`;

/** The shafts' light: each cell gathers the source along its line to the sun (`applySunShafts`'s maths). */
export const SHAFT_GATHER_WGSL = /* wgsl */ `
${SHAFT_STRUCT}
@group(0) @binding(1) var maskTex: texture_2d<f32>;
${FULLSCREEN_VS}
@fragment fn gather(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let cell = floor(pos.xy);
  let sx = u.grid.x;
  let sy = u.grid.y;
  let fall = max(0.0, 1.0 - length(vec2f(sx - cell.x, sy - cell.y)) / u.grid.z);
  if (fall <= 0.0) { return vec4f(0.0); }
  var acc = 0.0;
  for (var s = 0; s < 24; s = s + 1) {
    let t = (f32(s) + 0.5) / 24.0;
    // Math.round, not round-half-even.
    let xi = floor(cell.x + (sx - cell.x) * t + 0.5);
    let yi = floor(cell.y + (sy - cell.y) * t + 0.5);
    if (xi >= 0.0 && yi >= 0.0 && xi < u.size.z && yi < u.size.w) {
      acc = acc + textureLoad(maskTex, vec2i(i32(xi), i32(yi)), 0).r;
    }
  }
  return vec4f((acc / 24.0) * fall * fall * 1.6 * u.grid.w, 0.0, 0.0, 0.0);
}
`;

/** Everything over everything: base, scene, shafts, front layer, HUD, holo. */
export const COMPOSE_WGSL = /* wgsl */ `
struct Compose {
  layers: vec4f,
  layers2: vec4f,
  background: vec4f,
  shaftColor: vec4f,
  shaftScale: vec4f,
  hdr: vec4f,
};
@group(0) @binding(0) var<uniform> u: Compose;
@group(0) @binding(1) var baseTex: texture_2d<f32>;
@group(0) @binding(2) var scene: texture_2d<f32>;
@group(0) @binding(3) var light: texture_2d<f32>;
@group(0) @binding(4) var lightSampler: sampler;
@group(0) @binding(5) var front: texture_2d<f32>;
@group(0) @binding(6) var hud: texture_2d<f32>;
@group(0) @binding(7) var holo: texture_2d<f32>;
${FULLSCREEN_VS}
${SRGB_WGSL}
fn over(top: vec4f, under: vec4f) -> vec4f {
  return vec4f(top.rgb + under.rgb * (1.0 - top.a), top.a + under.a * (1.0 - top.a));
}
// Byte space clamps every layer to the displayable range; linear light (F0b) only to zero.
fn keep(c: vec4f) -> vec4f {
  if (u.hdr.x > 0.5) { return max(c, vec4f(0.0)); }
  return clamp(c, vec4f(0.0), vec4f(1.0));
}
@fragment fn compose(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let p = vec2i(floor(pos.xy));
  let hdr = u.hdr.x > 0.5;
  var c = u.background;
  if (u.layers.x > 0.5) { c = textureLoad(baseTex, p, 0); }
  // A linear frame decodes a base that was authored in display space (the sky is linear already).
  if (hdr && u.layers.x != 1.0) { c = vec4f(toLinear(c.rgb), c.a); }
  var open = true;
  if (u.layers.y > 0.5) {
    let s = textureLoad(scene, p, 0);
    open = all(s == vec4f(0.0));
    c = keep(over(s, c));
  }
  var v = textureSampleLevel(light, lightSampler, pos.xy * u.shaftScale.xy, 0.0).r;
  if (u.layers.z > 0.5) {
    if (open) { v = v * u.layers2.w; }
    if (hdr) { c = vec4f(c.rgb + toLinear(u.shaftColor.rgb) * v, c.a); }
    else { c = vec4f(min(vec3f(1.0), c.rgb + u.shaftColor.rgb * v), c.a); }
  }
  if (u.layers.w > 0.5) { c = keep(over(textureLoad(front, p, 0), c)); }
  // The linear frame is tone-mapped once, whole, and encoded for the display;
  // the HUD and holo UI are drawn in display space over it.
  if (hdr) {
    var mapped = clamp(c.rgb, vec3f(0.0), vec3f(1.0));
    if (u.hdr.y > 0.5) { mapped = acesFilmic(c.rgb * u.hdr.z); }
    c = vec4f(toSrgb(mapped), clamp(c.a, 0.0, 1.0));
  }
  if (u.layers2.x > 0.5) {
    let h = textureLoad(hud, p, 0);
    let b = round(h.rgb * 255.0);
    if (b.r + b.g + b.b > u.layers2.z) { c = vec4f(h.rgb, 1.0); }
  }
  if (u.layers2.y > 0.5) { c = clamp(over(textureLoad(holo, p, 0), c), vec4f(0.0), vec4f(1.0)); }
  return vec4f(c.rgb, 1.0);
}
`;

/** The frame's log-average luminance and the sun's open taps, in one workgroup (`frameLuminance` and `sunVisibility`'s maths). */
export const MEASURE_WGSL = /* wgsl */ `
struct Measure {
  size: vec4f,
  background: vec4f,
  sun: vec4f,
  hdr: vec4f,
};
@group(0) @binding(0) var<uniform> u: Measure;
@group(0) @binding(1) var baseTex: texture_2d<f32>;
@group(0) @binding(2) var scene: texture_2d<f32>;
@group(0) @binding(3) var<storage, read_write> result: array<f32, 4>;
var<workgroup> sums: array<f32, 256>;
var<workgroup> counts: array<f32, 256>;
${SRGB_WGSL}
fn linear(c: f32) -> f32 {
  let b = round(c * 255.0) / 255.0;
  if (b <= 0.04045) { return b / 12.92; }
  return pow((b + 0.055) / 1.055, 2.4);
}
fn composite(p: vec2i, kind: i32, hasScene: bool) -> vec4f {
  var c = u.background;
  if (kind > 0) { c = textureLoad(baseTex, p, 0); }
  let hdr = u.hdr.x > 0.5;
  if (hdr && kind != 1) { c = vec4f(toLinear(c.rgb), c.a); }
  if (hasScene) {
    let s = textureLoad(scene, p, 0);
    c = vec4f(s.rgb + c.rgb * (1.0 - s.a), s.a + c.a * (1.0 - s.a));
    if (hdr) { c = max(c, vec4f(0.0)); } else { c = clamp(c, vec4f(0.0), vec4f(1.0)); }
  }
  return c;
}
fn openSky(x: f32, y: f32) -> f32 {
  let xi = floor(x);
  let yi = floor(y);
  if (xi < 0.0 || yi < 0.0 || xi >= u.size.x || yi >= u.size.y) { return 0.0; }
  if (all(textureLoad(scene, vec2i(i32(xi), i32(yi)), 0) == vec4f(0.0))) { return 1.0; }
  return 0.0;
}
@compute @workgroup_size(256) fn measure(@builtin(local_invocation_index) tid: u32) {
  let flags = i32(u.size.w);
  let kind = flags & 7;
  let wantLuminance = (flags & 8) == 0;
  let hasScene = (flags & 16) == 0;
  let step = u.size.z;
  let first = floor(step / 2.0);
  let gw = u32(ceil((u.size.x - first) / step));
  let gh = u32(ceil((u.size.y - first) / step));
  var sum = 0.0;
  var count = 0.0;
  if (wantLuminance) {
    for (var i = tid; i < gw * gh; i = i + 256u) {
      let x = first + f32(i % gw) * step;
      let y = first + f32(i / gw) * step;
      let c = composite(vec2i(i32(x), i32(y)), kind, hasScene);
      if (round(clamp(c.a, 0.0, 1.0) * 255.0) == 0.0) { continue; }
      var l = 0.2126 * linear(c.r) + 0.7152 * linear(c.g) + 0.0722 * linear(c.b);
      // Linear light (F0b): its luminance as exposed, before the tone map.
      if (u.hdr.x > 0.5) { l = dot(c.rgb, vec3f(0.2126, 0.7152, 0.0722)) * u.hdr.y; }
      sum = sum + log(max(1e-4, l));
      count = count + 1.0;
    }
  }
  sums[tid] = sum;
  counts[tid] = count;
  workgroupBarrier();
  for (var half = 128u; half > 0u; half = half >> 1u) {
    if (tid < half) {
      sums[tid] = sums[tid] + sums[tid + half];
      counts[tid] = counts[tid] + counts[tid + half];
    }
    workgroupBarrier();
  }
  if (tid == 0u) {
    result[0] = sums[0];
    result[1] = counts[0];
    var open = 0.0;
    var taps = 0.0;
    if (u.sun.w > 0.5) {
      open = openSky(u.sun.x, u.sun.y);
      taps = 1.0;
      for (var ring = 0; ring < 2; ring = ring + 1) {
        let r = select(1.0, 0.5, ring == 0);
        for (var k = 0; k < 8; k = k + 1) {
          let a = f32(k) / 8.0 * 6.28318531 + r;
          open = open + openSky(u.sun.x + cos(a) * u.sun.z * r, u.sun.y + sin(a) * u.sun.z * r);
          taps = taps + 1.0;
        }
      }
    }
    result[2] = open;
    result[3] = taps;
  }
}
`;

// --- The presenter ----------------------------------------------------------

interface Uploaded {
  texture: any;
  width: number;
  height: number;
}

/**
 * Composites and presents frames on one device (see the module comment).
 * Holds its intermediate targets, sized for one frame size; the caller gives
 * the target texture each frame (a canvas's current texture) and its format.
 */
export class GpuPresenter {
  private readonly blank: any;
  private readonly linear: { clamp: any; wrapU: any; repeat: any };
  private readonly layouts: { sky: any; mask: any; gather: any; compose: any; measure: any };
  private readonly pipelines = new Map<string, any>();
  private readonly uniforms: { sky: any; shaft: any; compose: any; measure: any };
  private readonly data = {
    sky: new Float32Array(SKY_UNIFORM_FLOATS),
    shaft: new Float32Array(SHAFT_UNIFORM_FLOATS),
    compose: new Float32Array(COMPOSE_UNIFORM_FLOATS),
    measure: new Float32Array(MEASURE_UNIFORM_FLOATS),
  };
  private skyTarget: any = null;
  /** The composite, when a post stack reads it before the target. */
  private composed: any = null;
  private postFx: GpuPostFx | null = null;
  private shaftTargets: { mask: any; light: any } | null = null;
  private readonly uploads = new Map<string, Uploaded>();
  private panorama: { source: DecodedTexture; texture: any } | null = null;
  private cloudTexture: { sources: readonly BakedCloudLayer[]; texture: any } | null = null;
  private readonly measured: { result: any; staging: any; busy: boolean };
  private latestStats: PresentStats = { luminance: null, luminanceSeq: 0, sunVisible: null, seq: 0 };
  private destroyed = false;

  /** Linear HDR (F0b): the scene, sky and weapon arrive as linear light, and the frame is tone-mapped and encoded here. */
  readonly hdr: boolean;

  constructor(
    private readonly device: any,
    readonly width: number,
    readonly height: number,
    options: { readonly hdr?: boolean } = {},
  ) {
    this.hdr = options.hdr === true;
    this.blank = device.createTexture({ size: { width: 1, height: 1 }, format: "rgba8unorm", usage: USAGE.textureBinding | USAGE.copyDst });
    device.queue.writeTexture({ texture: this.blank }, new Uint8Array(4), { bytesPerRow: 4 }, { width: 1, height: 1 });
    const sampler = (u: string, v: string) => device.createSampler({ magFilter: "linear", minFilter: "linear", addressModeU: u, addressModeV: v });
    this.linear = { clamp: sampler("clamp-to-edge", "clamp-to-edge"), wrapU: sampler("repeat", "clamp-to-edge"), repeat: sampler("repeat", "repeat") };
    const tex = (binding: number, visibility = STAGE_FRAGMENT, viewDimension = "2d") => ({ binding, visibility, texture: { sampleType: "float", viewDimension } });
    const uni = (visibility = STAGE_FRAGMENT) => ({ binding: 0, visibility, buffer: { type: "uniform" } });
    const samp = (binding: number) => ({ binding, visibility: STAGE_FRAGMENT, sampler: { type: "filtering" } });
    const layout = (entries: object[]) => device.createBindGroupLayout({ entries });
    this.layouts = {
      sky: layout([uni(), tex(1), samp(2), tex(3, STAGE_FRAGMENT, "2d-array"), samp(4)]),
      mask: layout([uni(), tex(1), tex(2)]),
      gather: layout([uni(), tex(1)]),
      compose: layout([uni(), tex(1), tex(2), tex(3), samp(4), tex(5), tex(6), tex(7)]),
      measure: layout([uni(STAGE_COMPUTE), tex(1, STAGE_COMPUTE), tex(2, STAGE_COMPUTE), { binding: 3, visibility: STAGE_COMPUTE, buffer: { type: "storage" } }]),
    };
    const ubuf = (floats: number) => device.createBuffer({ size: floats * 4, usage: USAGE.uniform | USAGE.bufferCopyDst });
    this.uniforms = { sky: ubuf(SKY_UNIFORM_FLOATS), shaft: ubuf(SHAFT_UNIFORM_FLOATS), compose: ubuf(COMPOSE_UNIFORM_FLOATS), measure: ubuf(MEASURE_UNIFORM_FLOATS) };
    this.measured = {
      result: device.createBuffer({ size: 16, usage: USAGE.bufferStorage | USAGE.bufferCopySrc }),
      staging: device.createBuffer({ size: 16, usage: USAGE.mapRead | USAGE.bufferCopyDst }),
      busy: false,
    };
  }

  /** The newest measurements to arrive (a frame or two behind the frame that asked). */
  get stats(): PresentStats {
    return this.latestStats;
  }

  /** Composite `frame` into `target` (a texture of `format`, `width × height`) and submit. */
  present(frame: PresentFrame, target: any, format: string): void {
    if (this.destroyed) return;
    const device = this.device;
    const encoder = device.createCommandEncoder();
    const sky = frame.base.kind === "sky" ? frame.base.sky : null;
    const shafts = sky && frame.shafts && frame.shafts.shafts.strength > 0 ? frame.shafts : null;
    // 1. The sky, into its own target: the shafts and the measurements read it too.
    if (sky) {
      const skyFormat = this.hdr ? "rgba16float" : "rgba8unorm";
      this.skyTarget ??= this.target(skyFormat, this.width, this.height);
      device.queue.writeBuffer(this.uniforms.sky, 0, packSkyUniforms(sky, this.width, this.height, this.data.sky, this.hdr));
      this.fullScreen(encoder, "sky", skyFormat, SKY_WGSL, this.skyTarget, [
        { binding: 0, resource: { buffer: this.uniforms.sky } },
        { binding: 1, resource: this.panoramaFor(sky.map).createView() },
        { binding: 2, resource: this.linear.wrapU },
        { binding: 3, resource: this.cloudsFor(sky.clouds).createView({ dimension: "2d-array" }) },
        { binding: 4, resource: this.linear.repeat },
      ]);
    }
    const base = sky ? this.skyTarget : frame.base.kind === "frame" ? this.upload("base", frame.base.rgba) : this.blank;
    const scene = frame.scene ?? this.blank;
    // 2. The shafts: their source a cell at a time, then the gather toward the sun.
    let light = this.blank;
    if (shafts) {
      const grid = shaftGrid(this.width, this.height);
      this.shaftTargets ??= { mask: this.target("r16float", grid.width, grid.height), light: this.target("r16float", grid.width, grid.height) };
      device.queue.writeBuffer(this.uniforms.shaft, 0, packShaftUniforms(shafts.sun, shafts.shafts, shafts.color, this.width, this.height, this.data.shaft, this.hdr));
      this.fullScreen(encoder, "mask", "r16float", SHAFT_MASK_WGSL, this.shaftTargets.mask, [
        { binding: 0, resource: { buffer: this.uniforms.shaft } },
        { binding: 1, resource: scene.createView() },
        { binding: 2, resource: this.skyTarget.createView() },
      ]);
      this.fullScreen(encoder, "gather", "r16float", SHAFT_GATHER_WGSL, this.shaftTargets.light, [
        { binding: 0, resource: { buffer: this.uniforms.shaft } },
        { binding: 1, resource: this.shaftTargets.mask.createView() },
      ]);
      light = this.shaftTargets.light;
    }
    // 3. Everything over everything: into the target, or for the post stack to read.
    const post = frame.post ?? null;
    if (post) this.composed ??= this.target("rgba8unorm", this.width, this.height);
    device.queue.writeBuffer(this.uniforms.compose, 0, packComposeUniforms(frame, this.width, this.height, this.data.compose, this.hdr));
    this.fullScreen(encoder, "compose", post ? "rgba8unorm" : format, COMPOSE_WGSL, post ? this.composed : target, [
      { binding: 0, resource: { buffer: this.uniforms.compose } },
      { binding: 1, resource: base.createView() },
      { binding: 2, resource: scene.createView() },
      { binding: 3, resource: light.createView() },
      { binding: 4, resource: this.linear.clamp },
      { binding: 5, resource: (frame.front ?? this.blank).createView() },
      { binding: 6, resource: (frame.hud ? this.upload("hud", frame.hud) : this.blank).createView() },
      { binding: 7, resource: (frame.holo ? this.upload("holo", frame.holo) : this.blank).createView() },
    ]);
    // 4. The post stack, from the composite into the target.
    if (post) {
      this.postFx ??= new GpuPostFx(device, this.width, this.height);
      this.postFx.encode(encoder, this.composed, target, format, post.uniforms, post.time);
    }
    // 5. The measurements, when asked for and the last ones have been read.
    const measure = frame.measure && (frame.measure.luminance || frame.measure.sun) && !this.measured.busy ? frame.measure : null;
    if (measure) {
      device.queue.writeBuffer(this.uniforms.measure, 0, packMeasureUniforms(frame, this.width, this.height, this.data.measure, this.hdr));
      const pipeline = this.pipeline("measure", "", MEASURE_WGSL);
      const pass = encoder.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(
        0,
        device.createBindGroup({
          layout: this.layouts.measure,
          entries: [
            { binding: 0, resource: { buffer: this.uniforms.measure } },
            { binding: 1, resource: base.createView() },
            { binding: 2, resource: scene.createView() },
            { binding: 3, resource: { buffer: this.measured.result } },
          ],
        }),
      );
      pass.dispatchWorkgroups(1);
      pass.end();
      encoder.copyBufferToBuffer(this.measured.result, 0, this.measured.staging, 0, 16);
    }
    device.queue.submit([encoder.finish()]);
    if (measure) void this.readMeasurements(measure.luminance, measure.sun !== null);
  }

  /** Release every resource this presenter made. */
  dispose(): void {
    this.destroyed = true;
    const destroy = (t: any) => t?.destroy?.();
    destroy(this.blank);
    destroy(this.skyTarget);
    destroy(this.composed);
    this.postFx?.dispose();
    destroy(this.shaftTargets?.mask);
    destroy(this.shaftTargets?.light);
    destroy(this.panorama?.texture);
    destroy(this.cloudTexture?.texture);
    for (const u of this.uploads.values()) destroy(u.texture);
    for (const b of Object.values(this.uniforms)) destroy(b);
    destroy(this.measured.result);
    destroy(this.measured.staging);
  }

  private async readMeasurements(luminance: boolean, sun: boolean): Promise<void> {
    const m = this.measured;
    m.busy = true;
    try {
      await m.staging.mapAsync(USAGE.mapRead);
      if (this.destroyed) return;
      const [sum, count, open, taps] = Array.from(new Float32Array(m.staging.getMappedRange().slice(0)));
      m.staging.unmap();
      const prev = this.latestStats;
      this.latestStats = {
        luminance: luminance ? (count! > 0 ? Math.exp(sum! / count!) : AUTO_KEY_FALLBACK) : prev.luminance,
        luminanceSeq: prev.luminanceSeq + (luminance ? 1 : 0),
        sunVisible: sun ? (taps! > 0 ? open! / taps! : 0) : prev.sunVisible,
        seq: prev.seq + 1,
      };
    } catch {
      // A failed map is a measurement missed; the last ones stand.
    } finally {
      m.busy = false;
    }
  }

  private target(format: string, width: number, height: number): any {
    return this.device.createTexture({ size: { width, height }, format, usage: USAGE.renderAttachment | USAGE.textureBinding });
  }

  /** A CPU frame (RGBA8, this presenter's size) uploaded into its named slot. */
  private upload(slot: string, rgba: Uint8Array | Uint8ClampedArray): any {
    let entry = this.uploads.get(slot);
    if (!entry) {
      entry = {
        texture: this.device.createTexture({ size: { width: this.width, height: this.height }, format: "rgba8unorm", usage: USAGE.textureBinding | USAGE.copyDst }),
        width: this.width,
        height: this.height,
      };
      this.uploads.set(slot, entry);
    }
    const bytes = rgba instanceof Uint8Array ? rgba : new Uint8Array(rgba.buffer, rgba.byteOffset, rgba.byteLength);
    this.device.queue.writeTexture({ texture: entry.texture }, bytes, { bytesPerRow: this.width * 4, rowsPerImage: this.height }, { width: this.width, height: this.height });
    return entry.texture;
  }

  /** The panorama uploaded once per distinct map. */
  private panoramaFor(map: DecodedTexture): any {
    if (this.panorama?.source === map) return this.panorama.texture;
    this.panorama?.texture.destroy?.();
    const texture = this.device.createTexture({ size: { width: map.width, height: map.height }, format: "rgba8unorm", usage: USAGE.textureBinding | USAGE.copyDst });
    this.device.queue.writeTexture({ texture }, map.data, { bytesPerRow: map.width * 4, rowsPerImage: map.height }, { width: map.width, height: map.height });
    this.panorama = { source: map, texture };
    return texture;
  }

  /** The cloud layers' density tiles as one texture array (one blank layer for none), uploaded when the layers change. */
  private cloudsFor(layers: readonly BakedCloudLayer[]): any {
    const shown = layers.slice(0, MAX_CLOUD_LAYERS);
    const cached = this.cloudTexture;
    if (cached && cached.sources.length === shown.length && cached.sources.every((l, i) => l === shown[i])) return cached.texture;
    cached?.texture.destroy?.();
    const size = CLOUD_TILE_SIZE;
    const count = Math.max(1, shown.length);
    const texture = this.device.createTexture({ size: { width: size, height: size, depthOrArrayLayers: count }, format: "r8unorm", usage: USAGE.textureBinding | USAGE.copyDst });
    shown.forEach((layer, i) => {
      const bytes = new Uint8Array(size * size);
      for (let k = 0; k < bytes.length; k += 1) bytes[k] = Math.round(Math.max(0, Math.min(1, layer.density[k] ?? 0)) * 255);
      this.device.queue.writeTexture({ texture, origin: { x: 0, y: 0, z: i } }, bytes, { bytesPerRow: size, rowsPerImage: size }, { width: size, height: size, depthOrArrayLayers: 1 });
    });
    this.cloudTexture = { sources: shown, texture };
    return texture;
  }

  private pipeline(name: keyof GpuPresenter["layouts"], format: string, code: string): any {
    const key = `${name}|${format}`;
    let pipeline = this.pipelines.get(key);
    if (!pipeline) {
      const module = this.device.createShaderModule({ code });
      const layout = this.device.createPipelineLayout({ bindGroupLayouts: [this.layouts[name]] });
      pipeline =
        name === "measure"
          ? this.device.createComputePipeline({ layout, compute: { module, entryPoint: "measure" } })
          : this.device.createRenderPipeline({
              layout,
              vertex: { module, entryPoint: "vs" },
              fragment: { module, entryPoint: name, targets: [{ format }] },
              primitive: { topology: "triangle-list" },
            });
      this.pipelines.set(key, pipeline);
    }
    return pipeline;
  }

  private fullScreen(encoder: any, name: "sky" | "mask" | "gather" | "compose", format: string, code: string, target: any, entries: object[]): void {
    const pipeline = this.pipeline(name, format, code);
    const pass = encoder.beginRenderPass({
      colorAttachments: [{ view: target.createView(), clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: "clear", storeOp: "store" }],
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, this.device.createBindGroup({ layout: this.layouts[name], entries }));
    pass.draw(3);
    pass.end();
  }
}
