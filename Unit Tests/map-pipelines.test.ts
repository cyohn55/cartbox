/**
 * Shipped pipeline manifests (AAA_PRODUCTION_ROADMAP.md M3, R5's fix): each
 * map carries the pipelines a run of it asks for, so the very first load on a
 * browser compiles them behind the loading screen instead of as it meets them.
 *
 * - The manifest's text form (`packPipelineManifest`), shared by the page's
 *   store and the shipped files, round-trips; manifests merge without repeats.
 * - `fetchMapPipelines` is best effort: a missing, malformed, failing or slow
 *   file is no manifest.
 * - Each shipped file is a readable manifest of the current build's recipes.
 * - On a real device: `RECORD_PIPELINES=<map> npm run record:pipelines` (or
 *   `npm run record:pipelines <map>`) records a map's file by drawing it as
 *   Lockout draws it (its model, the player's mesh overlay, the texture-mode
 *   renderer) from views around the arena; and a fresh device warmed from the
 *   shipped file alone draws those views with **no late compiles**.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { arenaMap, lockoutMeshSidecar } from "@cartbox/editor";
import {
  MANIFEST_MAX,
  MODELS,
  MeshOverlaySurface,
  PipelineManifestStore,
  WebgpuSceneRenderer,
  mergeManifests,
  packPipelineManifest,
  parseMeshScene,
  pipelineCache,
  rasterStyleFor,
  unpackPipelineManifest,
  warmPipelines,
  type ManifestStorage,
} from "@cartbox/player";
import { MAP_PIPELINES_DIR, fetchMapPipelines, mapPipelinesUrl } from "@/lib/mapPipelines";

const ROOT = path.resolve(__dirname, "..");
const DIR = path.join(ROOT, "apps/web/public", MAP_PIPELINES_DIR);
const RECORD = process.env.RECORD_PIPELINES ?? "";

/** The maps with shipped manifests, and how each one's sidecar is built (as the Lockout page builds it). */
const MAPS: Readonly<Record<string, () => string>> = {
  lockout: () => lockoutMeshSidecar(),
  beaver: () => arenaMap("beaver").sidecar(),
};

/** The frame Lockout draws at: its model's (xbox360), on its default path (texture mode, no linear HDR). */
const W = 320;
const H = 180;

/** A recipe as pipelineRecipe writes one: `kind:` then the descriptor, its module as `{"$wgsl": source}`. */
const recipe = (code: string, entry: string) => `render:${JSON.stringify({ layout: "auto", vertex: { module: { $wgsl: code }, entryPoint: entry } })}`;

describe("the manifest as text", () => {
  it("round-trips, each shader once", () => {
    const shader = "@vertex fn v() -> @builtin(position) vec4f { return vec4f(0.0); }";
    const recipes = [recipe(shader, "a"), recipe(shader, "b"), recipe('"quoted" \\ code', "c")];
    const text = packPipelineManifest(recipes);
    expect(text.split(shader.slice(0, 20)).length - 1).toBe(1);
    expect(unpackPipelineManifest(text)).toEqual(recipes);
  });

  it("reads nothing from a missing, malformed or older manifest", () => {
    expect(unpackPipelineManifest(null)).toEqual([]);
    expect(unpackPipelineManifest("")).toEqual([]);
    expect(unpackPipelineManifest("{not json")).toEqual([]);
    expect(unpackPipelineManifest(JSON.stringify({ v: 0, wgsl: [], recipes: ["x"] }))).toEqual([]);
  });

  it("is what the page's store keeps", () => {
    const kept = new Map<string, string>();
    const storage: ManifestStorage = { getItem: (k) => kept.get(k) ?? null, setItem: (k, v) => void kept.set(k, v) };
    const recipes = [recipe("code", "a")];
    new PipelineManifestStore(storage).save(recipes);
    expect(unpackPipelineManifest([...kept.values()][0])).toEqual(recipes);
  });

  it("merges manifests without repeats, first seen first, within the cap", () => {
    expect(mergeManifests(["a", "b"], ["b", "c"], [])).toEqual(["a", "b", "c"]);
    const many = Array.from({ length: MANIFEST_MAX + 10 }, (_, i) => `r${i}`);
    expect(mergeManifests(many, ["x"])).toHaveLength(MANIFEST_MAX);
  });

  it("warms the shipped manifest with the stored one", async () => {
    const asked: string[] = [];
    const device = {
      createShaderModule: (d: { code: string }) => ({ code: d.code }),
      createRenderPipelineAsync: async (d: { vertex: { entryPoint: string } }) => {
        asked.push(d.vertex.entryPoint);
        return {};
      },
    };
    const kept = new Map<string, string>();
    const store = new PipelineManifestStore({ getItem: (k) => kept.get(k) ?? null, setItem: (k, v) => void kept.set(k, v) });
    store.save([recipe("s", "stored"), recipe("s", "both")]);
    const result = await warmPipelines(device, { store, shipped: [recipe("s", "shipped"), recipe("s", "both")] });
    expect(result).toMatchObject({ recipes: 3, compiled: 3, failed: 0 });
    expect(asked.sort()).toEqual(["both", "shipped", "stored"]);
  });
});

