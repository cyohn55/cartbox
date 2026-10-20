/**
 * The spot and point lights' shadows on the GPU, on the AAA tier
 * (AAA_FIDELITY_ROADMAP.md F2d): tiles sized by how much of the screen each
 * light covers, packed into one atlas without overlap, and drawn on a real
 * device from casters the camera need not see.
 */

import { describe, expect, it } from "vitest";

import { composeModelMatrix, projectionMatrix, viewMatrix, type MeshAsset, type MeshSceneInstance, type SceneLight } from "@cartbox/editor";
import { WebgpuSceneRenderer } from "@cartbox/player";
import { LOCAL_ATLAS_SIZE, MAX_GPU_LOCAL_TILES, TileAllocator, localCoverage, planLocalTiles } from "../packages/player/src/render/localAtlas";

const spot = (position: [number, number, number], range: number): SceneLight =>
  ({ kind: "spot", position, direction: [0, -1, 0], range, innerAngle: 35, outerAngle: 45, color: [1, 1, 1], intensity: 4, castShadows: true }) as SceneLight;
const point = (position: [number, number, number], range: number): SceneLight =>
  ({ kind: "point", position, range, color: [1, 1, 1], intensity: 4, castShadows: true }) as SceneLight;

describe("planning the atlas", () => {
  const eye: [number, number, number] = [0, 2, 0];
  const tan = Math.tan(0.5);

  it("sizes each light's tiles by how much of the screen it covers", () => {
    const near = spot([0, 2, -2], 6);
    const mid = spot([0, 2, -60], 6);
    const far = spot([0, 2, -200], 6);
    expect(localCoverage(near, eye, tan)).toBeGreaterThan(localCoverage(mid, eye, tan));
    const plan = planLocalTiles([far, near, mid], eye, tan);
    const size = (i: number) => plan.tiles.find((t) => t.light === i)!.size;
    expect(size(1)).toBe(1024);
    expect(size(2)).toBe(512);
    expect(size(0)).toBe(256);
    // Each light points at its own first tile.
    plan.lights.forEach((l, i) => expect(plan.tiles[l.shadowTile!]!.light).toBe(i));
  });

  it("gives a point light six faces in a row, and never overlaps two tiles", () => {
    const lights = [point([0, 2, -2], 8), spot([3, 2, -3], 5), point([0, 2, -15], 8), ...Array.from({ length: 6 }, (_, i) => spot([i, 2, -40], 4))];
    const plan = planLocalTiles(lights, eye, tan);
    const first = plan.lights[0]!.shadowTile!;
    expect(plan.tiles.slice(first, first + 6).map((t) => t.face)).toEqual([0, 1, 2, 3, 4, 5]);
    for (let a = 0; a < plan.tiles.length; a += 1) {
      const A = plan.tiles[a]!;
      expect(A.x + A.size).toBeLessThanOrEqual(LOCAL_ATLAS_SIZE);
      expect(A.y + A.size).toBeLessThanOrEqual(LOCAL_ATLAS_SIZE);
      for (let b = a + 1; b < plan.tiles.length; b += 1) {
        const B = plan.tiles[b]!;
        const apart = A.x + A.size <= B.x || B.x + B.size <= A.x || A.y + A.size <= B.y || B.y + B.size <= A.y;
        expect(apart).toBe(true);
      }
    }
  });

  it("shrinks a light that doesn't fit, and stops at the tile cap", () => {
    // Sixteen close point lights want 96 faces of 1024²: the atlas holds sixteen.
    const crowd = Array.from({ length: 16 }, (_, i) => point([i * 0.1, 2, -1], 20));
    const plan = planLocalTiles(crowd, eye, tan);
    expect(plan.tiles.length).toBeLessThanOrEqual(MAX_GPU_LOCAL_TILES);
    expect(plan.tiles.some((t) => t.size === 1024)).toBe(true);
    expect(plan.tiles.some((t) => t.size < 1024)).toBe(true);
    // Those left out cast nothing.
    const without = plan.lights.filter((l) => l.shadowTile === undefined).length;
    expect(without * 6 + plan.tiles.length).toBe(96);
  });

  it("splits blocks down without handing one out twice", () => {
    const atlas = new TileAllocator(1024);
    const got = new Set<string>();
    for (let i = 0; i < 16; i += 1) got.add(String(atlas.alloc(256)));
    expect(got.size).toBe(16);
    expect(atlas.alloc(256)).toBeNull();
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
  for (let i = 0; i < 800 && !done; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    device.tick?.();
  }
  return promise;
}

function half(h: number): number {
  const e = (h >> 10) & 0x1f;
  const m = h & 0x3ff;
  const s = h & 0x8000 ? -1 : 1;
  return e === 0 ? s * 2 ** -14 * (m / 1024) : s * 2 ** (e - 15) * (1 + m / 1024);
}

const W = 64;
const H = 64;

/** A unit square in XZ facing up (a floor; a cut-out card with `mask`), or a unit cube. */
const floor = (mask = false): MeshAsset =>
  ({
    name: mask ? "card" : "floor",
    primitives: [
      {
        positions: Float32Array.from([-1, 0, -1, 1, 0, -1, 1, 0, 1, -1, 0, 1]),
        normals: Float32Array.from([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]),
        uvs: Float32Array.from([0, 0, 1, 0, 1, 1, 0, 1]),
        indices: Uint32Array.from([0, 2, 1, 0, 3, 2]),
        material: { name: "floor", baseColorImage: null, baseColorFactor: [0.8, 0.8, 0.8, 1], metallicFactor: 0, roughnessFactor: 1, ...(mask ? { alphaMode: "mask", alphaCutoff: 0.5 } : {}) },
      },
    ],
  }) as unknown as MeshAsset;
const cube = (): MeshAsset => {
  const p: number[] = [];
  const n: number[] = [];
  const idx: number[] = [];
  const faces: [number[], number[], number[]][] = [
    [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
    [[-1, 0, 0], [0, 1, 0], [0, 0, -1]],
    [[0, 1, 0], [0, 0, 1], [1, 0, 0]],
    [[0, -1, 0], [0, 0, -1], [1, 0, 0]],
    [[0, 0, 1], [1, 0, 0], [0, 1, 0]],
    [[0, 0, -1], [-1, 0, 0], [0, 1, 0]],
  ];
  for (const [f, a, b] of faces) {
    const base = p.length / 3;
    for (const [s, t] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      p.push(f[0]! + a[0]! * s! + b[0]! * t!, f[1]! + a[1]! * s! + b[1]! * t!, f[2]! + a[2]! * s! + b[2]! * t!);
      n.push(...f);
    }
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  return {
    name: "cube",
    primitives: [
      {
        positions: Float32Array.from(p),
        normals: Float32Array.from(n),
        uvs: new Float32Array((p.length / 3) * 2),
        indices: Uint32Array.from(idx),
        material: { name: "cube", baseColorImage: null, baseColorFactor: [0.8, 0.8, 0.8, 1], metallicFactor: 0, roughnessFactor: 1 },
      },
    ],
  } as unknown as MeshAsset;
};


const ground: MeshSceneInstance = { mesh: floor(), model: composeModelMatrix([0, 0, 0], [0, 0, 0], [6, 1, 6]) };
// A box the camera never draws, between the light and the floor below it.
const box: MeshSceneInstance = { mesh: cube(), model: composeModelMatrix([0, 1.5, 0], [0, 0, 0], [0.4, 0.4, 0.4]) };
const VIEW = viewMatrix([0, 6, 0.01], [0, 0, 0]);
const PROJECTION = projectionMatrix(Math.PI / 3, 1, 0.1, 50);

/** The frame's linear-light green at a world x on the floor's centre line, lit by one local light alone. */
async function render(light: SceneLight, casters: MeshSceneInstance[] | null): Promise<(x: number) => number> {
  const renderer = (await WebgpuSceneRenderer.create(device, W, H, undefined, { hdr: true }))!;
  device.pushErrorScope("validation");
  const texture = renderer.renderToTexture!([ground], {
    width: W,
    height: H,
    view: VIEW,
    projection: PROJECTION,
    ambient: 0,
    lightDirection: [0, -1, 0],
    lights: [light],
    ...(casters ? { localShadowCasters: casters } : {}),
  } as any);
  const error = await settled(device.popErrorScope());
  expect(error ? String((error as any).message ?? error) : null).toBeNull();
  const bytesPerRow = Math.ceil((W * 8) / 256) * 256;
  const buffer = device.createBuffer({ size: bytesPerRow * H, usage: 0x01 | 0x08 });
  const encoder = device.createCommandEncoder();
  encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow, rowsPerImage: H }, { width: W, height: H });
  device.queue.submit([encoder.finish()]);
  await settled(buffer.mapAsync(0x01));
  const halves = new Uint16Array(buffer.getMappedRange().slice(0));
  buffer.unmap();
  buffer.destroy();
  renderer.dispose();
  const px = (x: number) => Math.round(W / 2 + (x / (6 * Math.tan(Math.PI / 6))) * (W / 2));
  return (x) => half(halves[(Math.round(H / 2) * bytesPerRow) / 2 + px(x) * 4 + 1]!);
}

describe.skipIf(!device)("local light shadows on the GPU, on a real device", { timeout: 60_000 }, () => {
  for (const [name, light] of [["a spot", spot([0, 3.5, 0], 8)], ["a point", point([0, 3.5, 0], 8)]] as const) {
    it(`shadows the floor under a box from ${name} light, and leaves the rest lit`, async () => {
      const lit = await render(light, null);
      const shaded = await render(light, [ground, box]);
      // Under the box: dark. Off to the side: as lit as without the box.
      expect(lit(0)).toBeGreaterThan(0.05);
      expect(shaded(0)).toBeLessThan(0.15 * lit(0));
      expect(Math.abs(shaded(1.6) - lit(1.6))).toBeLessThan(0.05 * lit(1.6) + 1e-3);
    });
  }
});
