/**
 * Terrain at scale (AAA_FIDELITY_ROADMAP.md F6c): a heightfield drawn on the
 * GPU with no CPU meshing. The quadtree tiles the terrain once over with nodes
 * no more than a level apart, and its morph closes every seam between them;
 * a heightfield of 4097² is planned and chosen from in a few milliseconds and
 * meshed by the CPU only as a coarse copy. On a real device (Dawn) the
 * terrain drawn from its heights covers what its CPU mesh covers, in the
 * colours its layers give it, and its holes stay open.
 */

import { describe, expect, it } from "vitest";

import { composeModelMatrix, meshableTerrain, projectionMatrix, readTerrain, serializeTerrain, terrainChunks, viewMatrix, type MeshMaterial, type MeshSceneInstance, type Terrain } from "@cartbox/editor";
import { MODELS, MeshOverlaySurface, WebgpuSceneRenderer, parseMeshScene, rasterStyleFor, type SceneRenderer } from "@cartbox/player";

import { readLinearTexture } from "../packages/player/src/render/lookDevCheck";
import { TERRAIN_MORPH, TERRAIN_PATCH, TERRAIN_RANGE, TerrainTree, encodeTerrainHeights, pageCorners, terrainPlan, type TerrainNode } from "../packages/player/src/render/gpuTerrain";

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

const material = (name: string, colour: [number, number, number]): MeshMaterial => ({ name, baseColorFactor: [...colour, 1], baseColorImage: null, metallicFactor: 0, roughnessFactor: 0.8 });

/** Rolling hills over `size` metres, `n` heights a side: grass where it's flat, rock where it's steep. */
function hills(n: number, size: number, extra: Partial<Terrain> = {}): Terrain {
  const heights = new Float32Array(n * n);
  for (let j = 0; j < n; j += 1)
    for (let i = 0; i < n; i += 1) {
      const x = (i / (n - 1)) * size;
      const z = (j / (n - 1)) * size;
      heights[j * n + i] = 4 * Math.sin(x * 0.11) * Math.cos(z * 0.09) + 2.5 * Math.sin(x * 0.31 + z * 0.17);
    }
  return {
    id: "hills",
    name: "Hills",
    origin: [-size / 2, 0, -size / 2],
    size: [size, size],
    samples: n,
    heights,
    layers: [
      { material: material("grass", [0.2, 0.6, 0.15]), up: [0.9, 1] },
      { material: material("rock", [0.5, 0.45, 0.4]) },
    ],
    ...extra,
  };
}

/** The shader's height read (terrainHeight), from the encoded heights. */
function heightReader(t: Terrain) {
  const { data, min, range } = encodeTerrainHeights(t);
  const n = t.samples;
  const cells = n - 1;
  const at = (i: number, j: number) => ((data[(j * n + i) * 4]! * 256 + data[(j * n + i) * 4 + 1]!) / 65535) * range + min;
  return (x: number, z: number) => {
    const qx = Math.max(0, Math.min(1, x / t.size[0])) * cells;
    const qz = Math.max(0, Math.min(1, z / t.size[1])) * cells;
    const i = Math.min(Math.floor(qx), cells - 1);
    const j = Math.min(Math.floor(qz), cells - 1);
    const fx = qx - i;
    const fz = qz - j;
    const a = at(i, j) + (at(i + 1, j) - at(i, j)) * fx;
    const b = at(i, j + 1) + (at(i + 1, j + 1) - at(i, j + 1)) * fx;
    return a + (b - a) * fz;
  };
}

/** The shader's morphed vertex (terrainOf): its place in the ground plane and its height. */
function vertexOf(t: Terrain, node: TerrainNode, gx: number, gz: number, eye: readonly [number, number], height: (x: number, z: number) => number): [number, number, number] {
  const n = TERRAIN_PATCH;
  const s = node.size;
  const d = Math.hypot(node.x + (gx / n) * s - eye[0], node.z + (gz / n) * s - eye[1]);
  const range = TERRAIN_RANGE * s;
  const morph = Math.max(0, Math.min(1, (d - TERRAIN_MORPH * range) / ((1 - TERRAIN_MORPH) * range)));
  const mx = gx - (gx % 2) * morph;
  const mz = gz - (gz % 2) * morph;
  const x = Math.max(0, Math.min(t.size[0], node.x + (mx / n) * s));
  const z = Math.max(0, Math.min(t.size[1], node.z + (mz / n) * s));
  return [x, z, height(x, z)];
}

