/**
 * The frame graph (AAA_FIDELITY_ROADMAP.md F0c). The pure compile covers
 * culling, ordering, transient lifetimes and aliasing, usage flags and the
 * declaration errors. The transient pool runs on a fake device, and the
 * timestamps arithmetic is checked on its own. On a real device (Dawn), it
 * checks that an aliased frame encodes correctly, and that the scene renderer
 * times each of its passes and reuses its transients from frame to frame.
 */

import { describe, expect, it } from "vitest";

import { FrameGraph, GraphTimer, TransientPool, slotKey, timesFromStamps, type TextureDesc } from "../packages/player/src/render/frameGraph";
import { WebgpuSceneRenderer, type SceneDraw } from "@cartbox/player";
import { composeModelMatrix, multiplyMat4, projectionMatrix, viewMatrix, type MeshAsset, type MeshSceneInstance } from "@cartbox/editor";

const RGBA: TextureDesc = { format: "rgba16float", width: 8, height: 8 };
const noop = () => () => {};

describe("compiling a frame", () => {
  it("runs the passes in the order declared and culls the ones nothing needs", () => {
    const graph = new FrameGraph();
    const out = graph.importTexture("out", {});
    const a = graph.createTexture("a", RGBA);
    const unused = graph.createTexture("unused", RGBA);
    graph.addPass("make-a", "render", (pass) => {
      pass.write(a);
      return () => {};
    });
    graph.addPass("make-unused", "render", (pass) => {
      pass.write(unused);
      return () => {};
    });
    graph.addPass("blit", "render", (pass) => {
      pass.read(a);
      pass.write(out);
      return () => {};
    });
    const frame = graph.compile();
    expect(frame.order).toEqual(["make-a", "blit"]);
    expect(frame.culled).toEqual(["make-unused"]);
    // Compiling is idempotent.
    expect(graph.compile()).toBe(frame);
  });

  it("keeps a pass marked kept, and what it reads, though it writes nothing", () => {
    const graph = new FrameGraph();
    const a = graph.createTexture("a", RGBA);
    graph.addPass("make", "render", (pass) => {
      pass.write(a);
      return () => {};
    });
    graph.addPass("readback", "transfer", (pass) => {
      pass.read(a, "copySrc");
      pass.keep();
      return () => {};
    });
    expect(graph.compile().order).toEqual(["make", "readback"]);
  });

  it("culls a whole chain that ends in nothing", () => {
    const graph = new FrameGraph();
    const a = graph.createTexture("a", RGBA);
    const b = graph.createTexture("b", RGBA);
    graph.addPass("one", "render", (pass) => (pass.write(a), () => {}));
    graph.addPass("two", "render", (pass) => (pass.read(a), pass.write(b), () => {}));
    const frame = graph.compile();
    expect(frame.order).toEqual([]);
    expect(frame.culled).toEqual(["one", "two"]);
    expect(frame.slots).toEqual([]);
  });

  it("aliases transients of one shape whose lives don't overlap, and never ones that do", () => {
    const graph = new FrameGraph();
    const out = graph.importTexture("out", {});
    const a = graph.createTexture("a", RGBA);
    const b = graph.createTexture("b", RGBA);
    const c = graph.createTexture("c", RGBA);
    // a lives over passes 0–1, b over 1–2, c over 2–3: a and c can share.
    graph.addPass("p0", "render", (pass) => (pass.write(a), () => {}));
    graph.addPass("p1", "render", (pass) => (pass.read(a), pass.write(b), () => {}));
    graph.addPass("p2", "render", (pass) => (pass.read(b), pass.write(c), () => {}));
    graph.addPass("p3", "render", (pass) => (pass.read(c), pass.write(out), () => {}));
    const frame = graph.compile();
    const slot = Object.fromEntries(frame.allocations.map((x) => [x.resource, x.slot]));
    expect(frame.slots).toHaveLength(2);
    expect(slot.a).toBe(slot.c);
    expect(slot.b).not.toBe(slot.a);
    expect(frame.allocations.find((x) => x.resource === "b")).toMatchObject({ first: 1, last: 2 });
  });

  it("doesn't alias transients that differ in shape or usage", () => {
    const graph = new FrameGraph();
    const out = graph.importTexture("out", {});
    const a = graph.createTexture("a", RGBA);
    const half = graph.createTexture("half", { ...RGBA, width: 4 });
    const copied = graph.createTexture("copied", RGBA);
    graph.addPass("p0", "render", (pass) => (pass.write(a), () => {}));
    graph.addPass("p1", "render", (pass) => (pass.read(a), pass.write(out), () => {}));
    graph.addPass("p2", "render", (pass) => (pass.write(half), () => {}));
    graph.addPass("p3", "render", (pass) => (pass.read(half), pass.write(out), () => {}));
    graph.addPass("p4", "render", (pass) => (pass.write(copied), () => {}));
    graph.addPass("p5", "transfer", (pass) => (pass.read(copied, "copySrc"), pass.write(out, "copyDst"), () => {}));
    const frame = graph.compile();
    expect(frame.slots).toHaveLength(3);
  });

  it("makes each transient with the usage its passes need", () => {
    const graph = new FrameGraph();
    const out = graph.importTexture("out", {});
    const a = graph.createTexture("a", RGBA);
    graph.addPass("draw", "render", (pass) => (pass.write(a), () => {}));
    graph.addPass("sample", "render", (pass) => (pass.read(a), pass.write(out), () => {}));
    graph.addPass("copy", "transfer", (pass) => (pass.read(a, "copySrc"), pass.write(out, "copyDst"), () => {}));
    const [slot] = graph.compile().slots;
    expect(slot!.usage).toBe(0x10 | 0x04 | 0x01); // RENDER_ATTACHMENT | TEXTURE_BINDING | COPY_SRC
    expect(slot!.key).toBe(slotKey(RGBA, 0x15));
  });

  it("refuses to read a transient before anything writes it", () => {
    const graph = new FrameGraph();
    const out = graph.importTexture("out", {});
    const a = graph.createTexture("a", RGBA);
    graph.addPass("early", "render", (pass) => (pass.read(a), pass.write(out), () => {}));
    graph.addPass("late", "render", (pass) => (pass.write(a), pass.keep(), () => {}));
    expect(() => graph.compile()).toThrow(/reads "a" before anything writes it/);
  });

  it("refuses a resource from another graph, a missing import, and changes after compiling", () => {
    const one = new FrameGraph();
    const two = new FrameGraph();
    const foreign = two.createTexture("x", RGBA);
    expect(() => one.addPass("p", "render", (pass) => (pass.read(foreign), noop()))).toThrow(/isn't this graph's/);
    expect(() => one.importTexture("gone", null)).toThrow(/missing/);
    one.compile();
    expect(() => one.createTexture("late", RGBA)).toThrow(/after compiling/);
    expect(() => one.addPass("late", "render", noop)).toThrow(/after compiling/);
  });

  it("hands a pass only what it declared", () => {
    const graph = new FrameGraph();
    const out = graph.importTexture("out", { label: "out" });
    const other = graph.importTexture("other", { label: "other" });
    graph.addPass("p", "render", (pass) => {
      pass.write(out);
      return (ctx) => {
        expect(ctx.texture(out)).toEqual({ label: "out" });
        expect(() => ctx.texture(other)).toThrow(/without declaring it/);
        expect(ctx.timing).toEqual({});
      };
    });
    graph.run({}, new TransientPool(fakeDevice().device));
  });
});

