/**
 * What local, cosmetic bodies land on — ragdolls (H9) and debris (H10): the
 * scene's static, solid bodies, each as an oriented box round its mesh, and
 * the boxes the scene authors for them (`ragdollColliders`).
 */

import type { RagdollBox } from "@cartbox/editor";

import type { MeshScene } from "./meshScene.js";

const transform = (m: ArrayLike<number>, p: readonly number[]): [number, number, number] => [
  m[0]! * p[0]! + m[4]! * p[1]! + m[8]! * p[2]! + m[12]!,
  m[1]! * p[0]! + m[5]! * p[1]! + m[9]! * p[2]! + m[13]!,
  m[2]! * p[0]! + m[6]! * p[1]! + m[10]! * p[2]! + m[14]!,
];

export function sceneColliders(scene: MeshScene): RagdollBox[] {
  const boxes: RagdollBox[] = [...(scene.ragdollColliders ?? [])];
  for (const inst of scene.instances) {
    if (inst.physics?.body !== "static" || inst.physics.trigger || inst.pooled) continue;
    const lo = [Infinity, Infinity, Infinity];
    const hi = [-Infinity, -Infinity, -Infinity];
    for (const prim of inst.mesh.primitives)
      for (let i = 0; i < prim.positions.length; i += 3)
        for (let k = 0; k < 3; k += 1) {
          lo[k] = Math.min(lo[k]!, prim.positions[i + k]!);
          hi[k] = Math.max(hi[k]!, prim.positions[i + k]!);
        }
    if (!(lo[0]! <= hi[0]!)) continue;
    const m = inst.model;
    const centre = transform(m, [(lo[0]! + hi[0]!) / 2, (lo[1]! + hi[1]!) / 2, (lo[2]! + hi[2]!) / 2]);
    const cols = [0, 1, 2].map((c) => [m[c * 4]!, m[c * 4 + 1]!, m[c * 4 + 2]!] as const);
    const lens = cols.map((c) => Math.hypot(c[0], c[1], c[2]) || 1);
    const axes = cols.map((c, i) => [c[0] / lens[i]!, c[1] / lens[i]!, c[2] / lens[i]!] as const);
    boxes.push({
      center: centre,
      half: [((hi[0]! - lo[0]!) / 2) * lens[0]!, ((hi[1]! - lo[1]!) / 2) * lens[1]!, ((hi[2]! - lo[2]!) / 2) * lens[2]!],
      axes: [axes[0]!, axes[1]!, axes[2]!],
    });
  }
  return boxes;
}