describe("terrain at scale: the quadtree and its morph", () => {
  it("keeps every height to 16 bits of its range", () => {
    const t = hills(65, 64);
    const read = heightReader(t);
    const { range } = encodeTerrainHeights(t);
    const cell = 64 / 64;
    let worst = 0;
    for (let j = 0; j < 65; j += 3) for (let i = 0; i < 65; i += 3) worst = Math.max(worst, Math.abs(read(i * cell, j * cell) - t.heights[j * 65 + i]!));
    expect(worst).toBeLessThanOrEqual(range / 65535);
  });

  it("tiles the terrain once over, finest at the eye, neighbours at most a level apart", () => {
    const t = hills(257, 256);
    const tree = new TerrainTree(t, terrainPlan(t));
    const eye: [number, number] = [70, 150];
    const nodes = tree.select(eye);
    // Once over: the nodes' areas (within the terrain) add up to it, and no two overlap.
    const area = nodes.reduce((sum, n) => sum + Math.max(0, Math.min(n.size, 256 - n.x)) * Math.max(0, Math.min(n.size, 256 - n.z)), 0);
    expect(area).toBeCloseTo(256 * 256, 3);
    const at = nodes.find((n) => eye[0] >= n.x && eye[0] < n.x + n.size && eye[1] >= n.z && eye[1] < n.z + n.size)!;
    expect(at.level).toBe(0);
    for (const a of nodes)
      for (const b of nodes) {
        const touchX = Math.abs(a.x + a.size - b.x) < 1e-6 && a.z < b.z + b.size && b.z < a.z + a.size;
        const touchZ = Math.abs(a.z + a.size - b.z) < 1e-6 && a.x < b.x + b.size && b.x < a.x + a.size;
        if (touchX || touchZ) expect(Math.abs(a.level - b.level)).toBeLessThanOrEqual(1);
      }
    // Each node's range holds its heights.
    const read = heightReader(t);
    for (const n of nodes.slice(0, 40)) {
      const h = read(Math.min(255.9, n.x + n.size / 2), Math.min(255.9, n.z + n.size / 2));
      expect(h).toBeGreaterThanOrEqual(n.min - 1e-3);
      expect(h).toBeLessThanOrEqual(n.max + 1e-3);
    }
  });

  it("closes every seam: neighbours' morphed edges are one line", () => {
    const t = hills(129, 128);
    const tree = new TerrainTree(t, terrainPlan(t));
    const read = heightReader(t);
    let seams = 0;
    for (const eye of [[40, 40], [64.3, 10.7], [127, 127]] as [number, number][]) {
      const nodes = tree.select(eye);
      // Each node's edge along x = const (its east side) as a polyline over z, and along z = const (its north side).
      const edge = (n: TerrainNode, side: "east" | "west" | "north" | "south") => {
        const pts: [number, number][] = [];
        for (let k = 0; k <= TERRAIN_PATCH; k += 1) {
          const [gx, gz] = side === "east" ? [TERRAIN_PATCH, k] : side === "west" ? [0, k] : side === "north" ? [k, TERRAIN_PATCH] : [k, 0];
          const [x, z, h] = vertexOf(t, n, gx, gz, eye, read);
          pts.push([side === "east" || side === "west" ? z : x, h]);
        }
        return pts;
      };
      const along = (pts: [number, number][], p: number) => {
        for (let k = 0; k + 1 < pts.length; k += 1) {
          const [a, ha] = pts[k]!;
          const [b, hb] = pts[k + 1]!;
          if (p >= a - 1e-9 && p <= b + 1e-9) return b - a < 1e-9 ? ha : ha + ((p - a) / (b - a)) * (hb - ha);
        }
        return NaN;
      };
      for (const a of nodes)
        for (const b of nodes) {
          if (a.level === b.level) continue;
          const east = Math.abs(a.x + a.size - b.x) < 1e-9;
          const north = Math.abs(a.z + a.size - b.z) < 1e-9;
          if (!east && !north) continue;
          const [lo, hi] = east ? [Math.max(a.z, b.z), Math.min(a.z + a.size, b.z + b.size)] : [Math.max(a.x, b.x), Math.min(a.x + a.size, b.x + b.size)];
          if (hi - lo <= 1e-9 || lo >= 128) continue;
          const pa = edge(a, east ? "east" : "north");
          const pb = edge(b, east ? "west" : "south");
          for (let k = 0; k <= 16; k += 1) {
            const p = Math.min(lo + ((hi - lo) * k) / 16, 128);
            expect(Math.abs(along(pa, p) - along(pb, p))).toBeLessThan(1e-4);
          }
          seams += 1;
        }
    }
    expect(seams).toBeGreaterThan(20);
  });

  it("plans and chooses from a 4097² heightfield in milliseconds, and meshes it on the CPU only as a coarse copy", () => {
    const t = hills(4097, 4096);
    const started = performance.now();
    const tree = new TerrainTree(t, terrainPlan(t));
    const built = performance.now() - started;
    const chose = performance.now();
    const nodes = tree.select([2000, 1500]);
    const selecting = performance.now() - chose;
    expect(nodes.length).toBeGreaterThan(100);
    expect(nodes.length).toBeLessThan(2500);
    expect(selecting).toBeLessThan(20);
    expect(built).toBeLessThan(3000);
    // The eye-following pages: each twice the last, holding the nodes of its level the eye can choose.
    const plan = terrainPlan(t);
    expect(plan.eyePages).toBe(8);
    const corners = pageCorners(plan, [2000, 1500]);
    for (const n of nodes) {
      if (n.level >= plan.eyePages) continue;
      const side = plan.page * 2 ** n.level;
      const [cx, cz] = corners[n.level]!;
      expect(n.x).toBeGreaterThanOrEqual(cx - 1e-6);
      expect(n.z).toBeGreaterThanOrEqual(cz - 1e-6);
      expect(n.x + n.size).toBeLessThanOrEqual(cx + side + 1e-6);
      expect(n.z + n.size).toBeLessThanOrEqual(cz + side + 1e-6);
    }
    const coarse = meshableTerrain(t);
    expect(coarse.samples).toBe(257);
    expect(coarse.size).toEqual([4096, 4096]);
    expect(coarse.heights[1]).toBe(t.heights[16]);
    expect(terrainChunks(coarse).length).toBe(256);
  });

  it("stores the relief, and reads a heightfield past 257²", () => {
    const t = hills(300, 64, { relief: 0.12 });
    const back = readTerrain(JSON.parse(JSON.stringify(serializeTerrain(t))))!;
    expect(back.samples).toBe(300);
    expect(back.relief).toBeCloseTo(0.12, 6);
  });
});

