/**
 * The post-process stack on WebGPU (AAA_FIDELITY_ROADMAP.md F0a, ahead of
 * F4e): the same effect chain as {@link PostFxPass}, ported to WGSL, so a frame
 * presented from the GPU is post-processed where it already is instead of
 * being copied into a WebGL context first.
 *
 * It is a port, not a redesign: the main pass is PostFxPass's fragment shader
 * effect for effect and in the same order (kaleidoscope, curvature,
 * aberration, tilt-shift, wet-floor reflection, bloom, god rays, streaks, lens
 * flare, tone map, grade, split tone, LUT, dither, posterize, halftone, fog,
 * vignette, grain, scanlines), reading the same {@link PostFxUniforms}; the
 * bloom is BloomPyramid's soft-knee prefilter and dual-Kawase pyramid in
 * half-float targets. So one artist's settings look the same on either path.
 * The two places GLSL and WGSL differ in meaning are spelt out: GLSL's
 * `mod` floors where WGSL's `%` truncates, and the inverted `smoothstep` the
 * lens ghosts use is written out as GLSL evaluates it.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { timingSpan, type PassContext } from "../render/frameGraph.js";
import { BLOOM_KNEE, pyramidLevelCount, pyramidLevelSize } from "./bloomModel.js";
import { FLARE_GHOSTS, FLARE_GHOST_GAIN, FLARE_SPIKE_POWER } from "./flareModel.js";
import { lutStrip, type GradingLut } from "./lutModel.js";
import type { PostFxUniforms } from "./postfx.js";

const f = (n: number) => n.toFixed(4);

/** Floats in the main pass's uniform block. */
export const POST_UNIFORM_FLOATS = 19 * 4;

/**
 * The main pass's uniforms, in the WGSL struct's order. `peak` is the
 * brightest the target shows (F4e): 1 for SDR, more for an HDR display, whose
 * highlights the stack carries past white instead of clipping.
 */
export function packPostUniforms(
  u: PostFxUniforms,
  width: number,
  height: number,
  time: number,
  hasBloom: boolean,
  out = new Float32Array(POST_UNIFORM_FLOATS),
  peak = 1,
): Float32Array {
  const rows: number[][] = [
    [width, height, time, hasBloom ? 1 : 0],
    [u.brightness, u.contrast, u.saturation, u.toneMap],
    [u.exposure, u.lut?.size ?? 2, u.lut ? u.lutStrength : 0, 0],
    [u.fogColor[0], u.fogColor[1], u.fogColor[2], u.fogDensity],
    [u.fogHorizon, u.bloomStrength, u.bloomThreshold, u.curvature],
    [u.scanlines, u.aberration, u.vignette, u.posterize],
    [u.ditherAmount, u.ditherScale, u.halftoneStrength, u.halftoneScale],
    [u.halftoneAngle, u.godrayStrength, u.godrayDensity, u.godrayDecay],
    [u.godrayOrigin[0], u.godrayOrigin[1], u.streakStrength, u.streakLength],
    [u.flareGlare, u.flareGhosts, u.flareSize, u.flareVisible],
    [u.flareColor[0], u.flareColor[1], u.flareColor[2], 0],
    [u.flareOrigin[0], u.flareOrigin[1], 0, 0],
    [u.splitStrength, u.splitBalance, 0, 0],
    [u.splitShadows[0], u.splitShadows[1], u.splitShadows[2], 0],
    [u.splitHighlights[0], u.splitHighlights[1], u.splitHighlights[2], 0],
    [u.reflectionStrength, u.reflectionHorizon, u.reflectionFalloff, u.reflectionWobble],
    [u.tiltStrength, u.tiltFocus, u.tiltRange, 0],
    [u.kaleidoSegments, u.kaleidoAngle, u.grainAmount, u.grainSize],
    [peak, peak > 1 ? 1 : 0, 0, 0],
  ];
  rows.forEach((row, i) => out.set(row, i * 4));
  return out;
}

const FULLSCREEN_VS = /* wgsl */ `
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  let x = f32((i << 1u) & 2u);
  let y = f32(i & 2u);
  return vec4f(x * 2.0 - 1.0, 1.0 - y * 2.0, 0.0, 1.0);
}
`;

