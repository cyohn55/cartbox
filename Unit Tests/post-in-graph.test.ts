/**
 * The AAA tier's presenter on the frame graph (AAA_FIDELITY_ROADMAP.md F4e):
 * its steps as named, timed passes over pooled transients; the post stack
 * reading the composite at full precision instead of 8 bits; and an HDR
 * display's highlights carried through the post stack instead of clipped.
 */

import { describe, expect, it } from "vitest";

import { GpuPresenter, defaultPostFxSettings, uniformsFromSettings } from "@cartbox/player";
import { POST_UNIFORM_FLOATS, packPostUniforms } from "../packages/player/src/fx/gpuPostFx";
import { timingSpan } from "../packages/player/src/render/frameGraph";
import { HDR_HEADROOM, HDR_PEAK } from "../packages/player/src/render/grading";
import { toneMap } from "../packages/player/src/render/toneMappers";

describe("the post stack's passes in the graph", () => {
  it("spans one graph pass's timestamps over the passes it encodes", () => {
    const querySet = {};
    const timing = { timestampWrites: { querySet, beginningOfPassWriteIndex: 4, endOfPassWriteIndex: 5 } };
    expect(timingSpan(timing, 0, 1)).toEqual(timing);
    expect(timingSpan(timing, 0, 3)).toEqual({ timestampWrites: { querySet, beginningOfPassWriteIndex: 4 } });
    expect(timingSpan(timing, 1, 3)).toEqual({});
    expect(timingSpan(timing, 2, 3)).toEqual({ timestampWrites: { querySet, endOfPassWriteIndex: 5 } });
    expect(timingSpan({}, 0, 3)).toEqual({});
  });

  it("tells the stack the brightest its target shows: white for SDR, the headroom on an HDR display", () => {
    const u = uniformsFromSettings(defaultPostFxSettings());
    const sdr = packPostUniforms(u, 64, 32, 0, false);
    expect(sdr.length).toBe(POST_UNIFORM_FLOATS);
    expect(Array.from(sdr.subarray(72, 74))).toEqual([1, 0]);
    const hdr = packPostUniforms(u, 64, 32, 0, false, undefined, HDR_PEAK);
    expect(hdr[72]).toBeCloseTo(1.055 * HDR_HEADROOM ** (1 / 2.4) - 0.055, 5);
    expect(hdr[73]).toBe(1);
  });
});

