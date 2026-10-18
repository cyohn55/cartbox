/**
 * The AAA tier's temporal anti-aliasing (AAA_FIDELITY_ROADMAP.md F4a), on a
 * real device (Dawn): the HDR resolve on synthetic inputs (it follows the
 * velocity buffer, clips the history to the neighbourhood's variance box,
 * takes the new frame where the reactive mask says so, keeps HDR range), and
 * the renderer running it frame after frame (a still scene converges to
 * itself, a moving object leaves no trail, see-through draws take the masked
 * path without errors).
 */

import { describe, expect, it } from "vitest";

import { composeModelMatrix, projectionMatrix, viewMatrix, type MeshAsset, type MeshSceneInstance } from "@cartbox/editor";
import { WebgpuSceneRenderer } from "@cartbox/player";
import { REACTIVE_MASK_WGSL, hdrTemporalShaderWgsl } from "../packages/player/src/render/temporal";

async function realDevice(): Promise<any | null> {
  try {
    const module = (await import(/* @vite-ignore */ "@kmamal/gpu")) as any;
    const instance = (module.default ?? module).create([]);
    const adapter = await instance.requestAdapter();
    return adapter ? await adapter.requestDevice() : null;
  } catch {
    return null;
  }
}
const device = await realDevice();

async function settled<T>(promise: Promise<T>): Promise<T> {
  let done = false;
  void promise.then(
    () => (done = true),
    () => (done = true),
  );
  for (let i = 0; i < 800 && !done; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    device.tick?.();
  }
  return promise;
}

function toHalf(v: number): number {
  const f = new Float32Array([v]);
  const bits = new Uint32Array(f.buffer)[0]!;
  const sign = (bits >>> 16) & 0x8000;
  const e = ((bits >>> 23) & 0xff) - 112;
  if (e <= 0) return sign;
  return sign | (Math.min(30, e) << 10) | ((bits & 0x7fffff) >>> 13);
}
function half(h: number): number {
  const e = (h >> 10) & 0x1f;
  const m = h & 0x3ff;
  const s = h & 0x8000 ? -1 : 1;
  return e === 0 ? s * 2 ** -14 * (m / 1024) : s * 2 ** (e - 15) * (1 + m / 1024);
}

const W = 16;
const H = 16;

/** An rgba16float texture of W×H, each texel from `at(x, y)`. */
function rgbaTexture(at: (x: number, y: number) => [number, number, number, number], usage = 0x04 | 0x02): any {
  const t = device.createTexture({ size: { width: W, height: H }, format: "rgba16float", usage });
  const data = new Uint16Array(W * H * 4);
  for (let y = 0; y < H; y += 1) for (let x = 0; x < W; x += 1) data.set(at(x, y).map(toHalf), (y * W + x) * 4);
  device.queue.writeTexture({ texture: t }, data, { bytesPerRow: W * 8, rowsPerImage: H }, { width: W, height: H });
  return t;
}

/** Read an rgba16float texture of W×H back as floats. */
async function readRgba(texture: any): Promise<(x: number, y: number) => [number, number, number, number]> {
  const bytesPerRow = 256;
  const buffer = device.createBuffer({ size: bytesPerRow * H, usage: 0x01 | 0x08 });
  const encoder = device.createCommandEncoder();
  encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow, rowsPerImage: H }, { width: W, height: H });
  device.queue.submit([encoder.finish()]);
  await settled(buffer.mapAsync(0x01));
  const halves = new Uint16Array(buffer.getMappedRange().slice(0));
  buffer.unmap();
  buffer.destroy();
  return (x, y) => [0, 1, 2, 3].map((k) => half(halves[(y * bytesPerRow) / 2 + x * 4 + k]!)) as [number, number, number, number];
}

