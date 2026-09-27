/**
 * The playtest profiler (ENGINE_ROADMAP.md, Phase 5): per-frame section times
 * over a rolling window, what the 3D renderer drew, memory estimates and
 * multiplayer traffic.
 */

import { describe, expect, it } from "vitest";

import { composeModelMatrix, type MeshAsset } from "@cartbox/editor";
import { MemoryNetHub, NetSession, PROFILE_WINDOW, Profiler, SoftwareSceneRenderer, estimateSceneBytes, type ProfileSnapshot } from "@cartbox/player";
import { WebglPassTimer } from "../packages/player/src/render/gpuTimer";
import { budgetBar } from "../apps/web/src/app/edit/[cartId]/profilerView";

describe("the profiler", () => {
  it("averages and peaks each section over closed frames, and totals without double-counting render passes", () => {
    const p = new Profiler();
    for (let f = 0; f < 4; f += 1) {
      p.nextFrame();
      p.add("cart", f === 2 ? 9 : 3);
      p.add("render", 4);
      p.add("scene", 3); // part of render
      p.add("runtime", 0.5);
      p.add("runtime", 0.5); // two laps in one frame add up
    }
    p.nextFrame(); // close the last one
    p.add("cart", 100); // the open frame isn't counted
    const { frames, sections, total } = p.sections();
    expect(frames).toBe(4);
    expect(sections.cart).toEqual({ avg: 4.5, max: 9 });
    expect(sections.runtime.avg).toBe(1);
    expect(sections.scene.avg).toBe(3);
    expect(total).toEqual({ avg: 9.5, max: 14 });
  });

  it("keeps only the last window of frames", () => {
    const p = new Profiler();
    for (let f = 0; f < PROFILE_WINDOW * 2; f += 1) {
      p.nextFrame();
      p.add("cart", f < PROFILE_WINDOW ? 50 : 1);
    }
    p.nextFrame();
    const { frames, sections } = p.sections();
    expect(frames).toBe(PROFILE_WINDOW - 1);
    expect(sections.cart).toEqual({ avg: 1, max: 1 });
  });
});

const quad = (textured: boolean): MeshAsset => ({
  name: "q",
  primitives: [
    {
      positions: Float32Array.from([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]),
      normals: null,
      uvs: null,
      indices: Uint32Array.from([0, 1, 2, 0, 2, 3]),
      material: { name: "m", baseColorFactor: [1, 1, 1, 1], baseColorImage: textured ? { mime: "image/png", bytes: new Uint8Array() } : null },
    },
  ],
});

describe("what the scene costs", () => {
  it("estimates geometry and textures once each, plus the render targets", () => {
    const mesh = quad(false);
    const tex = { width: 4, height: 2, data: new Uint8ClampedArray(32) };
    const bytes = estimateSceneBytes(
      [
        { mesh, textures: [tex] },
        { mesh, textures: [tex, null] },
      ],
      10,
      10,
    );
    expect(bytes).toBe(10 * 10 * 8 + 4 * 32 + 6 * 4 + 4 * 2 * 4);
  });

  it("the software renderer counts what it drew", () => {
    const r = new SoftwareSceneRenderer();
    const mesh = quad(false);
    const w = 16;
    const h = 16;
    const view = composeModelMatrix([0, 0, -5], [0, 0, 0], [1, 1, 1]);
    const projection = Float32Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, -1, -1, 0, 0, -0.2, 0]) as unknown as typeof view;
    r.render(
      [
        { mesh, model: composeModelMatrix([0, 0, 0], [0, 0, 0], [1, 1, 1]) },
        { mesh, model: composeModelMatrix([0.5, 0, 0], [0, 0, 0], [1, 1, 1]) },
      ],
      { width: w, height: h, out: new Uint8ClampedArray(w * h * 4), depth: new Float32Array(w * h), view, projection, background: null },
    );
    expect(r.lastFrameStats).toMatchObject({ drawCalls: 2, triangles: 4, gpuMs: null });
  });
});

describe("GPU timing", () => {
  it("reads WebGL2 elapsed-time queries once they're ready, skipping disjoint ones", () => {
    const results = new Map<object, number>();
    let disjoint = false;
    let ready = false;
    const gl = {
      QUERY_RESULT_AVAILABLE: 1,
      QUERY_RESULT: 2,
      getExtension: () => ({ TIME_ELAPSED_EXT: 9, GPU_DISJOINT_EXT: 10 }),
      getParameter: () => disjoint,
      createQuery: () => ({}),
      beginQuery: (_t: number, q: object) => results.set(q, 2_500_000),
      endQuery: () => {},
      getQueryParameter: (q: object, p: number) => (p === 1 ? ready : results.get(q)),
      deleteQuery: () => {},
    };
    const timer = WebglPassTimer.create(gl)!;
    timer.begin();
    timer.end();
    timer.begin(); // not ready yet
    timer.end();
    expect(timer.lastMs).toBeNull();
    ready = true;
    timer.begin();
    timer.end();
    expect(timer.lastMs).toBe(2.5);
    disjoint = true;
    timer.lastMs = null;
    timer.begin();
    expect(timer.lastMs).toBeNull();
    expect(WebglPassTimer.create({ getExtension: () => null })).toBeNull();
  });
});

describe("network traffic", () => {
  it("counts the bytes a session sends and receives", async () => {
    const hub = new MemoryNetHub();
    const a = new NetSession(hub.transport("a"));
    const b = new NetSession(hub.transport("b"));
    await a.connect();
    await b.connect();
    const words = new Uint32Array(119);
    for (let i = 0; i < 12; i += 1) {
      a.beforeTick(words);
      words[70] = 1; // slot 0's state changed
      words[72] = i;
      a.afterTick(words);
    }
    expect(a.traffic().sent).toBeGreaterThan(0);
    expect(b.traffic().received).toBe(a.traffic().sent);
  });
});

describe("the frame budget bar", () => {
  it("splits the budget by section and never overflows it", () => {
    const zero = { avg: 0, max: 0 };
    const profile = {
      frames: 10,
      sections: { cart: { avg: 8, max: 8 }, runtime: { avg: 4, max: 4 }, render: { avg: 10, max: 10 }, audio: zero, net: zero, shadow: zero, sky: zero, scene: zero },
      total: { avg: 22, max: 22 },
      render: null,
      memory: { wasm: 0, jsHeap: null, scene: null },
      net: null,
    } satisfies ProfileSnapshot;
    const bar = budgetBar(profile, 16);
    expect(bar.map((b) => b.fraction)).toEqual([0.5, 0.25, 0.25, 0, 0]);
  });
});
