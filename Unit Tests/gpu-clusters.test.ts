/**
 * Cluster rendering (AAA_FIDELITY_ROADMAP.md F6a) on a real device (Dawn):
 * the GPU chooses the same cut through a mesh's cluster hierarchy as the CPU
 * (clusterVisible), and the frame it draws is the one the CPU's cut draws:
 * the clusters it also drops (facing away, behind the prepass's depths) are
 * ones nobody sees.
 */

import { describe, expect, it } from "vitest";

import { buildClusterLod, clusterVisible, composeModelMatrix, projectionMatrix, viewMatrix, type ClusterLod, type MeshAsset, type MeshSceneInstance } from "@cartbox/editor";
import { MODELS, WebgpuSceneRenderer, rasterStyleFor } from "@cartbox/player";

import { readLinearTexture } from "../packages/player/src/render/lookDevCheck";

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

async function readBuffer(buffer: any, offset: number, bytes: number): Promise<Uint32Array> {
  const staging = device.createBuffer({ size: bytes, usage: 0x01 | 0x08 });
  const encoder = device.createCommandEncoder();
  encoder.copyBufferToBuffer(buffer, offset, staging, 0, bytes);
  device.queue.submit([encoder.finish()]);
  await settled(staging.mapAsync(1));
  const out = new Uint32Array(staging.getMappedRange().slice(0));
  staging.unmap();
  staging.destroy();
  return out;
}

/** An icosphere of radius 1, subdivided `n` times: closed, every vertex shared. */
function icosphere(n: number): { positions: Float32Array; indices: Uint32Array } {
  const t = (1 + Math.sqrt(5)) / 2;
  const verts: number[][] = [[-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t], [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1]].map((v) => v.map((x) => x / Math.hypot(...v)));
  let faces = [[0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8], [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]];
  for (let s = 0; s < n; s += 1) {
    const cache = new Map<string, number>();
    const mid = (a: number, b: number) => {
      const key = a < b ? `${a},${b}` : `${b},${a}`;
      let m = cache.get(key);
      if (m === undefined) {
        const v = [0, 1, 2].map((k) => (verts[a]![k]! + verts[b]![k]!) / 2);
        m = verts.length;
        verts.push(v.map((x) => x / Math.hypot(...v)));
        cache.set(key, m);
      }
      return m;
    };
    faces = faces.flatMap(([a, b, c]) => {
      const ab = mid(a!, b!), bc = mid(b!, c!), ca = mid(c!, a!);
      return [[a!, ab, ca], [b!, bc, ab], [c!, ca, bc], [ab, bc, ca]];
    });
  }
  return { positions: Float32Array.from(verts.flat()), indices: Uint32Array.from(faces.flat()) };
}

function meshOf(positions: Float32Array, indices: Uint32Array, lod: ClusterLod | null): MeshAsset {
  return {
    name: "ball",
    primitives: [
      {
        positions,
        normals: positions, // a unit sphere's normal is its position
        uvs: new Float32Array((positions.length / 3) * 2),
        indices,
        material: { name: "ball", baseColorFactor: [0.8, 0.5, 0.3, 1], baseColorImage: null, metallicFactor: 0, roughnessFactor: 0.5 },
        ...(lod ? { clusterLod: lod } : {}),
      },
    ],
  } as unknown as MeshAsset;
}

/** The CPU's cut, for an eye and a radian's pixels: its triangles. */
function cpuCut(lod: ClusterLod, eye: readonly number[], pixels: number): Uint32Array {
  const out: number[] = [];
  for (const c of lod.clusters) if (clusterVisible(c, eye, pixels)) for (let t = c.firstTriangle * 3; t < (c.firstTriangle + c.triangles) * 3; t += 1) out.push(lod.indices[t]!);
  return Uint32Array.from(out);
}

const W = 96;
const H = 96;
const PROJECTION = projectionMatrix(Math.PI / 3, 1, 0.1, 100);
const PIXELS = (PROJECTION[5]! * H) / 2;

