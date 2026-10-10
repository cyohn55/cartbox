/**
 * The dope sheet (LOCKOUT_MULTIPLAYER_ROADMAP.md L16): keys a skinned mesh's
 * bones on a clip — a bone's pose at a moment — easing from each key to the
 * next with the timeline's eases: `linear`, `smooth` (slowing into and out of
 * each key), `step` (hold, then jump) or `curve` (its own cubic Bézier, as
 * drawn in the curve editor).
 *
 * The clip keeps playing exactly as every clip does: its channels are what
 * the animator samples (linear or stepped keys). Keying a bone bakes that
 * bone's channels from its keys — a linear span as two keys, a stepped one
 * held until a moment before the next, an eased one sampled
 * {@link BAKE_RATE} times a second along its curve — and records the keys
 * themselves on the clip ({@link AnimationClip.keys}), so the dope sheet
 * shows and edits keys rather than samples. A bone of an imported clip,
 * which has no recorded keys, shows its channels' own keys, and keying it
 * starts from them; its other bones are left exactly as they were. So a
 * keyed clip plays through the animator (and exports to glTF) as an
 * imported one does. Pure and DOM-free.
 */

import type { MeshAsset } from "./MeshAsset";
import { freeClipName } from "./clipEdit";
import { quatNormalize, type JointPose, type Quat } from "./poseMode";
import { MAX_CLIPS, POSE_STRIDE, sampleClip, type AnimationClip, type ClipChannel, type ClipKey, type MeshSkin } from "./skeleton";
import { DEFAULT_EASE_CURVE, easeCurve, type EaseCurve, type TimelineEase } from "./timeline";

/** Samples a second along an eased span. */
export const BAKE_RATE = 30;
/** Two keys this close (seconds) are one. */
const SAME_TIME = 1e-3;
/** A stepped span holds its value until this long before the next key. */
const STEP_HOLD = 1e-3;

/** A key as the dope sheet shows it. */
export interface DopeKey {
  readonly time: number;
  readonly ease: TimelineEase;
  readonly curve?: EaseCurve;
}

/** A bone's row of the dope sheet: its keys, and whether they were authored here (else they are its channels' own). */
export interface DopeRow {
  readonly joint: number;
  readonly name: string;
  readonly keys: readonly DopeKey[];
  readonly authored: boolean;
}

/** A key with the bone's pose at it. */
export interface PoseKey extends DopeKey, JointPose {}

/** How far an eased span has got at `u` (0..1 of the way between its keys). */
export function easeAmount(ease: TimelineEase, u: number, curve?: EaseCurve): number {
  if (ease === "step") return 0;
  if (ease === "smooth") return u * u * (3 - 2 * u);
  if (ease === "curve") return easeCurve(curve ?? DEFAULT_EASE_CURVE, u);
  return u;
}

/** Each bone's row: its recorded keys, or its channels' own key times (stepped if they all step). */
export function dopeSheetRows(mesh: MeshAsset, clipIndex: number): DopeRow[] {
  const clip = mesh.clips?.[clipIndex];
  const skin = mesh.skin;
  if (!clip || !skin) return [];
  return skin.joints.map((joint, j) => {
    const recorded = (clip.keys ?? []).filter((k) => k.joint === j).sort((a, b) => a.time - b.time);
    if (recorded.length > 0) return { joint: j, name: joint.name, keys: recorded.map(({ time, ease, curve }) => ({ time, ease, ...(curve ? { curve } : {}) })), authored: true };
    const channels = clip.channels.filter((c) => c.joint === j);
    const step = channels.length > 0 && channels.every((c) => c.interpolation === "step");
    const times: number[] = [];
    for (const t of channels.flatMap((c) => Array.from(c.times)).sort((a, b) => a - b)) if (times.length === 0 || t - times[times.length - 1]! > SAME_TIME) times.push(t);
    return { joint: j, name: joint.name, keys: times.map((time) => ({ time, ease: step ? ("step" as const) : ("linear" as const) })), authored: false };
  });
}