describe("terrain at scale in the mesh overlay", () => {
  const sidecar = (t: Terrain) => JSON.stringify({ version: 2, meshes: [], lighting: null, terrains: [serializeTerrain(t)] });
  const renderer = (aaa: boolean) => ({ backend: "webgpu", ...(aaa ? { sunCascades: true } : {}), render() {}, dispose() {}, renderToTexture: () => null }) as unknown as SceneRenderer;

  it("draws a terrain from its heights on the AAA path, and not from its blocks", async () => {
    const scene = parseMeshScene(sidecar(hills(65, 64, { castShadows: true })))!;
    expect(scene.instances.every((i) => i.ground === "hills")).toBe(true);
    const surface = (await MeshOverlaySurface.create({ blit() {}, destroy() {} }, 16, 16, scene, renderer(true), { prepass: true })) as any;
    expect(surface.ground).toHaveLength(1);
    expect(surface.ground[0].terrain.id).toBe("hills");
    expect(surface.ground[0].layers).toHaveLength(2);
    // Its blocks neither draw nor cast.
    expect(surface.stillCasters()).toHaveLength(0);
    // Elsewhere, the blocks as before.
    const plain = (await MeshOverlaySurface.create({ blit() {}, destroy() {} }, 16, 16, scene, renderer(false), { prepass: true })) as any;
    expect(plain.ground).toHaveLength(0);
    expect(plain.stillCasters().length).toBe(scene.instances.length);
  });
});

