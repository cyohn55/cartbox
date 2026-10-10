/**
 * Skeletal animation (ENGINE_ROADMAP.md, Phase 3): a mesh's skeleton, the clips
 * that move it, and the math that turns a moment of a clip into skinned vertices.
 *
 * - A {@link MeshSkin} is a list of joints, each with a parent (or none) and a
 *   rest transform relative to it, plus one inverse bind matrix per joint.
 * - A skinned {@link MeshPrimitive} carries four joint indices and four weights
 *   per vertex (glTF's JOINTS_0 / WEIGHTS_0).
 * - An {@link AnimationClip} is a set of keyframed channels, each driving one
 *   joint's translation, rotation or scale.
 *
 * A pose is every joint's local transform packed as 10 floats (translation xyz,
 * rotation quaternion xyzw, scale xyz). Sampling a clip gives a pose; poses
 * blend (for crossfades); a pose becomes one skinning matrix per joint (joint
 * world transform × inverse bind); and each vertex becomes the weighted sum of
 * its joints' matrices applied to its bind position.
 *
 * Skinning runs on the CPU into buffers the renderers read (the software
 * reference directly; the WebGPU renderer re-uploads when a primitive's
 * `dynamic.revision` changes), so both renderers draw the same skinned mesh.
 *
 * Pure and DOM-free, shared by the editor's preview, the player and the tests.
 */

import type { MeshAsset, MeshPrimitive } from "./MeshAsset";
import type { EaseCurve, TimelineEase } from "./timeline";

/** One joint of a skeleton. */
export interface SkinJoint {
  readonly name: string;
  /** The parent joint's index, or -1 for a root. */
  readonly parent: number;
  /** Rest transform relative to the parent (or to `base` for a root). */
  readonly translation: readonly [number, number, number];
  readonly rotation: readonly [number, number, number, number];
  readonly scale: readonly [number, number, number];
  /**
   * Roots only: the transform of the (non-joint) nodes above the joint in the
   * source file, column-major. Absent = identity.
   */
  readonly base?: readonly number[];
}

export interface MeshSkin {
  readonly joints: readonly SkinJoint[];
  /** One column-major 4×4 inverse bind matrix per joint (16 floats each). */
  readonly inverseBind: Float32Array;
}

export type ClipPath = "translation" | "rotation" | "scale";

/** Keyframes for one property of one joint. */
export interface ClipChannel {
  readonly joint: number;
  readonly path: ClipPath;
  readonly interpolation: "linear" | "step";
  /** Key times in seconds, ascending. */
  readonly times: Float32Array;
  /** Key values: 3 floats per key (translation, scale) or 4 (rotation quaternion). */
  readonly values: Float32Array;
}

export interface AnimationClip {
  readonly name: string;
  /** Seconds. */
  readonly duration: number;
  readonly channels: readonly ClipChannel[];
  /**
   * The keys a clip was authored with in the dope sheet (L16; see
   * dopeSheet.ts): per joint, the moments it was keyed and how each eases
   * into the next. The channels are the clip as it plays, an eased span
   * baked to samples; these let the dope sheet show and edit the keys rather
   * than the samples. A joint without any plays (and edits) its channels'
   * own keys, as an imported clip does.
   */
  readonly keys?: readonly ClipKey[];
}

/** A key of the dope sheet: one joint's pose at a moment, easing into its next key. */
export interface ClipKey {
  readonly joint: number;
  /** Seconds. */
  readonly time: number;
  readonly ease: TimelineEase;
  /** A `curve` ease's handles (as the timeline's). */
  readonly curve?: EaseCurve;
}

// Caps for untrusted input.
export const MAX_SKIN_JOINTS = 256;
export const MAX_CLIPS = 64;
export const MAX_CLIP_KEYS = 500_000;

/** Floats per joint in a pose: translation (3), rotation (4), scale (3). */
export const POSE_STRIDE = 10;

/** Whether a mesh has a skeleton its primitives are bound to. */
export function isSkinned(mesh: MeshAsset): boolean {
  return Boolean(mesh.skin && mesh.skin.joints.length > 0 && mesh.primitives.some((p) => p.joints && p.weights));
}

