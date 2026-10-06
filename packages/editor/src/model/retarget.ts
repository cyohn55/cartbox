/**
 * Retargeting (ENGINE_PARITY_ROADMAP.md EP17b): playing one skeleton's clips
 * on another, matching joints by name.
 *
 * - **Joints** match by name, ignoring case and the prefixes rigging tools add
 *   ("mixamorig:", "Armature|", "Bip01 " …); joints with no match are left
 *   at rest.
 * - **Rotations** carry the source's motion *relative to its rest pose* onto
 *   the target's rest: q = restTarget · restSource⁻¹ · qSource. Skeletons that
 *   rest in different poses (an A-pose and a T-pose) still move alike.
 * - **The root's translation** (the hips walking, jumping) is carried as its
 *   offset from rest, scaled by the ratio of the two skeletons' heights, so a
 *   short character's stride is shorter. Other joints' translations and all
 *   scale keys are dropped: bones keep the target's proportions.
 *
 * Pure: clips and skeletons in, a new clip out.
 */

import type { AnimationClip, ClipChannel, MeshSkin, SkinJoint } from "./skeleton";

type Quat = [number, number, number, number];

const mul = (a: ArrayLike<number>, b: ArrayLike<number>): Quat => [
  a[3]! * b[0]! + a[0]! * b[3]! + a[1]! * b[2]! - a[2]! * b[1]!,
  a[3]! * b[1]! - a[0]! * b[2]! + a[1]! * b[3]! + a[2]! * b[0]!,
  a[3]! * b[2]! + a[0]! * b[1]! - a[1]! * b[0]! + a[2]! * b[3]!,
  a[3]! * b[3]! - a[0]! * b[0]! - a[1]! * b[1]! - a[2]! * b[2]!,
];
const inverse = (q: ArrayLike<number>): Quat => {
  const n = q[0]! * q[0]! + q[1]! * q[1]! + q[2]! * q[2]! + q[3]! * q[3]! || 1;
  return [-q[0]! / n, -q[1]! / n, -q[2]! / n, q[3]! / n];
};

/** A joint name reduced for matching: lower case, rig prefixes and separators gone. */
export function jointKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/^.*[:|]/, "")
    .replace(/^(bip0?1|mixamorig|armature|def|rig|ctrl)[\s_.-]*/, "")
    .replace(/[\s_.-]+/g, "");
}

/** Target joint index for each source joint (-1 where nothing matches). */
export function matchJoints(source: readonly SkinJoint[], target: readonly SkinJoint[]): number[] {
  const byKey = new Map<string, number>();
  target.forEach((j, i) => {
    const k = jointKey(j.name);
    if (!byKey.has(k)) byKey.set(k, i);
  });
  return source.map((j) => byKey.get(jointKey(j.name)) ?? -1);
}

/** A skeleton's height at rest: the spread of its joints' rest positions on Y (1 when flat). */
function restHeight(joints: readonly SkinJoint[]): number {
  const world: [number, number, number][] = [];
  joints.forEach((j, i) => {
    const p = j.parent >= 0 && j.parent < i ? world[j.parent]! : ([0, 0, 0] as [number, number, number]);
    // Rest rotations are ignored here: a height estimate, not a pose.
    world.push([p[0] + j.translation[0], p[1] + j.translation[1], p[2] + j.translation[2]]);
  });
  if (world.length === 0) return 1;
  const ys = world.map((w) => w[1]);
  const h = Math.max(...ys) - Math.min(...ys);
  return h > 1e-6 ? h : 1;
}

/** The source clip retargeted onto the target skeleton (null when no joints match). */
export function retargetClip(clip: AnimationClip, source: MeshSkin, target: MeshSkin, name = clip.name): AnimationClip | null {
  const map = matchJoints(source.joints, target.joints);
  if (!map.some((m) => m >= 0)) return null;
  const scale = restHeight(target.joints) / restHeight(source.joints);
  const channels: ClipChannel[] = [];
  for (const c of clip.channels) {
    const to = map[c.joint] ?? -1;
    if (to < 0) continue;
    const from = source.joints[c.joint]!;
    const dest = target.joints[to]!;
    if (c.path === "rotation") {
      const fix = mul(dest.rotation, inverse(from.rotation));
      const values = new Float32Array(c.values.length);
      for (let k = 0; k < c.values.length; k += 4) {
        const q = mul(fix, c.values.subarray(k, k + 4));
        const n = Math.hypot(...q) || 1;
        values.set(q.map((v) => v / n), k);
      }
      channels.push({ ...c, joint: to, times: c.times.slice(), values });
    } else if (c.path === "translation" && from.parent < 0 && dest.parent < 0) {
      const values = new Float32Array(c.values.length);
      for (let k = 0; k < c.values.length; k += 3) {
        for (let d = 0; d < 3; d += 1) values[k + d] = dest.translation[d]! + (c.values[k + d]! - from.translation[d]!) * scale;
      }
      channels.push({ ...c, joint: to, times: c.times.slice(), values });
    }
  }
  return { name, duration: clip.duration, channels };
}