const W = 128;
const H = 96;

describe.skipIf(!device)("terrain at scale on a real device", { timeout: 300_000 }, () => {
  // With the prepass, as the AAA tier draws; without the GPU cull, whose compaction faults Dawn's software
  // rasteriser (a null descriptor in its compiled shader) on some frames, terrain or not.
  const look = (eye: [number, number, number], at: [number, number, number]) =>
    ({ width: W, height: H, view: viewMatrix(eye, at), projection: projectionMatrix(Math.PI / 3, W / H, 0.1, 400), environment: null, lights: [], ambient: 1, lightDirection: [0.3, 1, 0.6], prepass: true }) as any;

  async function frames(t: Terrain, draw: any) {
    const identity = composeModelMatrix([0, 0, 0], [0, 0, 0], [1, 1, 1]);
    const cpu = terrainChunks(t).map((c) => ({ mesh: c.mesh, model: identity })) as unknown as MeshSceneInstance[];
    const plain = (await WebgpuSceneRenderer.create(device, W, H, rasterStyleFor(MODELS.aaa.renderCaps), { hdr: true, mips: true }))!;
    const meshed = (await readLinearTexture(device, plain.renderToTexture(cpu, draw), W, H, settled)).data;
    const renderer = (await WebgpuSceneRenderer.create(device, W, H, rasterStyleFor(MODELS.aaa.renderCaps), { hdr: true, mips: true }))!;
    device.pushErrorScope("validation");
    const layers = t.layers.map(() => ({ base: null, normal: null, mr: null }));
    const gpu = (await readLinearTexture(device, renderer.renderToTexture([], { ...draw, terrains: [{ terrain: t, layers }] }), W, H, settled)).data;
    const failure = await settled(device.popErrorScope());
    expect(failure ? String((failure as any).message) : null).toBeNull();
    plain.dispose();
    renderer.dispose();
    return { meshed, gpu };
  }

  it("covers what its CPU mesh covers, in its layers' colours", async () => {
    const t = hills(129, 128, { blend: { up: 0.08, height: 0 } });
    const { meshed, gpu } = await frames(t, look([5, 18, 40], [0, 0, 0]));
    let both = 0, either = 0, close = 0;
    for (let p = 0; p < W * H; p += 1) {
      const a = meshed[p * 4 + 3]! > 0.5;
      const b = gpu[p * 4 + 3]! > 0.5;
      if (a || b) either += 1;
      if (!(a && b)) continue;
      both += 1;
      const d = Math.max(Math.abs(meshed[p * 4]! - gpu[p * 4]!), Math.abs(meshed[p * 4 + 1]! - gpu[p * 4 + 1]!), Math.abs(meshed[p * 4 + 2]! - gpu[p * 4 + 2]!));
      if (d < 0.08) close += 1;
    }
    expect(both).toBeGreaterThan(W * H * 0.5);
    expect(both / either).toBeGreaterThan(0.98);
    expect(close / both).toBeGreaterThan(0.85);
  });

  it("leaves its holes open", async () => {
    const t0 = hills(65, 64);
    const holes = new Uint8Array(64 * 64);
    for (let j = 24; j < 40; j += 1) for (let i = 24; i < 40; i += 1) holes[j * 64 + i] = 1;
    const t = { ...t0, holes };
    const { meshed, gpu } = await frames(t, look([0, 40, 0.01], [0, 0, 0]));
    let open = 0, agree = 0;
    for (let p = 0; p < W * H; p += 1) {
      const a = meshed[p * 4 + 3]! > 0.5;
      const b = gpu[p * 4 + 3]! > 0.5;
      if (!a) open += 1;
      if (a === b) agree += 1;
    }
    expect(open).toBeGreaterThan(W * H * 0.05);
    expect(agree / (W * H)).toBeGreaterThan(0.98);
  });
});
