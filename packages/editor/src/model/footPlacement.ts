/**
 * Full-body IK with foot placement (AAA_FIDELITY_ROADMAP.md F7e): an animated
 * pose fitted to the ground it stands on, and FABRIK for chains longer than
 * two bones (a spine reaching, a tail).
 *
 * - **Foot placement.** Each foot's ground is found below it (a caller's
 *   height and normal at a point, in the mesh's space). The pelvis drops by
 *   the most any foot must reach down (so the lower foot can touch without
 *   the leg straightening), each leg then solves two-bone IK to put its foot
 *   on its ground at the height the animation held it above flat ground, and
 *   each foot turns to lie along its ground's slope. A foot the animation
 *   lifts (a stride) keeps its lift over the ground.
 * - **FABRIK** (Aristidou & Lasenby 2011): a chain's joints moved backward
 *   from the target and forward from the root until the end reaches, then the
 *   joints turned to point along the new bones.
 */

import { solveTwoBoneIK } from "./ik";
import { POSE_STRIDE, jointWorldMatrices, type MeshSkin } from "./skeleton";

type V3 = [number, number, number];
type Q = [number, number, number, number];

const qmul = (a: Q, b: Q): Q => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
];
const qconj = (q: Q): Q => [-q[0], -q[1], -q[2], q[3]];
function fromTo(a: V3, b: V3): Q {
  const d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  if (d < -0.999999) {
    const axis: V3 = Math.abs(a[0]) < 0.9 ? [0, -a[2], a[1]] : [a[2], 0, -a[0]];
    const l = Math.hypot(...axis);
    return [axis[0] / l, axis[1] / l, axis[2] / l, 0];
  }
  const q: Q = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0], 1 + d];
  const l = Math.hypot(...q);
  return [q[0] / l, q[1] / l, q[2] / l, q[3] / l];
}
function matrixQuat(m: ArrayLike<number>, o: number): Q {
  const sx = Math.hypot(m[o]!, m[o + 1]!, m[o + 2]!) || 1;
  const sy = Math.hypot(m[o + 4]!, m[o + 5]!, m[o + 6]!) || 1;
  const sz = Math.hypot(m[o + 8]!, m[o + 9]!, m[o + 10]!) || 1;
  const r00 = m[o]! / sx, r10 = m[o + 1]! / sx, r20 = m[o + 2]! / sx;
  const r01 = m[o + 4]! / sy, r11 = m[o + 5]! / sy, r21 = m[o + 6]! / sy;
  const r02 = m[o + 8]! / sz, r12 = m[o + 9]! / sz, r22 = m[o + 10]! / sz;
  const tr = r00 + r11 + r22;
  if (tr > 0) {
    const s = Math.sqrt(tr + 1) * 2;
    return [(r21 - r12) / s, (r02 - r20) / s, (r10 - r01) / s, s / 4];
  }
  if (r00 > r11 && r00 > r22) {
    const s = Math.sqrt(1 + r00 - r11 - r22) * 2;
    return [s / 4, (r01 + r10) / s, (r02 + r20) / s, (r21 - r12) / s];
  }
  if (r11 > r22) {
    const s = Math.sqrt(1 + r11 - r00 - r22) * 2;
    return [(r01 + r10) / s, s / 4, (r12 + r21) / s, (r02 - r20) / s];
  }
  const s = Math.sqrt(1 + r22 - r00 - r11) * 2;
  return [(r02 + r20) / s, (r12 + r21) / s, s / 4, (r10 - r01) / s];
}
const at = (world: Float64Array, j: number): V3 => [world[j * 16 + 12]!, world[j * 16 + 13]!, world[j * 16 + 14]!];

/** Turn joint `j` (in `pose`) by a world-space rotation `turn`, keeping its parent. */
export function turnJoint(pose: Float32Array, world: Float64Array, j: number, turn: Q): void {
  const p = j * POSE_STRIDE + 3;
  const local: Q = [pose[p]!, pose[p + 1]!, pose[p + 2]!, pose[p + 3]!];
  const parent = qmul(matrixQuat(world, j * 16), qconj(local));
  const turned = qmul(qmul(qmul(qconj(parent), turn), parent), local);
  const l = Math.hypot(...turned) || 1;
  pose.set([turned[0] / l, turned[1] / l, turned[2] / l, turned[3] / l], p);
}

/** The ground under a point: its height and normal (mesh space), or null where there is none. */
export type GroundQuery = (x: number, z: number) => { readonly height: number; readonly normal: readonly [number, number, number] } | null;

/** A leg for foot placement: its foot joint (the ankle; its parent the knee, its grandparent the hip), and how high the ankle sits over flat ground at rest. */
export interface Leg {
  readonly foot: number;
  readonly ankleHeight: number;
}

/** What foot placement did: how far the pelvis dropped, and where each foot went. */
export interface FootPlacement {
  readonly pelvisDrop: number;
  readonly feet: readonly V3[];
}

/**
 * Fit a pose's feet to the ground (rewrites `pose`): see the module comment.
 * `pelvis` is the joint whose translation drops; `ground` answers in the
 * mesh's space, where the animation's flat ground is y = 0. `maxDrop` caps
 * how far the pelvis goes down (a ledge too deep is left to the animation).
 */
