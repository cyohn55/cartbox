/**
 * Skeletal meshes (ENGINE_ROADMAP.md, Phase 3): glTF skins and clips import into
 * a mesh's skeleton, survive serialization, and sample, blend and skin into the
 * positions both renderers draw.
 */

import { describe, expect, it } from "vitest";

import {
  blendPoses,
  createLiveSkinnedMesh,
  deserializeMeshAsset,
  findClip,
  isSkinned,
  parseGltfText,
  restPose,
  sampleClip,
  serializeMeshAsset,
  skinMatrices,
  type MeshAsset,
} from "@cartbox/editor";
import { skinnedArmGltf } from "./helpers/skinnedGltf";

/** Vertex `v` of primitive `p` of a mesh, rounded to 1e-4. */
const vertex = (mesh: MeshAsset, p: number, v: number) =>
  [0, 1, 2].map((k) => Math.round(mesh.primitives[p]!.positions[v * 3 + k]! * 1e4) / 1e4 + 0);

/** The mesh posed by `clip` at `time` (held, not looped: t = duration is the last key). */
function posed(mesh: MeshAsset, clip: string, time: number): MeshAsset {
  const live = createLiveSkinnedMesh(mesh);
  live.update(skinMatrices(mesh.skin!, sampleClip(mesh.skin!, mesh.clips![findClip(mesh, clip)]!, time, false)));
  return live.mesh;
}

describe("glTF skin and clip import", () => {
  const mesh = parseGltfText(skinnedArmGltf(2), "arm");

  it("reads the skeleton, the vertex bindings and the joint clips", () => {
    expect(isSkinned(mesh)).toBe(true);
    expect(mesh.skin!.joints.map((j) => [j.name, j.parent])).toEqual([
      ["root", -1],
      ["elbow", 0],
    ]);
    // The root keeps the armature's ×2 above it as its base.
    expect(mesh.skin!.joints[0]!.base![0]).toBeCloseTo(2);
    expect(mesh.clips!.map((c) => [c.name, c.duration])).toEqual([
      ["bend", 1],
      ["wave", 1],
    ]);
    // The armature's own translation channel isn't a joint's: dropped.
    expect(mesh.clips![1]!.channels).toHaveLength(1);
    // Both the strip and the sword are bound (the sword rigidly, to the elbow).
    expect(mesh.primitives.map((p) => Boolean(p.joints))).toEqual([true, true]);
    expect([...mesh.primitives[1]!.joints!.subarray(0, 4)]).toEqual([1, 0, 0, 0]);
  });

  it("stores the rest pose as the still mesh (armature scale included)", () => {
    expect(vertex(mesh, 0, 9)).toEqual([0.2, 4, 0]); // the strip's top-right corner
    expect(vertex(mesh, 1, 0)).toEqual([0, 3, 0]); // the sword's origin, 0.5 m above the elbow
    // Skinning at rest reproduces it exactly.
    const rest = createLiveSkinnedMesh(mesh);
    rest.update(skinMatrices(mesh.skin!, restPose(mesh.skin!)));
    expect(vertex(rest.mesh, 0, 9)).toEqual([0.2, 4, 0]);
    expect(vertex(rest.mesh, 1, 0)).toEqual([0, 3, 0]);
  });

  it("bends the arm: vertices above the elbow and the held sword turn about it", () => {
    const bent = posed(mesh, "bend", 1);
    // The elbow sits at (0, 2, 0); the top corner (0.2, 4) turns 90° about it to (-2, 2.2).
    expect(vertex(bent, 0, 9)).toEqual([-2, 2.2, 0]);
    expect(vertex(bent, 0, 0)).toEqual([-0.2, 0, 0]); // bound to the root: unmoved
    expect(vertex(bent, 1, 0)).toEqual([-1, 2, 0]);
    // Normals turn with it (the strip faced +z; a turn about z keeps that).
    expect(Math.round(bent.primitives[0]!.normals![9 * 3 + 2]! * 1e4) / 1e4).toBe(1);
    // Halfway, 45°.
    const half = posed(mesh, "bend", 0.5);
    const [x, y] = vertex(half, 1, 0);
    expect(x).toBeCloseTo(-Math.SQRT1_2, 3);
    expect(y).toBeCloseTo(2 + Math.SQRT1_2, 3);
  });

  it("loops, holds, and blends poses for crossfades", () => {
    const skin = mesh.skin!;
    const bend = mesh.clips![0]!;
    // Looping wraps 1.25 s to 0.25 s; holding clamps it to the end.
    expect([...sampleClip(skin, bend, 1.25, true)]).toEqual([...sampleClip(skin, bend, 0.25, true)]);
    expect([...sampleClip(skin, bend, 3, false)]).toEqual([...sampleClip(skin, bend, 1, false)]);
    // Half of rest and half of fully bent is a 45° bend.
    const blended = blendPoses(restPose(skin), sampleClip(skin, bend, 1, false), 0.5);
    const live = createLiveSkinnedMesh(mesh);
    live.update(skinMatrices(skin, blended));
    expect(vertex(live.mesh, 1, 0)[0]).toBeCloseTo(-Math.SQRT1_2, 3);
    // The live copy shares everything but positions and normals, and counts revisions.
    expect(live.mesh.primitives[0]!.indices).toBe(mesh.primitives[0]!.indices);
    expect(live.mesh.primitives[0]!.positions).not.toBe(mesh.primitives[0]!.positions);
    expect(live.mesh.primitives[0]!.dynamic!.revision).toBe(1);
  });
});

describe("skinned mesh serialization", () => {
  const mesh = parseGltfText(skinnedArmGltf(1), "arm");

  it("round-trips the skeleton, bindings and clips", () => {
    const back = deserializeMeshAsset(serializeMeshAsset(mesh));
    expect(back.skin!.joints).toEqual(mesh.skin!.joints);
    expect([...back.skin!.inverseBind]).toEqual([...mesh.skin!.inverseBind]);
    expect([...back.primitives[0]!.joints!]).toEqual([...mesh.primitives[0]!.joints!]);
    expect(back.clips!.map((c) => c.name)).toEqual(["bend", "wave"]);
    expect(vertex(posed(back, "wave", 0.5), 0, 9)).toEqual(vertex(posed(mesh, "wave", 0.5), 0, 9));
    // A mesh without a skeleton serializes as before.
    const plain = serializeMeshAsset({ name: "p", primitives: [{ ...mesh.primitives[0]!, joints: null, weights: null }] });
    expect(plain).not.toContain("skin");
  });

  it("rejects bindings to joints that don't exist, and parent loops", () => {
    const raw = JSON.parse(serializeMeshAsset(mesh));
    const badJoint = structuredClone(raw);
    badJoint.skin.joints = badJoint.skin.joints.slice(0, 1);
    badJoint.skin.inverseBind = Buffer.from(new Float32Array(16).buffer).toString("base64");
    expect(() => deserializeMeshAsset(JSON.stringify(badJoint))).toThrow();
    const loop = structuredClone(raw);
    loop.skin.joints[0].parent = 1;
    expect(() => deserializeMeshAsset(JSON.stringify(loop))).toThrow();
    const badClip = structuredClone(raw);
    badClip.clips[0].channels[0].joint = 7;
    expect(() => deserializeMeshAsset(JSON.stringify(badClip))).toThrow();
  });
});
