/**
 * Virtual shadow maps for the sun on the AAA tier (AAA_FIDELITY_ROADMAP.md
 * F2b): the clipmap's geometry, the page pool's bookkeeping (giving pages
 * out, keeping them while they hold, drawing them again when the light or
 * something moving asks, evicting the least recently needed), the marks read
 * back to pages, and on a real device a thin pole's shadow kept sharp where
 * the cascades blur it, falling back to the cascades until pages are resident.
 */

import { describe, expect, it } from "vitest";

import { composeModelMatrix, defaultSceneLighting, projectionMatrix, viewMatrix, type MeshAsset, type MeshSceneInstance } from "@cartbox/editor";
import { MeshOverlaySurface, QUALITY_PRESETS, WebgpuSceneRenderer, type GpuSceneDraw, type PresentFrame, type SceneRenderer } from "@cartbox/player";
import {
  VSM_LEVELS,
  VSM_MARK_WORDS,
  VSM_PAGE,
  VSM_PAGES,
  VirtualPagePool,
  markedPages,
  physicalCorner,
  vsmDepthCentre,
  vsmLightBasis,
  vsmPageSize,
  vsmPageViewProj,
  vsmTexel,
  vsmWindows,
  wrap,
} from "../packages/player/src/render/virtualShadows";

const apply = (m: Float32Array, p: [number, number, number]) => [0, 1, 2, 3].map((r) => m[r]! * p[0] + m[4 + r]! * p[1] + m[8 + r]! * p[2] + m[12 + r]!);

describe("the virtual map's geometry", () => {
  it("doubles each level's texel, 16384 texels a side", () => {
    expect(vsmTexel(0)).toBeCloseTo(0.002, 9);
    expect(vsmTexel(3)).toBeCloseTo(0.016, 9);
    expect(VSM_PAGES * VSM_PAGE).toBe(16384);
    expect(vsmPageSize(1)).toBeCloseTo(0.512, 9);
  });

  it("frames the sun orthonormally, z toward it", () => {
    const b = vsmLightBasis([0.3, 0.8, 0.2]);
    const dot = (a: number[], c: number[]) => a[0]! * c[0]! + a[1]! * c[1]! + a[2]! * c[2]!;
    expect(dot(b.x, b.y)).toBeCloseTo(0, 9);
    expect(dot(b.x, b.z)).toBeCloseTo(0, 9);
    expect(dot(b.z, b.z)).toBeCloseTo(1, 9);
    expect(dot(b.z, [0.3, 0.8, 0.2])).toBeGreaterThan(0);
  });

  it("maps a page's square to −1..1 across, and its depth range sunward to 0", () => {
    const basis = vsmLightBasis([0, 1, 0.5]);
    const centre = vsmDepthCentre([10, 2, -4], basis);
    const m = vsmPageViewProj(2, 7, -3, basis, centre);
    const size = vsmPageSize(2);
    // The page's corner (7, −3) and the opposite one, at the range's middle along the sun.
    const at = (lx: number, ly: number, lz: number) => [0, 1, 2].map((i) => basis.x[i]! * lx + basis.y[i]! * ly + basis.z[i]! * lz) as [number, number, number];
    const lo = apply(m, at(7 * size, -3 * size, centre));
    const hi = apply(m, at(8 * size, -2 * size, centre));
    expect(lo[0]).toBeCloseTo(-1, 5);
    expect(lo[1]).toBeCloseTo(-1, 5);
    expect(hi[0]).toBeCloseTo(1, 5);
    expect(hi[1]).toBeCloseTo(1, 5);
    expect(lo[2]).toBeCloseTo(0.5, 5);
    // Toward the sun is nearer (smaller depth).
    expect(apply(m, at(7.5 * size, -2.5 * size, centre + 100))[2]).toBeLessThan(0.5);
  });

  it("centres each level's window on the camera, and holds the depth range still over short moves", () => {
    const basis = vsmLightBasis([0.2, 1, 0.1]);
    const w = vsmWindows([0, 0, 0], basis);
    expect(w).toHaveLength(VSM_LEVELS);
    for (const [x, y] of w) {
      expect(x).toBe(-VSM_PAGES / 2);
      expect(y).toBe(-VSM_PAGES / 2);
    }
    expect(vsmDepthCentre([0, 0, 0], basis)).toBe(vsmDepthCentre([3, 1, -2], basis));
  });
});

