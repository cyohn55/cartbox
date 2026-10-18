/**
 * Bloom from the HDR frame (AAA_FIDELITY_ROADMAP.md F4d), before the tone map.
 *
 * The post stack's bloom (BloomPyramid) thresholds the frame after it was
 * tone-mapped and clipped to 8 bits, so a light of 40 and one of 1.1 bloom the
 * same. Here the linear composite is blurred down a mip chain and back up
 * (Jimenez, "Next Generation Post Processing in Call of Duty: Advanced
 * Warfare"): each level a 13-tap downsample of the one above, the first with
 * Karis's average so a lone sparkle can't flicker the whole bloom; then each
 * level, from the smallest, a 3×3 tent upsampled and added into the next.
 *
 * Nothing is thresholded. The presenter mixes the result (over the levels it
 * summed) into the frame by the bloom strength, so light is moved into a
 * glow rather than added: a bright light glows by how bright it is, and the
 * frame keeps its energy.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

/** The fewest and most levels the chain blurs over, by the bloom's radius (0..1). */
const MIN_LEVELS = 3;
const MAX_LEVELS = 6;

/** How many levels a radius sums, and the half-resolution chain's sizes (none under 4 texels). */
export function bloomLevels(width: number, height: number, radius: number): { width: number; height: number }[] {
  const wanted = MIN_LEVELS + Math.round(Math.max(0, Math.min(1, radius)) * (MAX_LEVELS - MIN_LEVELS));
  const out: { width: number; height: number }[] = [];
  let w = Math.max(1, width >> 1);
  let h = Math.max(1, height >> 1);
  while (out.length < wanted && w >= 4 && h >= 4) {
    out.push({ width: w, height: h });
    w = Math.max(1, w >> 1);
    h = Math.max(1, h >> 1);
  }
  return out;
}

const VS = /* wgsl */ `
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  let x = f32((i << 1u) & 2u);
  let y = f32(i & 2u);
  return vec4f(x * 2.0 - 1.0, 1.0 - y * 2.0, 0.0, 1.0);
}
`;

const DOWN_WGSL = /* wgsl */ `
${VS}
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;
// xy = the source's texel, zw = the target's; first level when params2.x = 1.
@group(0) @binding(2) var<uniform> params: array<vec4f, 2>;
fn tap(uv: vec2f, dx: f32, dy: f32) -> vec3f { return textureSampleLevel(src, samp, uv + vec2f(dx, dy) * params[0].xy, 0.0).rgb; }
fn karis(c: vec3f) -> f32 { return 1.0 / (1.0 + max(c.r, max(c.g, c.b))); }
@fragment fn down(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let uv = pos.xy * params[0].zw;
  let a = tap(uv, -2.0, -2.0); let b = tap(uv, 0.0, -2.0); let c = tap(uv, 2.0, -2.0);
  let d = tap(uv, -1.0, -1.0); let e = tap(uv, 1.0, -1.0);
  let f = tap(uv, -2.0, 0.0); let g = tap(uv, 0.0, 0.0); let h = tap(uv, 2.0, 0.0);
  let i = tap(uv, -1.0, 1.0); let j = tap(uv, 1.0, 1.0);
  let k = tap(uv, -2.0, 2.0); let l = tap(uv, 0.0, 2.0); let m = tap(uv, 2.0, 2.0);
  // Five overlapping boxes: the inner one at half, the four corners at an eighth each.
  let inner = (d + e + i + j) * 0.25;
  let tl = (a + b + f + g) * 0.25;
  let tr = (b + c + g + h) * 0.25;
  let bl = (f + g + k + l) * 0.25;
  let br = (g + h + l + m) * 0.25;
  if (params[1].x > 0.5) {
    // The first level: each box weighted down by its brightness (Karis), so one sparkle can't flicker the glow.
    let wi = karis(inner) * 0.5; let w0 = karis(tl) * 0.125; let w1 = karis(tr) * 0.125; let w2 = karis(bl) * 0.125; let w3 = karis(br) * 0.125;
    return vec4f((inner * wi + tl * w0 + tr * w1 + bl * w2 + br * w3) / (wi + w0 + w1 + w2 + w3), 1.0);
  }
  return vec4f(inner * 0.5 + (tl + tr + bl + br) * 0.125, 1.0);
}
`;

