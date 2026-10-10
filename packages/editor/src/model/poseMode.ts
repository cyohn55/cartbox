/**
 * Pose mode (LOCKOUT_MULTIPLAYER_ROADMAP.md L16): the skeleton drawn over the
 * mesh, a bone picked by clicking it, and bones turned — about the world's
 * axes (as the gizmo drags them) or their own (as the panel's angles set
 * them). A pose here is skeleton.ts's: every joint's local translation,
 * rotation quaternion and scale, which the dope sheet keys onto a clip.
 *
 * A bone is drawn from a joint to each of its children: turning the joint
 * swings that bone (and everything below it). Pure and DOM-free.
 */

import { jointWorldMatrices, POSE_STRIDE, type MeshSkin } from "./skeleton";
import { projectPoint } from "./meshModel";

type Vec3 = [number, number, number];
export type Quat = [number, number, number, number];

// --- Quaternions (x, y, z, w) ----------------------------------------------------

export function quatMultiply(a: readonly number[], b: readonly number[]): Quat {
  const [ax, ay, az, aw] = [a[0]!, a[1]!, a[2]!, a[3]!];
  const [bx, by, bz, bw] = [b[0]!, b[1]!, b[2]!, b[3]!];
  return [aw * bx + ax * bw + ay * bz - az * by, aw * by - ax * bz + ay * bw + az * bx, aw * bz + ax * by - ay * bx + az * bw, aw * bw - ax * bx - ay * by - az * bz];
}

export function quatNormalize(q: readonly number[]): Quat {
  const l = Math.hypot(q[0]!, q[1]!, q[2]!, q[3]!) || 1;
  return [q[0]! / l, q[1]! / l, q[2]! / l, q[3]! / l];
}

export const quatConjugate = (q: readonly number[]): Quat => [-q[0]!, -q[1]!, -q[2]!, q[3]!];

/** A turn of `angle` radians about a unit axis. */
export function quatAxisAngle(axis: readonly number[], angle: number): Quat {
  const l = Math.hypot(axis[0]!, axis[1]!, axis[2]!) || 1;
  const s = Math.sin(angle / 2) / l;
  return [axis[0]! * s, axis[1]! * s, axis[2]! * s, Math.cos(angle / 2)];
}

/** The rotation of a column-major 4×4's upper 3×3 (its columns' scale removed). */
export function quatFromMatrix(m: ArrayLike<number>, o = 0): Quat {
  const col = (c: number): Vec3 => {
    const v: Vec3 = [m[o + c * 4]!, m[o + c * 4 + 1]!, m[o + c * 4 + 2]!];
    const l = Math.hypot(...v) || 1;
    return [v[0] / l, v[1] / l, v[2] / l];
  };
  const [x, y, z] = [col(0), col(1), col(2)];
  // Row r, column c of the rotation: column c's r-th component.
  const m00 = x[0], m10 = x[1], m20 = x[2], m01 = y[0], m11 = y[1], m21 = y[2], m02 = z[0], m12 = z[1], m22 = z[2];
  const trace = m00 + m11 + m22;
  let q: Quat;
  if (trace > 0) {
    const s = 0.5 / Math.sqrt(trace + 1);
    q = [(m21 - m12) * s, (m02 - m20) * s, (m10 - m01) * s, 0.25 / s];
  } else if (m00 > m11 && m00 > m22) {
    const s = 2 * Math.sqrt(1 + m00 - m11 - m22);
    q = [0.25 * s, (m01 + m10) / s, (m02 + m20) / s, (m21 - m12) / s];
  } else if (m11 > m22) {
    const s = 2 * Math.sqrt(1 + m11 - m00 - m22);
    q = [(m01 + m10) / s, 0.25 * s, (m12 + m21) / s, (m02 - m20) / s];
  } else {
    const s = 2 * Math.sqrt(1 + m22 - m00 - m11);
    q = [(m02 + m20) / s, (m12 + m21) / s, 0.25 * s, (m10 - m01) / s];
  }
  return quatNormalize(q);
}

/** Euler angles (radians, X then Y then Z, as three.js's "XYZ") from a quaternion. */
export function quatToEuler(q: readonly number[]): Vec3 {
  const [x, y, z, w] = quatNormalize(q);
  const m11 = 1 - 2 * (y * y + z * z), m12 = 2 * (x * y - z * w), m13 = 2 * (x * z + y * w);
  const m22 = 1 - 2 * (x * x + z * z), m23 = 2 * (y * z - x * w);
  const m32 = 2 * (y * z + x * w), m33 = 1 - 2 * (x * x + y * y);
  const ey = Math.asin(Math.max(-1, Math.min(1, m13)));
  if (Math.abs(m13) < 0.9999999) return [Math.atan2(-m23, m33), ey, Math.atan2(-m12, m11)];
  return [Math.atan2(m32, m22), ey, 0];
}

/** A quaternion from Euler angles (radians, "XYZ"). */
export function quatFromEuler(e: readonly number[]): Quat {
  const [c1, c2, c3] = [Math.cos(e[0]! / 2), Math.cos(e[1]! / 2), Math.cos(e[2]! / 2)];
  const [s1, s2, s3] = [Math.sin(e[0]! / 2), Math.sin(e[1]! / 2), Math.sin(e[2]! / 2)];
  return [s1 * c2 * c3 + c1 * s2 * s3, c1 * s2 * c3 - s1 * c2 * s3, c1 * c2 * s3 + s1 * s2 * c3, c1 * c2 * c3 - s1 * s2 * s3];
}

