/**
 * A skinned "leg" built directly as a mesh for the IK tests: hip at y = 2, knee
 * 1 m below it, foot 1 m below that (all facing +Z at rest), plus a "head" joint
 * on the hip, 0.5 m up. One vertex sits on each joint, bound to it, so skinned
 * positions show where the joints went. No clips: the rest pose is the pose.
 */

import type { MeshAsset, MeshSkin } from "@cartbox/editor";

const translate = (x: number, y: number, z: number) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];

export function skinnedLeg(clips: MeshAsset["clips"] = []): MeshAsset {
  const joint = (name: string, parent: number, y: number) => ({
    name,
    parent,
    translation: [0, y, 0] as [number, number, number],
    rotation: [0, 0, 0, 1] as [number, number, number, number],
    scale: [1, 1, 1] as [number, number, number],
  });
  const skin: MeshSkin = {
    joints: [joint("hip", -1, 2), joint("knee", 0, -1), joint("foot", 1, -1), joint("head", 0, 0.5)],
    // Inverse binds: the rest world transforms are pure translations.
    inverseBind: Float32Array.from([...translate(0, -2, 0), ...translate(0, -1, 0), ...translate(0, 0, 0), ...translate(0, -2.5, 0)]),
  };
  // One vertex per joint (hip, knee, foot, head), plus a nose 0.2 m in front of the head.
  const positions = Float32Array.from([0, 2, 0, 0, 1, 0, 0, 0, 0, 0, 2.5, 0, 0, 2.5, 0.2]);
  return {
    name: "leg",
    primitives: [
      {
        positions,
        normals: null,
        uvs: null,
        indices: Uint32Array.from([0, 1, 2, 2, 3, 4]),
        material: { name: "m", baseColorFactor: [1, 1, 1, 1], baseColorImage: null },
        joints: Uint16Array.from([0, 0, 0, 0, 1, 0, 0, 0, 2, 0, 0, 0, 3, 0, 0, 0, 3, 0, 0, 0]),
        weights: Float32Array.from([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]),
      },
    ],
    skin,
    ...(clips && clips.length > 0 ? { clips } : {}),
  };
}
