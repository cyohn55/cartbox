/**
 * Morph targets, corrective shapes and dual-quaternion skinning
 * (AAA_FIDELITY_ROADMAP.md F7a), on the CPU: the reference the GPU's compute
 * skinning (gpuSkinning.ts in @cartbox/player) is held to, and what the
 * renderers without compute draw.
 *
 * - **Morph targets** are glTF's: per primitive, each target a set of position
 *   (and normal) deltas from the bind shape, blended by the mesh's weights
 *   before skinning. They are kept dense here; {@link morphCsr} packs the
 *   non-zero deltas per vertex for the GPU, so a face's fifty shapes cost a
 *   vertex only the shapes that move it.
 * - **Corrective shapes** are targets a joint drives: a target's weight rises
 *   from 0 to 1 as its joint turns from `angles[0]` to `angles[1]` radians from
 *   its rest rotation (an elbow's crease, a shoulder's volume).
 * - **Dual-quaternion skinning** (Kavan et al. 2008) blends joints' rigid
 *   transforms as dual quaternions, which keeps a twisting joint's volume where
 *   linear blending collapses it ("candy wrapper").
 */

import type { MeshSkin } from "./skeleton";
import { POSE_STRIDE } from "./skeleton";

/** What drives a corrective target: a joint's turn from rest, between two angles (radians). */
export interface CorrectiveDriver {
  readonly joint: number;
  readonly angles: readonly [number, number];
}

/** One morph target of a primitive: deltas from the bind shape, three floats a vertex. */
export interface MorphTarget {
  readonly name: string;
  readonly positions: Float32Array;
  readonly normals?: Float32Array | null;
  /** A corrective shape's driver; absent, the mesh's (or the cart's) weight drives it. */
  readonly driver?: CorrectiveDriver;
}

/** The most targets a primitive keeps. */
export const MAX_MORPH_TARGETS = 64;

/**
 * Blend `targets` by `weights` over the bind shape into `outPositions` /
 * `outNormals` (normals renormalised).
 */
export function applyMorphs(
  positions: Float32Array,
  normals: Float32Array | null,
  targets: readonly MorphTarget[],
  weights: ArrayLike<number>,
  outPositions: Float32Array,
  outNormals: Float32Array | null,
): void {
  outPositions.set(positions);
  if (normals && outNormals) outNormals.set(normals);
  targets.forEach((t, i) => {
    const w = weights[i] ?? 0;
    if (w === 0) return;
    for (let k = 0; k < outPositions.length; k += 1) outPositions[k] = outPositions[k]! + w * (t.positions[k] ?? 0);
    if (t.normals && outNormals) for (let k = 0; k < outNormals.length; k += 1) outNormals[k] = outNormals[k]! + w * (t.normals[k] ?? 0);
  });
  if (outNormals && targets.some((t, i) => t.normals && (weights[i] ?? 0) !== 0)) {
    for (let v = 0; v < outNormals.length; v += 3) {
      const len = Math.hypot(outNormals[v]!, outNormals[v + 1]!, outNormals[v + 2]!) || 1;
      outNormals[v] = outNormals[v]! / len;
      outNormals[v + 1] = outNormals[v + 1]! / len;
      outNormals[v + 2] = outNormals[v + 2]! / len;
    }
  }
}

/**
 * The non-zero deltas per vertex, for the GPU: `starts[v]..starts[v + 1]` index
 * `entries`, each two vec4s (the target, then the position delta xyz; the
 * normal delta xyz, 0).
 */
export function morphCsr(targets: readonly MorphTarget[], vertexCount: number): { starts: Uint32Array; entries: Float32Array } {
  const starts = new Uint32Array(vertexCount + 1);
  const rows: number[] = [];
  for (let v = 0; v < vertexCount; v += 1) {
    starts[v] = rows.length / 8;
    targets.forEach((t, i) => {
      const dx = t.positions[v * 3] ?? 0, dy = t.positions[v * 3 + 1] ?? 0, dz = t.positions[v * 3 + 2] ?? 0;
      const nx = t.normals?.[v * 3] ?? 0, ny = t.normals?.[v * 3 + 1] ?? 0, nz = t.normals?.[v * 3 + 2] ?? 0;
      if (dx === 0 && dy === 0 && dz === 0 && nx === 0 && ny === 0 && nz === 0) return;
      rows.push(i, dx, dy, dz, nx, ny, nz, 0);
    });
  }
  starts[vertexCount] = rows.length / 8;
  return { starts, entries: Float32Array.from(rows.length > 0 ? rows : [0, 0, 0, 0, 0, 0, 0, 0]) };
}

