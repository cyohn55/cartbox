/**
 * Pacing a GPU that reads its frames back (gpuPacing.ts): the run loop keeps
 * time while the GPU falls behind, so the 3D's render size follows how often
 * its frames land — down at once to where they fit, up a step after a while —
 * and only when the GPU, not the run loop, is what's slow. A smaller frame is
 * filtered up to the full one.
 */

import { describe, expect, it } from "vitest";

import { GPU_RENDER_SCALES, GpuPacer, expandBilinear, resampleNearest, stepFor } from "../packages/player/src/render/gpuPacing";

/** Presents `frames` frames `presentMs` apart from `from`, one landing every `landEvery` presents: the pacer's steps over time. */
function run(pacer: GpuPacer, frames: number, presentMs: number, landEvery: number, from = 0, landed0 = 0): { now: number; landed: number; steps: number[] } {
  let now = from;
  let landed = landed0;
  const steps: number[] = [];
  for (let i = 1; i <= frames; i += 1) {
    now += presentMs;
    if (i % landEvery === 0) landed += 1;
    steps.push(pacer.update(now, landed));
  }
  return { now, landed, steps };
}

describe("GPU pacing", () => {
  it("leaves a GPU that keeps up at full size", () => {
    const pacer = new GpuPacer();
    const { steps } = run(pacer, 600, 1000 / 60, 1);
    expect(new Set(steps)).toEqual(new Set([0]));
    expect(pacer.gpuBoundMs(10_000)).toBeNull();
  });

  it("doesn't shrink the frame for a slow run loop: the CPU is what holds it back", () => {
    const pacer = new GpuPacer();
    // 15 fps, and every frame lands: the GPU keeps up with what it's given.
    const { steps } = run(pacer, 300, 66, 1);
    expect(steps.at(-1)).toBe(0);
  });

  it("drops straight to the step that fits when the GPU lands a frame a second, within a couple of seconds", () => {
    const pacer = new GpuPacer();
    const { steps } = run(pacer, 180, 1000 / 60, 60);
    const first = steps.findIndex((s) => s > 0);
    expect(first).toBeGreaterThan(0);
    expect(first).toBeLessThan(150);
    // A second a frame against a 30 ms aim is far past the smallest step: it goes all the way.
    expect(steps.at(-1)).toBe(GPU_RENDER_SCALES.length - 1);
    expect(pacer.scale).toBe(GPU_RENDER_SCALES.at(-1));
  });

  it("acts on a stall before any frame lands", () => {
    const pacer = new GpuPacer();
    const { steps } = run(pacer, 120, 1000 / 60, 1_000_000);
    expect(steps.at(-1)).toBeGreaterThan(0);
  });

  it("steps a little down for a GPU a little behind, then holds where it keeps up", () => {
    const pacer = new GpuPacer();
    // A GPU taking 50 ms over a full frame, its time going with the pixels (the square of the scale), behind a
    // run loop presenting 60 a second; it starts the next frame when the last lands.
    let now = 0;
    let landed = 0;
    let busyUntil = 50;
    const steps: number[] = [];
    for (let i = 0; i < 60 * 10; i += 1) {
      now += 1000 / 60;
      if (now >= busyUntil) {
        landed += 1;
        busyUntil = now + 50 * pacer.scale * pacer.scale;
      }
      steps.push(pacer.update(now, landed));
    }
    const after = steps.at(-1)!;
    expect(after).toBeGreaterThan(0);
    expect(after).toBeLessThan(GPU_RENDER_SCALES.length - 1);
    // Held for the last few seconds: no climbing back into the slow size and down again.
    expect(new Set(steps.slice(-60 * 4))).toEqual(new Set([after]));
  });

  it("climbs back a step at a time once the GPU has room, a few seconds apart", () => {
    const pacer = new GpuPacer();
    const slow = run(pacer, 180, 1000 / 60, 60);
    expect(pacer.step).toBe(GPU_RENDER_SCALES.length - 1);
    const fast = run(pacer, 60 * 8, 1000 / 60, 1, slow.now, slow.landed);
    const climbs = fast.steps.filter((s, i) => i > 0 && s < fast.steps[i - 1]!).length;
    expect(climbs).toBeGreaterThanOrEqual(1);
    expect(climbs).toBeLessThanOrEqual(3);
    expect(fast.steps.every((s, i) => i === 0 || fast.steps[i - 1]! - s <= 1)).toBe(true);
  });

  it("reports how slow a GPU that holds the 3D back is, for the quality governor", () => {
    const pacer = new GpuPacer();
    const { now } = run(pacer, 20, 1000 / 60, 10);
    expect(pacer.gpuBoundMs(now)).toBeGreaterThan(100);
  });

  it("ignores a pause (a hidden tab) rather than reading it as a stall", () => {
    const pacer = new GpuPacer();
    const a = run(pacer, 120, 1000 / 60, 1);
    pacer.update(a.now + 5000, a.landed);
    const b = run(pacer, 120, 1000 / 60, 1, a.now + 5000, a.landed);
    expect(b.steps.every((s) => s === 0)).toBe(true);
  });

  it("chooses the step whose pixels fit the aim (time goes with the square of the scale)", () => {
    expect(stepFor(1, 30, 30)).toBe(0);
    expect(GPU_RENDER_SCALES[stepFor(1, 60, 30)]!).toBeLessThanOrEqual(Math.sqrt(0.5) + 1e-9);
    expect(stepFor(1, 5000, 30)).toBe(GPU_RENDER_SCALES.length - 1);
  });
});