export function placeFeet(skin: MeshSkin, pose: Float32Array, pelvis: number, legs: readonly Leg[], ground: GroundQuery, weight = 1, maxDrop = 0.5): FootPlacement {
  let world = jointWorldMatrices(skin, pose);
  // Each foot's target: its ground plus the height the animation holds it above flat ground.
  const plans = legs.map((leg) => {
    const ankle = at(world, leg.foot);
    const hit = ground(ankle[0], ankle[2]);
    if (!hit) return null;
    const lift = Math.max(0, ankle[1] - leg.ankleHeight);
    const target: V3 = [ankle[0], hit.height + leg.ankleHeight + lift, ankle[2]];
    return { leg, ankle, target, normal: hit.normal };
  });
  // The pelvis drops by the most any foot must reach down (never rises: the legs straighten up to their length).
  let drop = 0;
  for (const p of plans) if (p) drop = Math.max(drop, p.ankle[1] - p.target[1]);
  drop = Math.min(maxDrop, drop) * weight;
  if (drop > 0) {
    // In the pelvis's parent's frame, its translation is local; a root joint's (with no parent) is the mesh's.
    const parent = skin.joints[pelvis]?.parent ?? -1;
    let down: V3 = [0, -drop, 0];
    if (parent >= 0) {
      const inv = qconj(matrixQuat(world, parent * 16));
      const r = qmul(qmul(inv, [down[0], down[1], down[2], 0]), qconj(inv));
      const sy = Math.hypot(world[parent * 16 + 4]!, world[parent * 16 + 5]!, world[parent * 16 + 6]!) || 1;
      down = [r[0] / sy, r[1] / sy, r[2] / sy];
    }
    const o = pelvis * POSE_STRIDE;
    pose[o] = pose[o]! + down[0];
    pose[o + 1] = pose[o + 1]! + down[1];
    pose[o + 2] = pose[o + 2]! + down[2];
  }
  const feet: V3[] = [];
  for (const p of plans) {
    if (!p) continue;
    world = jointWorldMatrices(skin, pose);
    const now = at(world, p.leg.foot);
    const target: V3 = [now[0] + (p.target[0] - now[0]) * weight, now[1] + (p.target[1] - now[1]) * weight, now[2] + (p.target[2] - now[2]) * weight];
    solveTwoBoneIK(skin, pose, p.leg.foot, target, null, 1);
    // The foot along its ground: up turned to the ground's normal.
    world = jointWorldMatrices(skin, pose);
    const n = p.normal;
    const l = Math.hypot(n[0], n[1], n[2]) || 1;
    const tilt = fromTo([0, 1, 0], [n[0] / l, n[1] / l, n[2] / l]);
    const partial: Q = [tilt[0] * weight, tilt[1] * weight, tilt[2] * weight, 1 - weight + tilt[3] * weight];
    const pl = Math.hypot(...partial) || 1;
    turnJoint(pose, world, p.leg.foot, [partial[0] / pl, partial[1] / pl, partial[2] / pl, partial[3] / pl]);
    feet.push(at(jointWorldMatrices(skin, pose), p.leg.foot));
  }
  return { pelvisDrop: drop, feet };
}

/**
 * FABRIK: bend the chain `joints` (root first, each the next's parent) so its
 * last joint reaches `target` (mesh space), rewriting the chain's rotations.
 * Returns the distance left to the target.
 */
export function solveFabrik(skin: MeshSkin, pose: Float32Array, joints: readonly number[], target: readonly [number, number, number], iterations = 12, tolerance = 1e-4): number {
  if (joints.length < 2) return Infinity;
  let world = jointWorldMatrices(skin, pose);
  const p = joints.map((j) => at(world, j));
  const lengths = p.slice(1).map((q, i) => Math.hypot(q[0] - p[i]![0], q[1] - p[i]![1], q[2] - p[i]![2]));
  const total = lengths.reduce((a, b) => a + b, 0);
  const root: V3 = [...p[0]!];
  const goal: V3 = [target[0], target[1], target[2]];
  const toward = (from: V3, to: V3, length: number): V3 => {
    const d: V3 = [to[0] - from[0], to[1] - from[1], to[2] - from[2]];
    const l = Math.hypot(...d) || 1;
    return [from[0] + (d[0] / l) * length, from[1] + (d[1] / l) * length, from[2] + (d[2] / l) * length];
  };
  if (Math.hypot(goal[0] - root[0], goal[1] - root[1], goal[2] - root[2]) >= total) {
    // Out of reach: straight at it.
    for (let i = 1; i < p.length; i += 1) p[i] = toward(p[i - 1]!, goal, lengths[i - 1]!);
  } else {
    for (let it = 0; it < iterations; it += 1) {
      p[p.length - 1] = [...goal];
      for (let i = p.length - 2; i >= 0; i -= 1) p[i] = toward(p[i + 1]!, p[i]!, lengths[i]!);
      p[0] = [...root];
      for (let i = 1; i < p.length; i += 1) p[i] = toward(p[i - 1]!, p[i]!, lengths[i - 1]!);
      const end = p[p.length - 1]!;
      if (Math.hypot(end[0] - goal[0], end[1] - goal[1], end[2] - goal[2]) < tolerance) break;
    }
  }
  // Turn each joint so its bone points at the solved next joint.
  for (let i = 0; i + 1 < joints.length; i += 1) {
    world = jointWorldMatrices(skin, pose);
    const head = at(world, joints[i]!);
    const tail = at(world, joints[i + 1]!);
    const from: V3 = [tail[0] - head[0], tail[1] - head[1], tail[2] - head[2]];
    const to: V3 = [p[i + 1]![0] - head[0], p[i + 1]![1] - head[1], p[i + 1]![2] - head[2]];
    const fl = Math.hypot(...from) || 1;
    const tl = Math.hypot(...to) || 1;
    turnJoint(pose, world, joints[i]!, fromTo([from[0] / fl, from[1] / fl, from[2] / fl], [to[0] / tl, to[1] / tl, to[2] / tl]));
  }
  const end = at(jointWorldMatrices(skin, pose), joints[joints.length - 1]!);
  return Math.hypot(end[0] - goal[0], end[1] - goal[1], end[2] - goal[2]);
}