/** The skeleton at rest. */
export function restPose(skin: MeshSkin, out: Float32Array = new Float32Array(skin.joints.length * POSE_STRIDE)): Float32Array {
  skin.joints.forEach((joint, j) => {
    const o = j * POSE_STRIDE;
    out.set(joint.translation, o);
    out.set(joint.rotation, o + 3);
    out.set(joint.scale, o + 7);
  });
  return out;
}

/** The index of the last key at or before `t` (0 before the first key). */
function keyBefore(times: Float32Array, t: number): number {
  let lo = 0;
  let hi = times.length - 1;
  if (t <= times[0]!) return 0;
  if (t >= times[hi]!) return hi;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (times[mid]! <= t) lo = mid;
    else hi = mid;
  }
  return lo;
}

/** Normalized-lerp between quaternions a and b (taking the short way round) into out[o..o+3]. */
function nlerp(out: Float32Array, o: number, a: ArrayLike<number>, ao: number, b: ArrayLike<number>, bo: number, w: number): void {
  const dot = a[ao]! * b[bo]! + a[ao + 1]! * b[bo + 1]! + a[ao + 2]! * b[bo + 2]! + a[ao + 3]! * b[bo + 3]!;
  const s = dot < 0 ? -w : w;
  const x = a[ao]! * (1 - w) + b[bo]! * s;
  const y = a[ao + 1]! * (1 - w) + b[bo + 1]! * s;
  const z = a[ao + 2]! * (1 - w) + b[bo + 2]! * s;
  const q = a[ao + 3]! * (1 - w) + b[bo + 3]! * s;
  const n = Math.sqrt(x * x + y * y + z * z + q * q) || 1;
  out[o] = x / n;
  out[o + 1] = y / n;
  out[o + 2] = z / n;
  out[o + 3] = q / n;
}

/** Clip time for a playhead: wrapped when looping, held at the end otherwise. */
export function clipTime(clip: AnimationClip, time: number, loop: boolean): number {
  if (clip.duration <= 0) return 0;
  if (!loop) return Math.max(0, Math.min(clip.duration, time));
  const t = time % clip.duration;
  return t < 0 ? t + clip.duration : t;
}

/**
 * Sample `clip` at `time` seconds into `out` (a pose): joints the clip doesn't
 * animate keep their rest transform.
 */
export function sampleClip(skin: MeshSkin, clip: AnimationClip, time: number, loop = true, out?: Float32Array): Float32Array {
  const pose = restPose(skin, out);
  const t = clipTime(clip, time, loop);
  for (const channel of clip.channels) {
    if (channel.joint < 0 || channel.joint >= skin.joints.length || channel.times.length === 0) continue;
    const width = channel.path === "rotation" ? 4 : 3;
    const o = channel.joint * POSE_STRIDE + (channel.path === "translation" ? 0 : channel.path === "rotation" ? 3 : 7);
    const k = keyBefore(channel.times, t);
    const last = channel.times.length - 1;
    if (channel.interpolation === "step" || k >= last || t <= channel.times[0]!) {
      for (let c = 0; c < width; c += 1) pose[o + c] = channel.values[k * width + c]!;
      continue;
    }
    const t0 = channel.times[k]!;
    const t1 = channel.times[k + 1]!;
    const w = t1 > t0 ? (t - t0) / (t1 - t0) : 0;
    if (width === 4) nlerp(pose, o, channel.values, k * 4, channel.values, (k + 1) * 4, w);
    else for (let c = 0; c < 3; c += 1) pose[o + c] = channel.values[k * 3 + c]! * (1 - w) + channel.values[(k + 1) * 3 + c]! * w;
  }
  return pose;
}

/** Blend pose `b` over pose `a` by `w` (0 = all a, 1 = all b) into `out`. */
export function blendPoses(a: Float32Array, b: Float32Array, w: number, out = new Float32Array(a.length)): Float32Array {
  for (let o = 0; o < a.length; o += POSE_STRIDE) {
    for (let c = 0; c < 3; c += 1) out[o + c] = a[o + c]! * (1 - w) + b[o + c]! * w;
    nlerp(out, o + 3, a, o + 3, b, o + 3, w);
    for (let c = 7; c < 10; c += 1) out[o + c] = a[o + c]! * (1 - w) + b[o + c]! * w;
  }
  return out;
}

