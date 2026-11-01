/**
 * Cloth and secondary motion (AAA_FIDELITY_ROADMAP.md F7d): position-based
 * cloth pinned to the skin and pushed by the wind and the body's capsules,
 * spring bones trailing a moving skeleton, both through the mesh format and a
 * live skinned copy, and on a real device (Dawn) the GPU's cloth against the CPU's.
 */

import { describe, expect, it } from "vitest";

import {
  bodyCapsules,
  clothFromHeight,
  clothState,
  clothTopology,
  composeModelMatrix,
  createLiveSkinnedMesh,
  deserializeMeshAsset,
  parseGltfText,
  projectionMatrix,
  pushOutOfCapsule,
  restPose,
  serializeMeshAsset,
  skinMatrices,
  stepCloth,
  stepSpringBones,
  viewMatrix,
  type ClothSettings,
  type MeshAsset,
  type MeshPrimitive,
  type MeshSceneInstance,
  type SpringState,
} from "@cartbox/editor";
import { MODELS, WebgpuSceneRenderer, rasterStyleFor } from "@cartbox/player";

import { skinnedArmGltf } from "./helpers/skinnedGltf";

/** A sheet `n`×`n` vertices, `size` metres a side, hanging in x-y with its top edge at y = `top`. */
function sheet(n: number, size: number, top = 1): Pick<MeshPrimitive, "positions" | "normals" | "uvs" | "indices"> {
  const positions: number[] = [];
  const uvs: number[] = [];
  const normals: number[] = [];
  for (let r = 0; r < n; r += 1)
    for (let c = 0; c < n; c += 1) {
      positions.push((c / (n - 1) - 0.5) * size, top - (r / (n - 1)) * size, 0);
      uvs.push(c / (n - 1), 1 - r / (n - 1));
      normals.push(0, 0, 1);
    }
  const indices: number[] = [];
  for (let r = 0; r + 1 < n; r += 1)
    for (let c = 0; c + 1 < n; c += 1) {
      const a = r * n + c;
      indices.push(a, a + n, a + 1, a + 1, a + n, a + n + 1);
    }
  return { positions: Float32Array.from(positions), normals: Float32Array.from(normals), uvs: Float32Array.from(uvs), indices: Uint32Array.from(indices) };
}

/** The greatest stretch of any edge over its rest length. */
function worstStretch(topology: ReturnType<typeof clothTopology>, p: Float32Array): number {
  let worst = 0;
  for (let i = 0; i < topology.count; i += 1)
    for (let e = topology.starts[i]!; e < topology.starts[i + 1]!; e += 1) {
      if (topology.entries[e * 4 + 2]! > 0.5) continue;
      const j = topology.entries[e * 4]!;
      const d = Math.hypot(p[j * 3]! - p[i * 3]!, p[j * 3 + 1]! - p[i * 3 + 1]!, p[j * 3 + 2]! - p[i * 3 + 2]!);
      worst = Math.max(worst, d / topology.entries[e * 4 + 1]! - 1);
    }
  return worst;
}