const GHOST_TERMS = FLARE_GHOSTS.map(
  (g) => `      flare = flare + vec3f(${f(g.tint[0])}, ${f(g.tint[1])}, ${f(g.tint[2])}) * flareGhost(uv, ${f(g.along)}, ${f(g.radius)}, aspect);`,
).join("\n");

/** PostFxPass's fragment shader, in WGSL. */
export const POST_WGSL = /* wgsl */ `
struct Post {
  size: vec4f,
  grade: vec4f,
  grade2: vec4f,
  fog: vec4f,
  fog2: vec4f,
  screen: vec4f,
  dither: vec4f,
  half: vec4f,
  godray: vec4f,
  flare: vec4f,
  flareColor: vec4f,
  flareOrigin: vec4f,
  split: vec4f,
  splitShadows: vec4f,
  splitHighlights: vec4f,
  reflect: vec4f,
  tilt: vec4f,
  kaleido: vec4f,
  range: vec4f, // F4e: x = the brightest the target shows (1 for SDR), y = 1 when that is past white (an HDR display)
};
@group(0) @binding(0) var<uniform> u: Post;
@group(0) @binding(1) var source: texture_2d<f32>;
@group(0) @binding(2) var nearestClamp: sampler;
@group(0) @binding(3) var bloomTex: texture_2d<f32>;
@group(0) @binding(4) var linearClamp: sampler;
@group(0) @binding(5) var lut: texture_2d<f32>;
${FULLSCREEN_VS}
const TAU = 6.2831853;

fn src(uv: vec2f) -> vec3f { return textureSampleLevel(source, nearestClamp, uv, 0.0).rgb; }
fn luma(c: vec3f) -> f32 { return dot(c, vec3f(0.299, 0.587, 0.114)); }
// GLSL's smoothstep as it evaluates, edges in either order.
fn glslSmoothstep(e0: f32, e1: f32, x: f32) -> f32 {
  let t = clamp((x - e0) / (e1 - e0), 0.0, 1.0);
  return t * t * (3.0 - 2.0 * t);
}
// GLSL's mod: floored, so a negative angle wraps rather than mirrors.
fn gmod(x: f32, y: f32) -> f32 { return x - y * floor(x / y); }
fn brightPass(uv: vec2f) -> vec3f {
  let c = src(uv);
  return c * glslSmoothstep(u.fog2.z, 1.0, luma(c));
}
fn acesFilmic(x: vec3f) -> vec3f {
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), vec3f(0.0), vec3f(1.0));
}
fn bayer2(a: vec2f) -> f32 {
  let b = floor(a);
  return fract(b.x * 0.5 + b.y * b.y * 0.75);
}
fn bayer4(a: vec2f) -> f32 { return bayer2(a * 0.5) * 0.25 + bayer2(a); }
fn bayer8(a: vec2f) -> f32 { return bayer4(a * 0.5) * 0.25 + bayer2(a); }
fn flareGhost(uv: vec2f, along: f32, radius: f32, aspect: f32) -> f32 {
  let centre = vec2f(0.5) + (u.flareOrigin.xy - vec2f(0.5)) * along;
  let d = (centre - uv) * vec2f(aspect, 1.0);
  return glslSmoothstep(radius, radius * 0.6, length(d)) * u.flare.y * ${FLARE_GHOST_GAIN.toFixed(4)};
}
fn hash12(p: vec2f) -> f32 { return fract(sin(dot(p, vec2f(12.9898, 78.233))) * 43758.5453); }

@fragment fn post(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let size = u.size.xy;
  // Screen UV with a top-left origin, as the WebGL pass's vUv.
  var folded = pos.xy / size;

  if (u.kaleido.x >= 2.0) {
    let offset = folded - 0.5;
    let radius = length(offset);
    let segment = TAU / u.kaleido.x;
    var angle = gmod(atan2(offset.y, offset.x) + u.kaleido.y, segment);
    angle = abs(angle - segment * 0.5);
    folded = clamp(vec2f(cos(angle), sin(angle)) * radius + 0.5, vec2f(0.0), vec2f(1.0));
  }

  let centered = folded - 0.5;
  let uv = folded + centered * dot(centered, centered) * u.fog2.w * 4.0;
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) { return vec4f(0.0, 0.0, 0.0, 1.0); }

  let fringe = centered * u.screen.y / size;
  var color = vec3f(src(uv + fringe).r, src(uv).g, src(uv - fringe).b);

  if (u.tilt.x > 0.0) {
    let outside = abs(uv.y - u.tilt.y) - max(u.tilt.z, 0.0);
    let blurAmount = clamp(outside / 0.35, 0.0, 1.0) * u.tilt.x;
    if (blurAmount > 0.001) {
      let radius = blurAmount * 6.0;
      let texel = 1.0 / size;
      var blurred = color;
      var total = 1.0;
      for (var i = 0; i < 10; i = i + 1) {
        let a = f32(i) / 10.0 * TAU;
        let dir = vec2f(cos(a), sin(a));
        blurred = blurred + src(uv + dir * radius * texel);
        blurred = blurred + src(uv + dir * (radius * 0.5) * texel);
        total = total + 2.0;
      }
      color = mix(color, blurred / total, clamp(blurAmount, 0.0, 1.0));
    }
  }

  if (u.reflect.x > 0.0) {
    let below = uv.y - u.reflect.y;
    if (below > 0.0) {
      let ripple = sin(uv.x * 40.0 + u.size.z * 2.2) * u.reflect.w * 0.02 * below / max(u.reflect.z, 0.001);
      let rUv = clamp(vec2f(uv.x + ripple, u.reflect.y - below), vec2f(0.0), vec2f(1.0));
      let fade = u.reflect.x * clamp(1.0 - below / max(u.reflect.z, 0.001), 0.0, 1.0);
      color = mix(color, src(rUv), fade);
    }
  }

  if (u.fog2.y > 0.0) {
    var glow = vec3f(0.0);
    if (u.size.w > 0.5) {
      glow = textureSampleLevel(bloomTex, linearClamp, uv, 0.0).rgb;
    } else {
      let texel = 1.0 / size;
      for (var dy = -1; dy <= 1; dy = dy + 1) {
        for (var dx = -1; dx <= 1; dx = dx + 1) {
          var weight = 0.0625;
          if (dx == 0 && dy == 0) { weight = 0.25; } else if (dx == 0 || dy == 0) { weight = 0.125; }
          glow = glow + brightPass(uv + vec2f(f32(dx), f32(dy)) * texel) * weight;
        }
      }
    }
    color = color + glow * u.fog2.y;
  }

  if (u.half.y > 0.0) {
    let marchStep = (uv - u.godray.xy) * u.half.z / 16.0;
    var probe = uv;
    var decay = 1.0;
    var shafts = vec3f(0.0);
    for (var i = 0; i < 16; i = i + 1) {
      probe = probe - marchStep;
      shafts = shafts + brightPass(clamp(probe, vec2f(0.0), vec2f(1.0))) * decay;
      decay = decay * u.half.w;
    }
    color = color + shafts * (u.half.y / 16.0);
  }

  if (u.godray.z > 0.0) {
    let reach = u.godray.w * 0.25;
    var streak = vec3f(0.0);
    var total = 0.0;
    for (var i = 1; i <= 8; i = i + 1) {
      let distance = f32(i) / 8.0;
      let weight = 1.0 - distance;
      let offset = vec2f(reach * distance, 0.0);
      streak = streak + (brightPass(clamp(uv + offset, vec2f(0.0), vec2f(1.0))) + brightPass(clamp(uv - offset, vec2f(0.0), vec2f(1.0)))) * weight;
      total = total + weight * 2.0;
    }
    color = color + streak * (u.godray.z / max(total, 1.0));
  }

  if ((u.flare.x > 0.0 || u.flare.y > 0.0) && u.flare.w > 0.0) {
    let aspect = size.x / size.y;
    let d = (uv - u.flareOrigin.xy) * vec2f(aspect, 1.0);
    let r = length(d);
    let fsize = max(0.01, u.flare.z);
    let glow = exp(-(r * r) / (fsize * fsize));
    let spikes = pow(abs(cos(atan2(d.y, d.x) * 3.0)), ${FLARE_SPIKE_POWER.toFixed(1)}) * exp(-r / (fsize * 2.5));
    var flare = vec3f(u.flare.x * (glow + spikes * 0.6));
    if (u.flare.y > 0.0) {
${GHOST_TERMS}
    }
    color = color + flare * min(u.flare.w, 1.0) * u.flareColor.rgb;
  }

  if (u.grade.w > 0.5) { color = acesFilmic(color * u.grade2.x); }

  color = color * u.grade.x;
  color = (color - 0.5) * u.grade.y + 0.5;
  color = mix(vec3f(luma(color)), color, u.grade.z);

  if (u.split.x > 0.0) {
    let tone = glslSmoothstep(u.split.y - 0.25, u.split.y + 0.25, luma(color));
    let tint = mix(u.splitShadows.rgb, u.splitHighlights.rgb, tone) * 2.0;
    color = mix(color, color * tint, u.split.x);
  }

  if (u.grade2.z > 0.0) {
    let c = clamp(color, vec3f(0.0), vec3f(1.0));
    let n = u.grade2.y;
    let slice = c.b * (n - 1.0);
    let b0 = floor(slice);
    let b1 = min(b0 + 1.0, n - 1.0);
    let x = c.r * (n - 1.0) + 0.5;
    let y = (c.g * (n - 1.0) + 0.5) / n;
    let lo = textureSampleLevel(lut, linearClamp, vec2f((b0 * n + x) / (n * n), y), 0.0).rgb;
    let hi = textureSampleLevel(lut, linearClamp, vec2f((b1 * n + x) / (n * n), y), 0.0).rgb;
    // On an HDR display the LUT grades the displayable range and the highlight past it rides along.
    color = mix(color, mix(lo, hi, slice - b0) + (color - c) * u.range.y, u.grade2.z);
  }

  if (u.dither.x > 0.0 && u.screen.w >= 2.0) {
    let cell = floor(uv * size / max(u.dither.y, 1.0));
    color = color + (bayer8(cell) - 0.5) * (u.dither.x / u.screen.w);
  }

  if (u.screen.w >= 2.0) {
    color = floor(color * u.screen.w) / (u.screen.w - 1.0);
    color = min(color, vec3f(u.range.x));
  }

  if (u.dither.z > 0.0) {
    let grid = uv * size / max(u.dither.w, 1.0);
    let sinA = sin(u.half.x);
    let cosA = cos(u.half.x);
    let rotated = vec2f(grid.x * cosA - grid.y * sinA, grid.x * sinA + grid.y * cosA);
    let radius = sqrt(clamp(luma(color), 0.0, 1.0)) * 0.7;
    let ink = step(length(fract(rotated) - 0.5), radius);
    color = mix(color, color * mix(0.15, 1.0, ink), u.dither.z);
  }

  let fogAmount = u.fog.w * (1.0 - glslSmoothstep(u.fog2.x - 0.35, u.fog2.x + 0.35, uv.y));
  color = mix(color, u.fog.rgb, clamp(fogAmount, 0.0, 1.0));

  let falloff = 1.0 - u.screen.z * glslSmoothstep(0.25, 0.75, dot(centered, centered) * 2.0);
  color = color * falloff;

  if (u.kaleido.z > 0.0) {
    let grainCell = floor(uv * size / max(u.kaleido.w, 1.0));
    color = color + (hash12(grainCell + fract(u.size.z) * 71.0) - 0.5) * u.kaleido.z;
  }

  let scan = 1.0 - u.screen.x * 0.25 * (1.0 + sin(uv.y * size.y * 3.14159));
  color = color * scan;

  return vec4f(clamp(color, vec3f(0.0), vec3f(u.range.x)), 1.0);
}
`;

