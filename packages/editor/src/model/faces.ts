/**
 * Faces (AAA_FIDELITY_ROADMAP.md F7b): a facial rig standard, facial
 * animation in, lip sync from speech, and eyes that look and dart.
 *
 * - **The standard** is ARKit's 52 blend shapes (also what Live Link Face,
 *   Ready Player Me, VRoid and most rigs exported for them use). A mesh's
 *   morph targets (F7a) are matched to them by name, forgiving the usual
 *   spellings (`eyeBlink_L`, `EyeBlinkLeft`, `eye_blink_left`), so a face
 *   driven in ARKit's terms drives whichever targets the mesh has.
 * - **Animation in:** glTF's morph-weight channels (a clip's `morphs`, F7a's
 *   weights over time) and Live Link Face's CSV recordings.
 * - **Lip sync:** speech becomes visemes, the 15 mouth shapes Oculus's
 *   lip sync names, either from timed phonemes (ARPAbet, as a forced aligner
 *   or a TTS engine gives them) or from the audio itself: per 20 ms frame, its
 *   loudness, its fricative noise, and its first two formants by linear
 *   prediction, which place a vowel. Visemes become ARKit weights, eased in
 *   and out across their neighbours (coarticulation).
 * - **Gaze:** the eyes turn toward a target within their range, by saccades:
 *   quick jumps whose length sets their duration (the main sequence), between
 *   fixations of a few hundred milliseconds, with micro-saccades about the
 *   target and blinks now and then. As ARKit's eyeLook weights, or angles for
 *   eye joints.
 */

import type { MeshAsset } from "./MeshAsset";

// --- The standard -------------------------------------------------------------

/** ARKit's blend shapes, in its order. */
export const ARKIT_SHAPES = [
  "eyeBlinkLeft", "eyeLookDownLeft", "eyeLookInLeft", "eyeLookOutLeft", "eyeLookUpLeft", "eyeSquintLeft", "eyeWideLeft",
  "eyeBlinkRight", "eyeLookDownRight", "eyeLookInRight", "eyeLookOutRight", "eyeLookUpRight", "eyeSquintRight", "eyeWideRight",
  "jawForward", "jawLeft", "jawRight", "jawOpen",
  "mouthClose", "mouthFunnel", "mouthPucker", "mouthLeft", "mouthRight", "mouthSmileLeft", "mouthSmileRight",
  "mouthFrownLeft", "mouthFrownRight", "mouthDimpleLeft", "mouthDimpleRight", "mouthStretchLeft", "mouthStretchRight",
  "mouthRollLower", "mouthRollUpper", "mouthShrugLower", "mouthShrugUpper", "mouthPressLeft", "mouthPressRight",
  "mouthLowerDownLeft", "mouthLowerDownRight", "mouthUpperUpLeft", "mouthUpperUpRight",
  "browDownLeft", "browDownRight", "browInnerUp", "browOuterUpLeft", "browOuterUpRight",
  "cheekPuff", "cheekSquintLeft", "cheekSquintRight", "noseSneerLeft", "noseSneerRight", "tongueOut",
] as const;
export type ArkitShape = (typeof ARKIT_SHAPES)[number];

const SHAPE_INDEX = new Map<string, number>(ARKIT_SHAPES.map((name, i) => [canonical(name), i]));

/** A name reduced to compare: lower case, no separators, `_l`/`_r`/`.l` endings read as Left/Right. */
function canonical(name: string): string {
  let n = name.trim();
  // A prefix many exporters add ("blendShape1.", "Face_", "ARKit_").
  n = n.replace(/^.*[.:]/, "");
  n = n.replace(/[_\-. ]([LR])$/i, (_, side: string) => (side.toUpperCase() === "L" ? "Left" : "Right"));
  n = n.replace(/^(arkit|face|bs|blendshape\d*)[_-]/i, "");
  return n.replace(/[_\-. ]/g, "").toLowerCase();
}

/** The ARKit shape a target's name stands for, or -1. */
export function arkitIndex(name: string): number {
  return SHAPE_INDEX.get(canonical(name)) ?? -1;
}

/** A mesh's face rig: for each ARKit shape, the morph target it drives (−1 for none), and how many matched. */
export interface FaceRig {
  readonly targets: Int16Array;
  readonly matched: number;
  /** The mesh's target count, the length of the weights it takes. */
  readonly count: number;
}

