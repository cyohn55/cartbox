/**
 * The pipeline cache and its recorded warm-up (AAA_PRODUCTION_ROADMAP.md M3,
 * completing DEMO_QUALITY_ROADMAP.md R5): every pipeline the player makes goes
 * through one cache per device, memoized by descriptor, with async compiles
 * and a count of the synchronous ones after the first frame (likely hitches);
 * the pipelines a session asked for are recorded as recipes, and the next load
 * compiles them off the frame first, so what was late once isn't again.
 */
import { describe, expect, it } from "vitest";
import { composeModelMatrix, projectionMatrix, viewMatrix, type MeshAsset, type MeshMaterial, type MeshSceneInstance } from "@cartbox/editor";
import {
  MANIFEST_MAX,
  MODELS,
  PipelineCache,
  PipelineManifestStore,
  WebgpuSceneRenderer,
  pipelineCache,
  pipelineKey,
  pipelineRecipe,
  rasterStyleFor,
  recipeDescriptor,
  shaderModule,
  warmPipelines,
  type ManifestStorage,
} from "@cartbox/player";
import { readLinearTexture } from "../packages/player/src/render/lookDevCheck";

/** A device that only records what it was asked to make. */
function fakeDevice({ async = true } = {}) {
  const log = { modules: 0, render: 0, compute: 0, renderAsync: 0, computeAsync: 0 };
  const device: any = {
    createShaderModule: (d: { code: string }) => {
      log.modules += 1;
      return { code: d.code };
    },
    createRenderPipeline: (d: object) => {
      log.render += 1;
      return { render: d };
    },
    createComputePipeline: (d: object) => {
      log.compute += 1;
      return { compute: d };
    },
    ...(async
      ? {
          createRenderPipelineAsync: async (d: object) => {
            log.renderAsync += 1;
            return { renderAsync: d };
          },
          createComputePipelineAsync: async (d: object) => {
            log.computeAsync += 1;
            return { computeAsync: d };
          },
        }
      : {}),
  };
  return { device, log };
}

function memoryStorage(): ManifestStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) };
}

const renderDesc = (module: object, format = "rgba8unorm", label = "x") => ({
  label,
  layout: "auto",
  vertex: { module, entryPoint: "vs" },
  fragment: { module, entryPoint: "fs", targets: [{ format }] },
  primitive: { topology: "triangle-list" },
});

describe("keys and memoization", () => {
  it("keys modules and layouts by identity, everything else by value, and ignores labels", () => {
    const a = {};
    const b = {};
    expect(pipelineKey("render", renderDesc(a, "rgba8unorm", "one"))).toBe(pipelineKey("render", renderDesc(a, "rgba8unorm", "two")));
    expect(pipelineKey("render", renderDesc(a))).not.toBe(pipelineKey("render", renderDesc(b)));
    expect(pipelineKey("render", renderDesc(a))).not.toBe(pipelineKey("render", renderDesc(a, "rgba16float")));
    expect(pipelineKey("render", { layout: a })).not.toBe(pipelineKey("render", { layout: b }));
    expect(pipelineKey("render", renderDesc(a))).not.toBe(pipelineKey("compute", renderDesc(a)));
  });

  it("compiles a pipeline once, however often it is asked for, and counts late compiles after the first frame", () => {
    const { device, log } = fakeDevice();
    const cache = new PipelineCache(device);
    const m = shaderModule(device, { code: "a" });
    const first = cache.render(renderDesc(m));
    expect(cache.render(renderDesc(m, "rgba8unorm", "again"))).toBe(first);
    cache.compute({ layout: "auto", compute: { module: m, entryPoint: "main" } });
    cache.compute({ layout: "auto", compute: { module: m, entryPoint: "main" } });
    expect(log).toMatchObject({ render: 1, compute: 1 });
    expect(cache.stats()).toEqual({ compiled: 2, compiledAsync: 0, reused: 2, late: 0, pending: 0 });
    cache.markReady();
    cache.render(renderDesc(m, "bgra8unorm"));
    expect(cache.stats().late).toBe(1);
    expect(cache.isReady).toBe(true);
  });

  it("compiles off the frame where the device can, then serves synchronous requests from it", async () => {
    const { device, log } = fakeDevice();
    const cache = new PipelineCache(device);
    const m = shaderModule(device, { code: "a" });
    const pending = cache.renderAsync(renderDesc(m));
    expect(cache.renderAsync(renderDesc(m))).toBe(pending); // one compile in flight
    expect(cache.stats().pending).toBe(1);
    const made = await pending;
    expect(cache.render(renderDesc(m))).toBe(made);
    expect(log).toMatchObject({ render: 0, renderAsync: 1 });
    expect(cache.stats()).toMatchObject({ compiled: 0, compiledAsync: 1, pending: 0 });
    // Without the async entry points it compiles now.
    const sync = fakeDevice({ async: false });
    await new PipelineCache(sync.device).renderAsync(renderDesc(shaderModule(sync.device, { code: "a" })));
    expect(sync.log.render).toBe(1);
  });

  it("is one cache per device, and one shader module per source", () => {
    const { device, log } = fakeDevice();
    expect(pipelineCache(device)).toBe(pipelineCache(device));
    expect(pipelineCache(fakeDevice().device)).not.toBe(pipelineCache(device));
    const a = shaderModule(device, { code: "x", label: "one" });
    expect(shaderModule(device, { code: "x", label: "two" })).toBe(a);
    expect(shaderModule(device, { code: "y" })).not.toBe(a);
    expect(shaderModule(device, { code: "x", compilationHints: [] } as never)).not.toBe(a); // more than code: made as asked
    expect(log.modules).toBe(3);
  });
});