/** Column-major T·R·S from pose entry `o` into m (16 floats at mo). */
function composeTRS(pose: Float32Array, o: number, m: Float64Array): void {
  const [tx, ty, tz, x, y, z, w, sx, sy, sz] = [pose[o]!, pose[o + 1]!, pose[o + 2]!, pose[o + 3]!, pose[o + 4]!, pose[o + 5]!, pose[o + 6]!, pose[o + 7]!, pose[o + 8]!, pose[o + 9]!];
  m[0] = (1 - 2 * (y * y + z * z)) * sx;
  m[1] = 2 * (x * y + z * w) * sx;
  m[2] = 2 * (x * z - y * w) * sx;
  m[3] = 0;
  m[4] = 2 * (x * y - z * w) * sy;
  m[5] = (1 - 2 * (x * x + z * z)) * sy;
  m[6] = 2 * (y * z + x * w) * sy;
  m[7] = 0;
  m[8] = 2 * (x * z + y * w) * sz;
  m[9] = 2 * (y * z - x * w) * sz;
  m[10] = (1 - 2 * (x * x + y * y)) * sz;
  m[11] = 0;
  m[12] = tx;
  m[13] = ty;
  m[14] = tz;
  m[15] = 1;
}

function mul4(a: ArrayLike<number>, b: ArrayLike<number>, out: Float64Array): void {
  for (let c = 0; c < 4; c += 1) {
    for (let r = 0; r < 4; r += 1) {
      out[c * 4 + r] = a[r]! * b[c * 4]! + a[4 + r]! * b[c * 4 + 1]! + a[8 + r]! * b[c * 4 + 2]! + a[12 + r]! * b[c * 4 + 3]!;
    }
  }
}

/** Each joint's world transform for a pose (column-major, 16 floats per joint). */
export function jointWorldMatrices(skin: MeshSkin, pose: Float32Array): Float64Array {
  const n = skin.joints.length;
  const world = new Float64Array(n * 16);
  const done = new Uint8Array(n);
  const local = new Float64Array(16);
  const tmp = new Float64Array(16);
  const solve = (j: number, depth: number): void => {
    if (done[j]) return;
    const joint = skin.joints[j]!;
    composeTRS(pose, j * POSE_STRIDE, local);
    const p = joint.parent;
    if (p >= 0 && p < n && depth < n) {
      solve(p, depth + 1);
      mul4(world.subarray(p * 16, p * 16 + 16), local, tmp);
    } else if (joint.base && joint.base.length === 16) {
      mul4(joint.base, local, tmp);
    } else tmp.set(local);
    world.set(tmp, j * 16);
    done[j] = 1;
  };
  for (let j = 0; j < n; j += 1) solve(j, 0);
  return world;
}

/** The skinning matrices for a pose: joint world × inverse bind (16 floats per joint). */
export function skinMatrices(skin: MeshSkin, pose: Float32Array, out = new Float32Array(skin.joints.length * 16)): Float32Array {
  const world = jointWorldMatrices(skin, pose);
  const tmp = new Float64Array(16);
  for (let j = 0; j < skin.joints.length; j += 1) {
    mul4(world.subarray(j * 16, j * 16 + 16), skin.inverseBind.subarray(j * 16, j * 16 + 16), tmp);
    out.set(tmp, j * 16);
  }
  return out;
}

/**
 * Skin one primitive: each vertex (from `bindPositions` / `bindNormals`) becomes
 * the weighted blend of its joints' matrices applied to it, written into
 * `outPositions` / `outNormals`.
 */