/** Match a mesh's morph targets (its first primitive with targets, which glTF keeps alike across a mesh's primitives) to ARKit's shapes. */
export function faceRig(mesh: MeshAsset): FaceRig {
  const targets = new Int16Array(ARKIT_SHAPES.length).fill(-1);
  const names = mesh.primitives.find((p) => (p.morphTargets?.length ?? 0) > 0)?.morphTargets?.map((t) => t.name) ?? [];
  let matched = 0;
  names.forEach((name, t) => {
    const i = arkitIndex(name);
    if (i >= 0 && targets[i] === -1) {
      targets[i] = t;
      matched += 1;
    }
  });
  return { targets, matched, count: names.length };
}

/** ARKit weights (52) as the mesh's morph weights, over `base` (the mesh's own, kept for targets ARKit doesn't name). */
export function faceWeights(rig: FaceRig, arkit: ArrayLike<number>, base: ArrayLike<number> = []): Float32Array {
  const out = Float32Array.from({ length: rig.count }, (_, t) => base[t] ?? 0);
  for (let i = 0; i < ARKIT_SHAPES.length; i += 1) {
    const t = rig.targets[i]!;
    if (t >= 0) out[t] = Math.max(0, Math.min(1, arkit[i] ?? 0));
  }
  return out;
}

/** A face's animation: ARKit weights (52 a key) over time, linearly between keys. */
export interface FaceClip {
  readonly name: string;
  readonly duration: number;
  readonly times: Float32Array;
  readonly weights: Float32Array;
}

/** A face clip's weights at `t` seconds (held at the ends). */
export function sampleFace(clip: FaceClip, t: number, out: Float32Array = new Float32Array(ARKIT_SHAPES.length)): Float32Array {
  const n = clip.times.length;
  const w = ARKIT_SHAPES.length;
  if (n === 0) return out.fill(0);
  if (t <= clip.times[0]!) return out.set(clip.weights.subarray(0, w)), out;
  if (t >= clip.times[n - 1]!) return out.set(clip.weights.subarray((n - 1) * w, n * w)), out;
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (clip.times[mid]! <= t) lo = mid;
    else hi = mid;
  }
  const f = (t - clip.times[lo]!) / (clip.times[hi]! - clip.times[lo]! || 1);
  for (let i = 0; i < w; i += 1) out[i] = clip.weights[lo * w + i]! * (1 - f) + clip.weights[hi * w + i]! * f;
  return out;
}

/**
 * Live Link Face's CSV: a `Timecode` column (`HH:MM:SS:FF.mmm`, at the
 * recording's frame rate), `BlendShapeCount`, then a column per shape, ARKit's
 * names (and head and eye rotations, which are skipped). Times start at 0.
 */
export function parseLiveLinkFaceCsv(text: string, name = "face", fps = 60): FaceClip {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) throw new Error("A face recording needs a header and a frame");
  const header = lines[0]!.split(",").map((h) => h.trim());
  const timeColumn = header.findIndex((h) => /^timecode$/i.test(h));
  const columns = header.map((h) => arkitIndex(h));
  const times: number[] = [];
  const weights: number[] = [];
  let start: number | null = null;
  for (const line of lines.slice(1)) {
    const cells = line.split(",");
    const t = timeColumn >= 0 ? parseTimecode(cells[timeColumn] ?? "", fps) : times.length / fps;
    if (t === null) continue;
    start ??= t;
    const row = new Array<number>(ARKIT_SHAPES.length).fill(0);
    columns.forEach((i, c) => {
      if (i < 0) return;
      const v = Number(cells[c]);
      if (Number.isFinite(v)) row[i] = Math.max(0, Math.min(1, v));
    });
    times.push(t - start);
    weights.push(...row);
  }
  if (times.length === 0) throw new Error("A face recording has no frames");
  return { name, duration: times[times.length - 1]!, times: Float32Array.from(times), weights: Float32Array.from(weights) };
}

/** `HH:MM:SS:FF.mmm` (or plain seconds) as seconds; null when unreadable. */
export function parseTimecode(value: string, fps: number): number | null {
  const v = value.trim();
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  const m = /^(\d+):(\d+):(\d+)[:;](\d+(?:\.\d+)?)$/.exec(v);
  if (!m) return null;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / fps;
}

// --- Lip sync -----------------------------------------------------------------