describe("recipes, the manifest and the warm-up", () => {
  it("writes an auto-layout pipeline down with its WGSL, and reads it back to the same key", () => {
    const { device } = fakeDevice();
    const m = shaderModule(device, { code: "@vertex fn vs() {}" });
    const recipe = pipelineRecipe("render", renderDesc(m))!;
    expect(recipe.startsWith("render:")).toBe(true);
    expect(recipe).toContain('"$wgsl":"@vertex fn vs() {}"');
    expect(recipe).not.toContain("label");
    const back = recipeDescriptor(device, recipe)!;
    expect(back.kind).toBe("render");
    expect(back.descriptor.vertex.module).toBe(m);
    expect(pipelineKey("render", back.descriptor)).toBe(pipelineKey("render", renderDesc(m)));
    expect(pipelineRecipe("render", { ...renderDesc(m), layout: {} })).toBeNull(); // an explicit layout
    expect(pipelineRecipe("render", renderDesc({}))).toBeNull(); // a module from elsewhere
    expect(recipeDescriptor(device, "nonsense")).toBeNull();
    expect(recipeDescriptor(device, "render:{bad json")).toBeNull();
  });

  it("records what the session asked for, and a warm-up compiles it off the frame so it is never late", async () => {
    const one = fakeDevice();
    const cache = new PipelineCache(one.device);
    const m = shaderModule(one.device, { code: "a" });
    cache.render(renderDesc(m));
    cache.render(renderDesc(m)); // reused: recorded once
    cache.compute({ layout: "auto", compute: { module: m, entryPoint: "main" } });
    cache.render({ ...renderDesc(m), layout: {} }); // not recordable
    expect(cache.manifest()).toHaveLength(2);

    const two = fakeDevice();
    const warm = new PipelineCache(two.device);
    expect(await warm.warm([...cache.manifest(), "render:{broken"])).toEqual({ compiled: 2, failed: 1 });
    warm.markReady();
    const m2 = shaderModule(two.device, { code: "a" });
    warm.render(renderDesc(m2));
    warm.compute({ layout: "auto", compute: { module: m2, entryPoint: "main" } });
    expect(warm.stats()).toMatchObject({ late: 0, compiled: 0, compiledAsync: 2 });
    expect(two.log).toMatchObject({ render: 0, compute: 0 });
    // Warmed recipes nobody asks for again drop out of the next manifest.
    expect(warm.manifest()).toHaveLength(2);
  });

  it("stores each WGSL source once, and survives a missing, broken or older manifest and a failing storage", () => {
    const { device } = fakeDevice();
    const big = "x".repeat(10_000);
    const m = shaderModule(device, { code: big });
    const recipes = [pipelineRecipe("render", renderDesc(m, "rgba8unorm"))!, pipelineRecipe("render", renderDesc(m, "rgba16float"))!, pipelineRecipe("compute", { layout: "auto", compute: { module: m, entryPoint: "main" } })!];
    const storage = memoryStorage();
    const store = new PipelineManifestStore(storage, "k");
    store.save(recipes);
    expect([...storage.data.values()][0]!.length).toBeLessThan(big.length + 1000); // the source once, not three times
    expect(store.load()).toEqual(recipes);
    expect(new PipelineManifestStore(storage, "other").load()).toEqual([]);
    storage.data.set("k", "{not json");
    expect(store.load()).toEqual([]);
    storage.data.set("k", JSON.stringify({ v: 0, wgsl: [], recipes: [] }));
    expect(store.load()).toEqual([]);
    const throwing: ManifestStorage = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("quota");
      },
    };
    expect(() => new PipelineManifestStore(throwing).save(recipes)).not.toThrow();
    expect(new PipelineManifestStore(throwing).load()).toEqual([]);
    expect(new PipelineManifestStore(null).load()).toEqual([]);
    // At most MANIFEST_MAX recipes, the most recent.
    const many = Array.from({ length: MANIFEST_MAX + 5 }, (_, i) => `compute:{"n":${i}}`);
    store.save(many);
    expect(store.load()).toEqual(many.slice(5));
  });

  it("waits for the warm-up at most its budget", async () => {
    const device: any = { createShaderModule: (d: { code: string }) => ({ code: d.code }), createRenderPipelineAsync: () => new Promise(() => undefined) };
    const storage = memoryStorage();
    const store = new PipelineManifestStore(storage, "k");
    store.save([pipelineRecipe("render", renderDesc(shaderModule(fakeDevice().device, { code: "a" })))!]);
    const started = Date.now();
    expect(await warmPipelines(device, { store, budgetMs: 50 })).toMatchObject({ recipes: 1, timedOut: true });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(await warmPipelines(fakeDevice().device, { store: new PipelineManifestStore(memoryStorage(), "k") })).toEqual({ recipes: 0, compiled: 0, failed: 0, timedOut: false });
  });
});

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
const deviceA = await realDevice();