const BLOOM_HEAD = /* wgsl */ `
struct Bloom {
  texel: vec4f,
  params: vec4f,
};
@group(0) @binding(0) var<uniform> b: Bloom;
@group(0) @binding(1) var tex: texture_2d<f32>;
@group(0) @binding(2) var linearClamp: sampler;
${FULLSCREEN_VS}
fn at(uv: vec2f) -> vec3f { return textureSampleLevel(tex, linearClamp, uv, 0.0).rgb; }
`;

/** BloomPyramid's bright pass: a 4-tap box of the source, through the soft knee. */
export const BLOOM_PREFILTER_WGSL = /* wgsl */ `
${BLOOM_HEAD}
fn prefilter(c: vec3f) -> vec3f {
  let brightest = max(c.r, max(c.g, c.b));
  let kneeWidth = max(b.params.y, 1e-4);
  var soft = brightest - b.params.x + kneeWidth;
  soft = clamp(soft, 0.0, 2.0 * kneeWidth);
  soft = soft * soft / (4.0 * kneeWidth + 1e-4);
  let contribution = max(soft, brightest - b.params.x) / max(brightest, 1e-4);
  return c * max(contribution, 0.0);
}
@fragment fn prefilterPass(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let uv = pos.xy * b.texel.zw;
  let o = b.texel.xy * 0.5;
  var sum = at(uv + vec2f(o.x, o.y));
  sum = sum + at(uv + vec2f(-o.x, o.y));
  sum = sum + at(uv + vec2f(o.x, -o.y));
  sum = sum + at(uv + vec2f(-o.x, -o.y));
  return vec4f(prefilter(sum * 0.25), 1.0);
}
`;