describe("cloth", () => {
  it("links a sheet's edges and, across each pair of triangles, its bends", () => {
    const s = sheet(3, 1);
    const t = clothTopology(s.positions, s.indices, { maxDistance: new Float32Array(9).fill(1) });
    // 3×3: 12 sides and 4 diagonals are edges; each of the 8 inner edges joins two triangles, whose far corners make a bend.
    let edges = 0;
    let bends = 0;
    for (let e = 0; e < t.starts[9]!; e += 1) {
      if (t.entries[e * 4 + 2]! > 0.5) bends += 1;
      else edges += 1;
    }
    expect(edges / 2).toBe(16);
    expect(bends / 2).toBe(8);
  });

  it("pushes a point out of a capsule", () => {
    const capsule = { a: [0, 0, 0] as const, b: [0, 1, 0] as const, radius: 0.1 };
    expect(pushOutOfCapsule([0.05, 0.5, 0], capsule, 0)).toEqual([0.1, 0.5, 0]);
    expect(pushOutOfCapsule([0.5, 0.5, 0], capsule, 0)).toEqual([0.5, 0.5, 0]);
    const below = pushOutOfCapsule([0, -0.05, 0], capsule, 0.01);
    expect(below[1]).toBeCloseTo(-0.11);
  });

  it("authors its distances by height", () => {
    const d = clothFromHeight(sheet(5, 1), 0.1, 0.5, 0.3);
    expect(d[0]).toBe(0);
    expect(d[2 * 5]).toBeCloseTo(0.3 * ((0.5 - 0.1) / 0.5));
    expect(d[4 * 5]).toBeCloseTo(0.3);
  });

  it("hangs from its pinned edge, falls, and holds its length", () => {
    const s = sheet(8, 1);
    const settings: ClothSettings = { maxDistance: clothFromHeight(s, 0.01, 0.2, 5) };
    const topology = clothTopology(s.positions, s.indices, settings);
    // Lay it out flat, toward the viewer, so it swings down.
    const flat = Float32Array.from(s.positions, (v, i) => (i % 3 === 1 ? 1 : i % 3 === 2 ? 1 - s.positions[i - 1]! : v));
    const state = clothState(flat);
    for (let i = 0; i < 120; i += 1) stepCloth(topology, settings, state, { skinned: flat, normals: null, capsules: [], wind: [0, 0, 0], dt: 1 / 60 });
    // The pinned row stays; the hem has swung down, near the sheet's length below.
    expect(state.position[1]).toBe(1);
    const hem = state.position[(7 * 8 + 3) * 3 + 1]!;
    expect(hem).toBeLessThan(0.3);
    expect(worstStretch(topology, state.position)).toBeLessThan(0.08);
  });

  it("keeps within its distance of the skin, out of the body, and goes with the wind", () => {
    const s = sheet(6, 1);
    const reach = 0.1;
    const settings: ClothSettings = { maxDistance: clothFromHeight(s, 0.01, 0.01, reach) };
    const topology = clothTopology(s.positions, s.indices, settings);
    const capsule = { a: [0, 0.2, -0.1] as const, b: [0, 0.8, -0.1] as const, radius: 0.12 };
    const state = clothState(s.positions);
    for (let i = 0; i < 90; i += 1) stepCloth(topology, settings, state, { skinned: s.positions, normals: s.normals!, capsules: [capsule], wind: [0, 0, 6], dt: 1 / 60 });
    let farthest = 0;
    let inside = false;
    let pushed = 0;
    for (let v = 6; v < 36; v += 1) {
      const p: [number, number, number] = [state.position[v * 3]!, state.position[v * 3 + 1]!, state.position[v * 3 + 2]!];
      farthest = Math.max(farthest, Math.hypot(p[0] - s.positions[v * 3]!, p[1] - s.positions[v * 3 + 1]!, p[2] - s.positions[v * 3 + 2]!));
      const q = pushOutOfCapsule(p, capsule, 0);
      inside ||= q[0] !== p[0] || q[1] !== p[1] || q[2] !== p[2];
      pushed += p[2];
    }
    expect(farthest).toBeLessThanOrEqual(reach + 1e-5);
    expect(inside).toBe(false);
    // Blown forward (+z), off the capsule behind it.
    expect(pushed / 30).toBeGreaterThan(0.03);
  });
});

/** The arm (helpers/skinnedGltf.ts) with a cape: a sheet bound wholly to the root, its top row pinned, and a spring chain up the arm. */
function capedArm(): MeshAsset {
  const arm = parseGltfText(skinnedArmGltf(1), "arm");
  const s = sheet(6, 0.8, 0.9);
  const n = s.positions.length / 3;
  // Behind the arm, so the capsules don't push it.
  const positions = Float32Array.from(s.positions, (v, i) => (i % 3 === 2 ? -0.3 : v));
  const cape: MeshPrimitive = {
    ...s,
    positions,
    joints: new Uint16Array(n * 4),
    weights: Float32Array.from({ length: n * 4 }, (_, i) => (i % 4 === 0 ? 1 : 0)),
    material: { name: "cape", baseColorFactor: [0.6, 0.1, 0.1, 1], baseColorImage: null },
    cloth: { maxDistance: clothFromHeight({ positions }, 0.01, 0.4, 0.6) },
  } as MeshPrimitive;
  return { ...arm, primitives: [...arm.primitives, cape], springs: [{ joints: [0, 1], stiffness: 4 }] };
}

/** The arm's pose with its root moved along x. */
function shifted(mesh: MeshAsset, x: number): Float32Array {
  const pose = restPose(mesh.skin!);
  pose[0] = x;
  return pose;
}