/** Oculus's 15 visemes. */
export const VISEMES = ["sil", "PP", "FF", "TH", "DD", "kk", "CH", "SS", "nn", "RR", "aa", "E", "ih", "oh", "ou"] as const;
export type Viseme = (typeof VISEMES)[number];

/** ARPAbet phonemes (stress digits dropped) to visemes. */
const PHONEME_VISEME: Readonly<Record<string, Viseme>> = {
  AA: "aa", AE: "aa", AH: "aa", AO: "oh", AW: "aa", AY: "aa", EH: "E", ER: "RR", EY: "E", IH: "ih", IY: "ih", OW: "oh", OY: "oh", UH: "ou", UW: "ou",
  B: "PP", P: "PP", M: "PP", F: "FF", V: "FF", TH: "TH", DH: "TH", T: "DD", D: "DD", K: "kk", G: "kk", NG: "kk", HH: "kk",
  CH: "CH", JH: "CH", SH: "CH", ZH: "CH", S: "SS", Z: "SS", N: "nn", L: "nn", R: "RR", W: "ou", Y: "ih",
  SIL: "sil", SP: "sil", "": "sil",
};

/** A phoneme's viseme (ARPAbet, any case, stress digits allowed); silence for one unknown. */
export function phonemeViseme(phoneme: string): Viseme {
  return PHONEME_VISEME[phoneme.toUpperCase().replace(/[0-9]/g, "")] ?? "sil";
}

/** A viseme over a span of time. */
export interface VisemeSpan {
  readonly viseme: Viseme;
  readonly start: number;
  readonly end: number;
  /** How strongly, 0..1 (the audio's loudness; 1 from phonemes). */
  readonly weight: number;
}

/** Timed phonemes (as an aligner gives them) as visemes, neighbours of the same viseme merged. */
export function visemesFromPhonemes(phonemes: readonly { readonly phoneme: string; readonly start: number; readonly end: number }[]): VisemeSpan[] {
  const out: VisemeSpan[] = [];
  for (const p of phonemes) {
    const viseme = phonemeViseme(p.phoneme);
    const last = out[out.length - 1];
    if (last && last.viseme === viseme && Math.abs(last.end - p.start) < 1e-3) out[out.length - 1] = { ...last, end: p.end };
    else out.push({ viseme, start: p.start, end: p.end, weight: 1 });
  }
  return out;
}

/** Each viseme's mouth, as ARKit weights (the shapes it moves). */
export const VISEME_SHAPES: Readonly<Record<Viseme, Partial<Record<ArkitShape, number>>>> = {
  sil: {},
  PP: { mouthClose: 0.6, mouthPressLeft: 0.5, mouthPressRight: 0.5, mouthRollLower: 0.2, mouthRollUpper: 0.2 },
  FF: { mouthRollLower: 0.6, mouthUpperUpLeft: 0.2, mouthUpperUpRight: 0.2, jawOpen: 0.08 },
  TH: { jawOpen: 0.15, tongueOut: 0.4, mouthUpperUpLeft: 0.1, mouthUpperUpRight: 0.1 },
  DD: { jawOpen: 0.2, mouthStretchLeft: 0.15, mouthStretchRight: 0.15 },
  kk: { jawOpen: 0.25, mouthStretchLeft: 0.2, mouthStretchRight: 0.2 },
  CH: { jawOpen: 0.15, mouthFunnel: 0.5, mouthPucker: 0.3 },
  SS: { jawOpen: 0.08, mouthStretchLeft: 0.35, mouthStretchRight: 0.35, mouthSmileLeft: 0.1, mouthSmileRight: 0.1 },
  nn: { jawOpen: 0.15, mouthClose: 0.1, mouthStretchLeft: 0.1, mouthStretchRight: 0.1 },
  RR: { jawOpen: 0.15, mouthFunnel: 0.3, mouthPucker: 0.25 },
  aa: { jawOpen: 0.6, mouthLowerDownLeft: 0.3, mouthLowerDownRight: 0.3 },
  E: { jawOpen: 0.35, mouthStretchLeft: 0.4, mouthStretchRight: 0.4, mouthSmileLeft: 0.15, mouthSmileRight: 0.15 },
  ih: { jawOpen: 0.2, mouthStretchLeft: 0.45, mouthStretchRight: 0.45, mouthSmileLeft: 0.2, mouthSmileRight: 0.2 },
  oh: { jawOpen: 0.45, mouthFunnel: 0.6, mouthPucker: 0.2 },
  ou: { jawOpen: 0.15, mouthPucker: 0.8, mouthFunnel: 0.4 },
};

