/**
 * GPU skinning and morph targets (AAA_FIDELITY_ROADMAP.md F7a): morphs blended
 * and packed per vertex, corrective shapes driven by a joint's turn, dual
 * quaternions keeping a twist's volume, targets through serialization and
 * glTF (sparse accessors included), and, on a real device (Dawn), the compute
 * pass writing what the CPU skins.
 */

import { describe, expect, it } from "vitest";

import {
  applyMorphs,
  correctiveWeights,
  createLiveSkinnedMesh,
  deserializeMeshAsset,
  dualQuaternions,
  encodeGlb,
  jointTurn,
  jointTurnFromMatrices,
  morphCsr,
  parseGlb,
  parseGltfText,
  restPose,
  serializeMeshAsset,
  skinMatrices,
  skinVertices,
  skinVerticesDq,
  composeModelMatrix,
  projectionMatrix,
  viewMatrix,
  type MeshAsset,
  type MeshSceneInstance,
  type MorphTarget,
} from "@cartbox/editor";
import { MODELS, WebgpuSceneRenderer, rasterStyleFor } from "@cartbox/player";

import { skinnedArmGltf } from "./helpers/skinnedGltf";

const s = Math.SQRT1_2;

/** The arm (helpers/skinnedGltf.ts) with two targets on its strip: one pushing the top out in z, one a corrective on the elbow. */
function morphingArm(): MeshAsset {
  const mesh = parseGltfText(skinnedArmGltf(1), "arm");
  const strip = mesh.primitives[0]!;
  const n = strip.positions.length / 3;
  const bulge = new Float32Array(n * 3);
  bulge[9 * 3 + 2] = 0.5; // the top-right corner, out along z
  const crease = new Float32Array(n * 3);
  crease[5 * 3] = -0.05; // the elbow's right vertex, in
  const targets: MorphTarget[] = [
    { name: "bulge", positions: bulge },
    { name: "crease", positions: crease, driver: { joint: 1, angles: [0, Math.PI / 2] } },
  ];
  return { ...mesh, primitives: [{ ...strip, morphTargets: targets }, ...mesh.primitives.slice(1)], morphWeights: [1, 0] };
}

/** The bend clip's pose at the end: the elbow turned 90° about z. */
function bentPose(mesh: MeshAsset): Float32Array {
  const pose = restPose(mesh.skin!);
  pose.set([0, 0, s, s], 1 * 10 + 3);
  return pose;
}