/** BloomPyramid's dual-Kawase downsample. */
export const BLOOM_DOWN_WGSL = /* wgsl */ `
${BLOOM_HEAD}
@fragment fn downPass(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let uv = pos.xy * b.texel.zw;
  let h = b.texel.xy * 0.5;
  var sum = at(uv) * 4.0;
  sum = sum + at(uv - h);
  sum = sum + at(uv + h);
  sum = sum + at(uv + vec2f(h.x, -h.y));
  sum = sum + at(uv - vec2f(h.x, -h.y));
  return vec4f(sum / 8.0, 1.0);
}
`;

/** BloomPyramid's dual-Kawase upsample (blended additively onto the finer level). */
export const BLOOM_UP_WGSL = /* wgsl */ `
${BLOOM_HEAD}
@fragment fn upPass(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let uv = pos.xy * b.texel.zw;
  let s = b.texel.xy * 0.5 * (0.5 + b.params.z);
  var sum = at(uv + vec2f(-s.x * 2.0, 0.0));
  sum = sum + at(uv + vec2f(-s.x, s.y)) * 2.0;
  sum = sum + at(uv + vec2f(0.0, s.y * 2.0));
  sum = sum + at(uv + vec2f(s.x, s.y)) * 2.0;
  sum = sum + at(uv + vec2f(s.x * 2.0, 0.0));
  sum = sum + at(uv + vec2f(s.x, -s.y)) * 2.0;
  sum = sum + at(uv + vec2f(0.0, -s.y * 2.0));
  sum = sum + at(uv + vec2f(-s.x, -s.y)) * 2.0;
  return vec4f(sum / 12.0, 1.0);
}
`;

