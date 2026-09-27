/**
 * Inverse kinematics on a skeleton pose (ENGINE_ROADMAP.md, Phase 3): adjust an
 * animated pose so a limb reaches a point (feet planted on uneven ground, a hand
 * on a ledge) or a joint turns toward one (a head following the player, a torso
 * aiming a gun).
 *
 * Both work in the mesh's own space on a pose from skeleton.ts (10 floats per
 * joint: translation, rotation quaternion, scale), rewriting only rotations, so
 * they layer on top of whatever clip or blend produced the pose.
 *
 * - {@link solveTwoBoneIK}: the chain end → its parent → grandparent (foot, knee,
 *   hip) solved analytically. The middle joint bends toward a pole point, or keeps
 *   its current bend plane without one; out of reach, the limb points straight at
 *   the target. `weight` blends from the animated pose (0) to the solve (1).
 * - {@link solveLookAt}: turns a joint so the direction it faces the way the mesh
 *   faces (+Z, glTF's "front") at rest now points at the target, by at most
 *   `maxAngle`.
 */

import { POSE_STRIDE, jointWorldMatrices, restPose, type MeshSkin } from "./skeleton";

type V3 = [number, number, number];
type Q = [number, number, number, number];

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a: V3) => Math.sqrt(dot(a, a));
const norm = (a: V3): V3 => {
  const l = len(a);
  return l > 1e-12 ? scale(a, 1 / l) : [0, 0, 0];
};

const qmul = (a: Q, b: Q): Q => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
];
const qconj = (q: Q): Q => [-q[0], -q[1], -q[2], q[3]];
const qnorm = (q: Q): Q => {
  const l = Math.sqrt(q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3]) || 1;
  return [q[0] / l, q[1] / l, q[2] / l, q[3] / l];
};
function qrot(q: Q, v: V3): V3 {
  const r = qmul(qmul(q, [v[0], v[1], v[2], 0]), qconj(q));
  return [r[0], r[1], r[2]];
}

/** The rotation taking unit vector a onto unit vector b. */
function qFromTo(a: V3, b: V3): Q {
  const d = dot(a, b);
  if (d < -0.999999) {
    // Opposite: half a turn about any axis perpendicular to a.
    let axis = cross([1, 0, 0], a);
    if (len(axis) < 1e-6) axis = cross([0, 1, 0], a);
    const n = norm(axis);
    return [n[0], n[1], n[2], 0];
  }
  const c = cross(a, b);
  return qnorm([c[0], c[1], c[2], 1 + d]);
}

/** Normalized-lerp between rotations a and b by w (the short way). */
function qnlerp(a: Q, b: Q, w: number): Q {
  const s = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3] < 0 ? -1 : 1;
  return qnorm([a[0] * (1 - w) + b[0] * s * w, a[1] * (1 - w) + b[1] * s * w, a[2] * (1 - w) + b[2] * s * w, a[3] * (1 - w) + b[3] * s * w]);
}

/** The rotation q scaled to `w` of its angle (the short way), exactly. */
function qweight(q: Q, w: number): Q {
  if (w >= 1) return q;
  const sign = q[3] < 0 ? -1 : 1;
  const cw = Math.min(1, q[3] * sign);
  const angle = 2 * Math.acos(cw);
  const s = Math.sqrt(Math.max(0, 1 - cw * cw));
  if (s < 1e-9) return [0, 0, 0, 1];
  const k = Math.sin((angle * w) / 2) / s;
  return [q[0] * sign * k, q[1] * sign * k, q[2] * sign * k, Math.cos((angle * w) / 2)];
}

/** The same rotation, limited to at most `max` radians. */
function qclamp(q: Q, max: number): Q {
  const angle = 2 * Math.acos(Math.min(1, Math.abs(q[3])));
  return angle > max && angle > 1e-9 ? qweight(q, max / angle) : q;
}