/** A device that only makes textures, counting them. */
function fakeDevice() {
  const made: { usage: number; format: string; destroyed: boolean }[] = [];
  return {
    made,
    device: {
      createTexture: (desc: any) => {
        const t = { usage: desc.usage, format: desc.format, destroyed: false, destroy: () => (t.destroyed = true) };
        made.push(t);
        return t;
      },
    },
  };
}

describe("the transient pool", () => {
  const slots = (n: number) => Array.from({ length: n }, () => ({ key: slotKey(RGBA, 0x14), desc: RGBA, usage: 0x14 }));

  it("gives a frame of the same shape the same textures, making none", () => {
    const { device, made } = fakeDevice();
    const pool = new TransientPool(device);
    const first = pool.take(slots(2));
    const second = pool.take(slots(2));
    expect(second).toEqual(first);
    expect(second[0]).toBe(first[0]);
    expect(made).toHaveLength(2);
    expect(pool.created).toBe(2);
  });

  it("grows for a bigger frame and destroys what stays idle", () => {
    const { device, made } = fakeDevice();
    const pool = new TransientPool(device, 3);
    pool.take(slots(3));
    expect(pool.size).toBe(3);
    for (let i = 0; i < 3; i += 1) pool.take(slots(1));
    expect(pool.size).toBe(3);
    pool.take(slots(1));
    expect(pool.size).toBe(1);
    expect(made.filter((t) => t.destroyed)).toHaveLength(2);
    pool.destroy();
    expect(made.every((t) => t.destroyed)).toBe(true);
  });
});

