/**
 * Cinematics (AAA_FIDELITY_ROADMAP.md F10d): a timeline's camera track as a
 * film camera — a lens, focus pulls, shake and rails — and the frames of an
 * offline render.
 *
 * - **The lens.** A camera key may give a focal length (mm, on a 36 × 24 mm
 *   full-frame sensor, which sets the field of view), an f-stop and a focus
 *   distance (m); between keys they ease as the eye does. The thin lens's
 *   aperture radius is f / 2N. A focus pull is the focus distance keyed, or a
 *   key focusing on an object (its distance from the eye at that moment).
 * - **Shake.** The track's amplitude (degrees) and frequency (Hz), scaled by
 *   each key's shake (0..1, eased): smooth noise on yaw, pitch and roll, three
 *   octaves of incommensurate sines each, so it never repeats visibly.
 * - **Rails.** A camera track may lay its eye on a rail (a Catmull-Rom curve
 *   through points); each key then gives how far along it (0..1) the eye is,
 *   and the eye glides along the curve between keys rather than cutting across.
 * - **Roll.** Each key's roll (degrees) turns the camera about its view.
 * - **Frames.** An offline render takes the timeline at a frame rate, frame
 *   by frame (`sequenceTimes`), each frame accumulated by the path tracer
 *   (F10b) with the shot's lens, then encoded to video in the browser.
 */

import type { Mat4 } from "../render/meshRasterizer";
import { projectionMatrix, viewMatrix } from "../render/meshRasterizer";
import { easeCurve, focalLengthToFov, sampleCamera, type SceneTimeline, type TimelineTrack } from "./timeline";

type V3 = [number, number, number];

/** A thin lens's aperture radius (m) for a focal length (mm) and f-stop. */
export function apertureRadius(mm: number, fStop: number): number {
  return mm / 1000 / (2 * Math.max(0.5, fStop));
}

/** Smooth camera shake at time `t`: yaw, pitch, roll in degrees, for an amplitude (deg) and frequency (Hz). */
export function cameraShake(t: number, amplitude: number, frequency: number, seed = 0): V3 {
  if (amplitude <= 0 || frequency <= 0) return [0, 0, 0];
  const axis = (k: number) => {
    let v = 0;
    let a = 1;
    let f = frequency;
    for (let o = 0; o < 3; o += 1) {
      v += a * Math.sin(2 * Math.PI * f * t + seed * 1.7 + k * 2.39 + o * 4.1) * Math.cos(2 * Math.PI * f * 0.618 * t + k * 0.7 + o);
      a *= 0.5;
      f *= 2.13;
    }
    return (v / 1.75) * amplitude;
  };
  return [axis(0), axis(1), axis(2) * 0.5];
}

/** A point along a Catmull-Rom rail through `points`, at `u` in 0..1 (by segment). */
export function railPoint(points: readonly (readonly number[])[], u: number): V3 {
  if (points.length === 0) return [0, 0, 0];
  if (points.length === 1) return [points[0]![0]!, points[0]![1]!, points[0]![2]!];
  const segments = points.length - 1;
  const s = Math.max(0, Math.min(1, u)) * segments;
  const i = Math.min(segments - 1, Math.floor(s));
  const f = s - i;
  const p = (k: number) => points[Math.max(0, Math.min(points.length - 1, k))]!;
  const [p0, p1, p2, p3] = [p(i - 1), p(i), p(i + 1), p(i + 2)];
  const f2 = f * f;
  const f3 = f2 * f;
  return [0, 1, 2].map((k) => 0.5 * (2 * p1[k]! + (p2[k]! - p0[k]!) * f + (2 * p0[k]! - 5 * p1[k]! + 4 * p2[k]! - p3[k]!) * f2 + (3 * p1[k]! - p0[k]! - 3 * p2[k]! + p3[k]!) * f3)) as V3;
}

/** A shot: where the camera is and looks, its up (rolled), field of view, and lens (null for a pinhole). */
export interface Shot {
  readonly eye: V3;
  readonly target: V3;
  readonly up: V3;
  readonly fov: number;
  readonly lens: { readonly aperture: number; readonly focus: number } | null;
}

type CameraTrack = Extract<TimelineTrack, { kind: "camera" }>;

/** Two keys around `t` and how far between (eased by the first key's ease). */
function between(keys: CameraTrack["keys"], t: number): { a: CameraTrack["keys"][number]; b: CameraTrack["keys"][number]; u: number } {
  if (t <= keys[0]!.time) return { a: keys[0]!, b: keys[0]!, u: 0 };
  const last = keys[keys.length - 1]!;
  if (t >= last.time) return { a: last, b: last, u: 0 };
  let i = 0;
  while (i + 1 < keys.length && keys[i + 1]!.time <= t) i += 1;
  const a = keys[i]!;
  const b = keys[i + 1]!;
  const raw = (t - a.time) / Math.max(1e-6, b.time - a.time);
  const u = a.ease === "step" ? 0 : a.ease === "smooth" ? raw * raw * (3 - 2 * raw) : a.ease === "curve" && a.curve ? easeCurve(a.curve, raw) : raw;
  return { a, b, u };
}

const lerp = (a: number, b: number, u: number) => a + (b - a) * u;

/**
 * The shot at `t` (null when the timeline has no camera keys). `objectAt`
 * finds an object's world position for a key that focuses on it.
 */