/** How long a viseme takes to come in and to go (s): the coarticulation. */
export const VISEME_BLEND = 0.06;

/**
 * The mouth at `t` from a track of visemes: each span's shape eased in over
 * {@link VISEME_BLEND} before it starts and out over the same after it ends,
 * the strongest of overlapping ones per shape (so a closure, PP's lips,
 * shows through a vowel either side), scaled by the span's weight.
 */
export function lipSyncWeights(track: readonly VisemeSpan[], t: number, out: Float32Array = new Float32Array(ARKIT_SHAPES.length)): Float32Array {
  out.fill(0);
  for (const span of track) {
    if (t < span.start - VISEME_BLEND || t > span.end + VISEME_BLEND) continue;
    let k = 1;
    if (t < span.start) k = 1 - (span.start - t) / VISEME_BLEND;
    else if (t > span.end) k = 1 - (t - span.end) / VISEME_BLEND;
    k = k * k * (3 - 2 * k) * span.weight;
    for (const [shape, w] of Object.entries(VISEME_SHAPES[span.viseme])) {
      const i = SHAPE_INDEX.get(canonical(shape))!;
      out[i] = Math.max(out[i]!, w * k);
    }
  }
  return out;
}

/** A frame of speech analysis: loudness (RMS), the high band's share of the energy, and the first two formants (Hz). */
export interface SpeechFrame {
  readonly time: number;
  readonly rms: number;
  readonly hiss: number;
  readonly f1: number;
  readonly f2: number;
}

/** The analysis frame and hop, seconds. */
export const SPEECH_FRAME = 0.02;

/** Autocorrelation of `x` to `order` lags. */
function autocorrelation(x: Float64Array, order: number): Float64Array {
  const r = new Float64Array(order + 1);
  for (let lag = 0; lag <= order; lag += 1) {
    let s = 0;
    for (let i = lag; i < x.length; i += 1) s += x[i]! * x[i - lag]!;
    r[lag] = s;
  }
  return r;
}

/** Linear prediction coefficients (Levinson-Durbin): a[0] = 1, the predictor's polynomial. */
export function lpc(x: Float64Array, order: number): Float64Array {
  const r = autocorrelation(x, order);
  const a = new Float64Array(order + 1);
  a[0] = 1;
  let e = r[0]! || 1e-12;
  for (let i = 1; i <= order; i += 1) {
    let acc = r[i]!;
    for (let j = 1; j < i; j += 1) acc += a[j]! * r[i - j]!;
    const k = -acc / e;
    const prev = a.slice();
    for (let j = 1; j < i; j += 1) a[j] = prev[j]! + k * prev[i - j]!;
    a[i] = k;
    e *= 1 - k * k;
    if (e <= 1e-12) break;
  }
  return a;
}

/**
 * The formants of an all-pole envelope: the peaks of 1 / |A(e^jω)| between
 * 200 Hz and 4 kHz, lowest first.
 */
export function formants(a: Float64Array, sampleRate: number, steps = 512): number[] {
  const mag: number[] = [];
  for (let s = 0; s <= steps; s += 1) {
    const w = (Math.PI * s) / steps;
    let re = 0;
    let im = 0;
    for (let k = 0; k < a.length; k += 1) {
      re += a[k]! * Math.cos(w * k);
      im -= a[k]! * Math.sin(w * k);
    }
    mag.push(1 / Math.max(1e-9, Math.hypot(re, im)));
  }
  const out: number[] = [];
  for (let s = 1; s < steps; s += 1) {
    const hz = (s / steps) * (sampleRate / 2);
    if (hz < 200 || hz > 4000) continue;
    if (mag[s]! > mag[s - 1]! && mag[s]! >= mag[s + 1]!) out.push(hz);
  }
  return out;
}

/**
 * Analyse mono speech: per {@link SPEECH_FRAME}, its loudness, its hiss (the
 * energy a first difference keeps, over twice the frame's: 1 for white noise, high for fricatives), and its
 * formants by 12th-order LPC on the pre-emphasised, windowed frame.
 */