describe.skipIf(!deviceA)("the recorded warm-up on a real device", { timeout: 300_000 }, () => {
  const PBR = { name: "m", baseColorFactor: [0.8, 0.5, 0.3, 1], baseColorImage: null, metallicFactor: 0.2, roughnessFactor: 0.6 } as MeshMaterial;
  function box(name: string, material: Partial<MeshMaterial>): MeshAsset {
    const positions: number[] = [];
    const normals: number[] = [];
    const indices: number[] = [];
    for (const [n, u, v] of [
      [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
      [[-1, 0, 0], [0, 0, 1], [0, 1, 0]],
      [[0, 1, 0], [0, 0, 1], [1, 0, 0]],
      [[0, -1, 0], [1, 0, 0], [0, 0, 1]],
      [[0, 0, 1], [1, 0, 0], [0, 1, 0]],
      [[0, 0, -1], [0, 1, 0], [1, 0, 0]],
    ] as [number[], number[], number[]][]) {
      const base = positions.length / 3;
      for (const [a, b] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) {
        positions.push(...[0, 1, 2].map((k) => 0.5 * (n[k]! + a * u[k]! + b * v[k]!)));
        normals.push(...n);
      }
      indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
    return {
      name,
      primitives: [{ positions: Float32Array.from(positions), normals: Float32Array.from(normals), uvs: new Float32Array((positions.length / 3) * 2), indices: Uint32Array.from(indices), material: { ...PBR, name, ...material } }],
    } as unknown as MeshAsset;
  }
  const W = 64;
  const H = 64;
  const plain = box("plain", {});
  const glass = box("glass", { baseColorFactor: [0.6, 0.7, 0.9, 0.4], alphaMode: "BLEND", softDepth: 0.5 } as Partial<MeshMaterial>);
  /** Two plain frames, then one that adds a see-through box and turns anti-aliasing on: pipelines first needed mid-session. */
  const frames = [0, 1, 2].map((f) => ({
    instances: (f < 2 ? [plain] : [plain, glass]).map((mesh, i) => ({ mesh, model: composeModelMatrix([i * 1.5 - 0.75, 0, -i], [0, 20 * i, 0], [1, 1, 1]) })) as unknown as MeshSceneInstance[],
    draw: {
      width: W,
      height: H,
      view: viewMatrix([0, 1, 6], [0, 0, 0]),
      projection: projectionMatrix(Math.PI / 3, 1, 0.1, 50),
      environment: null,
      lights: [],
      ambient: 0.3,
      lightDirection: [0.3, 1, 0.6],
      prepass: true,
      gpuCull: true,
      time: f * 0.25,
      ...(f >= 2 ? { antialias: true } : {}),
    } as any,
  }));
  const settledOn = (device: any) => async <T,>(promise: Promise<T>): Promise<T> => {
    let done = false;
    void promise.then(
      () => (done = true),
      () => (done = true),
    );
    for (let i = 0; i < 4000 && !done; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      device.tick?.();
    }
    return promise;
  };
  async function session(device: any): Promise<{ late: number; pixels: Float32Array[] }> {
    const renderer = (await WebgpuSceneRenderer.create(device, W, H, rasterStyleFor(MODELS.aaa.renderCaps), { hdr: true, mips: true }))!;
    const pixels: Float32Array[] = [];
    for (const f of frames) pixels.push((await readLinearTexture(device, renderer.renderToTexture(f.instances, f.draw), W, H, settledOn(device))).data);
    renderer.dispose();
    return { late: pipelineCache(device).stats().late, pixels };
  }

  it("records the pipelines compiled mid-session, and a fresh device warmed from them compiles none late, drawing the same frames", async () => {
    const a = await session(deviceA);
    expect(a.late).toBeGreaterThan(0); // the multisampled pipelines were first needed on frame 3
    const storage = memoryStorage();
    const store = new PipelineManifestStore(storage, "k");
    store.save(pipelineCache(deviceA).manifest());
    expect(store.load().length).toBeGreaterThan(0);

    const deviceB = await realDevice();
    const warmed = await settledOn(deviceB)(warmPipelines(deviceB, { store, budgetMs: 240_000 }));
    expect(warmed.timedOut).toBe(false);
    expect(warmed.failed).toBe(0);
    expect(warmed.compiled).toBe(store.load().length);
    const b = await session(deviceB);
    expect(b.late).toBe(0);
    expect(pipelineCache(deviceB).stats().compiledAsync).toBe(warmed.compiled);
    for (let f = 0; f < frames.length; f += 1) expect([...b.pixels[f]!]).toEqual([...a.pixels[f]!]);
  });
});
