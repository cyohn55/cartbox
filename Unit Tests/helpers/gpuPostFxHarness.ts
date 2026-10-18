/**
 * Runs inside Chromium for gpu-postfx.test.ts: one frame through the WebGL
 * post-process pass (PostFxPass) and through its WebGPU port (GpuPostFx), with
 * the same settings, and how far apart the two pictures are.
 */

 

import { PostFxPass } from "../../packages/player/src/fx/PostFxPass";
import { GpuPostFx } from "../../packages/player/src/fx/gpuPostFx";
import { POST_FX_EFFECTS, defaultPostFxSettings, parsePostFxSettings, uniformsFromSettings, type PostFxSettings } from "../../packages/player/src/fx/postfx";

const W = 160;
const H = 96;

/** A frame with every kind of pixel the stack treats differently: gradients, mid-tones, and light past the bloom threshold. */
function frame(): Uint8Array {
  const out = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      const o = (y * W + x) * 4;
      out[o] = (x * 255) / (W - 1);
      out[o + 1] = (y * 255) / (H - 1);
      out[o + 2] = 128 + 100 * Math.sin(x * 0.12) * Math.cos(y * 0.09);
      out[o + 3] = 255;
      // A cyan energy bar and two white lamps: what the bloom picks out.
      if (y > 40 && y < 46 && x > 20 && x < 140) out.set([90, 250, 255, 255], o);
      if (Math.hypot(x - 120, y - 20) < 5 || Math.hypot(x - 40, y - 75) < 4) out.set([255, 255, 255, 255], o);
    }
  }
  return out;
}

/** The cases: Lockout's authored stack, and everything at its defaults bar the grain (its hash is precision-bound). */
function settingsFor(which: number, lockout: unknown): PostFxSettings {
  if (which === 0) return parsePostFxSettings(lockout)!;
  const s = defaultPostFxSettings();
  for (const effect of POST_FX_EFFECTS) s.enabled[effect.id] = effect.id !== "grain" && effect.id !== "kaleido";
  return s;
}

async function viaWebgpu(source: Uint8Array, settings: PostFxSettings): Promise<Uint8Array> {
  const adapter = await (navigator as any).gpu.requestAdapter();
  const device = await adapter.requestDevice();
  const texture = device.createTexture({ size: { width: W, height: H }, format: "rgba8unorm", usage: 0x04 | 0x02 });
  device.queue.writeTexture({ texture }, source, { bytesPerRow: W * 4, rowsPerImage: H }, { width: W, height: H });
  const target = device.createTexture({ size: { width: W, height: H }, format: "rgba8unorm", usage: 0x10 | 0x01 });
  const post = new GpuPostFx(device, W, H);
  device.pushErrorScope("validation");
  const encoder = device.createCommandEncoder();
  post.encode(encoder, texture, target, "rgba8unorm", uniformsFromSettings(settings), 0);
  const bytesPerRow = Math.ceil((W * 4) / 256) * 256;
  const buffer = device.createBuffer({ size: bytesPerRow * H, usage: 0x01 | 0x08 });
  encoder.copyTextureToBuffer({ texture: target }, { buffer, bytesPerRow, rowsPerImage: H }, { width: W, height: H });
  device.queue.submit([encoder.finish()]);
  const error = await device.popErrorScope();
  if (error) throw new Error(String(error.message ?? error));
  await buffer.mapAsync(0x01);
  const padded = new Uint8Array(buffer.getMappedRange());
  const out = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y += 1) out.set(padded.subarray(y * bytesPerRow, y * bytesPerRow + W * 4), y * W * 4);
  return out;
}

function viaWebgl(source: Uint8Array, settings: PostFxSettings): Uint8ClampedArray {
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const pass = PostFxPass.create(canvas);
  if (!pass) throw new Error("no WebGL");
  pass.render(source, W, H, uniformsFromSettings(settings), 0);
  const read = document.createElement("canvas");
  read.width = W;
  read.height = H;
  const ctx = read.getContext("2d")!;
  ctx.drawImage(canvas, 0, 0);
  pass.dispose();
  return ctx.getImageData(0, 0, W, H).data;
}

interface PostReport {
  readonly mean: number;
  readonly max: number;
  readonly over8: number;
  readonly changed: number;
  readonly error?: string;
}

(globalThis as any).runPost = async (which: number, lockout: unknown): Promise<PostReport> => {
  try {
    const source = frame();
    const settings = settingsFor(which, lockout);
    const gl = viaWebgl(source, settings);
    const gpu = await viaWebgpu(source, settings);
    let sum = 0;
    let max = 0;
    let over8 = 0;
    let changed = 0;
    for (let i = 0; i < W * H; i += 1) {
      let moved = 0;
      for (let c = 0; c < 3; c += 1) {
        const d = Math.abs(gl[i * 4 + c]! - gpu[i * 4 + c]!);
        sum += d;
        max = Math.max(max, d);
        if (d > 8) over8 += 1;
        moved += Math.abs(gl[i * 4 + c]! - source[i * 4 + c]!);
      }
      if (moved > 12) changed += 1;
    }
    return { mean: sum / (W * H * 3), max, over8, changed };
  } catch (e) {
    return { mean: 0, max: 0, over8: 0, changed: 0, error: String(e) };
  }
};
