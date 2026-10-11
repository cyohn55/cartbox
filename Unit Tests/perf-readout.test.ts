/** Lockout's frame-rate readout: where a frame's time goes, in one line. */

import { describe, expect, it } from "vitest";

import type { ProfileSnapshot } from "@cartbox/player";
import { perfLine } from "../apps/web/src/lib/perfReadout";

const stats = (avg: number) => ({ avg, max: avg * 2 });
const snapshot = (render: ProfileSnapshot["render"]): ProfileSnapshot => ({
  frames: 60,
  sections: { cart: stats(6.12), runtime: stats(0.3), audio: stats(0.1), net: stats(0.05), render: stats(11.4), shadow: stats(2.05), sky: stats(1.42), scene: stats(6) },
  total: stats(18.3),
  render,
  memory: { wasm: 0, jsHeap: null, scene: null },
  net: null,
});

describe("the performance readout", () => {
  it("names the frame's cost, its parts, the GPU's time, the renderer and the preset", () => {
    expect(perfLine(snapshot({ drawCalls: 200, instances: 200, triangles: 1e4, gpuMs: 9.24, backend: "webgpu" }), "high")).toBe(
      "frame 18 ms · game 6.1 · 3D 11 (shadow 2.0, sky 1.4, scene 6.0) · GPU 9.2 · webgpu · high",
    );
  });

  it("leaves out what it can't know", () => {
    expect(perfLine(snapshot({ drawCalls: 200, instances: 200, triangles: 1e4, gpuMs: null, backend: "webgl2" }), "low")).toBe(
      "frame 18 ms · game 6.1 · 3D 11 (shadow 2.0, sky 1.4, scene 6.0) · webgl2 · low",
    );
    expect(perfLine(snapshot(null), undefined)).toBe("frame 18 ms · game 6.1");
    expect(perfLine(null, "high")).toBeNull();
  });
});
