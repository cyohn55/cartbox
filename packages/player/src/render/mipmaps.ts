/**
 * Mip chains on the GPU (AAA_FIDELITY_ROADMAP.md F1a). WebGPU has no
 * generateMipmap, so each level is drawn from the one above: a full-screen
 * triangle whose fragment samples the larger level bilinearly at the centre of
 * each 2×2 block, which is the block's average.
 *
 * Drawn through an sRGB view, the hardware decodes the four texels to linear
 * light, averages them there, and encodes the result again. So an sRGB colour
 * map (a checkerboard of black and white) mips to the mid-grey it looks like
 * from afar (188), not to the darker byte average (128).
 *
 * A colour map with see-through texels is mipped on the CPU instead
 * ({@link coverageMips}): its alpha is rescaled level by level so the share
 * of texels a cut-out keeps stays what it is at full size. Plain averaging
 * would pull a grass card's alpha under the cutoff and thin it away with
 * distance (Castaño, "Computing Alpha Mipmaps").
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import type { DecodedTexture } from "@cartbox/editor";

/** The anisotropy mipmapped textures are sampled at: the most WebGPU allows. */
export const MAX_ANISOTROPY = 16;

/** Levels in a full chain for a texture of this size, down to 1×1. */
export function mipLevelCount(width: number, height: number): number {
  return Math.floor(Math.log2(Math.max(1, width, height))) + 1;
}

/** A level's size: halved per level, never below 1. */
export function mipSize(width: number, height: number, level: number): { width: number; height: number } {
  return { width: Math.max(1, width >> level), height: Math.max(1, height >> level) };
}

const MIP_WGSL = /* wgsl */ `
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;
struct Out {
  @builtin(position) pos: vec4<f32>,
  @location(0) uv: vec2<f32>,
};
@vertex
fn vs(@builtin(vertex_index) i: u32) -> Out {
  let p = vec2<f32>(f32((i << 1u) & 2u), f32(i & 2u));
  var out: Out;
  out.pos = vec4<f32>(p * 2.0 - 1.0, 0.0, 1.0);
  out.uv = vec2<f32>(p.x, 1.0 - p.y);
  return out;
}
@fragment
fn fs(in: Out) -> @location(0) vec4<f32> {
  return textureSample(src, samp, in.uv);
}
`;

export class MipmapGenerator {
  private readonly pipelines = new Map<string, any>();
  private sampler: any = null;
  private module: any = null;

  constructor(private readonly device: any) {}

  /**
   * Draw levels 1 to `levels − 1` of `texture` from its level 0, through views
   * of `format` (the texture's own, or an sRGB view format it was made with).
   */
  generate(texture: any, levels: number, format: string): void {
    if (levels < 2) return;
    const device = this.device;
    this.module ??= device.createShaderModule({ code: MIP_WGSL });
    this.sampler ??= device.createSampler({ magFilter: "linear", minFilter: "linear", addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge" });
    let pipeline = this.pipelines.get(format);
    if (!pipeline) {
      pipeline = device.createRenderPipeline({
        layout: "auto",
        vertex: { module: this.module, entryPoint: "vs" },
        fragment: { module: this.module, entryPoint: "fs", targets: [{ format }] },
        primitive: { topology: "triangle-list" },
      });
      this.pipelines.set(format, pipeline);
    }
    const encoder = device.createCommandEncoder();
    for (let level = 1; level < levels; level += 1) {
      const view = (mip: number) => texture.createView({ format, baseMipLevel: mip, mipLevelCount: 1 });
      const pass = encoder.beginRenderPass({
        colorAttachments: [{ view: view(level), clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: "clear", storeOp: "store" }],
      });
      pass.setPipeline(pipeline);
      pass.setBindGroup(
        0,
        device.createBindGroup({
          layout: pipeline.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: view(level - 1) },
            { binding: 1, resource: this.sampler },
          ],
        }),
      );
      pass.draw(3);
      pass.end();
    }
    device.queue.submit([encoder.finish()]);
  }
}

/** The cutoff coverage is kept at: glTF's default `alphaCutoff`. */
export const COVERAGE_CUTOFF = 0.5;

/** Whether a texture has any texel that isn't fully opaque. */
export function hasTransparency(texture: DecodedTexture): boolean {
  const d = texture.data;
  for (let i = 3; i < d.length; i += 4) if (d[i]! < 255) return true;
  return false;
}