export function analyzeSpeech(samples: Float32Array, sampleRate: number): SpeechFrame[] {
  const size = Math.max(32, Math.round(SPEECH_FRAME * sampleRate));
  const frames: SpeechFrame[] = [];
  const x = new Float64Array(size);
  for (let start = 0; start + size <= samples.length; start += size) {
    let energy = 0;
    let diff = 0;
    for (let i = 0; i < size; i += 1) {
      const v = samples[start + i]!;
      const prev = i > 0 ? samples[start + i - 1]! : v;
      energy += v * v;
      diff += (v - prev) * (v - prev);
      // Pre-emphasis, then a Hamming window.
      x[i] = (v - 0.97 * prev) * (0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (size - 1)));
    }
    const rms = Math.sqrt(energy / size);
    // A first difference doubles white noise's energy and keeps little of a low voiced sound's.
    const hiss = energy > 0 ? Math.min(1, diff / (2 * energy)) : 0;
    const peaks = rms > 1e-4 ? formants(lpc(x, 12), sampleRate) : [];
    frames.push({ time: start / sampleRate, rms, hiss, f1: peaks[0] ?? 0, f2: peaks[1] ?? 0 });
  }
  return frames;
}

/** Loudness below which a frame is silence, as a fraction of the loudest. */
export const SILENCE = 0.08;

/**
 * A frame's viseme: silence when quiet; a fricative (SS) when hiss
 * dominates; else a vowel placed by its formants (F1 high is open, F2 high is
 * front): aa open, E front-mid, ih front-close, oh back-mid, ou back-close.
 */
export function frameViseme(f: SpeechFrame, loudest: number): Viseme {
  if (f.rms < SILENCE * loudest || f.rms < 1e-4) return "sil";
  if (f.hiss > 0.6) return "SS";
  if (f.f1 <= 0) return "nn";
  if (f.f1 > 600) return "aa";
  if (f.f2 > 1700) return f.f1 < 400 ? "ih" : "E";
  return f.f1 < 450 ? "ou" : "oh";
}

/** Speech straight to a viseme track: each frame classified, its weight its loudness against the loudest, runs merged. */
export function visemesFromAudio(samples: Float32Array, sampleRate: number): VisemeSpan[] {
  const frames = analyzeSpeech(samples, sampleRate);
  const loudest = frames.reduce((m, f) => Math.max(m, f.rms), 0);
  const out: VisemeSpan[] = [];
  for (const f of frames) {
    const viseme = frameViseme(f, loudest);
    const weight = viseme === "sil" ? 0 : Math.min(1, (1.5 * f.rms) / (loudest || 1));
    const last = out[out.length - 1];
    if (last && last.viseme === viseme) out[out.length - 1] = { ...last, end: f.time + SPEECH_FRAME, weight: Math.max(last.weight, weight) };
    else out.push({ viseme, start: f.time, end: f.time + SPEECH_FRAME, weight });
  }
  return out.filter((s) => s.viseme !== "sil");
}

// --- Gaze ---------------------------------------------------------------------

/** How far the eyes turn (radians): sideways each way, up, and down. */
export const EYE_RANGE = { yaw: 0.6, up: 0.45, down: 0.55 } as const;

/** A saccade's duration (s) for its amplitude (radians): the main sequence, about 2.2 ms a degree plus 21 ms. */
export function saccadeDuration(amplitude: number): number {
  return 0.021 + 0.0022 * ((amplitude * 180) / Math.PI);
}