/** The angle (radians) a pose's joint has turned from its rest rotation. */
export function jointTurn(skin: MeshSkin, pose: Float32Array, joint: number): number {
  const rest = skin.joints[joint]?.rotation;
  if (!rest) return 0;
  const o = joint * POSE_STRIDE + 3;
  const dot = Math.abs(rest[0] * pose[o]! + rest[1] * pose[o + 1]! + rest[2] * pose[o + 2]! + rest[3] * pose[o + 3]!);
  return 2 * Math.acos(Math.min(1, dot));
}

/**
 * The angle (radians) a joint has turned from its bind pose against its parent,
 * read from the skinning matrices alone (both are identity at bind): the
 * rotation of the parent's matrix inverse times the joint's.
 */
export function jointTurnFromMatrices(skin: MeshSkin, matrices: Float32Array, joint: number): number {
  const parent = skin.joints[joint]?.parent ?? -1;
  const col = (j: number, c: number): [number, number, number] => {
    if (j < 0) return [c === 0 ? 1 : 0, c === 1 ? 1 : 0, c === 2 ? 1 : 0];
    const o = j * 16 + c * 4;
    const v: [number, number, number] = [matrices[o]!, matrices[o + 1]!, matrices[o + 2]!];
    const l = Math.hypot(...v) || 1;
    return [v[0] / l, v[1] / l, v[2] / l];
  };
  // trace(Pᵀ J) = Σ columns' dots, for rotations P and J: 1 + 2 cos θ.
  let trace = 0;
  for (let c = 0; c < 3; c += 1) {
    const p = col(parent, c);
    const q = col(joint, c);
    trace += p[0] * q[0] + p[1] * q[1] + p[2] * q[2];
  }
  return Math.acos(Math.min(1, Math.max(-1, (trace - 1) / 2)));
}

/**
 * The weights its corrective targets take (others keep `weights`'): each
 * driver's joint turn, from a pose or (`matrices`) the skinning matrices, eased
 * from 0 at its first angle to 1 at its second.
 */
export function correctiveWeights(skin: MeshSkin, pose: Float32Array | null, targets: readonly MorphTarget[], weights: ArrayLike<number>, matrices?: Float32Array): Float32Array {
  const out = Float32Array.from({ length: targets.length }, (_, i) => weights[i] ?? 0);
  targets.forEach((t, i) => {
    if (!t.driver) return;
    const turn = pose ? jointTurn(skin, pose, t.driver.joint) : matrices ? jointTurnFromMatrices(skin, matrices, t.driver.joint) : 0;
    const [a, b] = t.driver.angles;
    const x = Math.min(1, Math.max(0, (turn - a) / (b - a || 1e-6)));
    out[i] = x * x * (3 - 2 * x);
  });
  return out;
}

/**
 * A rigid 4×4 (column-major) as a unit dual quaternion: 8 floats, the real
 * part (rotation, xyzw) then the dual (translation), as Kavan's skinning reads them.
 */
export function dualQuaternion(m: ArrayLike<number>, out: Float32Array = new Float32Array(8), at = 0): Float32Array {
  // The rotation's quaternion from the 3×3 (Shepperd), the scale taken out of each column.
  const sx = Math.hypot(m[0]!, m[1]!, m[2]!) || 1, sy = Math.hypot(m[4]!, m[5]!, m[6]!) || 1, sz = Math.hypot(m[8]!, m[9]!, m[10]!) || 1;
  const r00 = m[0]! / sx, r10 = m[1]! / sx, r20 = m[2]! / sx;
  const r01 = m[4]! / sy, r11 = m[5]! / sy, r21 = m[6]! / sy;
  const r02 = m[8]! / sz, r12 = m[9]! / sz, r22 = m[10]! / sz;
  const trace = r00 + r11 + r22;
  let x: number, y: number, z: number, w: number;
  if (trace > 0) {
    const s = Math.sqrt(trace + 1) * 2;
    w = s / 4;
    x = (r21 - r12) / s;
    y = (r02 - r20) / s;
    z = (r10 - r01) / s;
  } else if (r00 > r11 && r00 > r22) {
    const s = Math.sqrt(1 + r00 - r11 - r22) * 2;
    w = (r21 - r12) / s;
    x = s / 4;
    y = (r01 + r10) / s;
    z = (r02 + r20) / s;
  } else if (r11 > r22) {
    const s = Math.sqrt(1 + r11 - r00 - r22) * 2;
    w = (r02 - r20) / s;
    x = (r01 + r10) / s;
    y = s / 4;
    z = (r12 + r21) / s;
  } else {
    const s = Math.sqrt(1 + r22 - r00 - r11) * 2;
    w = (r10 - r01) / s;
    x = (r02 + r20) / s;
    y = (r12 + r21) / s;
    z = s / 4;
  }
  const tx = m[12]!, ty = m[13]!, tz = m[14]!;
  // dual = ½ (0, t) ⊗ real
  out[at] = x;
  out[at + 1] = y;
  out[at + 2] = z;
  out[at + 3] = w;
  out[at + 4] = 0.5 * (tx * w + ty * z - tz * y);
  out[at + 5] = 0.5 * (-tx * z + ty * w + tz * x);
  out[at + 6] = 0.5 * (tx * y - ty * x + tz * w);
  out[at + 7] = 0.5 * (-tx * x - ty * y - tz * z);
  return out;
}

