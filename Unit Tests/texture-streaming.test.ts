/**
 * Texture streaming (AAA_FIDELITY_ROADMAP.md F1b): the residency plan from the
 * feedback's footprints under a budget, and, on a real device (Dawn), the
 * feedback pass driving a map's resident level by how near it is drawn.
 */

import { describe, expect, it } from "vitest";

import { composeModelMatrix, projectionMatrix, viewMatrix, type DecodedTexture, type MeshAsset, type MeshSceneInstance } from "@cartbox/editor";
import { MODELS, QUALITY_PRESETS, WebgpuSceneRenderer, rasterStyleFor } from "@cartbox/player";

import { readLinearTexture } from "../packages/player/src/render/lookDevCheck";
import { FEEDBACK_NONE, FLOOR_TEXELS, FOOTPRINT_BIAS, FOOTPRINT_STEPS, TEXTURE_BUDGET_MB, TextureStreamer, UNSEEN_ROUNDS, feedbackWgsl, floorLevel, footprintLog2, residentBytes, topLevel, wantedLevel } from "../packages/player/src/render/textureStreaming";

const MB = 1024 * 1024;

describe("the residency plan", () => {
  it("counts a level's bytes with the mips below it", () => {
    expect(residentBytes(1, 1, 0)).toBe(4);
    expect(residentBytes(4, 4, 0)).toBe((16 + 4 + 1) * 4);
    expect(residentBytes(4, 4, 1)).toBe((4 + 1) * 4);
    expect(topLevel(1024, 512)).toBe(10);
    expect(floorLevel(1024, 1024)).toBe(10 - Math.log2(FLOOR_TEXELS));
    expect(floorLevel(32, 32)).toBe(0);
  });

  it("reads the feedback's fixed point and turns a footprint into a level", () => {
    expect(footprintLog2(FEEDBACK_NONE)).toBeNull();
    expect(footprintLog2((FOOTPRINT_BIAS - 10) * FOOTPRINT_STEPS)).toBe(-10);
    // A pixel spans a 1024th of the UV range: level 0 of a 1024 map, level 0 of a 512 one (clamped), 1 of 2048.
    expect(wantedLevel(1024, 1024, -10)).toBe(0);
    expect(wantedLevel(512, 512, -10)).toBe(0);
    expect(wantedLevel(2048, 2048, -10)).toBe(1);
    expect(wantedLevel(1024, 1024, -3)).toBe(7);
    expect(wantedLevel(1024, 1024, 5)).toBe(10);
  });

  it("starts each map at its floor, takes what the feedback asks for, and holds an unseen one a while", () => {
    const streamer = new TextureStreamer(64 * MB);
    const a = {};
    expect(streamer.register(a, 1024, 1024)).toBe(floorLevel(1024, 1024));
    streamer.observe(new Map([[a, -10]]));
    expect(streamer.plan().get(a)).toBe(0);
    for (let i = 0; i < UNSEEN_ROUNDS; i += 1) streamer.observe(new Map());
    expect(streamer.plan().size).toBe(0);
    streamer.observe(new Map());
    expect(streamer.plan().get(a)).toBe(floorLevel(1024, 1024));
  });

  it("steps the costliest map down until the total fits the budget", () => {
    const streamer = new TextureStreamer(4 * MB);
    const a = {};
    const b = {};
    streamer.register(a, 1024, 1024);
    streamer.register(b, 512, 512);
    streamer.observe(new Map([[a, -12], [b, -12]]));
    streamer.plan();
    const stats = streamer.stats();
    expect(stats.residentMB).toBeLessThanOrEqual(4);
    expect(stats.limited).toBeGreaterThan(0);
    expect(stats.wantedMB).toBeGreaterThan(5);
    // The large map gave way first: the small one keeps all it wants.
    expect(streamer.levelOf(b)).toBe(0);
    expect(streamer.levelOf(a)).toBeGreaterThan(0);
  });

  it("gives each preset a budget, and the feedback shader its scale", () => {
    expect(QUALITY_PRESETS.epic.textureBudgetMB).toBe(TEXTURE_BUDGET_MB.epic);
    expect(QUALITY_PRESETS.low.textureBudgetMB).toBe(TEXTURE_BUDGET_MB.low);
    expect(feedbackWgsl(4)).toContain("atomicMin(&wanted");
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
const device = await realDevice();

async function settled<T>(promise: Promise<T>): Promise<T> {
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
}

const W = 64;
const H = 64;

function checker(size: number): DecodedTexture {
  const data = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y += 1) for (let x = 0; x < size; x += 1) data.set(((x >> 4) + (y >> 4)) & 1 ? [230, 60, 40, 255] : [40, 60, 230, 255], (y * size + x) * 4);
  return { width: size, height: size, data } as DecodedTexture;
}

function quad(): MeshAsset {
  return {
    name: "q",
    primitives: [
      {
        positions: Float32Array.from([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]),
        normals: Float32Array.from([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
        uvs: Float32Array.from([0, 0, 1, 0, 1, 1, 0, 1]),
        indices: Uint32Array.from([0, 1, 2, 0, 2, 3]),
        material: { name: "q", baseColorFactor: [1, 1, 1, 1], baseColorImage: null, metallicFactor: 0, roughnessFactor: 1 },
      },
    ],
  } as unknown as MeshAsset;
}

describe.skipIf(!device)("streaming on a real device", { timeout: 300_000 }, () => {
  async function stream(distance: number, budgetMB: number, maps: DecodedTexture[]): Promise<{ renderer: WebgpuSceneRenderer; frame: Float32Array }> {
    const renderer = (await WebgpuSceneRenderer.create(device, W, H, rasterStyleFor(MODELS.aaa.renderCaps), { hdr: true, mips: true }))!;
    const instances = maps.map((map, i) => ({ mesh: quad(), model: composeModelMatrix([i * 2.2 - (maps.length - 1) * 1.1, 0, 0], [0, 0, 0], [1, 1, 1]), textures: [map] })) as unknown as MeshSceneInstance[];
    const draw = { width: W, height: H, view: viewMatrix([0, 0, distance], [0, 0, 0]), projection: projectionMatrix(Math.PI / 3, 1, 0.1, 500), environment: null, lights: [], ambient: 1, lightDirection: [0, 0, -1], textureBudget: budgetMB } as any;
    device.pushErrorScope("validation");
    let texture: any = null;
    // Rounds of feedback (every eighth frame), each read back before the next.
    for (let i = 0; i < 40; i += 1) {
      texture = renderer.renderToTexture(instances, draw);
      await settled(device.queue.onSubmittedWorkDone());
      for (let k = 0; k < 4; k += 1) await new Promise((r) => setTimeout(r, 1));
    }
    const error = await settled(device.popErrorScope());
    expect(error ? String((error as any).message ?? error) : null).toBeNull();
    const frame = (await readLinearTexture(device, texture, W, H, settled)).data;
    return { renderer, frame };
  }

  it("holds a far map coarse and brings a near one in whole", async () => {
    const far = await stream(200, 64, [checker(1024)]);
    const farStats = far.renderer.textureResidency!;
    expect(farStats.maps).toBe(1);
    // A quad under a pixel of the feedback: unseen, it stays at its floor (64 texels), not the whole map's 5.3 MB.
    expect(farStats.residentMB * MB).toBe(residentBytes(1024, 1024, floorLevel(1024, 1024)));
    far.renderer.dispose();
    const near = await stream(1.5, 64, [checker(1024)]);
    const nearStats = near.renderer.textureResidency!;
    // Filling the frame at 64 px, about 14 texels a pixel: level 3 (128²), above the floor and far short of the whole map.
    expect(nearStats.residentMB * MB).toBe(residentBytes(1024, 1024, 3));
    // The map still draws: red and blue checks under the light.
    const centre = Array.from(near.frame.slice((H / 2 * W + W / 2) * 4, (H / 2 * W + W / 2) * 4 + 3));
    expect(Math.max(centre[0]!, centre[2]!)).toBeGreaterThan(0.2);
    expect(near.renderer.lastFrameStats.textures?.maps).toBe(1);
    near.renderer.dispose();
  });

  it("holds maps back to fit a tight budget", async () => {
    const { renderer } = await stream(1.2, 0.05, [checker(512), checker(1024)]);
    const stats = renderer.textureResidency!;
    expect(stats.residentMB).toBeLessThanOrEqual(0.05 + 1e-6);
    expect(stats.limited).toBeGreaterThan(0);
    renderer.dispose();
  });
});