describe.skipIf(!device)("the HDR resolve, on synthetic frames", { timeout: 60_000 }, () => {
  /** Resolve `current` against `history` with a uniform depth, velocity and reactive value. */
  async function resolve(options: {
    current: (x: number, y: number) => [number, number, number, number];
    history: (x: number, y: number) => [number, number, number, number];
    velocity?: [number, number];
    reactive?: number;
    depth?: number;
  }) {
    const pipeline = device.createRenderPipeline({
      layout: "auto",
      vertex: { module: device.createShaderModule({ code: hdrTemporalShaderWgsl(false) }), entryPoint: "vs" },
      fragment: { module: device.createShaderModule({ code: hdrTemporalShaderWgsl(false) }), entryPoint: "resolve", targets: [{ format: "rgba16float" }] },
      primitive: { topology: "triangle-list" },
    });
    const uniforms = device.createBuffer({ size: 80, usage: 0x40 | 0x08 });
    // Identity reprojection, the new frame at 0.1, history on, NDC depth.
    device.queue.writeBuffer(uniforms, 0, new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0.1, 0, 1, 0]));
    const depth = device.createTexture({ size: { width: W, height: H }, format: "depth16unorm", usage: 0x04 | 0x02 });
    device.queue.writeTexture({ texture: depth }, new Uint16Array(W * H).fill(Math.round((options.depth ?? 0.5) * 65535)), { bytesPerRow: W * 2, rowsPerImage: H }, { width: W, height: H });
    const velocity = device.createTexture({ size: { width: W, height: H }, format: "rg32float", usage: 0x04 | 0x02 });
    const v = options.velocity ?? [0, 0];
    device.queue.writeTexture({ texture: velocity }, new Float32Array(W * H * 2).map((_, i) => v[i % 2]!), { bytesPerRow: W * 8, rowsPerImage: H }, { width: W, height: H });
    const reactive = device.createTexture({ size: { width: W, height: H }, format: "r8unorm", usage: 0x04 | 0x02 });
    device.queue.writeTexture({ texture: reactive }, new Uint8Array(W * H).fill(Math.round((options.reactive ?? 0) * 255)), { bytesPerRow: W, rowsPerImage: H }, { width: W, height: H });
    const out = device.createTexture({ size: { width: W, height: H }, format: "rgba16float", usage: 0x10 | 0x01 });
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({ colorAttachments: [{ view: out.createView(), loadOp: "clear", storeOp: "store", clearValue: { r: 0, g: 0, b: 0, a: 0 } }] });
    pass.setPipeline(pipeline);
    pass.setBindGroup(
      0,
      device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: uniforms } },
          { binding: 1, resource: rgbaTexture(options.current).createView() },
          { binding: 2, resource: rgbaTexture(options.history).createView() },
          { binding: 3, resource: device.createSampler({ magFilter: "linear", minFilter: "linear" }) },
          { binding: 4, resource: depth.createView() },
          { binding: 5, resource: velocity.createView() },
          { binding: 6, resource: reactive.createView() },
        ],
      }),
    );
    pass.draw(3);
    pass.end();
    device.pushErrorScope("validation");
    device.queue.submit([encoder.finish()]);
    const error = await settled(device.popErrorScope());
    expect(error ? String((error as any).message ?? error) : null).toBeNull();
    return readRgba(out);
  }

  // A soft gradient the history is drawn from (a texel's value is its x / 4), and the same frame now.
  const ramp = (x: number): [number, number, number, number] => [x / 4, x / 4, x / 4, 1];

  it("follows the velocity buffer: the history comes from where the surface was", async () => {
    // The surface moved 2 texels right: now at x it shows what history had at x − 2.
    const out = await resolve({ current: (x) => ramp(x - 2), history: (x) => ramp(x), velocity: [2 / W, 0] });
    for (const x of [5, 8, 11]) expect(out(x, 8)[0]).toBeCloseTo((x - 2) / 4, 1);
    // Ignoring the velocity would have read history at x (0.5 brighter), which the box keeps out.
  });

  it("clips a history outside the neighbourhood's variance box back into it", async () => {
    // A flat 0.5 frame and a stale history of 4: the box is tight, so the history is clipped to 0.5.
    const out = await resolve({ current: () => [0.5, 0.5, 0.5, 1], history: () => [4, 0.2, 0.2, 1] });
    for (const k of [0, 1, 2]) expect(out(8, 8)[k]).toBeCloseTo(0.5, 2);
  });

  it("keeps HDR range, and blends a bright pixel in tone-mapped space so it doesn't flicker", async () => {
    // A highlight of 40 on a 0.5 wall, its history the same: unchanged.
    const scene = (x: number, y: number): [number, number, number, number] => (x === 8 && y === 8 ? [40, 40, 40, 1] : [0.5, 0.5, 0.5, 1]);
    const out = await resolve({ current: scene, history: scene });
    expect(out(8, 8)[0]).toBeGreaterThan(30);
    expect(out(3, 3)[0]).toBeCloseTo(0.5, 2);
  });

  it("takes the new frame where the reactive mask is set", async () => {
    // Within the box (a noisy neighbourhood), history 0.3 and now 0.7: plain TAA keeps mostly history …
    const noisy = (x: number, y: number): [number, number, number, number] => ((x + y) % 2 ? [0.2, 0.2, 0.2, 1] : [0.8, 0.8, 0.8, 1]);
    const at = (x: number, y: number, v: number) => (x === 8 && y === 8 ? ([v, v, v, 1] as [number, number, number, number]) : noisy(x, y));
    const plain = await resolve({ current: (x, y) => at(x, y, 0.7), history: (x, y) => at(x, y, 0.3) });
    expect(plain(8, 8)[0]).toBeLessThan(0.45);
    // … a reactive pixel (something see-through changed it) takes the new frame.
    const masked = await resolve({ current: (x, y) => at(x, y, 0.7), history: (x, y) => at(x, y, 0.3), reactive: 1 });
    expect(masked(8, 8)[0]).toBeCloseTo(0.7, 2);
  });

  it("makes the mask from what the see-through pass changed, tone-mapped", async () => {
    const pipeline = device.createRenderPipeline({
      layout: "auto",
      vertex: { module: device.createShaderModule({ code: REACTIVE_MASK_WGSL }), entryPoint: "vs" },
      fragment: { module: device.createShaderModule({ code: REACTIVE_MASK_WGSL }), entryPoint: "mask", targets: [{ format: "rgba16float" }] },
      primitive: { topology: "triangle-list" },
    });
    const opaque = rgbaTexture(() => [2, 2, 2, 1]);
    // Particles over the left half; the right half untouched.
    const composited = rgbaTexture((x) => (x < 8 ? [2.6, 2.2, 2, 1] : [2, 2, 2, 1]));
    const out = device.createTexture({ size: { width: W, height: H }, format: "rgba16float", usage: 0x10 | 0x01 });
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({ colorAttachments: [{ view: out.createView(), loadOp: "clear", storeOp: "store", clearValue: { r: 0, g: 0, b: 0, a: 0 } }] });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: opaque.createView() }, { binding: 1, resource: composited.createView() }] }));
    pass.draw(3);
    pass.end();
    device.queue.submit([encoder.finish()]);
    const mask = await readRgba(out);
    expect(mask(3, 8)[0]).toBeGreaterThan(0.15);
    expect(mask(12, 8)[0]).toBe(0);
  });
});