describe("the page pool", () => {
  const page = (level: number, gx: number, gy: number) => ({ level, gx, gy });
  const still = () => false;

  it("gives out pages, draws each once, and keeps them while the key holds", () => {
    const pool = new VirtualPagePool(8);
    const first = pool.update([page(0, 1, 1), page(1, 0, 0)], "k", still);
    expect(first.map((d) => d.level)).toEqual([0, 1]);
    expect(new Set(first.map((d) => d.physical)).size).toBe(2);
    expect(pool.update([page(0, 1, 1), page(1, 0, 0)], "k", still)).toEqual([]);
    expect(pool.resident(page(0, 1, 1))).toBe(first[0]!.physical);
    // A new key (the sun moved) draws them all again, in the pages they had.
    const again = pool.update([page(0, 1, 1), page(1, 0, 0)], "k2", still);
    expect(again.map((d) => d.physical).sort()).toEqual(first.map((d) => d.physical).sort());
  });

  it("draws a page while something moves in it, and once more after it leaves", () => {
    const pool = new VirtualPagePool(4);
    let mover = true;
    const moving = (p: { level: number }) => mover && p.level === 0;
    pool.update([page(0, 0, 0), page(1, 0, 0)], "k", moving);
    expect(pool.update([page(0, 0, 0), page(1, 0, 0)], "k", moving).map((d) => d.level)).toEqual([0]);
    mover = false;
    expect(pool.update([page(0, 0, 0), page(1, 0, 0)], "k", moving).map((d) => d.level)).toEqual([0]);
    expect(pool.update([page(0, 0, 0), page(1, 0, 0)], "k", moving)).toEqual([]);
  });

  it("evicts the least recently needed page when full, never one needed this frame", () => {
    const pool = new VirtualPagePool(2);
    pool.update([page(0, 0, 0)], "k", still);
    pool.update([page(0, 1, 0)], "k", still);
    pool.update([page(0, 1, 0)], "k", still);
    // Full: page (0,0,0) was needed longest ago and goes.
    const got = pool.update([page(0, 2, 0), page(0, 1, 0)], "k", still);
    expect(got).toHaveLength(1);
    expect(pool.resident(page(0, 0, 0))).toBeNull();
    expect(pool.resident(page(0, 1, 0))).not.toBeNull();
    // Nothing to evict when every page is needed now: the rest wait.
    expect(pool.update([page(0, 3, 0), page(0, 1, 0), page(0, 2, 0)], "k", still)).toEqual([]);
  });

  it("draws at most its budget a frame, finest and missing first", () => {
    const pool = new VirtualPagePool(16);
    const want = [page(2, 0, 0), page(0, 0, 0), page(1, 0, 0), page(0, 1, 0)];
    expect(pool.update(want, "k", still, 2).map((d) => d.level)).toEqual([0, 0]);
    expect(pool.update(want, "k", still, 2).map((d) => d.level)).toEqual([1, 2]);
  });

  it("lays its table out by the windows, wrapped", () => {
    const pool = new VirtualPagePool(4);
    pool.update([page(1, 130, -5)], "k", still);
    const windows = Array.from({ length: VSM_LEVELS }, () => [100, -60] as [number, number]);
    const table = pool.table(windows);
    const slot = 1 * VSM_PAGES * VSM_PAGES + wrap(-5) * VSM_PAGES + wrap(130);
    expect(table[slot]).toBe(pool.resident(page(1, 130, -5))! + 1);
    expect(table.reduce((n, v) => n + (v > 0 ? 1 : 0), 0)).toBe(1);
    // Outside its window, it isn't in the table.
    const away = pool.table(Array.from({ length: VSM_LEVELS }, () => [0, 0] as [number, number]));
    expect(away.some((v) => v > 0)).toBe(false);
  });

  it("reads marks back to the pages they stand for in their windows", () => {
    const marks = new Uint32Array(VSM_MARK_WORDS);
    const windows = Array.from({ length: VSM_LEVELS }, () => [-70, 10] as [number, number]);
    for (const [k, gx, gy] of [[0, -70, 10], [3, 57, 137], [5, -1, 20]] as const) {
      const bit = k * VSM_PAGES * VSM_PAGES + wrap(gy) * VSM_PAGES + wrap(gx);
      marks[bit >> 5] |= 1 << (bit & 31);
    }
    const got = markedPages(marks, windows).map((p) => `${p.level}:${p.gx}:${p.gy}`).sort();
    expect(got).toEqual(["0:-70:10", "3:57:137", "5:-1:20"]);
  });

  it("packs physical pages across the pool", () => {
    expect(physicalCorner(0, 1024)).toEqual([0, 0]);
    expect(physicalCorner(9, 1024)).toEqual([VSM_PAGE, VSM_PAGE]);
  });
});

