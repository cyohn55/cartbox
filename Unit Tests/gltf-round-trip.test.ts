/**
 * A rigged round trip with Blender (LOCKOUT_MULTIPLAYER_ROADMAP.md L14): GLB
 * export writes the skin (joints, weights, inverse binds), every clip, the
 * second UV set and the material sets, so a Spartan sent to Blender and brought
 * back comes in rigged and animated — and Lockout's soldier and viewmodels
 * survive the trip unchanged. Blender-shaped files still import as before.
 */

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  LOCKOUT_VIEWMODELS,
  deserializeMeshAsset,
  encodeGlb,
  lockoutMeshSidecar,
  parseGlb,
  parseGltfText,
  readGlb,
  readMeshLibrary,
  resolveMeshRef,
  serializeMeshAsset,
  type GltfJson,
  type MeshAsset,
  type MeshPrimitive,
} from "@cartbox/editor";
import { skinnedArmGltf } from "./helpers/skinnedGltf";

const sidecar = JSON.parse(lockoutMeshSidecar());
const library = readMeshLibrary(sidecar.library);
const lockoutMesh = (id: string): MeshAsset => deserializeMeshAsset(resolveMeshRef(sidecar.meshes.find((m: { id: string }) => m.id === id).mesh, library)!);

/**
 * Everything the trip must keep, in the cart's stored form (so a binding stored
 * compactly — one joint for a part, a byte a vertex — must come back compact):
 * geometry, bindings, skeleton, inverse binds and clips exactly, and the
 * materials and material sets by name. Normals are compared apart, as import
 * renormalises them.
 */
function kept(mesh: MeshAsset): unknown {
  const stored = JSON.parse(serializeMeshAsset({ ...mesh, primitives: mesh.primitives.map((p) => ({ ...p, normals: null })), trails: undefined }));
  return {
    primitives: stored.primitives.map(({ material, ...p }: { material: { name: string } }) => ({ ...p, material: material.name })),
    skin: stored.skin,
    clips: stored.clips,
    variants: stored.variants?.map((v: { name: string; materials: ({ name: string } | null)[] }) => ({ name: v.name, materials: v.materials.map((m) => m?.name ?? null) })),
  };
}

function expectNormalsClose(a: MeshAsset, b: MeshAsset): void {
  a.primitives.forEach((p, i) => {
    const q = b.primitives[i]!;
    if (!p.normals) return expect(q.normals).toBeNull();
    expect(q.normals!.length).toBe(p.normals.length);
    let worst = 0;
    for (let k = 0; k < p.normals.length; k += 1) worst = Math.max(worst, Math.abs(p.normals[k]! - q.normals![k]!));
    expect(worst).toBeLessThan(1e-6);
  });
}

/** Export, re-import, and check nothing the trip carries was lost. */
function roundTrip(mesh: MeshAsset): MeshAsset {
  const back = parseGlb(encodeGlb(mesh), mesh.name);
  expect(kept(back)).toEqual(kept(mesh));
  expectNormalsClose(mesh, back);
  return back;
}

// --- A structural check of the written file, after the glTF 2.0 rules -----

const WIDTH: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };

function validate(glb: Uint8Array): GltfJson {
  const { json, buffers } = readGlb(glb);
  const bin = buffers[0]!;
  const accessors = json.accessors!;
  expect(json.buffers![0]!.byteLength).toBe(bin.byteLength);
  for (const view of json.bufferViews!) {
    expect((view.byteOffset ?? 0) % 4).toBe(0);
    expect((view.byteOffset ?? 0) + view.byteLength).toBeLessThanOrEqual(bin.byteLength);
  }
  const floats = (index: number): Float32Array => {
    const a = accessors[index]!;
    const view = json.bufferViews![a.bufferView!]!;
    expect(a.componentType).toBe(5126);
    expect(view.byteLength).toBe(a.count * WIDTH[a.type]! * 4);
    return new Float32Array(bin.slice(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength).buffer);
  };
  const jointCount = json.skins?.[0]?.joints.length ?? 0;
  for (const mesh of json.meshes!) {
    for (const p of mesh.primitives) {
      const position = accessors[p.attributes.POSITION!]!;
      const count = position.count;
      expect(position.min).toHaveLength(3);
      expect(position.max).toHaveLength(3);
      for (const [name, index] of Object.entries(p.attributes)) {
        expect(accessors[index as number]!.count, name).toBe(count);
      }
      if (p.attributes.JOINTS_0 === undefined) continue;
      const joints = accessors[p.attributes.JOINTS_0]!;
      expect(joints.type).toBe("VEC4");
      expect([5121, 5123]).toContain(joints.componentType);
      const view = json.bufferViews![joints.bufferView!]!;
      const raw = bin.slice(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength);
      const indices = joints.componentType === 5121 ? raw : new Uint16Array(raw.buffer);
      const weights = floats(p.attributes.WEIGHTS_0!);
      for (let v = 0; v < count; v += 1) {
        let total = 0;
        for (let k = 0; k < 4; k += 1) {
          expect(indices[v * 4 + k]!).toBeLessThan(jointCount);
          expect(weights[v * 4 + k]!).toBeGreaterThanOrEqual(0);
          if (weights[v * 4 + k] === 0) expect(indices[v * 4 + k]).toBe(0);
          total += weights[v * 4 + k]!;
        }
        expect(Math.abs(total - 1)).toBeLessThan(1e-6);
      }
    }
  }
  // Every node has at most one parent, and the scene's roots have none.
  const parents = new Map<number, number>();
  json.nodes!.forEach((node, i) => node.children?.forEach((c) => {
    expect(parents.has(c)).toBe(false);
    parents.set(c, i);
  }));
  for (const root of json.scenes![0]!.nodes!) expect(parents.has(root)).toBe(false);
  if (json.skins) {
    const skin = json.skins[0]!;
    expect(accessors[skin.inverseBindMatrices!]!).toMatchObject({ type: "MAT4", count: jointCount });
    // A skinned node's mesh has joints and weights on every primitive.
    for (const node of json.nodes!) {
      if (node.skin === undefined) continue;
      for (const p of json.meshes![node.mesh!]!.primitives) expect(p.attributes.JOINTS_0 !== undefined && p.attributes.WEIGHTS_0 !== undefined).toBe(true);
    }
  }
  for (const animation of json.animations ?? []) {
    expect(animation.channels.length).toBeGreaterThan(0);
    for (const channel of animation.channels) {
      expect(json.skins![0]!.joints).toContain(channel.target.node);
      const sampler = animation.samplers[channel.sampler]!;
      expect(["LINEAR", "STEP"]).toContain(sampler.interpolation);
      const input = accessors[sampler.input]!;
      expect(input.min).toHaveLength(1);
      expect(input.max).toHaveLength(1);
      const times = floats(sampler.input);
      for (let k = 1; k < times.length; k += 1) expect(times[k]!).toBeGreaterThan(times[k - 1]!);
      const width = channel.target.path === "rotation" ? 4 : 3;
      expect(accessors[sampler.output]!.count * WIDTH[accessors[sampler.output]!.type]!).toBe(input.count * width);
    }
  }
  return json;
}