/** A seeded random stream (mulberry32), so gaze replays alike. */
function stream(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Where the eyes look, and the lids. */
export interface GazeState {
  /** Radians: positive yaw to the head's left (+x), positive pitch up. */
  readonly yaw: number;
  readonly pitch: number;
  /** The lids, 0 open to 1 shut. */
  readonly blink: number;
  /** Whether a saccade is under way. */
  readonly moving: boolean;
}

/**
 * Eyes that look at a target in saccades. Each `update` takes the target's
 * direction in the head's space (+z ahead, +y up, +x the head's left).
 */
export class Gaze {
  private yaw = 0;
  private pitch = 0;
  private from = [0, 0];
  private to = [0, 0];
  private progress = 1;
  private duration = 0;
  private hold = 0;
  private blinkAt: number;
  private blinkT = -1;
  private readonly random: () => number;
  /** The last target, so a new one (by more than a degree) starts a saccade at once. */
  private aim: [number, number] | null = null;
  constructor(seed = 1) {
    this.random = stream(seed);
    this.blinkAt = 2 + this.random() * 4;
  }

  /** The target's direction as eye angles, clamped to the eyes' range. */
  static anglesTo(direction: readonly number[]): [number, number] {
    const [x, y, z] = [direction[0]!, direction[1]!, direction[2]!];
    const yaw = Math.atan2(x, Math.max(1e-6, z));
    const pitch = Math.atan2(y, Math.hypot(x, z));
    return [Math.max(-EYE_RANGE.yaw, Math.min(EYE_RANGE.yaw, yaw)), Math.max(-EYE_RANGE.down, Math.min(EYE_RANGE.up, pitch))];
  }

  update(dt: number, direction: readonly number[]): GazeState {
    const aim = Gaze.anglesTo(direction);
    const moved = !this.aim || Math.hypot(aim[0] - this.aim[0], aim[1] - this.aim[1]) > Math.PI / 180;
    if (moved) this.aim = aim;
    if (this.progress >= 1) {
      this.hold -= dt;
      if (moved || this.hold <= 0) {
        // A saccade: to the target when it moved, else a micro-saccade about it (up to half a degree).
        const jitter = moved ? 0 : (Math.PI / 360) * this.random();
        const angle = this.random() * Math.PI * 2;
        this.from = [this.yaw, this.pitch];
        this.to = [this.aim![0] + jitter * Math.cos(angle), this.aim![1] + jitter * Math.sin(angle)];
        this.duration = saccadeDuration(Math.hypot(this.to[0]! - this.from[0]!, this.to[1]! - this.from[1]!));
        this.progress = 0;
        // Fixations last 200 to 600 ms.
        this.hold = 0.2 + 0.4 * this.random();
      }
    }
    if (this.progress < 1) {
      this.progress = Math.min(1, this.progress + dt / this.duration);
      // A saccade's velocity profile: quick out, easing in.
      const p = 1 - (1 - this.progress) ** 3;
      this.yaw = this.from[0]! + (this.to[0]! - this.from[0]!) * p;
      this.pitch = this.from[1]! + (this.to[1]! - this.from[1]!) * p;
    }
    // Blinks every 2 to 6 s, 150 ms down and up.
    this.blinkAt -= dt;
    if (this.blinkAt <= 0 && this.blinkT < 0) {
      this.blinkT = 0;
      this.blinkAt = 2 + this.random() * 4;
    }
    let blink = 0;
    if (this.blinkT >= 0) {
      this.blinkT += dt;
      const b = this.blinkT / 0.15;
      blink = b < 0.5 ? b * 2 : Math.max(0, 2 - b * 2);
      if (b >= 1) this.blinkT = -1;
    }
    return { yaw: this.yaw, pitch: this.pitch, blink, moving: this.progress < 1 };
  }
}

/**
 * A gaze as ARKit's eye shapes: each eye's look in, out, up and down, by its
 * angle over the range, and both blinks. Looking to the head's left is the
 * left eye looking out and the right eye looking in.
 */
export function gazeWeights(state: GazeState, out: Float32Array = new Float32Array(ARKIT_SHAPES.length)): Float32Array {
  const set = (shape: ArkitShape, v: number) => (out[SHAPE_INDEX.get(canonical(shape))!] = Math.max(0, Math.min(1, v)));
  const left = state.yaw / EYE_RANGE.yaw;
  const up = state.pitch > 0 ? state.pitch / EYE_RANGE.up : 0;
  const down = state.pitch < 0 ? -state.pitch / EYE_RANGE.down : 0;
  set("eyeLookOutLeft", left);
  set("eyeLookInRight", left);
  set("eyeLookInLeft", -left);
  set("eyeLookOutRight", -left);
  set("eyeLookUpLeft", up);
  set("eyeLookUpRight", up);
  set("eyeLookDownLeft", down);
  set("eyeLookDownRight", down);
  set("eyeBlinkLeft", state.blink);
  set("eyeBlinkRight", state.blink);
  return out;
}

/** Layer ARKit weight sets: each shape the strongest of them (lip sync over an expression, the gaze over both). */
export function layerFace(...layers: readonly ArrayLike<number>[]): Float32Array {
  const out = new Float32Array(ARKIT_SHAPES.length);
  for (const layer of layers) for (let i = 0; i < out.length; i += 1) out[i] = Math.max(out[i]!, layer[i] ?? 0);
  return out;
}