/** Every joint's skinning matrix as a dual quaternion (8 floats a joint). */
export function dualQuaternions(matrices: Float32Array): Float32Array {
  const n = matrices.length / 16;
  const out = new Float32Array(n * 8);
  for (let j = 0; j < n; j += 1) dualQuaternion(matrices.subarray(j * 16, j * 16 + 16), out, j * 8);
  return out;
}

/**
 * Skin one primitive by dual quaternions (Kavan): each vertex's joints'
 * quaternions blended (each flipped into the first's hemisphere), normalised,
 * and applied as a rotation and a translation. The rigid part only: a joint's
 * scale is dropped.
 */
export function skinVerticesDq(
  joints: Uint16Array,
  weights: Float32Array,
  quats: Float32Array,
  bindPositions: Float32Array,
  bindNormals: Float32Array | null,
  outPositions: Float32Array,
  outNormals: Float32Array | null,
): void {
  const count = bindPositions.length / 3;
  const jointCount = quats.length / 8;
  for (let v = 0; v < count; v += 1) {
    const b = [0, 0, 0, 0, 0, 0, 0, 0];
    let first = -1;
    let total = 0;
    for (let k = 0; k < 4; k += 1) {
      const w0 = weights[v * 4 + k]!;
      const j = joints[v * 4 + k]!;
      if (w0 <= 0 || j >= jointCount) continue;
      if (first < 0) first = j;
      const sign = quats[first * 8]! * quats[j * 8]! + quats[first * 8 + 1]! * quats[j * 8 + 1]! + quats[first * 8 + 2]! * quats[j * 8 + 2]! + quats[first * 8 + 3]! * quats[j * 8 + 3]! < 0 ? -1 : 1;
      for (let c = 0; c < 8; c += 1) b[c] = b[c]! + w0 * sign * quats[j * 8 + c]!;
      total += w0;
    }
    const x = bindPositions[v * 3]!, y = bindPositions[v * 3 + 1]!, z = bindPositions[v * 3 + 2]!;
    if (total <= 0) {
      outPositions.set([x, y, z], v * 3);
      if (bindNormals && outNormals) outNormals.set(bindNormals.subarray(v * 3, v * 3 + 3), v * 3);
      continue;
    }
    const len = Math.hypot(b[0]!, b[1]!, b[2]!, b[3]!) || 1;
    const [qx, qy, qz, qw, dx, dy, dz, dw] = b.map((c) => c / len) as [number, number, number, number, number, number, number, number];
    const rotate = (px: number, py: number, pz: number): [number, number, number] => {
      // v + 2 q × (q × v + w v)
      const cx = qy * pz - qz * py + qw * px;
      const cy = qz * px - qx * pz + qw * py;
      const cz = qx * py - qy * px + qw * pz;
      return [px + 2 * (qy * cz - qz * cy), py + 2 * (qz * cx - qx * cz), pz + 2 * (qx * cy - qy * cx)];
    };
    // The translation: 2 (w·d − dw·q + q × d) over the real part.
    const tx = 2 * (qw * dx - dw * qx + qy * dz - qz * dy);
    const ty = 2 * (qw * dy - dw * qy + qz * dx - qx * dz);
    const tz = 2 * (qw * dz - dw * qz + qx * dy - qy * dx);
    const p = rotate(x, y, z);
    outPositions[v * 3] = p[0] + tx;
    outPositions[v * 3 + 1] = p[1] + ty;
    outPositions[v * 3 + 2] = p[2] + tz;
    if (bindNormals && outNormals) {
      const n = rotate(bindNormals[v * 3]!, bindNormals[v * 3 + 1]!, bindNormals[v * 3 + 2]!);
      outNormals.set(n, v * 3);
    }
  }
}