const UP_WGSL = /* wgsl */ `
${VS}
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;
// xy = the (smaller) source's texel, zw = the target's.
@group(0) @binding(2) var<uniform> params: array<vec4f, 2>;
fn tap(uv: vec2f, dx: f32, dy: f32) -> vec3f { return textureSampleLevel(src, samp, uv + vec2f(dx, dy) * params[0].xy, 0.0).rgb; }
@fragment fn up(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let uv = pos.xy * params[0].zw;
  // A 3×3 tent, added (by the blend) onto the level it lands on.
  let t = (tap(uv, -1.0, -1.0) + tap(uv, 1.0, -1.0) + tap(uv, -1.0, 1.0) + tap(uv, 1.0, 1.0))
    + (tap(uv, 0.0, -1.0) + tap(uv, -1.0, 0.0) + tap(uv, 1.0, 0.0) + tap(uv, 0.0, 1.0)) * 2.0
    + tap(uv, 0.0, 0.0) * 4.0;
  return vec4f(t / 16.0, 1.0);
}
`;

/** The chain's targets and pipelines on one device, for one frame size. */
export class HdrBloom {
  private levels: { width: number; height: number; texture: any }[] = [];
  private key = "";
  private down: any = null;
  private up: any = null;
  private readonly sampler: any;
  private readonly params: any[] = [];

  constructor(private readonly device: any) {
    this.sampler = device.createSampler({ magFilter: "linear", minFilter: "linear", addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge" });
  }

  /**
   * Encode the chain over `source` (rgba16float, `width × height`): the
   * half-resolution glow it returns sums `count` levels.
   */
  encode(encoder: any, source: any, width: number, height: number, radius: number): { texture: any; count: number } | null {
    const device = this.device;
    const sizes = bloomLevels(width, height, radius);
    if (sizes.length === 0) return null;
    const key = sizes.map((s) => `${s.width}x${s.height}`).join(",");
    if (key !== this.key) {
      for (const level of this.levels) level.texture.destroy?.();
      // RENDER_ATTACHMENT | TEXTURE_BINDING | COPY_SRC (its tests read the glow).
      this.levels = sizes.map((s) => ({ ...s, texture: device.createTexture({ size: s, format: "rgba16float", usage: 0x10 | 0x04 | 0x01 }) }));
      this.key = key;
    }
    const pipeline = (code: string, entryPoint: string, additive: boolean) => {
      const module = device.createShaderModule({ code });
      return device.createRenderPipeline({
        layout: "auto",
        vertex: { module, entryPoint: "vs" },
        fragment: {
          module,
          entryPoint,
          targets: [{ format: "rgba16float", ...(additive ? { blend: { color: { srcFactor: "one", dstFactor: "one", operation: "add" }, alpha: { srcFactor: "one", dstFactor: "one", operation: "add" } } } : {}) }],
        },
        primitive: { topology: "triangle-list" },
      });
    };
    this.down ??= pipeline(DOWN_WGSL, "down", false);
    this.up ??= pipeline(UP_WGSL, "up", true);
    let param = 0;
    const pass = (pipeline: any, from: any, fromSize: { width: number; height: number }, to: { width: number; height: number; texture: any }, first: boolean, load: boolean) => {
      const buffer = (this.params[param] ??= device.createBuffer({ size: 32, usage: 0x40 | 0x08 }));
      param += 1;
      device.queue.writeBuffer(buffer, 0, new Float32Array([1 / fromSize.width, 1 / fromSize.height, 1 / to.width, 1 / to.height, first ? 1 : 0, 0, 0, 0]));
      const encoded = encoder.beginRenderPass({ colorAttachments: [{ view: to.texture.createView(), clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: load ? "load" : "clear", storeOp: "store" }] });
      encoded.setPipeline(pipeline);
      encoded.setBindGroup(
        0,
        device.createBindGroup({
          layout: pipeline.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: from.createView() },
            { binding: 1, resource: this.sampler },
            { binding: 2, resource: { buffer } },
          ],
        }),
      );
      encoded.draw(3);
      encoded.end();
    };
    // Down the chain from the frame…
    let from: any = source;
    let fromSize = { width, height };
    this.levels.forEach((level, i) => {
      pass(this.down, from, fromSize, level, i === 0, false);
      from = level.texture;
      fromSize = level;
    });
    // …and back up, each level's tent added into the one above it.
    for (let i = this.levels.length - 1; i > 0; i -= 1) pass(this.up, this.levels[i]!.texture, this.levels[i]!, this.levels[i - 1]!, false, true);
    return { texture: this.levels[0]!.texture, count: this.levels.length };
  }

  dispose(): void {
    for (const level of this.levels) level.texture.destroy?.();
    for (const buffer of this.params) buffer.destroy?.();
    this.levels = [];
  }
}
