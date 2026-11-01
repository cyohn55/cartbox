/**
 * GPU-driven culling (AAA_FIDELITY_ROADMAP.md F0e): the frustum's planes and a
 * primitive's sphere on the CPU, and, on a real device (Dawn), the two rounds
 * — the frustum for the prepass, then a Hi-Z pyramid of its depths — counted
 * in the indirect arguments, with the frame drawn exactly as without them.
 */

import { describe, expect, it } from "vitest";

import { composeModelMatrix, multiplyMat4, projectionMatrix, viewMatrix, type MeshAsset, type MeshPrimitive, type MeshSceneInstance } from "@cartbox/editor";
import { MODELS, WebgpuSceneRenderer, rasterStyleFor } from "@cartbox/player";

import { INDIRECT_WORDS, frustumPlanesOf, primitiveSphere } from "../packages/player/src/render/gpuCulling";
import { readLinearTexture } from "../packages/player/src/render/lookDevCheck";

function box(name: string): MeshAsset {
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  const faces: [number[], number[], number[]][] = [
    [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
    [[-1, 0, 0], [0, 0, 1], [0, 1, 0]],
    [[0, 1, 0], [0, 0, 1], [1, 0, 0]],
    [[0, -1, 0], [1, 0, 0], [0, 0, 1]],
    [[0, 0, 1], [1, 0, 0], [0, 1, 0]],
    [[0, 0, -1], [0, 1, 0], [1, 0, 0]],
  ];
  for (const [n, u, v] of faces) {
    const base = positions.length / 3;
    for (const [a, b] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) {
      positions.push(...[0, 1, 2].map((k) => 0.5 * (n[k]! + a * u[k]! + b * v[k]!)));
      normals.push(...n);
    }
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  return {
    name,
    primitives: [
      {
        positions: Float32Array.from(positions),
        normals: Float32Array.from(normals),
        uvs: new Float32Array((positions.length / 3) * 2),
        indices: Uint32Array.from(indices),
        material: { name, baseColorFactor: [0.8, 0.5, 0.3, 1], baseColorImage: null, metallicFactor: 0, roughnessFactor: 0.6 },
      },
    ],
  } as unknown as MeshAsset;
}

function wall(): MeshAsset {
  return {
    name: "wall",
    primitives: [
      {
        positions: Float32Array.from([-4, -4, 0, 4, -4, 0, 4, 4, 0, -4, 4, 0]),
        normals: Float32Array.from([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
        uvs: new Float32Array(8),
        indices: Uint32Array.from([0, 1, 2, 0, 2, 3]),
        material: { name: "wall", baseColorFactor: [0.4, 0.6, 0.9, 1], baseColorImage: null, metallicFactor: 0, roughnessFactor: 0.8 },
      },
    ],
  } as unknown as MeshAsset;
}

describe("the cull's bounds", () => {
  it("takes the frustum's six planes, inward, from a view-projection", () => {
    const view = viewMatrix([0, 0, 10], [0, 0, 0]);
    const vp = multiplyMat4(projectionMatrix(Math.PI / 3, 1, 0.1, 50), view);
    const planes = frustumPlanesOf(vp);
    const inside = (p: number[]) => [0, 1, 2, 3, 4, 5].every((k) => planes[k * 4]! * p[0]! + planes[k * 4 + 1]! * p[1]! + planes[k * 4 + 2]! * p[2]! + planes[k * 4 + 3]! >= 0);
    expect(inside([0, 0, 0])).toBe(true);
    expect(inside([0, 0, 11])).toBe(false); // behind the eye
    expect(inside([0, 0, -45])).toBe(false); // past the far plane
    expect(inside([20, 0, 0])).toBe(false);
    expect(inside([0, 5.7, 0])).toBe(true); // tan 30° × 10 = 5.77
    expect(inside([0, 5.9, 0])).toBe(false);
    for (let k = 0; k < 6; k += 1) expect(Math.hypot(planes[k * 4]!, planes[k * 4 + 1]!, planes[k * 4 + 2]!)).toBeCloseTo(1, 5);
  });

  it("bounds a primitive by its box's centre and half-diagonal, with its furthest sway", () => {
    const p = box("b").primitives[0]!;
    const [x, y, z, r, sway] = primitiveSphere(p);
    expect([x, y, z]).toEqual([0, 0, 0]);
    expect(r).toBeCloseTo(Math.sqrt(3) / 2, 6);
    expect(sway).toBe(0);
    expect(primitiveSphere(p)).toBe(primitiveSphere(p));
    const swaying = { ...p, sway: Float32Array.from({ length: p.positions.length / 3 }, (_, i) => (i % 3) * 0.4) } as MeshPrimitive;
    expect(primitiveSphere(swaying)[4]).toBeCloseTo(0.8, 6);
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

async function readBuffer(buffer: any, bytes: number): Promise<ArrayBuffer> {
  const staging = device.createBuffer({ size: bytes, usage: 0x01 | 0x08 });
  const encoder = device.createCommandEncoder();
  encoder.copyBufferToBuffer(buffer, 0, staging, 0, bytes);
  device.queue.submit([encoder.finish()]);
  await settled(staging.mapAsync(1));
  const out = staging.getMappedRange().slice(0);
  staging.unmap();
  staging.destroy();
  return out;
}

const W = 64;
const H = 64;

describe.skipIf(!device)("GPU culling on a real device", { timeout: 300_000 }, () => {
  it("drops what's off screen for the prepass and what's behind the wall for the shading, and draws the same frame", async () => {
    const cube = box("cube");
    const at = (x: number, y: number, z: number) => composeModelMatrix([x, y, z], [20, 30, 0], [0.5, 0.5, 0.5]);
    const instances = [
      { mesh: wall(), model: composeModelMatrix([0, 0, 0], [0, 0, 0], [1, 1, 1]) },
      // In front of the wall: seen.
      ...[-2, 0, 2].map((x) => ({ mesh: cube, model: at(x, 0, 2) })),
      // Behind it: hidden.
      ...[-2, -1, 0, 1, 2].map((x) => ({ mesh: cube, model: at(x, 0.5, -3) })),
      // Behind it, but past its edge on screen: seen.
      { mesh: cube, model: at(5.5, 0, -3) },
      // Off screen.
      ...[-50, 50].flatMap((x) => [{ mesh: cube, model: at(x, 0, 0) }, { mesh: cube, model: at(0, x, 0) }]),
    ] as unknown as MeshSceneInstance[];
    const draw = { width: W, height: H, view: viewMatrix([0, 0, 10], [0, 0, 0]), projection: projectionMatrix(Math.PI / 3, 1, 0.1, 50), environment: null, lights: [], ambient: 0.3, lightDirection: [0.3, 1, 0.6], prepass: true } as any;

    const plainRenderer = (await WebgpuSceneRenderer.create(device, W, H, rasterStyleFor(MODELS.aaa.renderCaps), { hdr: true, mips: true }))!;
    const plain = (await readLinearTexture(device, plainRenderer.renderToTexture(instances, draw), W, H, settled)).data;
    // A renderer's second frame differs a little from its first (what it carries between frames), so each frame is
    // held to the unculled renderer's frame of the same number.
    const plainSecond = (await readLinearTexture(device, plainRenderer.renderToTexture(instances, draw), W, H, settled)).data;

    const renderer = (await WebgpuSceneRenderer.create(device, W, H, rasterStyleFor(MODELS.aaa.renderCaps), { hdr: true, mips: true }))!;
    const culling = () => (renderer as any).culling;
    // Every round's arguments (the prepass's two, then the shading's): the wall's batch and the cubes'.
    const rounds = async () => {
      const args = new Uint32Array(await readBuffer(culling().args, 3 * 2 * INDIRECT_WORDS * 4));
      return [0, 1, 2].map((round) =>
        [0, 1].map((batch) => {
          const a = (round * 2 + batch) * INDIRECT_WORDS;
          return { indexCount: args[a]!, count: args[a + 1]! };
        }),
      );
    };
    const counts = (r: { indexCount: number; count: number }[][], round: number) => ({ cubes: r[round]!.find((b) => b.indexCount === 36)!.count, walls: r[round]!.find((b) => b.indexCount === 6)!.count });
    // Two frames: the first with no guess from a last one, the second guessing from the first.
    for (const frame of [1, 2]) {
      device.pushErrorScope("validation");
      const culled = (await readLinearTexture(device, renderer.renderToTexture(instances, { ...draw, gpuCull: true }), W, H, settled)).data;
      const error = await settled(device.popErrorScope());
      expect(error).toBeNull();
      expect(culling().twoPhase).toBe(true);
      const r = await rounds();
      if (frame === 1) {
        // No guess: the prepass's first round draws nothing, its second all the frustum keeps (9 cubes and the wall).
        expect(counts(r, 0)).toEqual({ cubes: 0, walls: 0 });
        expect(counts(r, 1)).toEqual({ cubes: 9, walls: 1 });
      } else {
        // Last frame's shading as the guess: the wall and the 4 cubes seen; nothing else gets past their depths.
        expect(counts(r, 0)).toEqual({ cubes: 4, walls: 1 });
        expect(counts(r, 1)).toEqual({ cubes: 0, walls: 0 });
      }
      // The shading: the pyramid of the whole prepass drops the 5 behind the wall.
      expect(counts(r, 2)).toEqual({ cubes: 4, walls: 1 });

      // The frame is the same, less nothing anyone could see.
      const reference = frame === 1 ? plain : plainSecond;
      let worst = 0;
      for (let i = 0; i < reference.length; i += 1) worst = Math.max(worst, Math.abs(reference[i]! - culled[i]!));
      expect(worst).toBeLessThan(1e-5);
    }
    plainRenderer.dispose();
    renderer.dispose();
  });

  it("tests an anti-aliased frame against the farthest of each pixel's samples", async () => {
    const cube = box("cube");
    const at = (x: number, y: number, z: number) => composeModelMatrix([x, y, z], [20, 30, 0], [0.5, 0.5, 0.5]);
    const instances = [
      { mesh: wall(), model: composeModelMatrix([0, 0, 0], [0, 0, 0], [1, 1, 1]) },
      ...[-2, 0, 2].map((x) => ({ mesh: cube, model: at(x, 0, 2) })),
      ...[-2, -1, 0, 1, 2].map((x) => ({ mesh: cube, model: at(x, 0.5, -3) })),
    ] as unknown as MeshSceneInstance[];
    const draw = { width: W, height: H, view: viewMatrix([0, 0, 10], [0, 0, 0]), projection: projectionMatrix(Math.PI / 3, 1, 0.1, 50), environment: null, lights: [], ambient: 0.3, lightDirection: [0.3, 1, 0.6], prepass: true, antialias: true } as any;
    const plainRenderer = (await WebgpuSceneRenderer.create(device, W, H, rasterStyleFor(MODELS.aaa.renderCaps), { hdr: true, mips: true }))!;
    const plain = (await readLinearTexture(device, plainRenderer.renderToTexture(instances, draw), W, H, settled)).data;
    const renderer = (await WebgpuSceneRenderer.create(device, W, H, rasterStyleFor(MODELS.aaa.renderCaps), { hdr: true, mips: true }))!;
    device.pushErrorScope("validation");
    const culled = (await readLinearTexture(device, renderer.renderToTexture(instances, { ...draw, gpuCull: true }), W, H, settled)).data;
    const failure = await settled(device.popErrorScope());
    expect(failure ? String((failure as any).message) : null).toBeNull();
    const culling = (renderer as any).culling;
    // One phase (the pyramid of a multisampled depth is built for the shading alone): the frustum keeps all 8 cubes,
    // the shading's round drops the 5 behind the wall.
    expect(culling.twoPhase).toBe(false);
    const args = new Uint32Array(await readBuffer(culling.args, 3 * 2 * INDIRECT_WORDS * 4));
    const cubes = (round: number) => args[[0, 1].map((b) => (round * 2 + b) * INDIRECT_WORDS).find((a) => args[a] === 36)! + 1];
    expect(cubes(0)).toBe(8);
    expect(cubes(2)).toBe(3);
    let worst = 0;
    for (let i = 0; i < plain.length; i += 1) worst = Math.max(worst, Math.abs(plain[i]! - culled[i]!));
    expect(worst).toBeLessThan(1e-5);
    plainRenderer.dispose();
    renderer.dispose();
  });

  it("picks each copy's LOD level on the GPU as the CPU does, drawing the same frame", async () => {
    const near = box("near");
    // The far level: a flattened box (its own index count tells it apart).
    const far = box("far");
    (far.primitives[0] as any).indices = (far.primitives[0] as any).indices.slice(0, 24);
    const lod = { meshes: [near, far], distances: [12] };
    // Each 1 m box at its distance from the eye (z = 10): the switch at 12.
    // Enough copies (GPU_LOD_MIN_COPIES) that the GPU picks their levels: 40, from 3 to 22.5 m away, all on screen.
    // (None within the crossfade, F6b: 10% either side of the switch, 5.4 to 6.6 m.)
    const distances = Array.from({ length: 48 }, (_, i) => 3 + i * 0.5);
    const instances = distances
      .map((d, i) => ({ mesh: near, lod, model: composeModelMatrix([i % 2 === 0 ? -1 : 1, (i % 5) - 2, 10 - d], [20, 30, 0], [0.5, 0.5, 0.5]) }))
      .filter((inst) => Math.abs(Math.hypot(inst.model[12]!, inst.model[13]!, inst.model[14]! - 10) - 6) > 0.7)
      .slice(0, 40) as unknown as MeshSceneInstance[];
    expect(instances).toHaveLength(40);
    // As lod.ts picks: the distance to the copy's origin over its scale (0.5), against the switch at 12.
    const nearCount = instances.filter((inst) => Math.hypot(inst.model[12]!, inst.model[13]!, inst.model[14]! - 10) / 0.5 < 12).length;
    const draw = { width: W, height: H, view: viewMatrix([0, 0, 10], [0, 0, 0]), projection: projectionMatrix(Math.PI / 3, 1, 0.1, 50), environment: null, lights: [], ambient: 0.3, lightDirection: [0.3, 1, 0.6], prepass: true, lod: true } as any;
    const plainRenderer = (await WebgpuSceneRenderer.create(device, W, H, rasterStyleFor(MODELS.aaa.renderCaps), { hdr: true, mips: true }))!;
    const plain = (await readLinearTexture(device, plainRenderer.renderToTexture(instances, draw), W, H, settled)).data;
    const renderer = (await WebgpuSceneRenderer.create(device, W, H, rasterStyleFor(MODELS.aaa.renderCaps), { hdr: true, mips: true }))!;
    const culled = (await readLinearTexture(device, renderer.renderToTexture(instances, { ...draw, gpuCull: true }), W, H, settled)).data;
    // Two draws, one per level, sharing the 40 copies' records: those near the eye, and those past the switch (the
    // frustum keeps all; with no guess yet, the prepass draws them in its second round).
    const args = new Uint32Array(await readBuffer((renderer as any).culling.args, 3 * 2 * INDIRECT_WORDS * 4));
    const count = (round: number, indexCount: number) => [0, 1].map((b) => (round * 2 + b) * INDIRECT_WORDS).find((a) => args[a] === indexCount)!;
    expect(nearCount).toBeGreaterThan(3);
    expect(nearCount).toBeLessThan(35);
    expect(args[count(1, 36) + 1]).toBe(nearCount);
    expect(args[count(1, 24) + 1]).toBe(40 - nearCount);
    let worst = 0;
    for (let i = 0; i < plain.length; i += 1) worst = Math.max(worst, Math.abs(plain[i]! - culled[i]!));
    expect(worst).toBeLessThan(1e-5);
    plainRenderer.dispose();
    renderer.dispose();
  });

  it("crossfades a copy at its LOD switch, dithering each pixel to one level (F6b)", async () => {
    const red = box("red");
    const blue = box("blue");
    (blue.primitives[0] as any).material = { ...(blue.primitives[0] as any).material, baseColorFactor: [0.1, 0.2, 0.9, 1] };
    (red.primitives[0] as any).material = { ...(red.primitives[0] as any).material, baseColorFactor: [0.9, 0.1, 0.1, 1] };
    const lod = { meshes: [red, blue], distances: [8] };
    // 36 copies on a ring 8 m from the eye: each exactly at the switch, halfway through its crossfade.
    const eye: [number, number, number] = [0, 0, 10];
    const instances = Array.from({ length: 36 }, (_, i) => {
      const a = (i / 36) * Math.PI * 2;
      const dir = [Math.cos(a) * 0.35, Math.sin(a) * 0.35, -1];
      const l = Math.hypot(...dir);
      return { mesh: red, lod, model: composeModelMatrix([eye[0] + (dir[0]! / l) * 8, eye[1] + (dir[1]! / l) * 8, eye[2] + (dir[2]! / l) * 8], [0, 0, 0], [1, 1, 1]) };
    }) as unknown as MeshSceneInstance[];
    const draw = { width: W, height: H, view: viewMatrix(eye, [0, 0, 0]), projection: projectionMatrix(Math.PI / 3, 1, 0.1, 50), environment: null, lights: [], ambient: 1, lightDirection: [0.3, 1, 0.6], prepass: true, lod: true } as any;
    const renderer = (await WebgpuSceneRenderer.create(device, W, H, rasterStyleFor(MODELS.aaa.renderCaps), { hdr: true, mips: true }))!;
    const frame = (await readLinearTexture(device, renderer.renderToTexture(instances, { ...draw, gpuCull: true }), W, H, settled)).data;
    // Every copy is drawn in both levels.
    const args = new Uint32Array(await readBuffer((renderer as any).culling.args, 3 * 2 * INDIRECT_WORDS * 4));
    expect([args[2 * 2 * INDIRECT_WORDS + 1], args[(2 * 2 + 1) * INDIRECT_WORDS + 1]]).toEqual([36, 36]);
    // Each covered pixel is one level's colour, about half of them each; the boxes cover what they cover drawn plainly.
    const plain = (await readLinearTexture(device, (await WebgpuSceneRenderer.create(device, W, H, rasterStyleFor(MODELS.aaa.renderCaps), { hdr: true, mips: true }))!.renderToTexture(instances.map((i) => ({ ...i, lod: undefined })) as unknown as MeshSceneInstance[], draw), W, H, settled)).data;
    let reds = 0, blues = 0, covered = 0, plainCovered = 0;
    for (let p = 0; p < W * H; p += 1) {
      const [r, g, b, a] = [frame[p * 4]!, frame[p * 4 + 1]!, frame[p * 4 + 2]!, frame[p * 4 + 3]!];
      if (plain[p * 4 + 3]! > 0.5) plainCovered += 1;
      if (a < 0.5) continue;
      covered += 1;
      if (r > b) reds += 1;
      else blues += 1;
      expect(g).toBeLessThan(Math.max(r, b));
    }
    expect(covered).toBe(plainCovered);
    expect(reds / covered).toBeGreaterThan(0.35);
    expect(blues / covered).toBeGreaterThan(0.35);
    renderer.dispose();
  });

  it("culls the sun's casters per cascade, drawing the same shadowed frame", async () => {
    const SUN: [number, number, number] = [0.3, 1, 0.2];
    const floor = wall();
    const ground = { mesh: floor, model: composeModelMatrix([0, 0, 0], [-90, 0, 0], [3, 3, 3]) };
    const cube = box("caster");
    // Six cubes over the floor, in view; six far off past every cascade, which cast nothing anyone sees.
    const near = [-3, -1.5, 0, 1.5, 3, 4.5].map((x) => ({ mesh: cube, model: composeModelMatrix([x, 1.5, -1], [10, 20, 0], [0.6, 0.6, 0.6]) }));
    const far = [0, 1, 2, 3, 4, 5].map((k) => ({ mesh: cube, model: composeModelMatrix([400 + k * 3, 1.5, -400], [0, 0, 0], [0.6, 0.6, 0.6]) }));
    const instances = [ground, ...near, ...far] as unknown as MeshSceneInstance[];
    const draw = {
      width: W,
      height: H,
      view: viewMatrix([0, 7, 9], [0, 0, 0]),
      projection: projectionMatrix(Math.PI / 3, 1, 0.1, 60),
      environment: null,
      ambient: 0.1,
      lightDirection: SUN,
      lights: [{ kind: "directional", direction: SUN, color: [1, 1, 1], intensity: 1 }],
      sunShadow: { casters: instances, toLight: SUN, distance: 30, size: 1024, reach: 20 },
      prepass: true,
    } as any;
    const plainRenderer = (await WebgpuSceneRenderer.create(device, W, H, rasterStyleFor(MODELS.aaa.renderCaps), { hdr: true, mips: true }))!;
    const plain = (await readLinearTexture(device, plainRenderer.renderToTexture(instances, draw), W, H, settled)).data;
    const renderer = (await WebgpuSceneRenderer.create(device, W, H, rasterStyleFor(MODELS.aaa.renderCaps), { hdr: true, mips: true }))!;
    device.pushErrorScope("validation");
    const culled = (await readLinearTexture(device, renderer.renderToTexture(instances, { ...draw, gpuCull: true }), W, H, settled)).data;
    const failure = await settled(device.popErrorScope());
    expect(failure ? String((failure as any).message) : null).toBeNull();
    // The casters' batches: the floor's, and the cubes' (12 copies); in every cascade the far six are gone.
    const cull = (renderer as any).casterCulling;
    expect(cull).toBeTruthy();
    const cascades = cull.frame.cascades as number;
    const batches = cull.frame.batches as number;
    const args = new Uint32Array(await readBuffer(cull.args, cascades * batches * INDIRECT_WORDS * 4));
    let cubesDrawn = 0;
    for (let c = 0; c < cascades; c += 1) {
      for (let b = 0; b < batches; b += 1) {
        const a = (c * batches + b) * INDIRECT_WORDS;
        if (args[a] === 36) {
          expect(args[a + 1]).toBeLessThanOrEqual(6);
          cubesDrawn += args[a + 1]!;
        }
      }
    }
    expect(cubesDrawn).toBeGreaterThan(0);
    // The shadows are the ones drawn from every caster.
    let worst = 0;
    for (let i = 0; i < plain.length; i += 1) worst = Math.max(worst, Math.abs(plain[i]! - culled[i]!));
    expect(worst).toBeLessThan(1e-5);
    plainRenderer.dispose();
    renderer.dispose();
  });

  it("keeps every copy of a batch whose vertices move on the GPU", async () => {
    const renderer = (await WebgpuSceneRenderer.create(device, W, H, rasterStyleFor(MODELS.aaa.renderCaps), { hdr: true, mips: true }))!;
    const live = box("live");
    (live.primitives[0] as any).dynamic = { revision: 0 };
    const instances = [-50, 0, 50].map((x) => ({ mesh: live, model: composeModelMatrix([x, 0, 0], [0, 0, 0], [1, 1, 1]) })) as unknown as MeshSceneInstance[];
    const draw = { width: W, height: H, view: viewMatrix([0, 0, 10], [0, 0, 0]), projection: projectionMatrix(Math.PI / 3, 1, 0.1, 50), environment: null, lights: [], ambient: 0.3, prepass: true, gpuCull: true } as any;
    await readLinearTexture(device, renderer.renderToTexture(instances, draw), W, H, settled);
    // Drawn whole: in the prepass's first round and the shading's, and not again in the prepass's second.
    const args = new Uint32Array(await readBuffer((renderer as any).culling.args, 3 * INDIRECT_WORDS * 4));
    expect(args[1]).toBe(3);
    expect(args[INDIRECT_WORDS + 1]).toBe(0);
    expect(args[2 * INDIRECT_WORDS + 1]).toBe(3);
    renderer.dispose();
  });
});