describe("Lockout's Spartan, out to Blender and back", () => {
  const soldier = lockoutMesh("bot-1");

  it("comes back rigged and animated: positions, weights, joints, rest pose, inverse binds and every clip's keys", () => {
    const back = roundTrip(soldier);
    expect(back.skin!.joints.map((j) => j.name)).toEqual(soldier.skin!.joints.map((j) => j.name));
    expect(back.clips!.map((c) => c.name)).toEqual(["idle", "run", "air", "die", "strafeR", "strafeL", "back", "melee", "hit", "land"]);
    expect(back.variants!.map((v) => v.name)).toEqual(["Veteran", "Recon"]);
    // Bound piece by piece, a joint a vertex, it is stored as compactly as before.
    expect(serializeMeshAsset(back).length).toBeLessThanOrEqual(serializeMeshAsset(soldier).length);
  });

  it("writes a well-formed file: the armature as a node tree, the skin, and an animation per clip", () => {
    const glb = encodeGlb(soldier);
    const json = validate(glb);
    const n = soldier.skin!.joints.length;
    expect(json.skins![0]!.joints).toEqual([...Array(n).keys()]);
    expect(json.nodes!.slice(0, n).map((node) => node.name)).toEqual(soldier.skin!.joints.map((j) => j.name));
    expect(json.nodes!.filter((node) => node.skin === 0).map((node) => node.mesh)).toEqual([0]);
    expect(json.animations!.map((a) => a.name)).toEqual(soldier.clips!.map((c) => c.name));
    expect(json.meshes![0]!.primitives.every((p) => json.accessors![p.attributes.JOINTS_0!]!.componentType === 5121)).toBe(true);
    // About 124 KB: geometry, four influences a vertex, and the keys of ten clips.
    expect(glb.byteLength).toBeLessThan(160_000);
  });
});

describe("Lockout's viewmodels, out and back", () => {
  it.each([...LOCKOUT_VIEWMODELS])("the %s keeps its rig, its clips and its parts", (id) => {
    const model = lockoutMesh(`viewmodel-${id}`);
    const back = roundTrip(model);
    validate(encodeGlb(model));
    expect(back.clips!.map((c) => c.name)).toEqual(model.clips!.map((c) => c.name));
    expect(back.primitives.map((p) => p.material.name)).toEqual(model.primitives.map((p) => p.material.name));
  });
});

describe("what the rig carries", () => {
  const arm = parseGltfText(skinnedArmGltf(), "arm");

  /** The arm with a blended vertex, a stepped clip, a second UV set and an unbound part between two bound ones. */
  function dressed(): MeshAsset {
    const [body, sword] = arm.primitives as [MeshPrimitive, MeshPrimitive];
    const weights = body.weights!.slice();
    const joints = body.joints!.slice();
    // The two vertices at the elbow share it with the root.
    for (const v of [4, 5]) {
      joints.set([0, 1, 0, 0], v * 4);
      weights.set([0.25, 0.75, 0, 0], v * 4);
    }
    const count = body.positions.length / 3;
    const uvs2 = Float32Array.from({ length: count * 2 }, (_, i) => (i % 7) / 7);
    const plate: MeshPrimitive = { positions: Float32Array.from([0, 3, 0, 1, 3, 0, 0, 4, 0]), normals: null, uvs: null, indices: Uint32Array.from([0, 1, 2]), material: { name: "plate", baseColorFactor: [1, 1, 1, 1], baseColorImage: null } };
    const clip = arm.clips![0]!;
    return {
      ...arm,
      primitives: [{ ...body, joints, weights, uvs2 }, plate, sword],
      clips: [...arm.clips!, { name: "snap", duration: 1.5, channels: clip.channels.map((c) => ({ ...c, interpolation: "step" as const })) }],
    };
  }

  it("keeps blended weights, stepped keys, a clip held past its last key, the second UV set, and the order of an unbound part", () => {
    const mesh = dressed();
    const back = roundTrip(mesh);
    expect(back.primitives[1]!.joints).toBeUndefined();
    expect(Array.from(back.primitives[0]!.weights!.subarray(16, 20))).toEqual([0.25, 0.75, 0, 0]);
    expect(back.clips![2]).toMatchObject({ name: "snap", duration: 1.5 });
    expect(back.clips![2]!.channels.every((c) => c.interpolation === "step")).toBe(true);
    const json = validate(encodeGlb(mesh));
    // Bound, unbound, bound: three runs, three mesh nodes, the middle one off the skin.
    expect(json.nodes!.filter((n) => n.mesh !== undefined).map((n) => n.skin ?? null)).toEqual([0, null, 0]);
  });

  it("keeps the armature object above the root (Blender's), as its base", () => {
    const scaled = parseGltfText(skinnedArmGltf(2), "arm");
    expect(scaled.skin!.joints[0]!.base).toBeDefined();
    const back = roundTrip(scaled);
    expect(back.skin!.joints[0]!.base).toEqual(scaled.skin!.joints[0]!.base);
    const json = validate(encodeGlb(scaled));
    expect(json.nodes!.find((n) => n.name === "Armature")).toMatchObject({ children: [0] });
  });

  it("normalises weights that don't sum to 1, and gives an unweighted vertex wholly to its first joint", () => {
    const [body] = arm.primitives as [MeshPrimitive];
    const weights = body.weights!.slice();
    const joints = body.joints!.slice();
    joints.set([0, 1, 0, 0], 0);
    weights.set([1, 3, 0, 0], 0);
    joints.set([1, 0, 0, 0], 4);
    weights.set([0, 0, 0, 0], 4);
    const back = parseGlb(encodeGlb({ ...arm, primitives: [{ ...body, joints, weights }] }));
    expect(Array.from(back.primitives[0]!.weights!.subarray(0, 4))).toEqual([0.25, 0.75, 0, 0]);
    expect(Array.from(back.primitives[0]!.joints!.subarray(4, 8))).toEqual([1, 0, 0, 0]);
    expect(Array.from(back.primitives[0]!.weights!.subarray(4, 8))).toEqual([1, 0, 0, 0]);
  });
});