describe("pass timings", () => {
  it("are each pass's end minus begin, and the frame's first begin to last end", () => {
    const ns = (...v: number[]) => BigUint64Array.from(v.map((x) => BigInt(x)));
    const times = timesFromStamps(["a", "b"], ns(1_000_000, 3_000_000, 3_500_000, 4_000_000))!;
    expect(times.passes).toEqual([
      { name: "a", ms: 2 },
      { name: "b", ms: 0.5 },
    ]);
    expect(times.total).toBe(3);
  });

  it("are thrown away when the stamps are nonsense", () => {
    const ns = (...v: number[]) => BigUint64Array.from(v.map((x) => BigInt(x)));
    expect(timesFromStamps(["a"], ns(5, 1))).toBeNull(); // end before begin
    expect(timesFromStamps(["a", "b"], ns(1, 2))).toBeNull(); // too few
    expect(timesFromStamps([], ns())).toBeNull();
  });

  it("need the device to have timestamp queries", () => {
    expect(GraphTimer.create({ features: new Set() })).toBeNull();
    expect(GraphTimer.create(null)).toBeNull();
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

/** Pump Dawn until `done` holds (its callbacks run on tick). */
async function until(done: () => boolean, tries = 400): Promise<void> {
  for (let i = 0; i < tries && !done(); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    device.tick?.();
  }
}

async function readPixel(texture: any): Promise<number[]> {
  const buffer = device.createBuffer({ size: 256, usage: 0x01 | 0x08 }); // MAP_READ | COPY_DST
  const encoder = device.createCommandEncoder();
  encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow: 256 }, { width: 1, height: 1 });
  device.queue.submit([encoder.finish()]);
  let mapped = false;
  void buffer.mapAsync(0x01).then(() => (mapped = true));
  await until(() => mapped);
  const out = Array.from(new Uint8Array(buffer.getMappedRange()).slice(0, 4));
  buffer.unmap();
  buffer.destroy();
  return out;
}

// Each builds a renderer and pumps Dawn for frames: allow them the time a busy machine takes.
describe.skipIf(!device)("on a real device", { timeout: 60_000 }, () => {
  it("encodes an aliased frame correctly: two transients in one texture, each copied out before the next", async () => {
    const make = () => device.createTexture({ size: { width: 4, height: 4 }, format: "rgba8unorm", usage: 0x10 | 0x01 | 0x02 });
    const outs = [make(), make()];
    const graph = new FrameGraph();
    const desc: TextureDesc = { format: "rgba8unorm", width: 4, height: 4 };
    const colours = [
      { r: 1, g: 0, b: 0, a: 1 },
      { r: 0, g: 0, b: 1, a: 1 },
    ];
    colours.forEach((clearValue, k) => {
      const t = graph.createTexture(`t${k}`, desc);
      const out = graph.importTexture(`out${k}`, outs[k]);
      graph.addPass(`clear${k}`, "render", (pass) => {
        pass.write(t);
        return (ctx) => ctx.encoder.beginRenderPass({ colorAttachments: [{ view: ctx.texture(t).createView(), clearValue, loadOp: "clear", storeOp: "store" }], ...ctx.timing }).end();
      });
      graph.addPass(`copy${k}`, "transfer", (pass) => {
        pass.read(t, "copySrc");
        pass.write(out, "copyDst");
        return (ctx) => ctx.encoder.copyTextureToTexture({ texture: ctx.texture(t) }, { texture: ctx.texture(out) }, { width: 4, height: 4 });
      });
    });
    const pool = new TransientPool(device);
    const timer = GraphTimer.create(device);
    const encoder = device.createCommandEncoder();
    const frame = graph.run(encoder, pool, timer);
    device.queue.submit([encoder.finish()]);
    timer?.read();
    expect(frame.slots).toHaveLength(1);
    expect(pool.created).toBe(1);
    expect(await readPixel(outs[0])).toEqual([255, 0, 0, 255]);
    expect(await readPixel(outs[1])).toEqual([0, 0, 255, 255]);
    if (timer) {
      await until(() => timer.lastPasses.length > 0);
      expect(timer.lastPasses.map((p) => p.name)).toEqual(["clear0", "clear1"]);
      expect(timer.lastMs).toBeGreaterThanOrEqual(0);
    }
    pool.destroy();
    timer?.destroy();
  });

  it("times each of the scene renderer's passes, and makes its transients once", async () => {
    const W = 64;
    const H = 48;
    const renderer = (await WebgpuSceneRenderer.create(device, W, H))!;
    const quad: MeshAsset = {
      name: "q",
      primitives: [
        {
          positions: Float32Array.from([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]),
          normals: Float32Array.from([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
          uvs: Float32Array.from([0, 0, 1, 0, 1, 1, 0, 1]),
          indices: Uint32Array.from([0, 1, 2, 0, 2, 3]),
          material: { name: "m", baseColorFactor: [0.8, 0.5, 0.3, 1], baseColorImage: null, metallicFactor: 0, roughnessFactor: 0.6 },
        },
      ],
    } as unknown as MeshAsset;
    const instances: MeshSceneInstance[] = [{ mesh: quad, model: composeModelMatrix([0, 0, 0], [0, 0, 0], [1, 1, 1]), textures: null }];
    const draw = (): SceneDraw =>
      ({
        width: W,
        height: H,
        out: new Uint8ClampedArray(W * H * 4),
        depth: new Float32Array(W * H),
        background: [0, 0, 0, 255],
        view: viewMatrix([0, 0, 3], [0, 0, 0]),
        projection: projectionMatrix(Math.PI / 3, W / H, 0.1, 50),
        lightDirection: [0.3, 0.6, 1],
        ambient: 0.3,
        antialias: true,
        reflections: true,
        temporal: true,
        tonemap: { exposure: 1 },
      }) as unknown as SceneDraw;
    const pool = (renderer as any).transients as TransientPool;
    for (let frame = 0; frame < 6; frame += 1) {
      renderer.render(instances, draw());
      await until(() => false, 10);
    }
    const created = pool.created;
    expect(created).toBeGreaterThan(0);
    for (let frame = 0; frame < 4; frame += 1) {
      renderer.render(instances, draw());
      await until(() => false, 10);
    }
    // A steady frame takes the same transients: nothing new is made.
    expect(pool.created).toBe(created);
    if (device.features.has("timestamp-query")) {
      await until(() => (renderer.lastFrameStats.passes?.length ?? 0) > 0);
      const names = renderer.lastFrameStats.passes!.map((p) => p.name);
      expect(names).toEqual(["opaque", "reflections", "taa.resolve", "taa.sharpen"]);
      expect(renderer.lastFrameStats.gpuMs).toBeGreaterThanOrEqual(0);
    }
    renderer.dispose();
  });

  it("lays a depth prepass and the thin G-buffer before shading: normal, roughness, material ID", async () => {
    const W = 64;
    const H = 48;
    const quadOf = (material: Record<string, unknown>): MeshAsset =>
      ({
        name: "q",
        primitives: [
          {
            positions: Float32Array.from([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]),
            normals: Float32Array.from([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
            uvs: Float32Array.from([0, 0, 1, 0, 1, 1, 0, 1]),
            indices: Uint32Array.from([0, 1, 2, 0, 2, 3]),
            material: { name: "m", baseColorFactor: [0.8, 0.5, 0.3, 1], baseColorImage: null, metallicFactor: 0, roughnessFactor: 0.6, ...material },
          },
        ],
      }) as unknown as MeshAsset;
    // Left: a rough quad facing the camera. Right: a smoother one, turned 60° about Y.
    const left = quadOf({ roughnessFactor: 0.6 });
    const right = quadOf({ roughnessFactor: 0.25 });
    const glass = quadOf({ baseColorFactor: [0.2, 0.6, 1, 0.4], alphaMode: "blend" });
    const instances: MeshSceneInstance[] = [
      { mesh: left, model: composeModelMatrix([-1.1, 0, 0], [0, 0, 0], [0.9, 0.9, 1]), textures: null },
      { mesh: right, model: composeModelMatrix([1.1, 0, 0], [0, 60, 0], [0.9, 0.9, 1]), textures: null },
      // See-through: not in the prepass, so not in the G-buffer.
      { mesh: glass, model: composeModelMatrix([-1.1, 0, 0.5], [0, 0, 0], [0.4, 0.4, 1]), textures: null },
    ];
    for (const antialias of [false, true]) {
      const renderer = (await WebgpuSceneRenderer.create(device, W, H))!;
      const draw = (): SceneDraw =>
        ({
          width: W,
          height: H,
          out: new Uint8ClampedArray(W * H * 4),
          depth: new Float32Array(W * H),
          background: [0, 0, 0, 255],
          view: viewMatrix([0, 0, 4], [0, 0, 0]),
          projection: projectionMatrix(Math.PI / 3, W / H, 0.1, 50),
          lightDirection: [0.3, 0.6, 1],
          ambient: 0.3,
          antialias,
          prepass: true,
        }) as unknown as SceneDraw;
      for (let frame = 0; frame < 3; frame += 1) {
        renderer.render(instances, draw());
        await until(() => false, 10);
      }
      const targets = renderer.prepassTargets!;
      expect(targets.multisampled).toBe(antialias);
      const texels = await readHalf(targets.gbuffer, W, H);
      const at = (x: number, y: number) => Array.from(texels.subarray((y * W + x) * 4, (y * W + x) * 4 + 4));
      const decode = ([ox, oy]: number[]) => {
        let n = [ox!, oy!, 1 - Math.abs(ox!) - Math.abs(oy!)];
        if (n[2]! < 0) n = [(1 - Math.abs(oy!)) * Math.sign(ox!), (1 - Math.abs(ox!)) * Math.sign(oy!), n[2]!];
        const l = Math.hypot(n[0]!, n[1]!, n[2]!);
        return n.map((v) => v / l);
      };
      // The left quad, under the see-through one: its own normal (+Z, facing the camera), roughness and ID.
      const l = at(Math.round(W * 0.27), H / 2);
      expect(decode(l)[2]).toBeCloseTo(1, 2);
      expect(l[2]).toBeCloseTo(0.6, 2);
      expect(l[3]).toBe(1);
      // The right quad, turned 60°: its normal is the turned one, and it's another material.
      const row = Array.from({ length: W }, (_, x) => x).filter((x) => at(x, H / 2)[3] === 2);
      expect(row.length).toBeGreaterThan(2);
      const r = at(row[row.length >> 1]!, H / 2);
      const n = decode(r);
      expect(n[0]).toBeCloseTo(Math.sin(Math.PI / 3), 1);
      expect(n[2]).toBeCloseTo(Math.cos(Math.PI / 3), 1);
      expect(r[2]).toBeCloseTo(0.25, 2);
      expect(r[3]).toBe(2);
      // Nothing opaque drew in the corner.
      expect(at(1, 1)).toEqual([0, 0, 0, 0]);
      // The prepass is the frame's first pass.
      if (device.features.has("timestamp-query")) {
        await until(() => (renderer.lastFrameStats.passes?.length ?? 0) > 0);
        expect(renderer.lastFrameStats.passes![0]!.name).toBe("prepass");
      }
      renderer.dispose();
    }
  });

  it("writes the velocity buffer: the camera's motion, an object's, a skinned vertex's, and nothing from the jitter", async () => {
    const W = 64;
    const H = 48;
    const projection = projectionMatrix(Math.PI / 3, W / H, 0.1, 50);
    const plane = (positions: Float32Array, dynamic?: { revision: number }): MeshAsset =>
      ({
        name: "q",
        primitives: [
          {
            positions,
            normals: Float32Array.from([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
            uvs: Float32Array.from([0, 0, 1, 0, 1, 1, 0, 1]),
            indices: Uint32Array.from([0, 1, 2, 0, 2, 3]),
            material: { name: "m", baseColorFactor: [0.8, 0.5, 0.3, 1], baseColorImage: null, metallicFactor: 0, roughnessFactor: 0.6 },
            ...(dynamic ? { dynamic } : {}),
          },
        ],
      }) as unknown as MeshAsset;
    const square = () => Float32Array.from([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]);
    const draw = (eye: [number, number, number], extra: Record<string, unknown> = {}): SceneDraw =>
      ({
        width: W,
        height: H,
        out: new Uint8ClampedArray(W * H * 4),
        depth: new Float32Array(W * H),
        background: [0, 0, 0, 255],
        view: viewMatrix(eye, [eye[0], eye[1], 0]),
        projection,
        lightDirection: [0.3, 0.6, 1],
        ambient: 0.3,
        prepass: true,
        ...extra,
      }) as unknown as SceneDraw;
    /** Where world point p is on screen (UV, y down) through `view`. */
    const uvOf = (eye: [number, number, number], p: [number, number, number]) => {
      const vp = multiplyMat4(projection, viewMatrix(eye, [eye[0], eye[1], 0]));
      const x = vp[0]! * p[0] + vp[4]! * p[1] + vp[8]! * p[2] + vp[12]!;
      const y = vp[1]! * p[0] + vp[5]! * p[1] + vp[9]! * p[2] + vp[13]!;
      const w = vp[3]! * p[0] + vp[7]! * p[1] + vp[11]! * p[2] + vp[15]!;
      return [0.5 + (0.5 * x) / w, 0.5 - (0.5 * y) / w];
    };
    /** Draw two frames and read the velocity where world point p is now. */
    const velocityAt = async (
      frames: readonly { instances: MeshSceneInstance[]; draw: SceneDraw; before?: () => void }[],
      p: [number, number, number],
      eye: [number, number, number],
    ) => {
      const renderer = (await WebgpuSceneRenderer.create(device, W, H))!;
      for (const frame of frames) {
        frame.before?.();
        renderer.render(frame.instances, frame.draw);
        await until(() => false, 10);
      }
      const v = await readHalf(renderer.prepassTargets!.velocity, W, H, 2);
      const [u, w] = uvOf(eye, p);
      const i = (Math.floor(w! * H) * W + Math.floor(u! * W)) * 2;
      const corner = [v[0]!, v[1]!];
      renderer.dispose();
      return { v: [v[i]!, v[i + 1]!], corner };
    };
    const at = (x: number) => composeModelMatrix([x, 0, 0], [0, 0, 0], [0.8, 0.8, 1]);
    const mesh = plane(square());
    const one = (model: number[], extra: Partial<MeshSceneInstance> = {}): MeshSceneInstance[] => [{ mesh, model, textures: null, ...extra } as MeshSceneInstance];
    const eye: [number, number, number] = [0, 0, 4];

    // Still: no velocity, and none where nothing drew.
    const still = await velocityAt([{ instances: one(at(0)), draw: draw(eye) }, { instances: one(at(0)), draw: draw(eye) }], [0, 0, 0], eye);
    expect(Math.hypot(still.v[0]!, still.v[1]!)).toBeLessThan(1e-3);
    expect(still.corner).toEqual([0, 0]);

    // The camera steps right: the surface moves left on screen by what the projection says.
    const moved: [number, number, number] = [0.2, 0, 4];
    const pan = await velocityAt([{ instances: one(at(0)), draw: draw(eye) }, { instances: one(at(0)), draw: draw(moved) }], [0.1, 0, 0], moved);
    const panExpect = [uvOf(moved, [0.1, 0, 0])[0]! - uvOf(eye, [0.1, 0, 0])[0]!, 0];
    expect(panExpect[0]).toBeLessThan(-0.01);
    expect(pan.v[0]).toBeCloseTo(panExpect[0]!, 3);
    expect(pan.v[1]).toBeCloseTo(0, 3);

    // The object moves right by 0.3: given as its previous model, or matched to last frame's copy.
    const shift = uvOf(eye, [0.3, 0, 0])[0]! - uvOf(eye, [0, 0, 0])[0]!;
    const told = await velocityAt([{ instances: one(at(0.3), { previousModel: at(0) }), draw: draw(eye) }], [0.3, 0, 0], eye);
    expect(told.v[0]).toBeCloseTo(shift, 3);
    const matched = await velocityAt([{ instances: one(at(0)), draw: draw(eye) }, { instances: one(at(0.3)), draw: draw(eye) }], [0.3, 0, 0], eye);
    expect(matched.v[0]).toBeCloseTo(shift, 3);

    // A skinned (dynamic) mesh: its vertices move 0.3 right between frames, its model doesn't.
    const positions = square();
    const dynamic = { revision: 0 };
    const skinned = plane(positions, dynamic);
    const skinnedOne: MeshSceneInstance[] = [{ mesh: skinned, model: composeModelMatrix([0, 0, 0], [0, 0, 0], [1, 1, 1]), textures: null } as MeshSceneInstance];
    const bend = await velocityAt(
      [
        { instances: skinnedOne, draw: draw(eye) },
        {
          instances: [{ ...skinnedOne[0]!, model: composeModelMatrix([0, 0, 0], [0, 0, 0], [1, 1, 1]) }],
          draw: draw(eye),
          before: () => {
            for (let k = 0; k < positions.length; k += 3) positions[k] = positions[k]! + 0.3;
            dynamic.revision += 1;
          },
        },
      ],
      [0.3, 0, 0],
      eye,
    );
    expect(bend.v[0]).toBeCloseTo(shift, 3);

    // Temporal anti-aliasing jitters the projection every frame; the velocity leaves it out.
    const jittered = await velocityAt(
      [0, 1, 2].map(() => ({ instances: one(at(0)), draw: draw(eye, { temporal: true }) })),
      [0, 0, 0],
      eye,
    );
    expect(Math.hypot(jittered.v[0]!, jittered.v[1]!)).toBeLessThan(1e-3);
  });
});

/** Read a half-float texture (`channels` 4 for rgba16float, 2 for rg16float) back as floats. */
async function readHalf(texture: any, width: number, height: number, channels = 4): Promise<Float32Array> {
  const bytesPerRow = Math.ceil((width * channels * 2) / 256) * 256;
  const buffer = device.createBuffer({ size: bytesPerRow * height, usage: 0x01 | 0x08 }); // MAP_READ | COPY_DST
  const encoder = device.createCommandEncoder();
  encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow, rowsPerImage: height }, { width, height });
  device.queue.submit([encoder.finish()]);
  let mapped = false;
  void buffer.mapAsync(0x01).then(() => (mapped = true));
  await until(() => mapped);
  const halves = new Uint16Array(buffer.getMappedRange().slice(0));
  buffer.unmap();
  buffer.destroy();
  const out = new Float32Array(width * height * channels);
  for (let y = 0; y < height; y += 1) {
    for (let i = 0; i < width * channels; i += 1) out[y * width * channels + i] = halfToFloat(halves[(y * bytesPerRow) / 2 + i]!);
  }
  return out;
}

function halfToFloat(h: number): number {
  const sign = h & 0x8000 ? -1 : 1;
  const exponent = (h >> 10) & 0x1f;
  const fraction = h & 0x3ff;
  if (exponent === 0) return sign * 2 ** -14 * (fraction / 1024);
  if (exponent === 31) return fraction ? NaN : sign * Infinity;
  return sign * 2 ** (exponent - 15) * (1 + fraction / 1024);
}
