/**
 * The HD tiers on a high-density screen (DEMO_QUALITY_ROADMAP.md R4): Lockout
 * and Beaver Creek looked low-resolution and broken up on an iPad.
 *
 * - The Xbox 360 tier read every frame back to the CPU. The byte path's pacing
 *   and "auto" quality judge the GPU by how fast those readbacks land, so a
 *   browser whose readbacks come back slowly (Safari) looks like a slow GPU.
 *   The 3D was cut to a third of the frame and the preset to Low (no
 *   anti-aliasing, no shadows), for good. The tier now presents from the GPU
 *   wherever WebGPU is, with no readback to misjudge.
 * - Every canvas was scaled with nearest-neighbour. An HD frame stretched by a
 *   non-integer factor (1.8× across an iPad) doubles some pixels and not
 *   others. HD frames now scale smoothly; pixel art keeps hard edges.
 */

import { describe, expect, it } from "vitest";

import { upscaleRendering } from "../packages/player/src/display";
import { MODELS, getModel } from "../packages/player/src/models";
import { QualityGovernor, type QualityLevel } from "../packages/player/src/quality";
import { GPU_RENDER_SCALES, GpuPacer } from "../packages/player/src/render/gpuPacing";
import { gpuPresentFailed, watchGpuPresent } from "../packages/player/src/render/presentFallback";

/**
 * A run on the byte path: a GPU taking `gpuMs` a frame, read back through 3
 * buffers whose readbacks each land `latency` ms after the frame is done, with
 * the run loop at 60 fps skipping a submit while all 3 are in flight. The
 * render scale and preset the pacing and "auto" settle on.
 */
function bytePath(gpuMs: number, latency: number): { scale: number; level: QualityLevel } {
  const pacer = new GpuPacer();
  const governor = new QualityGovernor();
  let level: QualityLevel = "medium";
  governor.reset(0);
  const inFlight: number[] = [];
  let landed = 0;
  let gpuFree = 0;
  for (let t = 0; t < 20000; t += 1000 / 60) {
    while (inFlight.length > 0 && inFlight[0]! <= t) {
      inFlight.shift();
      landed += 1;
    }
    if (inFlight.length < 3) {
      gpuFree = Math.max(gpuFree, t) + gpuMs * pacer.scale ** 2;
      inFlight.push(gpuFree + latency);
    }
    pacer.update(t, landed);
    const gpu = pacer.gpuBoundMs(t);
    const step = gpu !== null && gpu > 1000 / 60 ? governor.feed(gpu, gpu, t, level) : governor.feed(1000 / 60, 4, t, level);
    if (step) level = step;
  }
  return { scale: GPU_RENDER_SCALES[pacer.step]!, level };
}

describe("why the HD tier no longer reads its frames back", () => {
  it("the byte path can't tell slow readbacks from a slow GPU", () => {
    // A fast GPU with quick readbacks keeps the full frame and its preset...
    expect(bytePath(2, 20)).toEqual({ scale: 1, level: "medium" });
    // ...but the same fast GPU behind slow readbacks is cut to the smallest frame and Low, as a slow GPU is.
    expect(bytePath(2, 200)).toEqual({ scale: GPU_RENDER_SCALES.at(-1), level: "low" });
    // Worse than a GPU thirty times slower: fewer pixels can't shorten a readback, so it cuts all the way down.
    const slowGpu = bytePath(60, 20);
    expect(slowGpu.scale).toBeGreaterThan(GPU_RENDER_SCALES.at(-1)!);
    expect(slowGpu.level).not.toBe("low");
  });
});

describe("the Xbox 360 tier", () => {
  it("presents from the GPU wherever it can (no readback to misjudge)", () => {
    expect(getModel("xbox360").renderCaps.gpuPresent).toBe(true);
    expect(getModel("aaa").renderCaps.gpuPresent).toBe(true);
  });

  it("leaves the pixel-art tiers on the path they shipped on", () => {
    for (const model of Object.values(MODELS)) {
      if (model.width < 1280) expect(model.renderCaps?.gpuPresent ?? false, model.id).toBe(false);
    }
  });
});

describe("scaling a frame up to the screen", () => {
  it("is smooth for an HD frame and keeps hard pixels for pixel art", () => {
    expect(upscaleRendering(getModel("xbox360"))).toBe("auto");
    expect(upscaleRendering(getModel("aaa"))).toBe("auto");
    for (const model of Object.values(MODELS)) expect(upscaleRendering(model), model.id).toBe(model.width >= 1280 ? "auto" : "pixelated");
    expect(Object.values(MODELS).some((m) => upscaleRendering(m) === "pixelated")).toBe(true);
  });
});

describe("a browser where presenting from the GPU fails", () => {
  const memory = () => {
    const kept = new Map<string, string>();
    return { getItem: (k: string) => kept.get(k) ?? null, setItem: (k: string, v: string) => void kept.set(k, v) };
  };
  /** A device whose uncaptured errors the test raises, and a clock the test runs. */
  const device = () => {
    const listeners = new Set<(e: { error?: { message?: string } }) => void>();
    return {
      addEventListener: (_t: "uncapturederror", l: (e: { error?: { message?: string } }) => void) => void listeners.add(l),
      removeEventListener: (_t: "uncapturederror", l: (e: { error?: { message?: string } }) => void) => void listeners.delete(l),
      fail: (message: string) => listeners.forEach((l) => l({ error: { message } })),
      listening: () => listeners.size,
    };
  };

  it("is remembered, so the next load takes the byte path", () => {
    const storage = memory();
    const d = device();
    const warn = console.warn;
    console.warn = () => {};
    try {
      expect(gpuPresentFailed(storage)).toBe(false);
      watchGpuPresent(d, storage, 8000, () => {});
      d.fail("pipeline rejected");
      expect(gpuPresentFailed(storage)).toBe(true);
      // One error is enough: it stops listening.
      expect(d.listening()).toBe(0);
    } finally {
      console.warn = warn;
    }
  });

  it("is watched only for the first seconds, and a quiet start leaves the GPU path on", () => {
    const storage = memory();
    const d = device();
    let stop: (() => void) | null = null;
    watchGpuPresent(d, storage, 8000, (fn) => (stop = fn));
    expect(d.listening()).toBe(1);
    stop!();
    expect(d.listening()).toBe(0);
    d.fail("later, unrelated");
    expect(gpuPresentFailed(storage)).toBe(false);
  });

  it("does nothing where there is no device or no storage", () => {
    expect(() => watchGpuPresent(null, null)()).not.toThrow();
    expect(gpuPresentFailed(null)).toBe(false);
    const d = device();
    const warn = console.warn;
    console.warn = () => {};
    try {
      watchGpuPresent(d, null, 8000, () => {});
      expect(() => d.fail("no storage")).not.toThrow();
    } finally {
      console.warn = warn;
    }
  });
});