/** A column-major matrix's rotation (its columns normalized). */
function matRotation(m: ArrayLike<number>, o = 0): Q {
  const c0 = norm([m[o]!, m[o + 1]!, m[o + 2]!]);
  const c1 = norm([m[o + 4]!, m[o + 5]!, m[o + 6]!]);
  const c2 = norm([m[o + 8]!, m[o + 9]!, m[o + 10]!]);
  const [r00, r10, r20] = c0;
  const [r01, r11, r21] = c1;
  const [r02, r12, r22] = c2;
  const trace = r00 + r11 + r22;
  let x: number, y: number, z: number, w: number;
  if (trace > 0) {
    const s = Math.sqrt(trace + 1) * 2;
    w = s / 4; x = (r21 - r12) / s; y = (r02 - r20) / s; z = (r10 - r01) / s;
  } else if (r00 > r11 && r00 > r22) {
    const s = Math.sqrt(1 + r00 - r11 - r22) * 2;
    w = (r21 - r12) / s; x = s / 4; y = (r01 + r10) / s; z = (r02 + r20) / s;
  } else if (r11 > r22) {
    const s = Math.sqrt(1 + r11 - r00 - r22) * 2;
    w = (r02 - r20) / s; x = (r01 + r10) / s; y = s / 4; z = (r12 + r21) / s;
  } else {
    const s = Math.sqrt(1 + r22 - r00 - r11) * 2;
    w = (r10 - r01) / s; x = (r02 + r20) / s; y = (r12 + r21) / s; z = s / 4;
  }
  return qnorm([x, y, z, w]);
}

const position = (world: Float64Array, j: number): V3 => [world[j * 16 + 12]!, world[j * 16 + 13]!, world[j * 16 + 14]!];

/** The world rotation of joint j's parent (its base for a root; identity without one). */
function parentRotation(skin: MeshSkin, world: Float64Array, j: number): Q {
  const joint = skin.joints[j]!;
  if (joint.parent >= 0) return matRotation(world, joint.parent * 16);
  return joint.base && joint.base.length === 16 ? matRotation(joint.base) : [0, 0, 0, 1];
}

/** Set joint j's local rotation so its world rotation becomes `worldRot`. */
function setWorldRotation(skin: MeshSkin, pose: Float32Array, world: Float64Array, j: number, worldRot: Q): void {
  const local = qnorm(qmul(qconj(parentRotation(skin, world, j)), worldRot));
  pose.set(local, j * POSE_STRIDE + 3);
}

/** A joint's position in mesh space for a pose. */
export function jointPosition(skin: MeshSkin, pose: Float32Array, joint: number): V3 {
  return position(jointWorldMatrices(skin, pose), joint);
}

/**
 * Bend the chain ending at `end` (its parent the middle joint, its grandparent
 * the root) so `end` reaches `target` (mesh space), rewriting the root's and
 * middle joint's rotations in `pose`. Returns false when `end` has no grandparent.
 */