describe("morph targets", () => {
  it("blends targets over the bind shape, renormalising normals", () => {
    const positions = Float32Array.from([0, 0, 0, 1, 0, 0]);
    const normals = Float32Array.from([0, 0, 1, 0, 0, 1]);
    const targets: MorphTarget[] = [
      { name: "a", positions: Float32Array.from([0, 1, 0, 0, 0, 0]), normals: Float32Array.from([1, 0, 0, 0, 0, 0]) },
      { name: "b", positions: Float32Array.from([0, 0, 0, 0, 2, 0]) },
    ];
    const p = new Float32Array(6);
    const nn = new Float32Array(6);
    applyMorphs(positions, normals, targets, [0.5, 0.25], p, nn);
    expect([...p]).toEqual([0, 0.5, 0, 1, 0.5, 0]);
    // Renormalised: (0.5, 0, 1) / |·|.
    expect(nn[0]).toBeCloseTo(0.5 / Math.sqrt(1.25), 6);
    expect(nn[2]).toBeCloseTo(1 / Math.sqrt(1.25), 6);
    expect([...nn.subarray(3)]).toEqual([0, 0, 1]);
  });

  it("packs only the deltas that move each vertex", () => {
    const targets: MorphTarget[] = [
      { name: "a", positions: Float32Array.from([0, 1, 0, 0, 0, 0, 0, 0, 0]) },
      { name: "b", positions: Float32Array.from([0, 0, 3, 0, 0, 0, 0, 0, 0]), normals: Float32Array.from([0, 0, 0, 0, 0, 0, 1, 0, 0]) },
    ];
    const { starts, entries } = morphCsr(targets, 3);
    expect([...starts]).toEqual([0, 2, 2, 3]);
    expect([...entries]).toEqual([0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 3, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]);
  });

  it("drives a corrective from its joint's turn, by the pose or by the matrices alone", () => {
    const mesh = morphingArm();
    const skin = mesh.skin!;
    const targets = mesh.primitives[0]!.morphTargets!;
    const rest = restPose(skin);
    expect(jointTurn(skin, rest, 1)).toBeCloseTo(0, 6);
    const bent = bentPose(mesh);
    expect(jointTurn(skin, bent, 1)).toBeCloseTo(Math.PI / 2, 5);
    expect(jointTurnFromMatrices(skin, skinMatrices(skin, bent), 1)).toBeCloseTo(Math.PI / 2, 4);
    expect(jointTurnFromMatrices(skin, skinMatrices(skin, rest), 1)).toBeCloseTo(0, 4);
    // Undriven targets keep the mesh's weight; the corrective eases from 0 to 1.
    expect([...correctiveWeights(skin, rest, targets, [1, 0])]).toEqual([1, 0]);
    expect(correctiveWeights(skin, bent, targets, [1, 0])[1]).toBeCloseTo(1, 4);
    const half = restPose(skin);
    half.set([0, 0, Math.sin(Math.PI / 8), Math.cos(Math.PI / 8)], 13);
    expect(correctiveWeights(skin, half, targets, [1, 0])[1]).toBeCloseTo(0.5, 4);
    expect(correctiveWeights(skin, null, targets, [1, 0], skinMatrices(skin, half))[1]).toBeCloseTo(0.5, 3);
  });

  it("morphs then skins a live copy", () => {
    const mesh = morphingArm();
    const live = createLiveSkinnedMesh(mesh);
    live.update(skinMatrices(mesh.skin!, restPose(mesh.skin!)));
    const at = (v: number) => [...live.mesh.primitives[0]!.positions.subarray(v * 3, v * 3 + 3)].map((x) => Math.round(x * 1e4) / 1e4 + 0);
    expect(at(9)).toEqual([0.1, 2, 0.5]); // the bulge, unbent
    expect(at(5)).toEqual([0.1, 1, 0]); // the crease, off at rest
    const bent = bentPose(mesh);
    live.update(skinMatrices(mesh.skin!, bent), { pose: bent, morphWeights: [0, 0] });
    // Bent 90° about the elbow (0, 1): the top corner (0.1, 2) goes to (-1, 1.1); the crease pulled the elbow's vertex in.
    expect(at(9)).toEqual([-1, 1.1, 0]);
    expect(at(5)[0]).toBeCloseTo(0.05, 4);
  });
});

describe("dual-quaternion skinning", () => {
  const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const twist = [-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1]; // 180° about y

  it("matches linear blending for a rigid joint", () => {
    const matrices = Float32Array.from([...identity, 0, -1, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 2, 3, 4, 1]); // 90° about z, moved
    const joints = Uint16Array.from([1, 0, 0, 0]);
    const weights = Float32Array.from([1, 0, 0, 0]);
    const bind = Float32Array.from([1, 2, 3]);
    const lbs = new Float32Array(3);
    const dq = new Float32Array(3);
    skinVertices(joints, weights, matrices, bind, null, lbs, null);
    skinVerticesDq(joints, weights, dualQuaternions(matrices), bind, null, dq, null);
    for (let k = 0; k < 3; k += 1) expect(dq[k]).toBeCloseTo(lbs[k]!, 5);
  });

  it("keeps a half-twisted vertex's distance from the bone where linear blending collapses it", () => {
    const matrices = Float32Array.from([...identity, ...twist]);
    const joints = Uint16Array.from([0, 1, 0, 0]);
    const weights = Float32Array.from([0.5, 0.5, 0, 0]);
    const bind = Float32Array.from([1, 0, 0]);
    const lbs = new Float32Array(3);
    const dq = new Float32Array(3);
    skinVertices(joints, weights, matrices, bind, null, lbs, null);
    skinVerticesDq(joints, weights, dualQuaternions(matrices), bind, null, dq, null);
    expect(Math.hypot(lbs[0]!, lbs[2]!)).toBeCloseTo(0, 5); // the candy wrapper
    expect(Math.hypot(dq[0]!, dq[2]!)).toBeCloseTo(1, 5); // turned 90°, still a metre out
  });

  it("is what a mesh asking for it skins with", () => {
    const mesh = { ...parseGltfText(skinnedArmGltf(1), "arm"), dualQuaternion: true };
    const live = createLiveSkinnedMesh(mesh);
    live.update(skinMatrices(mesh.skin!, bentPose(mesh)));
    const p = live.mesh.primitives[0]!.positions;
    expect(p[9 * 3]).toBeCloseTo(-1, 4);
    expect(p[9 * 3 + 1]).toBeCloseTo(1.1, 4);
  });
});