/** A bone's pose at a moment of a clip (rest where the clip doesn't move it). */
export function sampleJoint(skin: MeshSkin, clip: AnimationClip, joint: number, time: number): JointPose {
  const pose = sampleClip(skin, clip, time, false);
  const o = joint * POSE_STRIDE;
  return {
    translation: [pose[o]!, pose[o + 1]!, pose[o + 2]!],
    rotation: [pose[o + 3]!, pose[o + 4]!, pose[o + 5]!, pose[o + 6]!],
    scale: [pose[o + 7]!, pose[o + 8]!, pose[o + 9]!],
  };
}

/** A bone's keys on a clip, each with its pose (sampled from the clip as it plays). */
export function jointKeys(mesh: MeshAsset, clipIndex: number, joint: number): PoseKey[] {
  const clip = mesh.clips?.[clipIndex];
  const skin = mesh.skin;
  const row = dopeSheetRows(mesh, clipIndex)[joint];
  if (!clip || !skin || !row) return [];
  return row.keys.map((k) => ({ ...k, ...sampleJoint(skin, clip, joint, k.time) }));
}

const differs = (a: readonly number[], b: readonly number[]) => a.some((v, k) => Math.abs(v - b[k]!) > 1e-6);

/**
 * A bone's channels baked from its keys (sorted by time): rotation always,
 * translation and scale where a key moves them from rest. A span eases by
 * its first key's ease.
 */
export function bakeJoint(skin: MeshSkin, joint: number, keys: readonly PoseKey[]): ClipChannel[] {
  if (keys.length === 0 || joint < 0 || joint >= skin.joints.length) return [];
  const rest = skin.joints[joint]!;
  // Rotations on one side of the sphere, so each span turns the short way.
  const rotations: Quat[] = [];
  for (const k of keys) {
    let q = quatNormalize(k.rotation);
    const prev = rotations[rotations.length - 1];
    if (prev && prev[0] * q[0] + prev[1] * q[1] + prev[2] * q[2] + prev[3] * q[3] < 0) q = [-q[0], -q[1], -q[2], -q[3]];
    rotations.push(q);
  }
  const allStep = keys.length > 1 && keys.slice(0, -1).every((k) => k.ease === "step");
  const times: number[] = [];
  const at: { k: number; u: number }[] = []; // each sample: the span it's in and how far eased
  keys.forEach((key, k) => {
    times.push(key.time);
    at.push({ k, u: 0 });
    const next = keys[k + 1];
    if (!next || allStep) return;
    const span = next.time - key.time;
    if (key.ease === "step") {
      if (span > STEP_HOLD * 2) {
        times.push(next.time - STEP_HOLD);
        at.push({ k, u: 0 });
      }
    } else if (key.ease === "smooth" || key.ease === "curve") {
      const n = Math.max(1, Math.ceil(span * BAKE_RATE));
      for (let i = 1; i < n; i += 1) {
        times.push(key.time + (span * i) / n);
        at.push({ k, u: easeAmount(key.ease, i / n, key.curve) });
      }
    }
  });
  const lerp = (a: readonly number[], b: readonly number[], u: number) => a.map((v, c) => v + (b[c]! - v) * u);
  const value = (path: "translation" | "rotation" | "scale", { k, u }: { k: number; u: number }): number[] => {
    const a = path === "rotation" ? rotations[k]! : keys[k]![path];
    if (u === 0 || k + 1 >= keys.length) return [...a];
    const b = path === "rotation" ? rotations[k + 1]! : keys[k + 1]![path];
    return path === "rotation" ? quatNormalize(lerp(a, b, u)) : lerp(a, b, u);
  };
  const interpolation = allStep ? "step" : "linear";
  const channel = (path: "translation" | "rotation" | "scale"): ClipChannel => ({
    joint,
    path,
    interpolation,
    times: Float32Array.from(times),
    values: Float32Array.from(at.flatMap((s) => value(path, s))),
  });
  const out = [channel("rotation")];
  if (keys.some((k) => differs(k.translation, rest.translation))) out.push(channel("translation"));
  if (keys.some((k) => differs(k.scale, rest.scale))) out.push(channel("scale"));
  return out;
}