export function sampleShot(timeline: SceneTimeline, t: number, objectAt: (id: string) => readonly number[] | null = () => null): Shot | null {
  const base = sampleCamera(timeline, t);
  const track = timeline.tracks.find((k): k is CameraTrack => k.kind === "camera" && k.keys.length > 0);
  if (!base || !track) return null;
  const { a, b, u } = between(track.keys, t);
  // On a rail, the eye glides along it.
  let eye: V3 = [base.eye[0], base.eye[1], base.eye[2]];
  if (track.rail && track.rail.length >= 2 && a.along !== undefined) eye = railPoint(track.rail, lerp(a.along, b.along ?? a.along, u));
  let target: V3 = [base.target[0], base.target[1], base.target[2]];
  // The lens: a focal length sets the field of view; with an f-stop and a focus, the thin lens.
  const focal = a.focalLength !== undefined ? lerp(a.focalLength, b.focalLength ?? a.focalLength, u) : null;
  const fov = focal !== null ? focalLengthToFov(focal) : base.fov;
  const focusAt = (key: typeof a): number | null => {
    if (key.focusOn) {
      const p = objectAt(key.focusOn);
      if (p) return Math.hypot(p[0]! - eye[0], p[1]! - eye[1], p[2]! - eye[2]);
    }
    return key.focus ?? null;
  };
  const fa = focusAt(a);
  const fb = focusAt(b) ?? fa;
  const fStop = a.fStop !== undefined ? lerp(a.fStop, b.fStop ?? a.fStop, u) : null;
  const lens = fa !== null && fStop !== null ? { aperture: apertureRadius(focal ?? 50, fStop), focus: Math.max(0.05, lerp(fa, fb!, u)) } : null;
  // Shake, then roll, turn the view about the eye.
  const shakeScale = lerp(a.shake ?? 0, b.shake ?? a.shake ?? 0, u);
  const [yaw, pitch, roll] = cameraShake(t, (track.shakeAmplitude ?? 0) * shakeScale, track.shakeFrequency ?? 6);
  const totalRoll = roll + lerp(a.roll ?? 0, b.roll ?? a.roll ?? 0, u);
  const fwd = normalize([target[0] - eye[0], target[1] - eye[1], target[2] - eye[2]]);
  const right = normalize(cross(fwd, [0, 1, 0]));
  const up0 = cross(right, fwd);
  const turned = rotate(rotate(fwd, up0, (yaw * Math.PI) / 180), right, (pitch * Math.PI) / 180);
  const dist = Math.hypot(target[0] - eye[0], target[1] - eye[1], target[2] - eye[2]) || 1;
  target = [eye[0] + turned[0] * dist, eye[1] + turned[1] * dist, eye[2] + turned[2] * dist];
  const up = rotate(up0, turned, (-totalRoll * Math.PI) / 180);
  return { eye, target, up, fov, lens };
}

const cross = (a: readonly number[], b: readonly number[]): V3 => [a[1]! * b[2]! - a[2]! * b[1]!, a[2]! * b[0]! - a[0]! * b[2]!, a[0]! * b[1]! - a[1]! * b[0]!];
function normalize(v: V3): V3 {
  const l = Math.hypot(...v) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}
/** Rodrigues: `v` turned by `angle` about unit `axis`. */
function rotate(v: V3, axis: V3, angle: number): V3 {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const d = v[0] * axis[0] + v[1] * axis[1] + v[2] * axis[2];
  const x = cross(axis, v);
  return [v[0] * c + x[0] * s + axis[0] * d * (1 - c), v[1] * c + x[1] * s + axis[1] * d * (1 - c), v[2] * c + x[2] * s + axis[2] * d * (1 - c)];
}

/** A shot's view and projection matrices (its roll in the view), for an aspect ratio. */
export function shotMatrices(shot: Shot, aspect: number, near = 0.05, far = 2000): { view: Mat4; projection: Mat4 } {
  const view = viewMatrix(shot.eye, shot.target);
  // viewMatrix takes +Y as up: turn the view about its axis by the angle between that and the shot's up.
  const fwd = normalize([shot.target[0] - shot.eye[0], shot.target[1] - shot.eye[1], shot.target[2] - shot.eye[2]]);
  const right = normalize(cross(fwd, [0, 1, 0]));
  const up0 = cross(right, fwd);
  const angle = Math.atan2(shot.up[0] * right[0] + shot.up[1] * right[1] + shot.up[2] * right[2], shot.up[0] * up0[0] + shot.up[1] * up0[1] + shot.up[2] * up0[2]);
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  // A roll in view space (about −Z, the view direction), applied after the view.
  const rollM = [c, -s, 0, 0, s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const rolled = new Float64Array(16);
  for (let col = 0; col < 4; col += 1)
    for (let row = 0; row < 4; row += 1) {
      let sum = 0;
      for (let k = 0; k < 4; k += 1) sum += rollM[k * 4 + row]! * view[col * 4 + k]!;
      rolled[col * 4 + row] = sum;
    }
  return { view: rolled, projection: projectionMatrix((shot.fov * Math.PI) / 180, aspect, near, far) };
}

/** The moments an offline render takes a timeline at: `fps` frames a second over its duration (the last frame included). */
export function sequenceTimes(timeline: Pick<SceneTimeline, "duration">, fps: number): number[] {
  const n = Math.max(1, Math.floor(timeline.duration * fps + 1e-6) + 1);
  return Array.from({ length: n }, (_, i) => i / fps);
}