describe.skipIf(!device)("the renderer's TAA on the AAA tier", { timeout: 120_000 }, () => {
  const R = 48;
  const quad = (emissive: [number, number, number], alpha = 1): MeshAsset =>
    ({
      name: "q",
      primitives: [
        {
          positions: Float32Array.from([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]),
          normals: Float32Array.from([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
          uvs: Float32Array.from([0, 0, 1, 0, 1, 1, 0, 1]),
          indices: Uint32Array.from([0, 1, 2, 0, 2, 3]),
          material: { name: "m", baseColorFactor: [0, 0, 0, alpha], baseColorImage: null, metallicFactor: 0, roughnessFactor: 1, emissiveFactor: emissive, ...(alpha < 1 ? { alphaMode: "blend" } : {}) },
        },
      ],
    }) as unknown as MeshAsset;

  async function frames(renderer: any, scene: (frame: number) => MeshSceneInstance[], count: number): Promise<(x: number, y: number, k?: number) => number> {
    let texture: any = null;
    device.pushErrorScope("validation");
    for (let f = 0; f < count; f += 1) {
      texture = renderer.renderToTexture(scene(f), {
        width: R,
        height: R,
        view: viewMatrix([0, 0, 4], [0, 0, 0]),
        projection: projectionMatrix(Math.PI / 3, 1, 0.1, 50),
        ambient: 0,
        lightDirection: [0, 0, 1],
        temporal: true,
        prepass: true,
      } as any);
    }
    const error = await settled(device.popErrorScope());
    expect(error ? String((error as any).message ?? error) : null).toBeNull();
    const bytesPerRow = Math.ceil((R * 8) / 256) * 256;
    const buffer = device.createBuffer({ size: bytesPerRow * R, usage: 0x01 | 0x08 });
    const encoder = device.createCommandEncoder();
    encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow, rowsPerImage: R }, { width: R, height: R });
    device.queue.submit([encoder.finish()]);
    await settled(buffer.mapAsync(0x01));
    const halves = new Uint16Array(buffer.getMappedRange().slice(0));
    buffer.unmap();
    return (x, y, k = 0) => half(halves[(y * bytesPerRow) / 2 + x * 4 + k]!);
  }

  it("converges a still HDR scene to itself", async () => {
    const renderer = (await WebgpuSceneRenderer.create(device, R, R, undefined, { hdr: true }))!;
    const scene = () => [{ mesh: quad([2, 2, 2]), model: composeModelMatrix([0, 0, 0], [0, 0, 0], [1, 1, 1]) }];
    const one = await frames(renderer, scene, 1);
    const many = await frames(renderer, scene, 16);
    expect(one(24, 24)).toBeGreaterThan(1);
    expect(Math.abs(many(24, 24) - one(24, 24)) / one(24, 24)).toBeLessThan(0.02);
    renderer.dispose();
  });

  it("leaves no trail behind a moving object: its history moves with it", async () => {
    const renderer = (await WebgpuSceneRenderer.create(device, R, R, undefined, { hdr: true }))!;
    // A bright square sliding right a tenth of a unit a frame.
    const scene = (f: number) => [{ mesh: quad([4, 4, 4]), model: composeModelMatrix([-1 + f * 0.1, 0, 0], [0, 0, 0], [0.4, 0.4, 1]) }];
    const out = await frames(renderer, scene, 12);
    // Where it ends (x ≈ 0.1 in world → just right of centre) it is bright; where it was five frames ago, dark.
    let brightest = 0;
    for (let x = 0; x < R; x += 1) brightest = Math.max(brightest, out(x, 24));
    expect(brightest).toBeGreaterThan(3);
    // World x = −0.4 (where it was centred five frames back, now left behind by more than its width).
    const behind = Math.round(((-0.4 / (4 * Math.tan(Math.PI / 6))) * 0.5 + 0.5) * R) - 4;
    expect(out(behind, 24)).toBeLessThan(0.1);
    renderer.dispose();
  });

  it("draws see-through surfaces through the reactive mask without errors", async () => {
    const renderer = (await WebgpuSceneRenderer.create(device, R, R, undefined, { hdr: true }))!;
    // A glowing pane over a dim wall, its glow changing every frame.
    const scene = (f: number): MeshSceneInstance[] => [
      { mesh: quad([0.3, 0.3, 0.3]), model: composeModelMatrix([0, 0, -0.5], [0, 0, 0], [2, 2, 1]) },
      { mesh: quad(f % 2 ? [3, 0, 0] : [0, 3, 0], 0.5), model: composeModelMatrix([0, 0, 0], [0, 0, 0], [0.8, 0.8, 1]) },
    ];
    const out = await frames(renderer, scene, 9);
    // The last frame (f = 8) glowed green: the pane shows it, not the red the history half holds.
    expect(out(24, 24, 1)).toBeGreaterThan(out(24, 24, 0) * 2);
    renderer.dispose();
  });
});