describe("fetching a map's manifest", () => {
  const good = packPipelineManifest([recipe("code", "a")]);
  const responding = (status: number, body: string) => (async () => new Response(body, { status })) as unknown as typeof fetch;

  it("is served beside the app, by map", () => {
    expect(mapPipelinesUrl("beaver")).toBe("/pipelines/beaver.json");
    expect(mapPipelinesUrl("a b")).toBe("/pipelines/a%20b.json");
  });

  it("returns a readable manifest, and nothing otherwise", async () => {
    expect(await fetchMapPipelines("beaver", { fetchFn: responding(200, good) })).toBe(good);
    expect(await fetchMapPipelines("beaver", { fetchFn: responding(404, good) })).toBeNull();
    expect(await fetchMapPipelines("beaver", { fetchFn: responding(200, "<html>") })).toBeNull();
    expect(await fetchMapPipelines("beaver", { fetchFn: (async () => Promise.reject(new Error("offline"))) as unknown as typeof fetch })).toBeNull();
  });

  it("gives up on a slow one", async () => {
    const slow = ((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))))) as unknown as typeof fetch;
    const started = Date.now();
    expect(await fetchMapPipelines("beaver", { fetchFn: slow, timeoutMs: 30 })).toBeNull();
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe("the shipped manifests", () => {
  for (const id of Object.keys(MAPS)) {
    it(`${id}: a readable manifest of render and compute recipes`, () => {
      const file = path.join(DIR, `${id}.json`);
      expect(existsSync(file), `no manifest for ${id}: run npm run record:pipelines ${id} on a GPU`).toBe(true);
      const recipes = unpackPipelineManifest(readFileSync(file, "utf8"));
      expect(recipes.length).toBeGreaterThan(5);
      for (const r of recipes) {
        const colon = r.indexOf(":");
        expect(["render", "compute"]).toContain(r.slice(0, colon));
        expect(() => JSON.parse(r.slice(colon + 1))).not.toThrow();
        expect(r).not.toContain('{"$wgsl":""}'); // every shader written down
      }
    });
  }
});

async function realDevice(): Promise<any | null> {
  try {
    const module = (await import(/* @vite-ignore */ "@kmamal/gpu")) as any;
    const instance = (module.default ?? module).create([]);
    const adapter = await instance.requestAdapter();
    return adapter ? { adapter, device: await adapter.requestDevice() } : null;
  } catch {
    return null;
  }
}
const gpu = await realDevice();

describe.skipIf(!gpu)("map manifests on a real device", { timeout: 1_200_000 }, () => {
  /** Views around the arena: each side, high and low, near and far, as a match's cameras see it. */
  const VIEWS = [0, 1, 2, 3, 4, 5].map((k) => ({ yaw: (k * Math.PI) / 3, pitch: k % 2 ? 0.15 : 0.6, distance: k < 3 ? null : 25, target: [0, 1, 0] as [number, number, number], fov: null, hud: false }));

  /** Draw a map's views on `device` as Lockout does; the cache's stats after, and its manifest. */
  async function drawMap(device: any, id: string) {
    const style = rasterStyleFor(MODELS.xbox360.renderCaps);
    const real = (await WebgpuSceneRenderer.create(device, W, H, style, { hdr: false, mips: MODELS.xbox360.renderCaps.mipmaps === true }))!;
    expect(real, "the WebGPU renderer declined the xbox360 style").toBeTruthy();
    // Texture mode, as the GPU presenter draws (the default path): the scene stays on the GPU.
    const tap = new Proxy(real as object, {
      get(target, property) {
        if (property === "render") return (instances: unknown, draw: unknown) => void (target as WebgpuSceneRenderer).renderToTexture(instances as never, draw as never);
        const value = Reflect.get(target, property) as unknown;
        return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
    });
    const surface = await MeshOverlaySurface.create({ blit() {}, destroy() {} }, W, H, parseMeshScene(MAPS[id]!())!, tap as never, {});
    const frame = new Uint8Array(W * H * 4);
    for (const view of VIEWS) {
      surface.setCameraOverride(view);
      for (let i = 0; i < 2; i += 1) surface.blit(frame);
    }
    await device.queue.onSubmittedWorkDone?.();
    surface.destroy();
    real.dispose();
    const cache = pipelineCache(device);
    return { stats: cache.stats(), manifest: cache.manifest() };
  }

  // Defined only when recording, and the checks below only when not: the GPU job fails on a skipped test.
  if (RECORD) it(`records ${RECORD}'s manifest`, async () => {
    expect(Object.keys(MAPS), `no map "${RECORD}"`).toContain(RECORD);
    const { manifest } = await drawMap(gpu!.device, RECORD);
    const text = packPipelineManifest(manifest);
    writeFileSync(path.join(DIR, `${RECORD}.json`), text);
    console.log(`${RECORD}: ${manifest.length} pipelines, ${(text.length / 1024).toFixed(0)} KB -> apps/web/public/${MAP_PIPELINES_DIR}/${RECORD}.json`);
  });

  for (const id of Object.keys(MAPS)) {
    if (!RECORD) it(`${id}: a fresh device warmed from the shipped manifest alone draws with nothing late`, async () => {
      const device = await gpu!.adapter.requestDevice();
      const nothingStored = new PipelineManifestStore(null);
      const shipped = unpackPipelineManifest(readFileSync(path.join(DIR, `${id}.json`), "utf8"));
      const warmed = await warmPipelines(device, { store: nothingStored, shipped, budgetMs: 600_000 });
      expect(warmed.failed).toBe(0);
      expect(warmed.compiled).toBe(shipped.length);
      const { stats } = await drawMap(device, id);
      expect(stats.late).toBe(0);
      expect(stats.compiled).toBe(0); // every pipeline the draw asked for came from the warm-up
      device.destroy?.();
    });
  }
});
