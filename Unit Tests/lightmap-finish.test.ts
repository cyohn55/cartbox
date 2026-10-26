/**
 * Finishing a GPU-baked light map (AAA_FIDELITY_ROADMAP.md F3d-2): texels
 * inside geometry dropped and filled from outside, the à-trous denoiser, and
 * seams stitched so a lookup either side of an edge agrees.
 */

import { describe, expect, it } from "vitest";

import { dilateLightmapValues, layoutLightmap, lightmapSeams, lightmapTexels, stitchLightmapSeams, type MeshAsset, type Occluder } from "@cartbox/editor";
import { decodePngRgba, deserializeMeshAsset } from "@cartbox/editor";
import { bakeLightmapGpu, denoiseLightmap, type GpuLightBakeOptions, type LightmapAtlas } from "../packages/player/src/render/gpuLightmapper";
import { bakeSceneLighting } from "../apps/web/src/lib/lightBake";
import { addMesh, decodeMeshSidecar, emptyMeshSidecar, encodeMeshSidecar, lightmapScaleOf, setMeshLightmapScale } from "../apps/web/src/lib/meshSidecar";

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/** Quads from a corner and two edges, each facing its own normal, in one primitive (vertices shared where `share`). */
function quads(list: readonly { corner: number[]; u: number[]; v: number[]; normal: number[] }[], colour = [0.5, 0.5, 0.5]): MeshAsset {
  const positions: number[] = [], normals: number[] = [], indices: number[] = [];
  for (const { corner, u, v, normal } of list) {
    const base = positions.length / 3;
    for (const [a, b] of [[0, 0], [1, 0], [1, 1], [0, 1]]) {
      positions.push(...corner.map((c, i) => c + u[i]! * a! + v[i]! * b!));
      normals.push(...normal);
    }
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  return {
    name: "quads",
    primitives: [
      {
        positions: Float32Array.from(positions),
        normals: Float32Array.from(normals),
        uvs: null,
        indices: Uint32Array.from(indices),
        material: { name: "m", baseColorImage: null, baseColorFactor: [colour[0]!, colour[1]!, colour[2]!, 1] },
      },
    ],
  } as unknown as MeshAsset;
}

/** An axis-aligned box, its faces' normals outward. */
function box(min: number[], max: number[]): MeshAsset {
  const [x0, y0, z0] = min as [number, number, number];
  const [x1, y1, z1] = max as [number, number, number];
  const dx = x1 - x0, dy = y1 - y0, dz = z1 - z0;
  return quads([
    { corner: [x0, y1, z0], u: [dx, 0, 0], v: [0, 0, dz], normal: [0, 1, 0] },
    { corner: [x0, y0, z0], u: [dx, 0, 0], v: [0, 0, dz], normal: [0, -1, 0] },
    { corner: [x1, y0, z0], u: [0, dy, 0], v: [0, 0, dz], normal: [1, 0, 0] },
    { corner: [x0, y0, z0], u: [0, dy, 0], v: [0, 0, dz], normal: [-1, 0, 0] },
    { corner: [x0, y0, z1], u: [dx, 0, 0], v: [0, dy, 0], normal: [0, 0, 1] },
    { corner: [x0, y0, z0], u: [dx, 0, 0], v: [0, dy, 0], normal: [0, 0, -1] },
  ]);
}

describe("seam stitching", () => {
  // A floor and a wall meeting at a right angle, sharing their edge's vertices: one patch, not planar, so a chart per triangle.
  const hinge = (): MeshAsset => {
    const positions = Float32Array.from([0, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 1, 0, 1, 0, 0, 1, 1]);
    const normals = Float32Array.from([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 1, 0, 0]);
    // Floor (0, 1, 2, 3) and wall (0, 3, 5, 4) share the edge 0–3.
    return {
      name: "hinge",
      primitives: [{ positions, normals, uvs: null, indices: Uint32Array.from([0, 2, 1, 0, 3, 2, 0, 4, 5, 0, 5, 3]), material: { name: "m", baseColorImage: null, baseColorFactor: [1, 1, 1, 1] } }],
    } as unknown as MeshAsset;
  };

  it("finds where one edge in the world sits twice in the atlas", () => {
    const layout = layoutLightmap(hinge(), IDENTITY, { density: 8 });
    // Four charts: the floor's diagonal, the wall's, and the hinge between them.
    expect(lightmapSeams(layout).length).toBeGreaterThan(8);
    // A flat quad is one chart: no seams.
    expect(lightmapSeams(layoutLightmap(quads([{ corner: [0, 0, 0], u: [1, 0, 0], v: [0, 0, 1], normal: [0, 1, 0] }]), IDENTITY, { density: 8 })).length).toBe(0);
  });

  it("makes a lookup either side of a seam agree, and leaves texels away from seams as they were", () => {
    const layout = layoutLightmap(hinge(), IDENTITY, { density: 8 });
    const texels = lightmapTexels(layout);
    const { size } = layout;
    // The floor dark, the wall bright: a hard step at the hinge. (Charts 1 and 2 are the floor's triangles, 3 and 4 the wall's.)
    const value = new Float32Array(size * size * 3);
    for (const i of texels.index) value.fill(texels.chart[i]! > 2 ? 1 : 0, i * 3, i * 3 + 3);
    dilateLightmapValues(value, texels.chart, size);
    const seams = lightmapSeams(layout);
    const mismatch = () => Math.max(...seams.map((s) => Math.abs(s.taps.reduce((sum, t, k) => sum + value[t * 3]! * s.weights[k]!, 0))));
    expect(mismatch()).toBeGreaterThan(0.9);
    const before = value.slice();
    expect(stitchLightmapSeams(layout, value)).toBe(seams.length);
    expect(mismatch()).toBeLessThan(0.1);
    // Texels no seam touches keep their values.
    const touched = new Set(seams.flatMap((s) => [...s.taps]));
    for (let i = 0; i < size * size; i += 1) if (!touched.has(i)) expect(value[i * 3]).toBe(before[i * 3]);
  });
});

describe("texel density per object", () => {
  it("snaps to powers of two from a quarter to four, survives a save, and stores nothing at 1", () => {
    expect([0.2, 0.5, 1.4, 3, 9, -1, NaN, "2"].map(lightmapScaleOf)).toEqual([0.25, 0.5, 1, 4, 4, 1, 1, 1]);
    const placed = addMesh(emptyMeshSidecar(), box([0, 0, 0], [1, 1, 1]), "crate");
    const scaled = setMeshLightmapScale(placed.sidecar, placed.id, 2);
    expect(decodeMeshSidecar(encodeMeshSidecar(scaled)).meshes[0]!.lightmapScale).toBe(2);
    expect("lightmapScale" in setMeshLightmapScale(scaled, placed.id, 1).meshes[0]!).toBe(false);
  });

  it("bakes an object's light map at its own density", async () => {
    const one = addMesh(emptyMeshSidecar(), box([0, 0, 0], [2, 2, 2]), "near");
    const two = addMesh(one.sidecar, box([4, 0, 0], [6, 2, 2]), "far");
    const sidecar = setMeshLightmapScale(two.sidecar, one.id, 4);
    const baked = await bakeSceneLighting(sidecar, { density: 8, rays: 4, probeSpacing: 0 });
    const width = async (id: string) => (await decodePngRgba(deserializeMeshAsset(baked.meshes.find((m) => m.id === id)!.mesh).primitives[0]!.material.lightmapImage!.bytes)).width;
    expect(await width(one.id)).toBeGreaterThan(await width(two.id));
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
  for (let i = 0; i < 40_000 && !done; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2));
    device.tick?.();
  }
  return promise;
}

const uniformSky = (l: number) => ({ width: 4, height: 2, data: new Float32Array(32).map((_, i) => (i % 4 === 3 ? 1 : l)) });

async function bake(mesh: MeshAsset, others: readonly Occluder[], options: GpuLightBakeOptions, density = 8) {
  const layout = layoutLightmap(mesh, IDENTITY, { density });
  device.pushErrorScope("validation");
  const result = await settled(bakeLightmapGpu(device, layout, [{ mesh: layout.mesh, model: IDENTITY }, ...others], options));
  const error = await settled(device.popErrorScope());
  expect(error ? String((error as any).message ?? error) : null).toBeNull();
  const texels = lightmapTexels(layout);
  const at = (p: readonly number[]) => {
    let best = -1, bestD = Infinity;
    for (let j = 0; j < texels.index.length; j += 1) {
      const d = Math.hypot(texels.position[j * 3]! - p[0]!, texels.position[j * 3 + 1]! - p[1]!, texels.position[j * 3 + 2]! - p[2]!);
      if (d < bestD) [best, bestD] = [texels.index[j]!, d];
    }
    return best;
  };
  return { result, layout, texels, at };
}

describe.skipIf(!device)("finishing a GPU bake, on a real device", { timeout: 300_000 }, () => {
  const floor = quads([{ corner: [-2, 0, -2], u: [4, 0, 0], v: [0, 0, 4], normal: [0, 1, 0] }]);

  it("drops the floor's texels under a box and fills them from outside, so the box's foot doesn't darken", async () => {
    const block = box([-0.5, 0, -0.5], [0.5, 1, 0.5]);
    const options = { samples: 128, bounces: 1, sky: uniformSky(1), denoise: false, stitch: false };
    const filled = await bake(floor, [{ mesh: block, model: IDENTITY }], options);
    // Under the box's 1 m² at 8 texels a metre: about 64 texels, all inside it.
    expect(filled.result.invalid).toBeGreaterThan(40);
    expect(filled.result.invalid).toBeLessThan(100);
    const inside = filled.at([0.44, 0, 0]);
    const outside = filled.at([0.56, 0, 0]);
    expect(filled.result.hdr.irradiance[inside * 3]! / filled.result.hdr.irradiance[outside * 3]!).toBeGreaterThan(0.8);
    // Kept, the texel inside reads the black inside of the box.
    const kept = await bake(floor, [{ mesh: block, model: IDENTITY }], { ...options, backfaceLimit: 1.01 });
    expect(kept.result.invalid).toBe(0);
    expect(kept.result.hdr.irradiance[inside * 3]! / kept.result.hdr.irradiance[outside * 3]!).toBeLessThan(0.3);
  });

  it("keeps the floor behind a one-sided wall: half its rays meet the wall's back, and that is not inside it", async () => {
    const wall = quads([{ corner: [0, 0, -3], u: [0, 3, 0], v: [0, 0, 6], normal: [1, 0, 0] }]);
    const behind = await bake(floor, [{ mesh: wall, model: IDENTITY }], { samples: 64, bounces: 0, sky: uniformSky(1), denoise: false });
    expect(behind.result.invalid).toBe(0);
  });

  it("denoises a few paths a texel to nearer the many-path answer, without bleeding across a corner", async () => {
    const red = quads([{ corner: [0, 0, -2], u: [0, 2, 0], v: [0, 0, 4], normal: [1, 0, 0] }], [0.9, 0.1, 0.1]);
    const ground = quads([{ corner: [0, 0, -1], u: [2, 0, 0], v: [0, 0, 2], normal: [0, 1, 0] }]);
    const sun = { direction: [1, 0.4, 0.2] as const, radiance: [3, 3, 3] as const };
    const base = { sky: uniformSky(0.3), lights: [sun], bounces: 2, stitch: false };
    const truth = await bake(ground, [{ mesh: red, model: IDENTITY }], { ...base, samples: 1024, denoise: false });
    const noisy = await bake(ground, [{ mesh: red, model: IDENTITY }], { ...base, samples: 8, denoise: false });
    const clean = await bake(ground, [{ mesh: red, model: IDENTITY }], { ...base, samples: 8 });
    const rmse = (r: typeof noisy) => {
      let sum = 0;
      for (const i of truth.texels.index) sum += (r.result.hdr.irradiance[i * 3]! - truth.result.hdr.irradiance[i * 3]!) ** 2;
      return Math.sqrt(sum / truth.texels.index.length);
    };
    expect(rmse(clean)).toBeLessThan(0.6 * rmse(noisy));
  });

  it("smooths noise on a plane and stops at a corner and at a neighbouring chart in the atlas", async () => {
    // A 16 × 8 atlas in a 16² map: left half a floor (normal up) at 0.2, right half a wall (normal +x) at 1, both noisy;
    // their texels side by side in the atlas, and in the world too, where the wall stands on the floor's edge.
    const size = 16;
    const values = new Float32Array(size * size * 12);
    const guide = new Float32Array(size * size * 8);
    const valid = new Int32Array(size * size).fill(-1);
    const texel = 0.125;
    let seed = 7;
    const noise = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648 - 0.5) * 0.2;
    for (let y = 0; y < 8; y += 1) {
      for (let x = 0; x < size; x += 1) {
        const i = y * size + x;
        const wall = x >= 8;
        const level = (wall ? 1 : 0.2) + noise();
        values.set([level, level, level, (0.2 * 0.2) / 12], i * 12); // the noise's own variance
        guide.set(wall ? [1, (x - 8 + 0.5) * texel, y * texel, 1, 1, 0, 0, 0] : [(x + 0.5) * texel, 0, y * texel, 1, 0, 1, 0, 0], i * 8);
        valid[i] = wall ? 1 : 0;
      }
    }
    const atlas: LightmapAtlas = { size, values, valid, guide, invalid: 0 };
    const spread = (from: number, to: number) => {
      let mean = 0, sq = 0, n = 0;
      for (let y = 0; y < 8; y += 1) for (let x = from; x < to; x += 1) {
        const v = values[(y * size + x) * 12]!;
        mean += v;
        sq += v * v;
        n += 1;
      }
      mean /= n;
      return { mean, sd: Math.sqrt(sq / n - mean * mean) };
    };
    const before = spread(0, 8);
    await settled(denoiseLightmap(device, atlas, texel));
    const after = spread(0, 8);
    expect(after.sd).toBeLessThan(0.5 * before.sd);
    expect(Math.abs(after.mean - 0.2)).toBeLessThan(0.03);
    // Nothing of the bright wall reached the floor's column beside it, nor the floor the wall's.
    for (let y = 0; y < 8; y += 1) {
      expect(values[(y * size + 7) * 12]!).toBeLessThan(0.35);
      expect(values[(y * size + 8) * 12]!).toBeGreaterThan(0.85);
    }
    // Unbaked texels are left alone.
    expect(values[(12 * size + 3) * 12]).toBe(0);
  });
});
