/**
 * Projected decals (AAA_FIDELITY_ROADMAP.md F1f): marks as boxes the AAA
 * tier's shader projects onto its surfaces before lighting them, changing
 * base colour, roughness, normal and AO, fading by angle and depth, from one
 * shared atlas of tiles.
 */

import { describe, expect, it } from "vitest";

import {
  DECAL_DEPTH,
  DECAL_TILE,
  DecalSystem,
  composeModelMatrix,
  decalBox,
  decalPreset,
  decalTiles,
  projectDecals,
  projectionMatrix,
  viewMatrix,
  type DecalTiles,
  type MeshAsset,
  type MeshSceneInstance,
  type ProjectedDecal,
} from "@cartbox/editor";
import { WebgpuSceneRenderer } from "@cartbox/player";

import { DECAL_WORDS, MAX_GPU_DECALS, packDecalBoxes, packDecalTiles } from "../packages/player/src/render/decalBuffer";

describe("the tiles and boxes", () => {
  it("draws each decal's tile: covered at its heart, clear at its edge, a crater's rim leaning in toward it", () => {
    const tiles = decalTiles([decalPreset("pock"), decalPreset("glyph")]);
    expect(tiles.size).toBe(DECAL_TILE);
    expect(tiles.colour.length).toBe(2 * DECAL_TILE * DECAL_TILE * 4);
    const at = (t: number, x: number, y: number) => (t * DECAL_TILE * DECAL_TILE + y * DECAL_TILE + x) * 4;
    const mid = DECAL_TILE >> 1;
    expect(tiles.colour[at(0, mid, mid) + 3]).toBeGreaterThan(200);
    expect(tiles.colour[at(0, 0, 0) + 3]).toBe(0);
    // A pock is rough and occludes; it sinks, so the rim right of its centre faces back toward it (−x).
    expect(tiles.surface[at(0, mid, mid) + 2]).toBeGreaterThan(200);
    expect(tiles.surface[at(0, mid, mid) + 3]).toBeLessThan(160);
    let leans = 255;
    for (let x = mid; x < DECAL_TILE; x += 1) leans = Math.min(leans, tiles.surface[at(0, x, mid)]!);
    expect(leans).toBeLessThan(116);
  });

  it("lays a box on its surface: across and along at half its size, out of it a quarter, turned by its spin", () => {
    const box = decalBox([1, 2, 3], [0, 0, 2], 2, 90, 0, 1, 0);
    const len = (v: readonly number[]) => Math.hypot(v[0]!, v[1]!, v[2]!);
    expect(len(box.axes[0])).toBeCloseTo(1, 10);
    expect(len(box.axes[1])).toBeCloseTo(1, 10);
    expect(len(box.axes[2])).toBeCloseTo(2 * DECAL_DEPTH, 10);
    expect(box.axes[2][2]).toBeGreaterThan(0);
    const dot = (a: readonly number[], b: readonly number[]) => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
    expect(dot(box.axes[0], box.axes[1])).toBeCloseTo(0, 10);
    expect(dot(box.axes[0], box.axes[2])).toBeCloseTo(0, 10);
    const unturned = decalBox([1, 2, 3], [0, 0, 2], 2, 0, 0, 1, 0);
    expect(dot(box.axes[0], unturned.axes[0])).toBeCloseTo(0, 10);
  });

  it("orders the marks permanent first, then the oldest, a fading one with less of it left", () => {
    const scorch = decalPreset("scorch");
    const system = new DecalSystem([scorch], [{ decal: scorch.name, position: [0, 0, 0], normal: [0, 1, 0], size: 0, spin: 0 }]);
    system.lay(0, [1, 0, 0], [0, 1, 0]);
    system.step(scorch.life * 0.9);
    system.lay(0, [2, 0, 0], [0, 1, 0]);
    const boxes = projectDecals(system);
    expect(boxes.map((b) => b.center[0])).toEqual([0, 1, 2]);
    expect(boxes[0]!.alpha).toBe(1);
    expect(boxes[1]!.alpha).toBeLessThan(0.8);
    expect(boxes[1]!.alpha).toBeGreaterThan(0);
    expect(boxes[2]!.alpha).toBe(1);
    expect(boxes[0]!.glow).toBe(scorch.glow);
  });

  it("packs a box as rows taking the world into it, keeping the nearest when there are too many", () => {
    const box = decalBox([1, 2, 3], [0, 1, 0], 2, 30, 2, 0.5, 1.5);
    const words = packDecalBoxes([box], [0, 0, 0]);
    const f = new Float32Array(words.buffer);
    expect(words[0]).toBe(1);
    const q = (p: readonly number[], r: number) => f[4 + r * 4]! * p[0]! + f[4 + r * 4 + 1]! * p[1]! + f[4 + r * 4 + 2]! * p[2]! + f[4 + r * 4 + 3]!;
    for (let r = 0; r < 3; r += 1) expect(q(box.center, r)).toBeCloseTo(0, 5);
    const corner = box.center.map((c, k) => c + box.axes[0][k]! + box.axes[1][k]! - box.axes[2][k]!);
    expect([q(corner, 0), q(corner, 1), q(corner, 2)].map((v) => Math.round(v * 1e4) / 1e4)).toEqual([1, 1, -1]);
    expect([f[4 + 12], f[4 + 13], f[4 + 14]]).toEqual([2, 0.5, 1.5]);
    // Too many: the nearest MAX, in their order.
    // On a wall facing +z, so a box's across-axis runs along x and its row gives back its centre's x.
    const many: ProjectedDecal[] = Array.from({ length: MAX_GPU_DECALS + 10 }, (_, i) => decalBox([i, 0, 0], [0, 0, 1], 1, 0, 0, 1, 0));
    const centres = (w: Uint32Array) => {
      const f = new Float32Array(w.buffer);
      return Array.from({ length: w[0]! }, (_, i) => Math.round(-f[4 + i * DECAL_WORDS + 3]! / f[4 + i * DECAL_WORDS]!));
    };
    const kept = packDecalBoxes(many, [0, 0, 0]);
    expect(kept[0]).toBe(MAX_GPU_DECALS);
    expect(kept.length).toBe(4 + MAX_GPU_DECALS * DECAL_WORDS);
    // The ten farthest are the ones left out, whichever order they came in, and the rest keep their order.
    expect(centres(kept)).toEqual(Array.from({ length: MAX_GPU_DECALS }, (_, i) => i));
    expect(centres(packDecalBoxes([...many].reverse(), [0, 0, 0]))).toEqual(Array.from({ length: MAX_GPU_DECALS }, (_, i) => MAX_GPU_DECALS - 1 - i));
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
  for (let i = 0; i < 400 && !done; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    device.tick?.();
  }
  return promise;
}

function half(h: number): number {
  const s = h & 0x8000 ? -1 : 1;
  const e = (h >> 10) & 0x1f;
  const m = h & 0x3ff;
  if (e === 0) return s * 2 ** -14 * (m / 1024);
  if (e === 31) return m ? NaN : s * Infinity;
  return s * 2 ** (e - 15) * (1 + m / 1024);
}

/** One tile of solid colour, fully covering, flat, as rough as `rough` and occluding to `ao`. */
function solidTile(rgb: readonly [number, number, number], rough = 1, ao = 1): DecalTiles {
  const n = DECAL_TILE;
  const colour = new Uint8ClampedArray(n * n * 4);
  const surface = new Uint8ClampedArray(n * n * 4);
  for (let i = 0; i < n * n; i += 1) {
    colour.set([rgb[0] * 255, rgb[1] * 255, rgb[2] * 255, 255], i * 4);
    surface.set([128, 128, rough * 255, ao * 255], i * 4);
  }
  return { size: n, count: 1, colour, surface };
}

function quad(alphaMode?: "blend"): MeshAsset {
  return {
    name: "q",
    primitives: [
      {
        positions: Float32Array.from([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]),
        normals: Float32Array.from([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
        uvs: Float32Array.from([0, 0, 1, 0, 1, 1, 0, 1]),
        indices: Uint32Array.from([0, 1, 2, 0, 2, 3]),
        material: { name: "white", baseColorFactor: [1, 1, 1, 1], baseColorImage: null, metallicFactor: 0, roughnessFactor: 1, ...(alphaMode ? { alphaMode } : {}) },
      },
    ],
  } as unknown as MeshAsset;
}

const W = 32;
const H = 32;

describe.skipIf(!device)("on a real device, in linear light", { timeout: 60_000 }, () => {
  /** The centre's linear colour: a white quad facing the camera, lit head-on, under `decals`. */
  async function centre(decals: { boxes: ProjectedDecal[]; tiles: DecalTiles } | null, mesh: MeshAsset = quad()): Promise<[number, number, number]> {
    const renderer = (await WebgpuSceneRenderer.create(device, W, H, undefined, { hdr: true }))!;
    const instances: MeshSceneInstance[] = [{ mesh, model: composeModelMatrix([0, 0, 0], [0, 0, 0], [2, 2, 1]) }];
    device.pushErrorScope("validation");
    const texture = renderer.renderToTexture!(instances, {
      width: W,
      height: H,
      view: viewMatrix([0, 0, 3], [0, 0, 0]),
      projection: projectionMatrix(Math.PI / 3, 1, 0.1, 50),
      ambient: 0,
      lightDirection: [0, 0, 1],
      environment: null,
      lights: [{ kind: "directional", direction: [0, 0, 1], color: [1, 1, 1], intensity: 1 }],
      ...(decals ? { decals } : {}),
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
    const i = ((H >> 1) * bytesPerRow) / 2 + (W >> 1) * 4;
    return [half(halves[i]!), half(halves[i + 1]!), half(halves[i + 2]!)];
  }

  const red = solidTile([1, 0, 0]);
  const onQuad = (extra: Partial<ProjectedDecal> = {}): ProjectedDecal => ({ ...decalBox([0, 0, 0], [0, 0, 1], 1, 0, 0, 1, 0), ...extra });

  it("paints the surface beneath it, before it is lit", async () => {
    const plain = await centre(null);
    expect(plain[0]).toBeGreaterThan(0.5);
    expect(Math.abs(plain[1] - plain[0])).toBeLessThan(0.02);
    const painted = await centre({ boxes: [onQuad()], tiles: red });
    expect(painted[0]).toBeCloseTo(plain[0], 1);
    expect(painted[1]).toBeLessThan(0.05);
    expect(painted[2]).toBeLessThan(0.05);
  });

  it("fades as it fades, misses a surface outside its box or turned from it, and leaves see-through surfaces alone", async () => {
    const plain = await centre(null);
    const halfway = await centre({ boxes: [onQuad({ alpha: 0.5 })], tiles: red });
    expect(halfway[1]).toBeGreaterThan(plain[1] * 0.35);
    expect(halfway[1]).toBeLessThan(plain[1] * 0.65);
    // Out beyond the box's depth.
    const off = await centre({ boxes: [decalBox([0, 0, 1], [0, 0, 1], 1, 0, 0, 1, 0)], tiles: red });
    expect(off[1]).toBeCloseTo(plain[1], 2);
    // A box laid for a floor (facing +y) through the wall: the wall turns from it.
    const turned = await centre({ boxes: [decalBox([0, 0, 0], [0, 1, 0], 1, 0, 0, 1, 0)], tiles: red });
    expect(turned[1]).toBeCloseTo(plain[1], 2);
    const glass = await centre({ boxes: [onQuad()], tiles: red }, quad("blend"));
    expect(glass[1]).toBeGreaterThan(0.05);
  });

  it("glows by its decal's glow, and occludes by its tile's AO", async () => {
    const dark = solidTile([0, 0, 1], 1, 0.25);
    const lit = await centre({ boxes: [onQuad()], tiles: dark });
    const glowing = await centre({ boxes: [onQuad({ glow: 2 })], tiles: dark });
    expect(glowing[2] - lit[2]).toBeCloseTo(2, 1);
    expect(lit[0]).toBeLessThan(0.02);
  });
});

describe("the packed tiles", () => {
  it("interleaves each texel's colour and surface as RGBA8 words", () => {
    const words = packDecalTiles(solidTile([1, 0.5, 0], 0.5, 0.25));
    expect(words.length).toBe(DECAL_TILE * DECAL_TILE * 2);
    expect(words[0]! & 0xff).toBe(255);
    expect((words[0]! >>> 8) & 0xff).toBe(128);
    expect(words[0]! >>> 24).toBe(255);
    expect((words[1]! >>> 16) & 0xff).toBe(128);
    expect(words[1]! >>> 24).toBe(64);
  });
});