describe("the presets", () => {
  it("turn virtual shadow maps on at High and Epic, and leave Medium and Low on the cascades", () => {
    expect(QUALITY_PRESETS.epic.virtualShadows).toBe(true);
    expect(QUALITY_PRESETS.high.virtualShadows).toBe(true);
    expect(QUALITY_PRESETS.medium.virtualShadows).toBeUndefined();
    expect(QUALITY_PRESETS.low.virtualShadows).toBeUndefined();
  });
});

describe("the player under virtual shadow maps", () => {
  it("hands the AAA renderer a pool, the still casters' key and the movers at High, and none at Medium", async () => {
    const draws: GpuSceneDraw[] = [];
    const renderer = { backend: "webgpu", sunCascades: true, render: () => {}, renderToTexture: (_i: unknown, draw: GpuSceneDraw) => (draws.push(draw), {}), dispose: () => {} } as unknown as SceneRenderer;
    const presenter = { present: (_frame: PresentFrame) => undefined, stats: { luminance: null, luminanceSeq: 0, sunVisible: null, seq: 0 } };
    const floor = { name: "floor", primitives: [{ positions: Float32Array.from([-1, 0, -1, 1, 0, -1, 1, 0, 1]), normals: Float32Array.from([0, 1, 0, 0, 1, 0, 0, 1, 0]), uvs: null, indices: Uint32Array.from([0, 2, 1]), material: { name: "m", baseColorFactor: [1, 1, 1, 1], baseColorImage: null, metallicFactor: 0, roughnessFactor: 1 } }] } as unknown as MeshAsset;
    const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    const scene = { instances: [{ mesh: floor, model: IDENTITY }], bounds: { min: [-1, 0, -1], max: [1, 1, 1], center: [0, 0, 0], radius: 2 }, lighting: { ...defaultSceneLighting(), shadows: true } } as never;
    const frame = async (level: "high" | "medium") => {
      const surface = await MeshOverlaySurface.create({ blit() {}, destroy() {} }, 32, 24, scene, renderer, { presenter, prepass: true } as never);
      surface.setQuality(QUALITY_PRESETS[level]);
      surface.setHudMode(true);
      surface.blit(new Uint8Array(32 * 24 * 4));
      return draws.at(-1)!;
    };
    const high = await frame("high");
    expect(high.sunShadow).toBeTruthy();
    expect(high.virtualShadows).toEqual({ poolSize: 4096 });
    expect(typeof high.localShadowKey).toBe("string");
    expect(high.localShadowMoved).toEqual([]);
    expect((await frame("medium")).virtualShadows).toBeUndefined();
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

const W = 128;
const H = 128;
const material = { name: "m", baseColorImage: null, baseColorFactor: [0.8, 0.8, 0.8, 1], metallicFactor: 0, roughnessFactor: 1 };
const quad: MeshAsset = {
  name: "floor",
  primitives: [{ positions: Float32Array.from([-1, 0, -1, 1, 0, -1, 1, 0, 1, -1, 0, 1]), normals: Float32Array.from([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]), uvs: Float32Array.from([0, 0, 1, 0, 1, 1, 0, 1]), indices: Uint32Array.from([0, 2, 1, 0, 3, 2]), material }],
} as unknown as MeshAsset;
const box = (): MeshAsset => {
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
  return { name: "box", primitives: [{ positions: Float32Array.from(p), normals: Float32Array.from(n), uvs: new Float32Array((p.length / 3) * 2), indices: Uint32Array.from(idx), material }] } as unknown as MeshAsset;
};

describe.skipIf(!device)("virtual shadow maps, on a real device", { timeout: 180_000 }, () => {
  // A floor 200 m across, and a rod 2 cm thick a metre above it along z: the sun from straight above casts it a 2 cm line.
  const floor: MeshSceneInstance = { mesh: quad, model: composeModelMatrix([0, 0, 0], [0, 0, 0], [100, 1, 100]) };
  const pole: MeshSceneInstance = { mesh: box(), model: composeModelMatrix([0, 1, 0], [0, 0, 0], [0.01, 0.01, 3]) };
  const PROJECTION = projectionMatrix(Math.PI / 3, 1, 0.1, 200);
  // Low beside the line, looking along −x at it, so the rod above is off the screen and the line runs across it.
  const VIEW = viewMatrix([0.35, 0.45, 0.0001], [0, 0, 0]);

  /** The floor's green along a row of pixels across the shadow after `frames` frames. */
  async function row(virtualShadows: boolean, frames: number): Promise<number[]> {
    const renderer = (await WebgpuSceneRenderer.create(device, W, H, undefined, { hdr: true }))!;
    device.pushErrorScope("validation");
    let texture: any = null;
    for (let f = 0; f < frames; f += 1) {
      texture = renderer.renderToTexture!([floor, pole], {
        width: W,
        height: H,
        view: VIEW,
        projection: PROJECTION,
        ambient: 0.05,
        lightDirection: [0, 1, 0.0001],
        lights: [],
        prepass: true,
        ambientOcclusion: false,
        sunShadow: { casters: [floor, pole], toLight: [0, 1, 0.0001], distance: 200, size: 256, reach: 50, softness: 0 },
        localShadowKey: "still",
        ...(virtualShadows ? { virtualShadows: { poolSize: 2048 } } : {}),
      } as any);
      // Let the marks' readback land before the next frame.
      await settled(device.queue.onSubmittedWorkDone());
      for (let i = 0; i < 4; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
        device.tick?.();
      }
    }
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
    if (virtualShadows && frames > 1) {
      // Pages were marked, read back and drawn.
      expect((renderer as any).vsm.pages.used).toBeGreaterThan(0);
    }
    renderer.dispose();
    // The column through the line: where (0, 0, 0) lands, the floor from 0.3 m beyond to 0.3 m nearer.
    const m = (a: ArrayLike<number>, v: number[]) => [0, 1, 2, 3].map((r) => a[r]! * v[0]! + a[4 + r]! * v[1]! + a[8 + r]! * v[2]! + a[12 + r]! * v[3]!);
    const c = m(PROJECTION, m(VIEW, [0, 0, 0, 1]));
    const x = Math.round((c[0]! / c[3]! * 0.5 + 0.5) * W);
    return Array.from({ length: H }, (_, y) => half(halves[(y * bytesPerRow) / 2 + x * 4 + 1]!)).filter((v) => v > 0);
  }

  it("keeps a 2 cm pole's shadow sharp and dark where the cascades blur it, and falls back to them until pages are resident", async () => {
    const cascades = await row(false, 3);
    const virtual = await row(true, 6);
    const first = await row(true, 1);
    const lit = Math.max(...cascades);
    // How dark the shadow's core gets, and how many pixels are darker than halfway.
    const darkest = (r: number[]) => Math.min(...r) / lit;
    const width = (r: number[]) => r.filter((v) => v < lit * 0.5).length;
    expect(darkest(virtual)).toBeLessThan(0.3);
    // The cascades' texels (256² here, over the whole view) are wider than the line: it is lost in them.
    expect(darkest(cascades)).toBeGreaterThan(0.85);
    expect(width(virtual)).toBeGreaterThan(0);
    // The first frame has no pages yet: it is the cascades' frame.
    first.forEach((v, i) => expect(Math.abs(v - cascades[i]!)).toBeLessThan(0.02 + cascades[i]! * 0.02));
  });
});