describe.skipIf(!device)("cluster rendering on a real device", { timeout: 300_000 }, () => {
  const sphere = icosphere(5);
  const closed = buildClusterLod(sphere);

  it("keeps the CPU's cut on an open mesh in view (no cone to cull by)", async () => {
    // A sphere less one triangle: open, so every cluster in the cut is drawn.
    const indices = sphere.indices.slice(3);
    const lod = buildClusterLod({ positions: sphere.positions, indices });
    expect(lod.closed).toBe(false);
    const eye = [0, 0, 6];
    const renderer = (await WebgpuSceneRenderer.create(device, W, H, rasterStyleFor(MODELS.aaa.renderCaps), { hdr: true, mips: true }))!;
    const instances = [{ mesh: meshOf(sphere.positions, indices, lod), model: composeModelMatrix([0, 0, 0], [0, 0, 0], [1, 1, 1]) }] as unknown as MeshSceneInstance[];
    device.pushErrorScope("validation");
    await readLinearTexture(device, renderer.renderToTexture(instances, { width: W, height: H, view: viewMatrix(eye as any, [0, 0, 0]), projection: PROJECTION, environment: null, lights: [], ambient: 0.3, lightDirection: [0.3, 1, 0.6], prepass: true, gpuCull: true } as any), W, H, settled);
    const failure = await settled(device.popErrorScope());
    expect(failure ? String((failure as any).message) : null).toBeNull();
    const clusters = (renderer as any).clusterRendering;
    const prepassArgs = await readBuffer(clusters.args, clusters.argsOffset(0, 0), 20);
    const expected = cpuCut(lod, eye, PIXELS);
    // Not the whole mesh: the far side is coarser, as the CPU's cut has it.
    expect(expected.length).toBeLessThan(indices.length);
    expect(prepassArgs[0]).toBe(expected.length);
    expect(prepassArgs[1]).toBe(1);
    renderer.dispose();
  });

  it("draws the frame the CPU's cut draws, dropping only what nobody sees", async () => {
    expect(closed.closed).toBe(true);
    for (const distance of [2.5, 8]) {
      const eye = [0.4, 0.3, distance];
      const draw = { width: W, height: H, view: viewMatrix(eye as any, [0, 0, 0]), projection: PROJECTION, environment: null, lights: [], ambient: 0.3, lightDirection: [0.3, 1, 0.6], prepass: true } as any;
      const model = composeModelMatrix([0, 0, 0], [0, 0, 0], [1, 1, 1]);
      // The reference: the CPU's cut as a plain mesh, drawn without culling.
      const plainRenderer = (await WebgpuSceneRenderer.create(device, W, H, rasterStyleFor(MODELS.aaa.renderCaps), { hdr: true, mips: true }))!;
      const cutMesh = meshOf(sphere.positions, cpuCut(closed, eye, PIXELS), null);
      const plain = (await readLinearTexture(device, plainRenderer.renderToTexture([{ mesh: cutMesh, model }] as unknown as MeshSceneInstance[], draw), W, H, settled)).data;
      const renderer = (await WebgpuSceneRenderer.create(device, W, H, rasterStyleFor(MODELS.aaa.renderCaps), { hdr: true, mips: true }))!;
      const clustered = (await readLinearTexture(device, renderer.renderToTexture([{ mesh: meshOf(sphere.positions, sphere.indices, closed), model }] as unknown as MeshSceneInstance[], { ...draw, gpuCull: true }), W, H, settled)).data;
      const clusters = (renderer as any).clusterRendering;
      const [prepass, shading] = [await readBuffer(clusters.args, clusters.argsOffset(0, 0), 20), await readBuffer(clusters.args, clusters.argsOffset(0, 1), 20)];
      // The cone drops the far side's clusters before the prepass; the pyramid can only drop more for the shading.
      expect(prepass[0]!).toBeLessThan(cpuCut(closed, eye, PIXELS).length);
      expect(shading[0]!).toBeLessThanOrEqual(prepass[0]!);
      let worst = 0;
      for (let i = 0; i < plain.length; i += 1) worst = Math.max(worst, Math.abs(plain[i]! - clustered[i]!));
      expect(worst).toBeLessThan(1e-5);
      plainRenderer.dispose();
      renderer.dispose();
    }
  });
});
