/**
 * Animation compression (AAA_FIDELITY_ROADMAP.md F7e): a clip made smaller
 * within an error a player can't see, then packed into a compact binary.
 *
 * - **Key reduction.** Each channel keeps only the keys its neighbours can't
 *   rebuild: a key whose value linear interpolation (a rotation: normalised)
 *   recovers within the tolerance (radians for rotations, metres for
 *   translations, a ratio for scale) is dropped, greedily from the start, by
 *   checking every dropped key against the span it now lies in.
 * - **Quantisation.** Times become 16-bit steps over the clip; rotations go
 *   "smallest three" (the largest component dropped and rebuilt from the
 *   unit length, the other three in 15 bits each over ±1/√2, plus 2 bits for
 *   which); translations and scales 16 bits each over the channel's own range.
 *   A rotation then errs by under 0.0002 rad, a translation by a 65 536th of
 *   its range.
 */

import type { AnimationClip, ClipChannel } from "./skeleton";

/** The error budgets: radians, metres, and a scale ratio. */
export interface CompressionTolerance {
  readonly rotation: number;
  readonly translation: number;
  readonly scale: number;
}
export const DEFAULT_TOLERANCE: CompressionTolerance = { rotation: 0.002, translation: 0.0005, scale: 0.001 };

function valueAt(channel: Pick<ClipChannel, "values">, width: number, k: number): number[] {
  return Array.from(channel.values.subarray(k * width, k * width + width));
}

function lerp(a: number[], b: number[], f: number, rotation: boolean): number[] {
  if (!rotation) return a.map((v, i) => v + (b[i]! - v) * f);
  // Short way round, then normalised (nlerp, as sampleClip blends).
  const d = a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]! + a[3]! * b[3]!;
  const s = d < 0 ? -1 : 1;
  const q = a.map((v, i) => v + (s * b[i]! - v) * f);
  const l = Math.hypot(...q) || 1;
  return q.map((v) => v / l);
}

function error(a: number[], b: number[], rotation: boolean): number {
  if (!rotation) return Math.max(...a.map((v, i) => Math.abs(v - b[i]!)));
  const d = Math.min(1, Math.abs(a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]! + a[3]! * b[3]!));
  return 2 * Math.acos(d);
}

/** A channel with only the keys interpolation can't rebuild within `tolerance`. */
export function reduceChannel(channel: ClipChannel, tolerance: number): ClipChannel {
  const width = channel.path === "rotation" ? 4 : 3;
  const n = channel.times.length;
  if (n <= 2 || channel.interpolation === "step") return channel;
  const rotation = channel.path === "rotation";
  const kept = [0];
  let anchor = 0;
  for (let k = 2; k < n; k += 1) {
    // Can the span anchor → k rebuild every key between?
    const a = valueAt(channel, width, anchor);
    const b = valueAt(channel, width, k);
    const t0 = channel.times[anchor]!;
    const t1 = channel.times[k]!;
    let ok = true;
    for (let m = anchor + 1; m < k && ok; m += 1) {
      const f = (channel.times[m]! - t0) / (t1 - t0 || 1);
      ok = error(lerp(a, b, f, rotation), valueAt(channel, width, m), rotation) <= tolerance;
    }
    if (!ok) {
      kept.push(k - 1);
      anchor = k - 1;
    }
  }
  kept.push(n - 1);
  const times = Float32Array.from(kept, (k) => channel.times[k]!);
  const values = new Float32Array(kept.length * width);
  kept.forEach((k, i) => values.set(channel.values.subarray(k * width, k * width + width), i * width));
  return { ...channel, times, values };
}

/** A clip with each channel reduced (a constant channel to its one key). */
export function reduceClip(clip: AnimationClip, tolerance: CompressionTolerance = DEFAULT_TOLERANCE): AnimationClip {
  return {
    ...clip,
    channels: clip.channels.map((c) => {
      const reduced = reduceChannel(c, c.path === "rotation" ? tolerance.rotation : c.path === "translation" ? tolerance.translation : tolerance.scale);
      // Every key alike: one is enough.
      const width = c.path === "rotation" ? 4 : 3;
      if (reduced.times.length === 2 && error(valueAt(reduced, width, 0), valueAt(reduced, width, 1), c.path === "rotation") <= 1e-7) {
        return { ...reduced, times: reduced.times.subarray(0, 1), values: reduced.values.subarray(0, width) };
      }
      return reduced;
    }),
  };
}

// --- Packing ------------------------------------------------------------------

const ROT_RANGE = Math.SQRT1_2;
const ROT_BITS = 15;
const ROT_MAX = (1 << ROT_BITS) - 1;

/** A unit quaternion as 48 bits ("smallest three"): two 16-bit words and a 16-bit word, the dropped index in the top bits. */
export function packQuat(q: readonly number[]): [number, number, number] {
  let largest = 0;
  for (let i = 1; i < 4; i += 1) if (Math.abs(q[i]!) > Math.abs(q[largest]!)) largest = i;
  const sign = q[largest]! < 0 ? -1 : 1;
  const rest = [0, 1, 2, 3].filter((i) => i !== largest).map((i) => q[i]! * sign);
  const enc = rest.map((v) => Math.round(((Math.max(-ROT_RANGE, Math.min(ROT_RANGE, v)) + ROT_RANGE) / (2 * ROT_RANGE)) * ROT_MAX));
  // 15 bits each, packed into three 16-bit words: the index's two bits in the top bits of the first two.
  return [enc[0]! | ((largest & 1) << 15), enc[1]! | ((largest >> 1) << 15), enc[2]!];
}