async function realDevice(): Promise<any | null> {
  try {
    const module = (await import(/* @vite-ignore */ "@kmamal/gpu")) as any;
    const instance = (module.default ?? module).create([]);
    const adapter = await instance.requestAdapter();
    if (!adapter) return null;
    const timestamps = adapter.features?.has?.("timestamp-query") === true;
    return await adapter.requestDevice(timestamps ? { requiredFeatures: ["timestamp-query"] } : undefined);
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

async function until(done: () => boolean, tries = 400): Promise<void> {
  for (let i = 0; i < tries && !done(); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    device.tick?.();
  }
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
const srgb = (v: number) => (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055);
const smoothstep = (e0: number, e1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

const W = 64;
const H = 32;

function sceneOf(at: (x: number, y: number) => [number, number, number]): any {
  const t = device.createTexture({ size: { width: W, height: H }, format: "rgba16float", usage: 0x04 | 0x02 | 0x10 });
  const data = new Uint16Array(W * H * 4);
  for (let y = 0; y < H; y += 1) for (let x = 0; x < W; x += 1) data.set([...at(x, y), 1].map(toHalf), (y * W + x) * 4);
  device.queue.writeTexture({ texture: t }, data, { bytesPerRow: W * 8, rowsPerImage: H }, { width: W, height: H });
  return t;
}

/** A target read back as floats: bytes / 255 for rgba8unorm, halves for rgba16float. */
async function read(texture: any, format: "rgba8unorm" | "rgba16float"): Promise<(x: number, y: number, k: number) => number> {
  const bytesPerRow = 512;
  const buffer = device.createBuffer({ size: bytesPerRow * H, usage: 0x01 | 0x08 });
  const encoder = device.createCommandEncoder();
  encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow, rowsPerImage: H }, { width: W, height: H });
  device.queue.submit([encoder.finish()]);
  await settled(buffer.mapAsync(0x01));
  const copy = buffer.getMappedRange().slice(0);
  buffer.unmap();
  if (format === "rgba8unorm") {
    const bytes = new Uint8Array(copy);
    return (x, y, k) => bytes[y * bytesPerRow + x * 4 + k]! / 255;
  }
  const halves = new Uint16Array(copy);
  return (x, y, k) => half(halves[(y * bytesPerRow) / 2 + x * 4 + k]!);
}

describe.skipIf(!device)("the presenter's frame graph, on a real device", { timeout: 60_000 }, () => {
  // A fine ramp of greys: brightness across, a little more down.
  const ramp = (x: number, y: number): [number, number, number] => {
    const v = 0.002 + x * 0.0045 + y * 0.0011;
    return [v, v, v];
  };

  function present(presenter: GpuPresenter, out: any, format: string, scene: any, post: any) {
    presenter.present({ base: { kind: "colour", rgba: [0, 0, 0, 255] }, scene, tonemap: { exposure: 1, operator: "neutral" }, post }, out, format);
  }

  it("feeds the post stack the composite at full precision: one rounding, not two", async () => {
    const presenter = new GpuPresenter(device, W, H, { hdr: true });
    const out = device.createTexture({ size: { width: W, height: H }, format: "rgba8unorm", usage: 0x10 | 0x01 });
    const uniforms = { ...uniformsFromSettings(defaultPostFxSettings()), vignette: 0.6 };
    device.pushErrorScope("validation");
    present(presenter, out, "rgba8unorm", sceneOf(ramp), { uniforms, time: 0 });
    const error = await settled(device.popErrorScope());
    expect(error ? String((error as any).message ?? error) : null).toBeNull();
    const got = await read(out, "rgba8unorm");
    let worst = 0;
    for (let y = 0; y < H; y += 1) {
      for (let x = 0; x < W; x += 1) {
        const cx = (x + 0.5) / W - 0.5;
        const cy = (y + 0.5) / H - 0.5;
        const falloff = 1 - 0.6 * smoothstep(0.25, 0.75, (cx * cx + cy * cy) * 2);
        const want = srgb(toneMap("neutral", ramp(x, y))[0]) * falloff;
        worst = Math.max(worst, Math.abs(got(x, y, 0) - want) * 255);
      }
    }
    // Rounded once, at the end: within half a step (and a little for half-float input).
    // Through an 8-bit composite it was rounded before the vignette too, up to a whole step out.
    expect(worst).toBeLessThan(0.7);
    presenter.dispose();
  });

  it("carries an HDR display's highlights through the post stack", async () => {
    const presenter = new GpuPresenter(device, W, H, { hdr: true, extended: true });
    const out = device.createTexture({ size: { width: W, height: H }, format: "rgba16float", usage: 0x10 | 0x01 });
    const bright = sceneOf((x) => (x < 32 ? [0.18, 0.18, 0.18] : [40, 40, 40]));
    const uniforms = { ...uniformsFromSettings(defaultPostFxSettings()), scanlines: 0.2 };
    device.pushErrorScope("validation");
    present(presenter, out, "rgba16float", bright, { uniforms, time: 0 });
    const error = await settled(device.popErrorScope());
    expect(error ? String((error as any).message ?? error) : null).toBeNull();
    const got = await read(out, "rgba16float");
    // Past SDR white after the scanlines (they darken by up to a tenth), and no further than the headroom.
    expect(got(48, 16, 1)).toBeGreaterThan(1.2);
    for (let y = 0; y < H; y += 1) expect(got(48, y, 1)).toBeLessThanOrEqual(HDR_PEAK + 1e-3);
    presenter.dispose();
  });

  it("names and times its passes, and a steady frame makes no new targets", async () => {
    const presenter = new GpuPresenter(device, W, H, { hdr: true });
    const out = device.createTexture({ size: { width: W, height: H }, format: "rgba8unorm", usage: 0x10 | 0x01 });
    const scene = sceneOf(ramp);
    const post = { uniforms: { ...uniformsFromSettings(defaultPostFxSettings()), bloomStrength: 0.5, bloomRadius: 0.5, bloomPhysical: 1 }, time: 0 };
    present(presenter, out, "rgba8unorm", scene, post);
    await settled(device.queue.onSubmittedWorkDone());
    const pool = (presenter as any).transients as { created: number };
    const created = pool.created;
    for (let i = 0; i < 3; i += 1) {
      present(presenter, out, "rgba8unorm", scene, post);
      await settled(device.queue.onSubmittedWorkDone());
    }
    expect(pool.created).toBe(created);
    if (device.features.has("timestamp-query")) {
      await until(() => (presenter.stats.passes?.length ?? 0) > 0);
      expect(presenter.stats.passes!.map((p) => p.name)).toEqual(["linear composite", "bloom", "tone map", "post"]);
      expect(presenter.stats.gpuMs).toBeGreaterThanOrEqual(0);
    }
    presenter.dispose();
  });
});