export function skinVertices(
  joints: Uint16Array,
  weights: Float32Array,
  matrices: Float32Array,
  bindPositions: Float32Array,
  bindNormals: Float32Array | null,
  outPositions: Float32Array,
  outNormals: Float32Array | null,
): void {
  const count = bindPositions.length / 3;
  const jointCount = matrices.length / 16;
  const m = new Float64Array(12); // the blended matrix's upper 3×4
  for (let v = 0; v < count; v += 1) {
    m.fill(0);
    let total = 0;
    for (let k = 0; k < 4; k += 1) {
      const w = weights[v * 4 + k]!;
      const j = joints[v * 4 + k]!;
      if (w <= 0 || j >= jointCount) continue;
      total += w;
      const b = j * 16;
      m[0] = m[0]! + matrices[b]! * w;
      m[1] = m[1]! + matrices[b + 1]! * w;
      m[2] = m[2]! + matrices[b + 2]! * w;
      m[3] = m[3]! + matrices[b + 4]! * w;
      m[4] = m[4]! + matrices[b + 5]! * w;
      m[5] = m[5]! + matrices[b + 6]! * w;
      m[6] = m[6]! + matrices[b + 8]! * w;
      m[7] = m[7]! + matrices[b + 9]! * w;
      m[8] = m[8]! + matrices[b + 10]! * w;
      m[9] = m[9]! + matrices[b + 12]! * w;
      m[10] = m[10]! + matrices[b + 13]! * w;
      m[11] = m[11]! + matrices[b + 14]! * w;
    }
    const x = bindPositions[v * 3]!;
    const y = bindPositions[v * 3 + 1]!;
    const z = bindPositions[v * 3 + 2]!;
    if (total <= 0) {
      // Unweighted vertices stay where they were bound.
      outPositions[v * 3] = x;
      outPositions[v * 3 + 1] = y;
      outPositions[v * 3 + 2] = z;
      if (bindNormals && outNormals) outNormals.set(bindNormals.subarray(v * 3, v * 3 + 3), v * 3);
      continue;
    }
    if (total !== 1) for (let i = 0; i < 12; i += 1) m[i] = m[i]! / total;
    outPositions[v * 3] = m[0]! * x + m[3]! * y + m[6]! * z + m[9]!;
    outPositions[v * 3 + 1] = m[1]! * x + m[4]! * y + m[7]! * z + m[10]!;
    outPositions[v * 3 + 2] = m[2]! * x + m[5]! * y + m[8]! * z + m[11]!;
    if (bindNormals && outNormals) {
      // Rotation-dominant skinning: the blended 3×3 is close enough to its own
      // inverse-transpose for normals once renormalized.
      const nx = bindNormals[v * 3]!;
      const ny = bindNormals[v * 3 + 1]!;
      const nz = bindNormals[v * 3 + 2]!;
      const ox = m[0]! * nx + m[3]! * ny + m[6]! * nz;
      const oy = m[1]! * nx + m[4]! * ny + m[7]! * nz;
      const oz = m[2]! * nx + m[5]! * ny + m[8]! * nz;
      const len = Math.sqrt(ox * ox + oy * oy + oz * oz) || 1;
      outNormals[v * 3] = ox / len;
      outNormals[v * 3 + 1] = oy / len;
      outNormals[v * 3 + 2] = oz / len;
    }
  }
}

/**
 * A skinned mesh's live copy: the same mesh, but with its own position and
 * normal buffers that {@link LiveSkinnedMesh.update} rewrites for a pose (and a
 * `dynamic` revision renderers watch to re-upload). Everything else — indices,
 * UVs, materials, skin, clips — is shared with the source.
 */
export interface LiveSkinnedMesh {
  readonly mesh: MeshAsset;
  /** Skin every primitive for a pose (see {@link skinMatrices}). */
  update(matrices: Float32Array): void;
}

export function createLiveSkinnedMesh(source: MeshAsset): LiveSkinnedMesh {
  const primitives: MeshPrimitive[] = source.primitives.map((p) => ({
    ...p,
    positions: p.positions.slice(),
    normals: p.normals ? p.normals.slice() : null,
    dynamic: { revision: 0 },
  }));
  const mesh: MeshAsset = { ...source, primitives };
  return {
    mesh,
    update(matrices) {
      source.primitives.forEach((src, i) => {
        const live = primitives[i]!;
        if (!src.joints || !src.weights) return;
        skinVertices(src.joints, src.weights, matrices, src.positions, src.normals, live.positions, live.normals);
        live.dynamic!.revision += 1;
      });
    },
  };
}

/** A clip's index by name (or a valid numeric index), or -1. */
export function findClip(mesh: MeshAsset, clip: string | number): number {
  const clips = mesh.clips ?? [];
  if (typeof clip === "number") return Number.isInteger(clip) && clip >= 0 && clip < clips.length ? clip : -1;
  return clips.findIndex((c) => c.name === clip);
}