describe("filtering a smaller frame up", () => {
  const px = (r: number, g: number, b: number, a: number) => [r, g, b, a];

  it("keeps a flat frame flat and its alpha", () => {
    const src = new Uint8ClampedArray(4 * 4 * 4).fill(0);
    for (let i = 0; i < 16; i += 1) src.set(px(10, 200, 30, 255), i * 4);
    const dst = new Uint8ClampedArray(9 * 7 * 4);
    expandBilinear(src, 4, 4, dst, 9, 7);
    for (let i = 0; i < 9 * 7; i += 1) expect([...dst.subarray(i * 4, i * 4 + 4)]).toEqual([10, 200, 30, 255]);
  });

  it("blends between neighbours, channel by channel, clamped at the edges", () => {
    // Two pixels, black and white, doubled: the outer pixels keep their colour, the inner ones meet between.
    const src = new Uint8ClampedArray([...px(0, 0, 0, 0), ...px(255, 255, 255, 255)]);
    const dst = new Uint8ClampedArray(4 * 1 * 4);
    expandBilinear(src, 2, 1, dst, 4, 1);
    const reds = [0, 1, 2, 3].map((i) => dst[i * 4]!);
    expect(reds[0]).toBe(0);
    expect(reds[3]).toBe(255);
    expect(reds[1]).toBeGreaterThan(40);
    expect(reds[1]).toBeLessThan(90);
    expect(reds[2]).toBeGreaterThan(165);
    expect(reds[2]).toBeLessThan(215);
    // Alpha (the top byte) is filtered the same way.
    expect(dst[1 * 4 + 3]).toBe(reds[1]);
  });

  it("matches a straightforward bilinear filter to within a step", () => {
    const sw = 5, sh = 3, dw = 13, dh = 8;
    const src = new Uint8ClampedArray(sw * sh * 4);
    for (let i = 0; i < src.length; i += 1) src[i] = (i * 37) % 256;
    const dst = new Uint8ClampedArray(dw * dh * 4);
    expandBilinear(src, sw, sh, dst, dw, dh);
    for (let y = 0; y < dh; y += 1) {
      for (let x = 0; x < dw; x += 1) {
        const sx = Math.min(sw - 1, Math.max(0, ((x + 0.5) * sw) / dw - 0.5));
        const sy = Math.min(sh - 1, Math.max(0, ((y + 0.5) * sh) / dh - 0.5));
        const x0 = Math.floor(sx), y0 = Math.floor(sy), x1 = Math.min(sw - 1, x0 + 1), y1 = Math.min(sh - 1, y0 + 1);
        for (let c = 0; c < 4; c += 1) {
          const at = (xx: number, yy: number) => src[(yy * sw + xx) * 4 + c]!;
          const top = at(x0, y0) + (at(x1, y0) - at(x0, y0)) * (sx - x0);
          const bottom = at(x0, y1) + (at(x1, y1) - at(x0, y1)) * (sx - x0);
          const want = top + (bottom - top) * (sy - y0);
          expect(Math.abs(dst[(y * dw + x) * 4 + c]! - want)).toBeLessThanOrEqual(2);
        }
      }
    }
  });

  it("resamples a frame to a new size, nearest, so the last frame shows until one lands at the new size", () => {
    const src = new Uint8Array([...px(1, 2, 3, 4), ...px(5, 6, 7, 8)]);
    const out = resampleNearest(src, 2, 1, 4, 2);
    expect(out.length).toBe(4 * 2 * 4);
    expect([...out.subarray(0, 4)]).toEqual([1, 2, 3, 4]);
    expect([...out.subarray(12, 16)]).toEqual([5, 6, 7, 8]);
    expect([...out.subarray(16, 20)]).toEqual([1, 2, 3, 4]);
  });
});