/** The clip with one bone's keys replaced (its channels baked from them), the clip lengthened to its last key. */
export function withJointKeys(mesh: MeshAsset, clipIndex: number, joint: number, keys: readonly PoseKey[]): MeshAsset {
  const clip = mesh.clips?.[clipIndex];
  const skin = mesh.skin;
  if (!clip || !skin || joint < 0 || joint >= skin.joints.length) return mesh;
  // Sorted, and one key a moment (the later one given wins).
  const sorted: PoseKey[] = [];
  for (const k of [...keys].map((k, i) => ({ k: { ...k, time: Math.max(0, k.time) }, i })).sort((a, b) => a.k.time - b.k.time || a.i - b.i).map((x) => x.k)) {
    const last = sorted[sorted.length - 1];
    if (last && k.time - last.time <= SAME_TIME) sorted[sorted.length - 1] = k;
    else sorted.push(k);
  }
  const recorded: ClipKey[] = sorted.map((k) => ({ joint, time: k.time, ease: k.ease, ...(k.ease === "curve" ? { curve: k.curve ?? DEFAULT_EASE_CURVE } : {}) }));
  const next: AnimationClip = {
    ...clip,
    duration: Math.max(clip.duration, sorted[sorted.length - 1]?.time ?? 0),
    channels: [...clip.channels.filter((c) => c.joint !== joint), ...bakeJoint(skin, joint, sorted)],
    keys: [...(clip.keys ?? []).filter((k) => k.joint !== joint), ...recorded],
  };
  return { ...mesh, clips: (mesh.clips ?? []).map((c, i) => (i === clipIndex ? next : c)) };
}

/**
 * Key a bone at `time`: its pose there becomes `value` (any part left out
 * stays as the clip has it). A key already at that moment is replaced,
 * keeping its ease unless one is given; a new key eases as given, else as
 * the key before it.
 */
export function keyBone(mesh: MeshAsset, clipIndex: number, joint: number, time: number, value: Partial<JointPose>, ease?: { ease: TimelineEase; curve?: EaseCurve }): MeshAsset {
  const clip = mesh.clips?.[clipIndex];
  const skin = mesh.skin;
  if (!clip || !skin || joint < 0 || joint >= skin.joints.length || !Number.isFinite(time)) return mesh;
  const t = Math.max(0, time);
  const keys = jointKeys(mesh, clipIndex, joint);
  const here = keys.findIndex((k) => Math.abs(k.time - t) <= SAME_TIME);
  const now = sampleJoint(skin, clip, joint, t);
  const before = [...keys].reverse().find((k) => k.time < t);
  const eased = ease ?? (here >= 0 ? keys[here]! : before) ?? { ease: "linear" as const };
  const key: PoseKey = {
    time: here >= 0 ? keys[here]!.time : t,
    ease: eased.ease,
    ...(eased.ease === "curve" ? { curve: eased.curve ?? DEFAULT_EASE_CURVE } : {}),
    translation: value.translation ? [...value.translation] : now.translation,
    rotation: value.rotation ? quatNormalize(value.rotation) : now.rotation,
    scale: value.scale ? [...value.scale] : now.scale,
  };
  const next = here >= 0 ? keys.map((k, i) => (i === here ? key : k)) : [...keys, key];
  return withJointKeys(mesh, clipIndex, joint, next);
}