const USAGE = { copyDst: 0x02, textureBinding: 0x04, renderAttachment: 0x10, uniform: 0x40, bufferCopyDst: 0x08 } as const;
const STAGE_FRAGMENT = 0x2;

interface Level {
  texture: any;
  width: number;
  height: number;
  uniforms: any;
}

/** The post stack on one device, for frames of one size (see the module comment). */
export class GpuPostFx {
  private readonly layouts: { post: any; bloom: any };
  private readonly pipelines = new Map<string, any>();
  private readonly samplers: { nearest: any; linear: any };
  private readonly uniformBuffer: any;
  private readonly data = new Float32Array(POST_UNIFORM_FLOATS);
  private readonly blank: any;
  private levels: Level[] = [];
  private lut: { source: GradingLut; texture: any } | null = null;

  constructor(
    private readonly device: any,
    readonly width: number,
    readonly height: number,
  ) {
    const tex = (binding: number) => ({ binding, visibility: STAGE_FRAGMENT, texture: { sampleType: "float" } });
    const samp = (binding: number) => ({ binding, visibility: STAGE_FRAGMENT, sampler: { type: "filtering" } });
    const uni = { binding: 0, visibility: STAGE_FRAGMENT, buffer: { type: "uniform" } };
    this.layouts = {
      post: device.createBindGroupLayout({ entries: [uni, tex(1), samp(2), tex(3), samp(4), tex(5)] }),
      bloom: device.createBindGroupLayout({ entries: [uni, tex(1), samp(2)] }),
    };
    const sampler = (filter: string) => device.createSampler({ magFilter: filter, minFilter: filter, addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge" });
    this.samplers = { nearest: sampler("nearest"), linear: sampler("linear") };
    this.uniformBuffer = device.createBuffer({ size: POST_UNIFORM_FLOATS * 4, usage: USAGE.uniform | USAGE.bufferCopyDst });
    this.blank = device.createTexture({ size: { width: 1, height: 1 }, format: "rgba8unorm", usage: USAGE.textureBinding | USAGE.copyDst });
    device.queue.writeTexture({ texture: this.blank }, new Uint8Array([0, 0, 0, 255]), { bytesPerRow: 4 }, { width: 1, height: 1 });
  }

  /**
   * Encode the stack: `source` (this size; RGBA8, or half-float at full
   * precision on the AAA tier) through every effect into `target` (of
   * `format`). `peak` is the brightest the target shows (see
   * {@link packPostUniforms}); `timing` (a frame graph pass's) spans every
   * pass the stack encodes.
   */
  encode(
    encoder: any,
    source: any,
    target: any,
    format: string,
    uniforms: PostFxUniforms,
    time: number,
    options: { readonly peak?: number; readonly timing?: PassContext["timing"] } = {},
  ): void {
    const device = this.device;
    const timing = options.timing ?? {};
    const blooms = uniforms.bloomStrength > 0;
    // The bright pass, the downsamples and the upsamples, then the stack itself.
    const passes = (blooms ? 2 * pyramidLevelCount(this.width, this.height) - 1 : 0) + 1;
    let bloom: any = null;
    if (blooms) bloom = this.encodeBloom(encoder, source, uniforms.bloomThreshold, uniforms.bloomRadius, (i) => timingSpan(timing, i, passes));
    device.queue.writeBuffer(this.uniformBuffer, 0, packPostUniforms(uniforms, this.width, this.height, time, bloom !== null, this.data, options.peak ?? 1));
    const pass = encoder.beginRenderPass({
      colorAttachments: [{ view: target.createView(), clearValue: { r: 0, g: 0, b: 0, a: 1 }, loadOp: "clear", storeOp: "store" }],
      ...timingSpan(timing, passes - 1, passes),
    });
    pass.setPipeline(this.pipeline("post", format, POST_WGSL, "post", false));
    pass.setBindGroup(
      0,
      device.createBindGroup({
        layout: this.layouts.post,
        entries: [
          { binding: 0, resource: { buffer: this.uniformBuffer } },
          { binding: 1, resource: source.createView() },
          { binding: 2, resource: this.samplers.nearest },
          { binding: 3, resource: (bloom ?? this.blank).createView() },
          { binding: 4, resource: this.samplers.linear },
          { binding: 5, resource: this.lutTexture(uniforms.lut).createView() },
        ],
      }),
    );
    pass.draw(3);
    pass.end();
  }

  dispose(): void {
    for (const level of this.levels) {
      level.texture.destroy?.();
      level.uniforms.destroy?.();
    }
    this.levels = [];
    for (const buffer of this.upUniforms.values()) buffer.destroy?.();
    this.lut?.texture.destroy?.();
    this.blank.destroy?.();
    this.uniformBuffer.destroy?.();
  }

  /** BloomPyramid.generate on the GPU: prefilter into level 0, blur down the chain, fold back up additively. */
  private encodeBloom(encoder: any, source: any, threshold: number, radius: number, span: (index: number) => object): any {
    if (this.levels.length === 0) {
      const count = pyramidLevelCount(this.width, this.height);
      for (let i = 0; i < count; i += 1) {
        const { width, height } = pyramidLevelSize(this.width, this.height, i);
        this.levels.push({
          texture: this.device.createTexture({ size: { width, height }, format: "rgba16float", usage: USAGE.renderAttachment | USAGE.textureBinding }),
          width,
          height,
          uniforms: this.device.createBuffer({ size: 32, usage: USAGE.uniform | USAGE.bufferCopyDst }),
        });
      }
    }
    const levels = this.levels;
    let index = 0;
    const draw = (name: "prefilter" | "down" | "up", code: string, entry: string, target: Level, input: any, inputTexel: [number, number], params: [number, number, number, number], blend: boolean) => {
      this.device.queue.writeBuffer(target.uniforms, 0, new Float32Array([inputTexel[0], inputTexel[1], 1 / target.width, 1 / target.height, ...params]));
      const pass = encoder.beginRenderPass({
        colorAttachments: [{ view: target.texture.createView(), clearValue: { r: 0, g: 0, b: 0, a: 1 }, loadOp: blend ? "load" : "clear", storeOp: "store" }],
        ...span(index++),
      });
      pass.setPipeline(this.pipeline(name, "rgba16float", code, entry, blend));
      pass.setBindGroup(
        0,
        this.device.createBindGroup({
          layout: this.layouts.bloom,
          entries: [
            { binding: 0, resource: { buffer: target.uniforms } },
            { binding: 1, resource: input.createView() },
            { binding: 2, resource: this.samplers.linear },
          ],
        }),
      );
      pass.draw(3);
      pass.end();
    };
    // A buffer written twice before the submit keeps only the last write, so
    // each pass reads a block of its own: the bright pass and the downsamples
    // their target level's, the upsamples theirs (see drawUp).
    draw("prefilter", BLOOM_PREFILTER_WGSL, "prefilterPass", levels[0]!, source, [1 / this.width, 1 / this.height], [threshold, BLOOM_KNEE, 0, 0], false);
    for (let i = 1; i < levels.length; i += 1) {
      const finer = levels[i - 1]!;
      draw("down", BLOOM_DOWN_WGSL, "downPass", levels[i]!, finer.texture, [1 / finer.width, 1 / finer.height], [0, 0, 0, 0], false);
    }
    for (let i = levels.length - 2; i >= 0; i -= 1) this.drawUp(encoder, i, radius, span(index++));
    return levels[0]!.texture;
  }

  /** Each upsample step's uniform block, by the level it adds onto. */
  private readonly upUniforms = new Map<number, any>();

  /** One upsample step: level `index + 1`'s tent, added onto level `index`. */
  private drawUp(encoder: any, index: number, radius: number, timing: object): void {
    const target = this.levels[index]!;
    const coarser = this.levels[index + 1]!;
    let buffer = this.upUniforms.get(index);
    if (!buffer) {
      buffer = this.device.createBuffer({ size: 32, usage: USAGE.uniform | USAGE.bufferCopyDst });
      this.upUniforms.set(index, buffer);
    }
    this.device.queue.writeBuffer(buffer, 0, new Float32Array([1 / coarser.width, 1 / coarser.height, 1 / target.width, 1 / target.height, 0, 0, radius, 0]));
    const pass = encoder.beginRenderPass({ colorAttachments: [{ view: target.texture.createView(), loadOp: "load", storeOp: "store" }], ...timing });
    pass.setPipeline(this.pipeline("up", "rgba16float", BLOOM_UP_WGSL, "upPass", true));
    pass.setBindGroup(
      0,
      this.device.createBindGroup({
        layout: this.layouts.bloom,
        entries: [
          { binding: 0, resource: { buffer } },
          { binding: 1, resource: coarser.texture.createView() },
          { binding: 2, resource: this.samplers.linear },
        ],
      }),
    );
    pass.draw(3);
    pass.end();
  }

  private lutTexture(lut: GradingLut | null): any {
    if (!lut) return this.blank;
    if (this.lut?.source === lut) return this.lut.texture;
    this.lut?.texture.destroy?.();
    const strip = lutStrip(lut);
    const texture = this.device.createTexture({ size: { width: strip.width, height: strip.height }, format: "rgba8unorm", usage: USAGE.textureBinding | USAGE.copyDst });
    this.device.queue.writeTexture({ texture }, strip.data, { bytesPerRow: strip.width * 4, rowsPerImage: strip.height }, { width: strip.width, height: strip.height });
    this.lut = { source: lut, texture };
    return texture;
  }

  private pipeline(name: string, format: string, code: string, entry: string, additive: boolean): any {
    const key = `${name}|${format}|${additive}`;
    let pipeline = this.pipelines.get(key);
    if (!pipeline) {
      const module = this.device.createShaderModule({ code });
      pipeline = this.device.createRenderPipeline({
        layout: this.device.createPipelineLayout({ bindGroupLayouts: [name === "post" ? this.layouts.post : this.layouts.bloom] }),
        vertex: { module, entryPoint: "vs" },
        fragment: {
          module,
          entryPoint: entry,
          targets: [
            additive
              ? { format, blend: { color: { srcFactor: "one", dstFactor: "one", operation: "add" }, alpha: { srcFactor: "one", dstFactor: "one", operation: "add" } } }
              : { format },
          ],
        },
        primitive: { topology: "triangle-list" },
      });
      this.pipelines.set(key, pipeline);
    }
    return pipeline;
  }
}