export function solveTwoBoneIK(
  skin: MeshSkin,
  pose: Float32Array,
  end: number,
  target: readonly [number, number, number],
  pole: readonly [number, number, number] | null = null,
  weight = 1,
): boolean {
  const mid = skin.joints[end]?.parent ?? -1;
  const root = mid >= 0 ? skin.joints[mid]!.parent : -1;
  if (root < 0 || weight <= 0) return false;
  const w = Math.min(1, weight);
  let world = jointWorldMatrices(skin, pose);
  const pa = position(world, root);
  const pb = position(world, mid);
  const pc = position(world, end);
  const l1 = len(sub(pb, pa));
  const l2 = len(sub(pc, pb));
  if (l1 < 1e-9 || l2 < 1e-9) return false;
  const toTarget = sub([target[0], target[1], target[2]], pa);
  const reach = len(toTarget);
  if (reach < 1e-9) return false;
  const u = scale(toTarget, 1 / reach);
  const d = Math.max(Math.abs(l1 - l2) + 1e-6, Math.min(l1 + l2 - 1e-6, reach));
  // The bend plane: toward the pole, else the way the middle joint already bends.
  let bend = pole ? sub([pole[0], pole[1], pole[2]], pa) : sub(pb, pa);
  bend = sub(bend, scale(u, dot(bend, u)));
  if (len(bend) < 1e-6) {
    // Straight limb, no hint: bend along any perpendicular (the current child side if possible).
    bend = cross(u, [0, 0, 1]);
    if (len(bend) < 1e-6) bend = cross(u, [1, 0, 0]);
  }
  const v = norm(bend);
  const cosA = Math.max(-1, Math.min(1, (l1 * l1 + d * d - l2 * l2) / (2 * l1 * d)));
  const sinA = Math.sqrt(Math.max(0, 1 - cosA * cosA));
  const pbGoal = add(pa, add(scale(u, l1 * cosA), scale(v, l1 * sinA)));
  const pcGoal = add(pa, scale(u, d));

  // Solve fully on a copy, then blend each joint's local rotation by the weight.
  const solved = w < 1 ? pose.slice() : pose;
  // Root: turn so the middle joint lands on its goal.
  const turnRoot = qFromTo(norm(sub(pb, pa)), norm(sub(pbGoal, pa)));
  setWorldRotation(skin, solved, world, root, qmul(turnRoot, matRotation(world, root * 16)));
  // Middle: turn so the end lands on its goal.
  world = jointWorldMatrices(skin, solved);
  const pb2 = position(world, mid);
  const pc2 = position(world, end);
  const turnMid = qFromTo(norm(sub(pc2, pb2)), norm(sub(pcGoal, pb2)));
  setWorldRotation(skin, solved, world, mid, qmul(turnMid, matRotation(world, mid * 16)));
  if (w < 1) {
    for (const j of [root, mid]) {
      const o = j * POSE_STRIDE + 3;
      const from: Q = [pose[o]!, pose[o + 1]!, pose[o + 2]!, pose[o + 3]!];
      const to: Q = [solved[o]!, solved[o + 1]!, solved[o + 2]!, solved[o + 3]!];
      pose.set(qnlerp(from, to, w), o);
    }
  }
  return true;
}

const restForward = new WeakMap<MeshSkin, Map<number, V3>>();

/** The axis, in joint j's own frame, that points the mesh's way (+Z) at rest. */
function forwardAxis(skin: MeshSkin, j: number): V3 {
  let byJoint = restForward.get(skin);
  if (!byJoint) {
    byJoint = new Map();
    restForward.set(skin, byJoint);
  }
  let axis = byJoint.get(j);
  if (!axis) {
    const world = jointWorldMatrices(skin, restPose(skin));
    axis = norm(qrot(qconj(matRotation(world, j * 16)), [0, 0, 1]));
    byJoint.set(j, axis);
  }
  return axis;
}

/**
 * Turn `joint` toward `target` (mesh space): the direction it faced the mesh's
 * front in at rest swings to point at the target, by at most `maxAngle` radians,
 * blended by `weight`.
 */
export function solveLookAt(
  skin: MeshSkin,
  pose: Float32Array,
  joint: number,
  target: readonly [number, number, number],
  weight = 1,
  maxAngle = Math.PI / 3,
): boolean {
  if (joint < 0 || joint >= skin.joints.length || weight <= 0) return false;
  const world = jointWorldMatrices(skin, pose);
  const rot = matRotation(world, joint * 16);
  const facing = norm(qrot(rot, forwardAxis(skin, joint)));
  const aim = norm(sub([target[0], target[1], target[2]], position(world, joint)));
  if (len(aim) < 1e-9 || len(facing) < 1e-9) return false;
  const turn = qweight(qclamp(qFromTo(facing, aim), Math.max(0, maxAngle)), Math.min(1, weight));
  setWorldRotation(skin, pose, world, joint, qmul(turn, rot));
  return true;
}