export function unpackQuat(words: readonly [number, number, number]): [number, number, number, number] {
  const largest = ((words[0] >> 15) & 1) | (((words[1] >> 15) & 1) << 1);
  const dec = [words[0] & ROT_MAX, words[1] & ROT_MAX, words[2] & ROT_MAX].map((v) => (v / ROT_MAX) * 2 * ROT_RANGE - ROT_RANGE);
  const w = Math.sqrt(Math.max(0, 1 - dec[0]! ** 2 - dec[1]! ** 2 - dec[2]! ** 2));
  const out: [number, number, number, number] = [0, 0, 0, 0];
  let r = 0;
  for (let i = 0; i < 4; i += 1) out[i] = i === largest ? w : dec[r++]!;
  return out;
}

/**
 * A clip packed: a header, then per channel its joint, path, interpolation,
 * key count, range (translation and scale), 16-bit times and its values (three
 * 16-bit words a rotation, three a vector). Little-endian.
 */
export function packClip(clip: AnimationClip): Uint8Array {
  const parts: number[] = [];
  const u16 = (v: number) => parts.push(v & 0xff, (v >> 8) & 0xff);
  const f32 = (v: number) => {
    const b = new Uint8Array(new Float32Array([v]).buffer);
    parts.push(...b);
  };
  f32(clip.duration);
  u16(clip.channels.length);
  const span = clip.duration > 0 ? clip.duration : 1;
  for (const c of clip.channels) {
    u16(c.joint);
    parts.push(c.path === "translation" ? 0 : c.path === "rotation" ? 1 : 2, c.interpolation === "step" ? 1 : 0);
    u16(c.times.length);
    for (const t of c.times) u16(Math.round((Math.max(0, Math.min(span, t)) / span) * 65535));
    if (c.path === "rotation") {
      for (let k = 0; k < c.times.length; k += 1) for (const w of packQuat(Array.from(c.values.subarray(k * 4, k * 4 + 4)))) u16(w);
    } else {
      const lo = [Infinity, Infinity, Infinity];
      const hi = [-Infinity, -Infinity, -Infinity];
      for (let k = 0; k < c.times.length; k += 1)
        for (let a = 0; a < 3; a += 1) {
          lo[a] = Math.min(lo[a]!, c.values[k * 3 + a]!);
          hi[a] = Math.max(hi[a]!, c.values[k * 3 + a]!);
        }
      for (let a = 0; a < 3; a += 1) {
        f32(lo[a]!);
        f32(hi[a]!);
      }
      for (let k = 0; k < c.times.length; k += 1)
        for (let a = 0; a < 3; a += 1) {
          const range = hi[a]! - lo[a]!;
          u16(range > 0 ? Math.round(((c.values[k * 3 + a]! - lo[a]!) / range) * 65535) : 0);
        }
    }
  }
  return Uint8Array.from(parts);
}

/** A packed clip back (named `name`). */
export function unpackClip(bytes: Uint8Array, name: string): AnimationClip {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let o = 0;
  const u16 = () => {
    const v = view.getUint16(o, true);
    o += 2;
    return v;
  };
  const f32 = () => {
    const v = view.getFloat32(o, true);
    o += 4;
    return v;
  };
  const duration = f32();
  const count = u16();
  const span = duration > 0 ? duration : 1;
  const channels: ClipChannel[] = [];
  for (let i = 0; i < count; i += 1) {
    const joint = u16();
    const path = (["translation", "rotation", "scale"] as const)[bytes[o]!] ?? "translation";
    const interpolation = bytes[o + 1] === 1 ? "step" : "linear";
    o += 2;
    const keys = u16();
    const times = Float32Array.from({ length: keys }, () => (u16() / 65535) * span);
    let values: Float32Array;
    if (path === "rotation") {
      values = new Float32Array(keys * 4);
      for (let k = 0; k < keys; k += 1) values.set(unpackQuat([u16(), u16(), u16()]), k * 4);
    } else {
      const lo: number[] = [];
      const hi: number[] = [];
      for (let a = 0; a < 3; a += 1) {
        lo.push(f32());
        hi.push(f32());
      }
      values = new Float32Array(keys * 3);
      for (let k = 0; k < keys; k += 1) for (let a = 0; a < 3; a += 1) values[k * 3 + a] = lo[a]! + (u16() / 65535) * (hi[a]! - lo[a]!);
    }
    channels.push({ joint, path, interpolation, times, values });
  }
  return { name, duration, channels };
}

/** A clip's size as the engine stores it uncompressed (float32 times and values). */
export function clipBytes(clip: AnimationClip): number {
  return clip.channels.reduce((n, c) => n + c.times.byteLength + c.values.byteLength, 0);
}