describe("targets in files", () => {
  it("serializes targets, drivers, weights and the skinning method", () => {
    const mesh = { ...morphingArm(), dualQuaternion: true };
    const back = deserializeMeshAsset(serializeMeshAsset(mesh));
    const targets = back.primitives[0]!.morphTargets!;
    expect(targets.map((t) => t.name)).toEqual(["bulge", "crease"]);
    expect([...targets[0]!.positions]).toEqual([...mesh.primitives[0]!.morphTargets![0]!.positions]);
    expect(targets[1]!.driver).toEqual({ joint: 1, angles: [0, Math.PI / 2] });
    expect(back.morphWeights).toEqual([1, 0]);
    expect(back.dualQuaternion).toBe(true);
  });

  it("round-trips targets and weights through glTF", () => {
    const mesh = morphingArm();
    const back = parseGlb(encodeGlb(mesh), "arm");
    const targets = back.primitives[0]!.morphTargets!;
    expect(targets.map((t) => t.name)).toEqual(["bulge", "crease"]);
    for (let k = 0; k < targets[0]!.positions.length; k += 1) expect(targets[0]!.positions[k]).toBeCloseTo(mesh.primitives[0]!.morphTargets![0]!.positions[k]!, 6);
    expect(back.morphWeights).toEqual([1, 0]);
  });

  it("reads a sparse target, scaled by its node", () => {
    const f32 = (v: number[]) => new Uint8Array(new Float32Array(v).buffer);
    const u32 = (v: number[]) => new Uint8Array(new Uint32Array(v).buffer);
    const parts = [f32([0, 0, 0, 1, 0, 0, 0, 1, 0]), u32([2]), f32([0, 0, 1])];
    const bin = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    const views = parts.map((p) => {
      bin.set(p, at);
      const view = { buffer: 0, byteOffset: at, byteLength: p.length };
      at += p.length;
      return view;
    });
    const json = {
      asset: { version: "2.0" },
      scene: 0,
      scenes: [{ nodes: [0] }],
      nodes: [{ mesh: 0, scale: [2, 2, 2] }],
      meshes: [{ weights: [0.5], extras: { targetNames: ["lift"] }, primitives: [{ attributes: { POSITION: 0 }, targets: [{ POSITION: 1 }] }] }],
      accessors: [
        { bufferView: 0, componentType: 5126, count: 3, type: "VEC3", min: [0, 0, 0], max: [1, 1, 0] },
        { componentType: 5126, count: 3, type: "VEC3", sparse: { count: 1, indices: { bufferView: 1, componentType: 5125 }, values: { bufferView: 2 } } },
      ],
      bufferViews: views,
      buffers: [{ byteLength: bin.length, uri: `data:application/octet-stream;base64,${Buffer.from(bin).toString("base64")}` }],
    };
    const mesh = parseGltfText(JSON.stringify(json), "sparse");
    const target = mesh.primitives[0]!.morphTargets![0]!;
    expect(target.name).toBe("lift");
    // Only the third vertex moves, by the node's ×2: a delta is scaled, not normalised.
    expect([...target.positions]).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 2]);
    expect(mesh.morphWeights).toEqual([0.5]);
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

/** A GPU buffer's floats. */
async function readFloats(buffer: any, bytes: number): Promise<Float32Array> {
  const staging = device.createBuffer({ size: bytes, usage: 0x01 | 0x08 }); // MAP_READ | COPY_DST
  const encoder = device.createCommandEncoder();
  encoder.copyBufferToBuffer(buffer, 0, staging, 0, bytes);
  device.queue.submit([encoder.finish()]);
  await settled(staging.mapAsync(1));
  const out = new Float32Array(staging.getMappedRange().slice(0));
  staging.unmap();
  staging.destroy();
  return out;
}

describe.skipIf(!device)("skinning on a real device", { timeout: 300_000 }, () => {
  async function skinned(mesh: MeshAsset, pose: Float32Array, morphWeights?: number[]): Promise<{ gpu: Float32Array; previous: Float32Array; cpu: MeshAsset; renderer: WebgpuSceneRenderer }> {
    const renderer = (await WebgpuSceneRenderer.create(device, 32, 32, rasterStyleFor(MODELS.aaa.renderCaps), { hdr: true, mips: true }))!;
    expect(renderer.gpuSkinning).toBe(true);
    const live = createLiveSkinnedMesh(mesh, { gpu: true });
    const cpu = createLiveSkinnedMesh(mesh);
    const draw = { width: 32, height: 32, view: viewMatrix([0, 1, 5], [0, 1, 0]), projection: projectionMatrix(Math.PI / 3, 1, 0.1, 100), environment: null, lights: [], ambient: 1, lightDirection: [0, -1, 0] } as any;
    const instances = [{ mesh: live.mesh, model: composeModelMatrix([0, 0, 0], [0, 0, 0], [1, 1, 1]), textures: [] }] as unknown as MeshSceneInstance[];
    device.pushErrorScope("validation");
    // A rest frame first, then the pose: the previous buffer holds the rest.
    live.update(skinMatrices(mesh.skin!, restPose(mesh.skin!)));
    renderer.renderToTexture(instances, draw);
    const options = { pose, ...(morphWeights ? { morphWeights } : {}) };
    live.update(skinMatrices(mesh.skin!, pose), options);
    cpu.update(skinMatrices(mesh.skin!, pose), options);
    renderer.renderToTexture(instances, draw);
    await settled(device.queue.onSubmittedWorkDone());
    const error = await settled(device.popErrorScope());
    expect(error ? String((error as any).message ?? error) : null).toBeNull();
    // The CPU's copy stays in the bind pose: the GPU skins it.
    expect([...live.mesh.primitives[0]!.positions]).toEqual([...mesh.primitives[0]!.positions]);
    const gpuPrimitive = (renderer as any).meshes.get(live.mesh)[0];
    const n = mesh.primitives[0]!.positions.length / 3;
    return { gpu: await readFloats(gpuPrimitive.vertexBuffer, n * 64), previous: await readFloats(gpuPrimitive.previousBuffer, n * 64), cpu: cpu.mesh, renderer };
  }

  function expectMatches(gpu: Float32Array, cpu: MeshAsset): void {
    const p = cpu.primitives[0]!;
    for (let v = 0; v < p.positions.length / 3; v += 1) {
      for (let k = 0; k < 3; k += 1) {
        expect(gpu[v * 16 + k]).toBeCloseTo(p.positions[v * 3 + k]!, 4);
        expect(gpu[v * 16 + 3 + k]).toBeCloseTo(p.normals![v * 3 + k]!, 4);
      }
    }
  }

  it("writes the posed, morphed vertices the CPU skins, and keeps the last ones for motion", async () => {
    const mesh = morphingArm();
    const { gpu, previous, cpu, renderer } = await skinned(mesh, bentPose(mesh), [1, 0]);
    expectMatches(gpu, cpu);
    // The bulge rode the bend; the corrective came on with it.
    expect(gpu[9 * 16 + 2]).toBeCloseTo(0.5, 4);
    expect(gpu[5 * 16]).toBeCloseTo(0.05, 4);
    // The previous frame's vertices: the rest pose, the bulge out.
    expect(previous[9 * 16]).toBeCloseTo(0.1, 4);
    expect(previous[9 * 16 + 1]).toBeCloseTo(2, 4);
    // UVs and the rest of the layout untouched.
    expect(gpu[9 * 16 + 6]).toBe(previous[9 * 16 + 6]);
    renderer.dispose();
  });

  it("skins by dual quaternions when the mesh asks", async () => {
    const mesh = { ...morphingArm(), dualQuaternion: true };
    const { gpu, cpu, renderer } = await skinned(mesh, bentPose(mesh), [0, 0]);
    expectMatches(gpu, cpu);
    renderer.dispose();
  });
});