/** Key several bones at once from a pose (pose mode's Key pose). */
export function keyPose(mesh: MeshAsset, clipIndex: number, time: number, pose: Float32Array, joints: readonly number[], ease?: { ease: TimelineEase; curve?: EaseCurve }): MeshAsset {
  let out = mesh;
  for (const j of joints) {
    const o = j * POSE_STRIDE;
    if (o + POSE_STRIDE > pose.length) continue;
    out = keyBone(
      out,
      clipIndex,
      j,
      time,
      { translation: [pose[o]!, pose[o + 1]!, pose[o + 2]!], rotation: [pose[o + 3]!, pose[o + 4]!, pose[o + 5]!, pose[o + 6]!], scale: [pose[o + 7]!, pose[o + 8]!, pose[o + 9]!] },
      ease,
    );
  }
  return out;
}

/** Remove a bone's key at `time`. */
export function deleteBoneKey(mesh: MeshAsset, clipIndex: number, joint: number, time: number): MeshAsset {
  const keys = jointKeys(mesh, clipIndex, joint);
  const next = keys.filter((k) => Math.abs(k.time - time) > SAME_TIME);
  return next.length === keys.length ? mesh : withJointKeys(mesh, clipIndex, joint, next);
}

/** Move a bone's key from one moment to another, keeping its pose and ease (it replaces any key already there). */
export function moveBoneKey(mesh: MeshAsset, clipIndex: number, joint: number, from: number, to: number): MeshAsset {
  const keys = jointKeys(mesh, clipIndex, joint);
  const moving = keys.find((k) => Math.abs(k.time - from) <= SAME_TIME);
  if (!moving || !Number.isFinite(to)) return mesh;
  const t = Math.max(0, to);
  const rest = keys.filter((k) => k !== moving && Math.abs(k.time - t) > SAME_TIME);
  return withJointKeys(mesh, clipIndex, joint, [...rest, { ...moving, time: t }]);
}

/** Change how a bone's key eases into its next. */
export function setBoneKeyEase(mesh: MeshAsset, clipIndex: number, joint: number, time: number, ease: TimelineEase, curve?: EaseCurve): MeshAsset {
  const keys = jointKeys(mesh, clipIndex, joint);
  const k = keys.findIndex((key) => Math.abs(key.time - time) <= SAME_TIME);
  if (k < 0) return mesh;
  const { curve: _old, ...key } = keys[k]!;
  const changed: PoseKey = { ...key, ease, ...(ease === "curve" ? { curve: curve ?? keys[k]!.curve ?? DEFAULT_EASE_CURVE } : {}) };
  return withJointKeys(mesh, clipIndex, joint, keys.map((x, i) => (i === k ? changed : x)));
}

/** A new, empty clip of `duration` seconds (a taunt to key), and its index; -1 when the mesh has all the clips it may. */
export function newClip(mesh: MeshAsset, name: string, duration: number): { mesh: MeshAsset; index: number } {
  const clips = mesh.clips ?? [];
  if (!mesh.skin || clips.length >= MAX_CLIPS) return { mesh, index: -1 };
  const clip: AnimationClip = { name: freeClipName(mesh, name.trim().slice(0, 64) || "clip"), duration: Math.max(0.05, Number.isFinite(duration) ? duration : 1), channels: [] };
  return { mesh: { ...mesh, clips: [...clips, clip] }, index: clips.length };
}

/** Every bone of a pose that differs from the clip at `time` (the bones a Key pose would key). */
export function posedJoints(skin: MeshSkin, clip: AnimationClip | undefined, time: number, pose: Float32Array): number[] {
  const base = clip ? sampleClip(skin, clip, time, false) : null;
  return skin.joints.flatMap((joint, j) => {
    const o = j * POSE_STRIDE;
    const ref = base ? Array.from(base.subarray(o, o + POSE_STRIDE)) : [...joint.translation, ...joint.rotation, ...joint.scale];
    return Array.from(pose.subarray(o, o + POSE_STRIDE)).some((v, k) => Math.abs(v - ref[k]!) > 1e-5) ? [j] : [];
  });
}

/** Whether a clip's channels have keys recorded by the dope sheet for this bone. */
export function isAuthored(clip: AnimationClip, joint: number): boolean {
  return (clip.keys ?? []).some((k) => k.joint === joint);
}