describe("secondary motion on a skeleton", () => {
  it("puts a capsule along each bone, sized by its radius", () => {
    const mesh = capedArm();
    const capsules = bodyCapsules(mesh.skin!, skinMatrices(mesh.skin!, restPose(mesh.skin!)), [0.1, 0.05]);
    expect(capsules).toHaveLength(1);
    expect(capsules[0]!.a.map((v) => Math.round(v * 1e4) / 1e4 + 0)).toEqual([0, 0, 0]);
    expect(capsules[0]!.b.map((v) => Math.round(v * 1e4) / 1e4 + 0)).toEqual([0, 1, 0]);
    expect(capsules[0]!.radius).toBe(0.1);
    // Moved with the skeleton.
    expect(bodyCapsules(mesh.skin!, skinMatrices(mesh.skin!, shifted(mesh, 2)), [0.1])[0]!.a[0]).toBeCloseTo(2);
  });

  it("trails a spring chain behind a moving skeleton, then lets it settle back", () => {
    const mesh = capedArm();
    const state: SpringState = { tails: [], previous: [] };
    const chains = [{ joints: [0, 1], stiffness: 6, gravity: 0 }];
    const elbowX = (pose: Float32Array) => {
      // The elbow's world x: the root's rotation turns its +y offset.
      const q = pose.subarray(3, 7);
      return pose[0]! + 2 * (q[0]! * q[1]! - q[3]! * q[2]!);
    };
    let pose = shifted(mesh, 0);
    stepSpringBones(mesh.skin!, pose, chains, state, 1 / 60);
    // Snap the root along +x: the chain lags, its tip behind (−x of the root).
    for (let i = 0; i < 3; i += 1) {
      pose = shifted(mesh, 0.5);
      stepSpringBones(mesh.skin!, pose, chains, state, 1 / 60);
    }
    expect(elbowX(pose)).toBeLessThan(0.5 - 0.05);
    for (let i = 0; i < 240; i += 1) {
      pose = shifted(mesh, 0.5);
      stepSpringBones(mesh.skin!, pose, chains, state, 1 / 60);
    }
    expect(elbowX(pose)).toBeCloseTo(0.5, 2);
  });

  it("stores cloth and spring chains in the mesh format", () => {
    const mesh = capedArm();
    const back = deserializeMeshAsset(serializeMeshAsset(mesh));
    expect([...back.primitives[2]!.cloth!.maxDistance]).toEqual([...mesh.primitives[2]!.cloth!.maxDistance]);
    expect(back.springs).toEqual([{ joints: [0, 1], stiffness: 4 }]);
  });

  it("swings a live copy's cape when the skeleton moves, its collar held", () => {
    const mesh = capedArm();
    const live = createLiveSkinnedMesh(mesh);
    const cape = () => live.mesh.primitives[2]!.positions;
    for (let i = 0; i < 30; i += 1) live.update(skinMatrices(mesh.skin!, shifted(mesh, 0)));
    const restHem = cape()[(5 * 6 + 2) * 3]!;
    for (let i = 0; i < 4; i += 1) live.update(skinMatrices(mesh.skin!, shifted(mesh, 0.3)));
    // The collar went with the root; the hem lags behind it.
    expect(cape()[2 * 3]! - mesh.primitives[2]!.positions[2 * 3]!).toBeCloseTo(0.3, 4);
    expect(cape()[(5 * 6 + 2) * 3]! - restHem).toBeLessThan(0.25);
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

async function readFloats(buffer: any, bytes: number): Promise<Float32Array> {
  const staging = device.createBuffer({ size: bytes, usage: 0x01 | 0x08 });
  const encoder = device.createCommandEncoder();
  encoder.copyBufferToBuffer(buffer, 0, staging, 0, bytes);
  device.queue.submit([encoder.finish()]);
  await settled(staging.mapAsync(1));
  const out = new Float32Array(staging.getMappedRange().slice(0));
  staging.unmap();
  staging.destroy();
  return out;
}

describe.skipIf(!device)("cloth on a real device", { timeout: 300_000 }, () => {
  it("simulates the cape on the GPU as the CPU does", async () => {
    const mesh = capedArm();
    const renderer = (await WebgpuSceneRenderer.create(device, 32, 32, rasterStyleFor(MODELS.aaa.renderCaps), { hdr: true, mips: true }))!;
    const gpu = createLiveSkinnedMesh(mesh, { gpu: true });
    const cpu = createLiveSkinnedMesh(mesh);
    const draw = { width: 32, height: 32, view: viewMatrix([0, 0.5, 4], [0, 0.5, 0]), projection: projectionMatrix(Math.PI / 3, 1, 0.1, 100), environment: null, lights: [], ambient: 1, lightDirection: [0, -1, 0] } as any;
    const instances = [{ mesh: gpu.mesh, model: composeModelMatrix([0, 0, 0], [0, 0, 0], [1, 1, 1]), textures: [] }] as unknown as MeshSceneInstance[];
    device.pushErrorScope("validation");
    for (let i = 0; i < 20; i += 1) {
      const matrices = skinMatrices(mesh.skin!, shifted(mesh, i < 10 ? 0 : 0.3));
      gpu.update(matrices);
      cpu.update(matrices);
      renderer.renderToTexture(instances, draw);
    }
    await settled(device.queue.onSubmittedWorkDone());
    const error = await settled(device.popErrorScope());
    expect(error ? String((error as any).message ?? error) : null).toBeNull();
    const n = mesh.primitives[2]!.positions.length / 3;
    const out = await readFloats((renderer as any).meshes.get(gpu.mesh)[2].vertexBuffer, n * 64);
    const want = cpu.mesh.primitives[2]!.positions;
    let worst = 0;
    for (let v = 0; v < n; v += 1) for (let k = 0; k < 3; k += 1) worst = Math.max(worst, Math.abs(out[v * 16 + k]! - want[v * 3 + k]!));
    // Within millimetres after 20 frames: the GPU sums in f32 where the CPU sums in f64, and 16 sweeps a frame carry it.
    expect(worst).toBeLessThan(5e-3);
    // The hem moved off its skinned place: the cloth ran, not just the skinning.
    expect(Math.abs(out[(5 * 6 + 2) * 16]! - (mesh.primitives[2]!.positions[(5 * 6 + 2) * 3]! + 0.3))).toBeGreaterThan(0.01);
    // Normals unit length.
    expect(Math.hypot(out[3]!, out[4]!, out[5]!)).toBeCloseTo(1, 4);
    renderer.dispose();
  });
});
