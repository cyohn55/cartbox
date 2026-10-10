/**
 * Editing a skinned mesh's animation clips (ENGINE_PARITY_ROADMAP.md EP17):
 * trim a clip to a span, change its speed, play it backwards, rename,
 * duplicate and delete it. Pure: each returns a new clip or mesh, sharing
 * nothing mutable with the old.
 */

import type { MeshAsset } from "./MeshAsset";
import { MAX_CLIPS, type AnimationClip, type ClipChannel } from "./skeleton";

const widthOf = (c: ClipChannel) => (c.path === "rotation" ? 4 : 3);

/** One channel's value at `t` (interpolated as the channel does; rotations by normalised lerp). */
function sampleChannel(c: ClipChannel, t: number): number[] {
  const w = widthOf(c);
  const n = c.times.length;
  const at = (k: number) => Array.from(c.values.subarray(k * w, k * w + w));
  if (n === 0) return new Array<number>(w).fill(0);
  if (t <= c.times[0]!) return at(0);
  if (t >= c.times[n - 1]!) return at(n - 1);
  let k = 0;
  while (k < n - 2 && c.times[k + 1]! <= t) k += 1;
  const a = at(k);
  if (c.interpolation === "step") return a;
  const b = at(k + 1);
  const u = (t - c.times[k]!) / Math.max(1e-9, c.times[k + 1]! - c.times[k]!);
  if (w === 4) {
    const dot = a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]! + a[3]! * b[3]!;
    const s = dot < 0 ? -u : u;
    const q = a.map((v, i) => v * (1 - u) + b[i]! * s);
    const len = Math.hypot(...q) || 1;
    return q.map((v) => v / len);
  }
  return a.map((v, i) => v + (b[i]! - v) * u);
}

/**
 * The span [from, to] of a clip as a clip of its own, starting at 0: keys
 * inside the span kept, with a key added at each end so the motion starts and
 * stops exactly where it was.
 */
export function trimClip(clip: AnimationClip, from: number, to: number, name = clip.name): AnimationClip {
  const a = Math.max(0, Math.min(clip.duration, Math.min(from, to)));
  const b = Math.max(a, Math.min(clip.duration, Math.max(from, to)));
  const channels = clip.channels.map((c) => {
    const w = widthOf(c);
    const times: number[] = [0];
    const values: number[] = [...sampleChannel(c, a)];
    for (let k = 0; k < c.times.length; k += 1) {
      const t = c.times[k]!;
      if (t > a + 1e-6 && t < b - 1e-6) {
        times.push(t - a);
        values.push(...Array.from(c.values.subarray(k * w, k * w + w)));
      }
    }
    if (b - a > 1e-6) {
      times.push(b - a);
      values.push(...sampleChannel(c, b));
    }
    return { ...c, times: Float32Array.from(times), values: Float32Array.from(values) };
  });
  return { name, duration: b - a, channels };
}

/** The clip played `speed` times as fast (0.05..20): every key's time divided by it. */
export function retimeClip(clip: AnimationClip, speed: number): AnimationClip {
  const s = Math.max(0.05, Math.min(20, Number.isFinite(speed) ? speed : 1));
  return {
    ...clip,
    duration: clip.duration / s,
    channels: clip.channels.map((c) => ({ ...c, times: Float32Array.from(c.times, (t) => t / s), values: c.values.slice() })),
    ...(clip.keys ? { keys: clip.keys.map((k) => ({ ...k, time: k.time / s })) } : {}),
  };
}

/** The clip played backwards. */
export function reverseClip(clip: AnimationClip, name = clip.name): AnimationClip {
  return {
    name,
    duration: clip.duration,
    channels: clip.channels.map((c) => {
      const w = widthOf(c);
      const n = c.times.length;
      const times = new Float32Array(n);
      const values = new Float32Array(c.values.length);
      for (let k = 0; k < n; k += 1) {
        const from = n - 1 - k;
        times[k] = clip.duration - c.times[from]!;
        values.set(c.values.subarray(from * w, from * w + w), k * w);
      }
      return { ...c, times, values };
    }),
  };
}

/** A clip name not yet on the mesh: `base`, else `base 2`, `base 3` … */
export function freeClipName(mesh: MeshAsset, base: string): string {
  const names = new Set((mesh.clips ?? []).map((c) => c.name));
  if (!names.has(base)) return base;
  for (let n = 2; ; n += 1) if (!names.has(`${base} ${n}`)) return `${base} ${n}`;
}

/** Replace clip `index` (null removes it). */
export function setMeshClip(mesh: MeshAsset, index: number, clip: AnimationClip | null): MeshAsset {
  const clips = [...(mesh.clips ?? [])];
  if (index < 0 || index >= clips.length) return mesh;
  if (clip) clips[index] = clip;
  else clips.splice(index, 1);
  return { ...mesh, clips };
}

/** Add a clip after the others (refused past {@link MAX_CLIPS}: the mesh comes back unchanged). */
export function addMeshClip(mesh: MeshAsset, clip: AnimationClip): MeshAsset {
  const clips = mesh.clips ?? [];
  if (clips.length >= MAX_CLIPS) return mesh;
  return { ...mesh, clips: [...clips, { ...clip, name: freeClipName(mesh, clip.name) }] };
}

/** Rename clip `index` (a name already taken gets a number). */
export function renameMeshClip(mesh: MeshAsset, index: number, name: string): MeshAsset {
  const clip = mesh.clips?.[index];
  const trimmed = name.trim().slice(0, 64);
  if (!clip || !trimmed || trimmed === clip.name) return mesh;
  const others = { ...mesh, clips: (mesh.clips ?? []).filter((_, i) => i !== index) };
  return setMeshClip(mesh, index, { ...clip, name: freeClipName(others, trimmed) });
}