/** sRGB bytes to linear light, and back. */
const TO_LINEAR = Float32Array.from({ length: 256 }, (_, i) => {
  const c = i / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
});
function toSrgbByte(linear: number): number {
  const c = linear <= 0.0031308 ? linear * 12.92 : 1.055 * linear ** (1 / 2.4) - 0.055;
  return Math.round(Math.min(1, Math.max(0, c)) * 255);
}

/** The share of texels at or over `cutoff` once alpha is scaled by `scale`. */
function coverageOf(alpha: Float32Array, scale: number, cutoff: number): number {
  let kept = 0;
  for (let i = 0; i < alpha.length; i += 1) if (alpha[i]! * scale >= cutoff) kept += 1;
  return kept / Math.max(1, alpha.length);
}

/**
 * Levels 1 and down of an sRGB colour map that has see-through texels: each
 * the box average of the one above, its colour averaged in linear light (as
 * the GPU path does) weighted by alpha so a transparent texel's colour doesn't
 * bleed into the edge, and its alpha scaled so the share of texels at or over
 * `cutoff` matches level 0's.
 */
export function coverageMips(source: DecodedTexture, cutoff = COVERAGE_CUTOFF): DecodedTexture[] {
  const levels = mipLevelCount(source.width, source.height);
  const base = new Float32Array(source.width * source.height);
  for (let i = 0; i < base.length; i += 1) base[i] = source.data[i * 4 + 3]! / 255;
  const target = coverageOf(base, 1, cutoff);
  // The level above, in linear light (premultiplied) and alpha.
  let width = source.width;
  let height = source.height;
  let rgb = new Float32Array(width * height * 3);
  let alpha = base;
  for (let i = 0; i < width * height; i += 1) {
    for (let k = 0; k < 3; k += 1) rgb[i * 3 + k] = TO_LINEAR[source.data[i * 4 + k]!]! * alpha[i]!;
  }
  const out: DecodedTexture[] = [];
  for (let level = 1; level < levels; level += 1) {
    const { width: w, height: h } = mipSize(source.width, source.height, level);
    const nextRgb = new Float32Array(w * h * 3);
    const nextAlpha = new Float32Array(w * h);
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        let r = 0;
        let g = 0;
        let b = 0;
        let a = 0;
        let n = 0;
        for (let dy = 0; dy < 2; dy += 1) {
          for (let dx = 0; dx < 2; dx += 1) {
            const sx = Math.min(width - 1, x * 2 + dx);
            const sy = Math.min(height - 1, y * 2 + dy);
            const j = sy * width + sx;
            r += rgb[j * 3]!;
            g += rgb[j * 3 + 1]!;
            b += rgb[j * 3 + 2]!;
            a += alpha[j]!;
            n += 1;
          }
        }
        const i = y * w + x;
        nextRgb[i * 3] = r / n;
        nextRgb[i * 3 + 1] = g / n;
        nextRgb[i * 3 + 2] = b / n;
        nextAlpha[i] = a / n;
      }
    }
    // The scale that keeps the coverage: coverage only grows with it, so bisect.
    let lo = 0;
    let hi = 4;
    if (target <= 0) hi = 1;
    for (let step = 0; step < 12; step += 1) {
      const mid = (lo + hi) / 2;
      if (coverageOf(nextAlpha, mid, cutoff) < target) lo = mid;
      else hi = mid;
    }
    // Coverage moves in whole texels: of the two scales either side of the target, take the nearer.
    const scale = target <= 0 ? 1 : Math.abs(coverageOf(nextAlpha, lo, cutoff) - target) < Math.abs(coverageOf(nextAlpha, hi, cutoff) - target) ? lo : hi;
    // A fully see-through texel takes the level's mean colour, so filtering at a card's edge doesn't fringe it dark.
    const mean = [0, 0, 0];
    let weight = 0;
    for (let i = 0; i < w * h; i += 1) {
      for (let k = 0; k < 3; k += 1) mean[k] = mean[k]! + nextRgb[i * 3 + k]!;
      weight += nextAlpha[i]!;
    }
    const data = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i += 1) {
      const a = nextAlpha[i]!;
      for (let k = 0; k < 3; k += 1) data[i * 4 + k] = toSrgbByte(a > 0 ? nextRgb[i * 3 + k]! / a : weight > 0 ? mean[k]! / weight : 0);
      data[i * 4 + 3] = Math.round(Math.min(1, a * scale) * 255);
    }
    out.push({ width: w, height: h, data });
    width = w;
    height = h;
    rgb = nextRgb;
    alpha = nextAlpha;
  }
  return out;
}