describe("files without a rig, and files from Blender", () => {
  /** A textured, two-set triangle: the shape every unskinned export test uses. */
  const prop: MeshAsset = {
    name: "prop",
    primitives: [
      {
        positions: Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0]),
        normals: Float32Array.from([0, 0, 1, 0, 0, 1, 0, 0, 1]),
        uvs: Float32Array.from([0, 0, 1, 0, 0, 1]),
        indices: Uint32Array.from([0, 1, 2]),
        material: { name: "paint", baseColorFactor: [0.5, 0.25, 0.75, 1], baseColorImage: { mime: "image/png", bytes: Uint8Array.from([137, 80, 78, 71, 1, 2, 3, 4]) }, roughnessFactor: 0.4 },
      },
    ],
    variants: [{ name: "Gold", materials: [{ name: "gold", baseColorFactor: [1, 0.8, 0.3, 1], baseColorImage: null, metallicFactor: 1 }] }],
  };

  it("writes an unskinned mesh exactly as before: one node, no skin, no animations", () => {
    const glb = encodeGlb(prop);
    // Pinned from the encoder before L14: not a byte has moved.
    expect(createHash("sha256").update(glb).digest("hex")).toBe("a590c791295cdcbe69614a2a4d70f013623cfc642cc0bd08167950417535c575");
    const json = validate(glb);
    expect(json.nodes).toEqual([{ mesh: 0 }]);
    expect(json.skins).toBeUndefined();
    expect(json.animations).toBeUndefined();
    roundTrip(prop);
  });

  it("writes a light-mapped mesh's second UV set as TEXCOORD_1, and reads it back", () => {
    const uvs2 = Float32Array.from([0.1, 0.2, 0.3, 0.4, 0.5, 0.6]);
    const mesh: MeshAsset = { ...prop, primitives: [{ ...prop.primitives[0]!, uvs2 }] };
    const json = validate(encodeGlb(mesh));
    expect(json.meshes![0]!.primitives[0]!.attributes.TEXCOORD_1).toBeDefined();
    expect(parseGlb(encodeGlb(mesh)).primitives[0]!.uvs2).toEqual(uvs2);
  });

  it("imports the Blender-shaped arm as before, and round-trips it", () => {
    const arm = parseGltfText(skinnedArmGltf(), "arm");
    expect(arm.skin!.joints.map((j) => [j.name, j.parent])).toEqual([["root", -1], ["elbow", 0]]);
    expect(arm.clips!.map((c) => [c.name, c.duration, c.channels.length])).toEqual([["bend", 1, 1], ["wave", 1, 1]]);
    // The sword parented to the elbow rides it wholly.
    expect(Array.from(arm.primitives[1]!.joints!.subarray(0, 4))).toEqual([1, 0, 0, 0]);
    expect(arm.primitives.every((p) => p.uvs2 === undefined)).toBe(true);
    roundTrip(arm);
  });
});