/** The angle between two rotations, radians (0..π). */
export function quatAngle(a: readonly number[], b: readonly number[]): number {
  // From the difference's vector and scalar parts: steady near 0, where acos of the dot product isn't.
  const d = quatMultiply(quatNormalize(a), quatConjugate(quatNormalize(b)));
  return 2 * Math.atan2(Math.hypot(d[0], d[1], d[2]), Math.abs(d[3]));
}

// --- A pose's joints --------------------------------------------------------------

/** One joint's local transform in a pose. */
export interface JointPose {
  readonly translation: Vec3;
  readonly rotation: Quat;
  readonly scale: Vec3;
}

export function jointPose(pose: Float32Array, joint: number): JointPose {
  const o = joint * POSE_STRIDE;
  return {
    translation: [pose[o]!, pose[o + 1]!, pose[o + 2]!],
    rotation: [pose[o + 3]!, pose[o + 4]!, pose[o + 5]!, pose[o + 6]!],
    scale: [pose[o + 7]!, pose[o + 8]!, pose[o + 9]!],
  };
}

/** A copy of `pose` with one joint's transform patched. */
export function withJointPose(pose: Float32Array, joint: number, patch: Partial<JointPose>): Float32Array {
  const out = pose.slice();
  const o = joint * POSE_STRIDE;
  if (patch.translation) out.set(patch.translation, o);
  if (patch.rotation) out.set(quatNormalize(patch.rotation), o + 3);
  if (patch.scale) out.set(patch.scale, o + 7);
  return out;
}

/**
 * Turn one joint by `angle` radians about `axis`: a world axis (the gizmo's,
 * as seen in the preview) or, with `space: "local"`, the joint's own.
 * Everything below it follows; nothing else moves.
 */
export function rotateJoint(skin: MeshSkin, pose: Float32Array, joint: number, axis: readonly number[], angle: number, space: "world" | "local" = "world"): Float32Array {
  if (joint < 0 || joint >= skin.joints.length) return pose;
  const local = jointPose(pose, joint).rotation;
  const turn = quatAxisAngle(axis, angle);
  if (space === "local") return withJointPose(pose, joint, { rotation: quatMultiply(local, turn) });
  // The parent's world rotation P: the joint's world rotation is P·local, so
  // turning it by T in the world makes local' = P⁻¹·T·P·local.
  const parent = skin.joints[joint]!.parent;
  let p: Quat = [0, 0, 0, 1];
  if (parent >= 0) p = quatFromMatrix(jointWorldMatrices(skin, pose), parent * 16);
  else if (skin.joints[joint]!.base?.length === 16) p = quatFromMatrix(skin.joints[joint]!.base!);
  return withJointPose(pose, joint, { rotation: quatMultiply(quatMultiply(quatConjugate(p), turn), quatMultiply(p, local)) });
}

// --- The skeleton over the mesh -------------------------------------------------------

/** A bone as drawn: from a joint's origin to its child's (`joint` the child; turning `parent` swings it). */
export interface BoneSegment {
  readonly joint: number;
  readonly parent: number;
  readonly from: Vec3;
  readonly to: Vec3;
}

/** Every joint's origin in a pose (model space). */
export function jointOrigins(skin: MeshSkin, pose: Float32Array): Vec3[] {
  const world = jointWorldMatrices(skin, pose);
  return skin.joints.map((_, j) => [world[j * 16 + 12]!, world[j * 16 + 13]!, world[j * 16 + 14]!]);
}

/** The skeleton's bones in a pose: one from each joint with a parent to it. */
export function skeletonSegments(skin: MeshSkin, pose: Float32Array): BoneSegment[] {
  const at = jointOrigins(skin, pose);
  return skin.joints.flatMap((j, k) => (j.parent >= 0 && j.parent < skin.joints.length ? [{ joint: k, parent: j.parent, from: at[j.parent]!, to: at[k]! }] : []));
}

/**
 * The joint under a click (NDC) in the preview's projection: a joint's
 * origin within `radius`, else the bone nearest within it — which picks the
 * joint that swings it (its parent). Null when nothing is near.
 */
export function pickJoint(skin: MeshSkin, pose: Float32Array, viewProj: ArrayLike<number>, ndc: readonly [number, number], radius = 0.05): number | null {
  const at = jointOrigins(skin, pose).map((p) => projectPoint(viewProj, p));
  let best: { joint: number; d: number } | null = null;
  at.forEach((s, j) => {
    if (!s) return;
    const d = Math.hypot(s[0] - ndc[0], s[1] - ndc[1]);
    if (d <= radius && (!best || d < best.d)) best = { joint: j, d };
  });
  if (best) return (best as { joint: number }).joint;
  skin.joints.forEach((joint, k) => {
    const a = joint.parent >= 0 ? at[joint.parent] : null, b = at[k];
    if (!a || !b) return;
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const l2 = dx * dx + dy * dy;
    const t = l2 > 0 ? Math.max(0, Math.min(1, ((ndc[0] - a[0]) * dx + (ndc[1] - a[1]) * dy) / l2)) : 0;
    const d = Math.hypot(ndc[0] - (a[0] + dx * t), ndc[1] - (a[1] + dy * t));
    if (d <= radius && (!best || d < best.d)) best = { joint: joint.parent, d };
  });
  return (best as { joint: number } | null)?.joint ?? null;
}
