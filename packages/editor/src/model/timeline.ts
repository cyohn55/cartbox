/**
 * Timelines (ENGINE_ROADMAP.md, Phase 3): cutscenes and scripted camera moves,
 * stored scene-wide on the mesh sidecar as `timelines`.
 *
 * A timeline is a set of tracks over `duration` seconds:
 *
 * - **camera**: keys of eye position, look-at target and field of view — while
 *   the timeline plays, the camera flies through them;
 * - **object**: keys of one scene object's transform (relative to its parent,
 *   like the Inspector) — it moves, turns and scales through them;
 * - **animation**: cues that start a clip (or state machine state) on a skinned
 *   object at a moment;
 * - **events**: named moments the cart hears (cartbox.timelineevents) — a line
 *   of dialogue, a sound, the end of the cutscene.
 *
 * Each key eases into the next: `linear`, `smooth` (a curve through the keys,
 * slowing into and out of each one) or `step` (hold, then jump). A timeline can
 * loop, start by itself when the cart does (`autoplay`), and `hold` its last
 * frame when it ends (otherwise the camera and objects go back to the cart).
 * Objects are referred to by their sidecar entry id; everything is validated on
 * the way in.
 */

export type TimelineEase = "linear" | "smooth" | "step";
export const TIMELINE_EASES: readonly TimelineEase[] = ["linear", "smooth", "step"];

type V3 = readonly [number, number, number];

export interface CameraKey {
  readonly time: number;
  readonly eye: V3;
  readonly target: V3;
  /** Vertical field of view, degrees. */
  readonly fov: number;
  readonly ease: TimelineEase;
}

export interface TransformKey {
  readonly time: number;
  readonly position: V3;
  /** Euler degrees (as the Inspector). */
  readonly rotation: V3;
  readonly scale: V3;
  readonly ease: TimelineEase;
}

export interface AnimationCue {
  readonly time: number;
  /** A clip name, or a state name when the object has a state machine. */
  readonly clip: string;
  readonly fade: number;
  readonly loop: boolean;
}

export type TimelineTrack =
  | { readonly kind: "camera"; readonly keys: readonly CameraKey[] }
  | { readonly kind: "object"; readonly object: string; readonly keys: readonly TransformKey[] }
  | { readonly kind: "animation"; readonly object: string; readonly cues: readonly AnimationCue[] }
  | { readonly kind: "events"; readonly events: readonly { readonly time: number; readonly name: string }[] };

export interface SceneTimeline {
  readonly name: string;
  /** Seconds. */
  readonly duration: number;
  readonly loop: boolean;
  /** Start playing as soon as the cart does. */
  readonly autoplay: boolean;
  /** Keep the last frame's camera and object placement after it ends. */
  readonly hold: boolean;
  readonly tracks: readonly TimelineTrack[];
}

export const TIMELINE_LIMITS = { timelines: 16, tracks: 32, keys: 128, duration: 600 } as const;
export const DEFAULT_TIMELINE_FOV = 50;

const NAME_MAX = 32;
const num = (v: unknown, lo: number, hi: number, fallback: number): number =>
  typeof v === "number" && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : fallback;
const vec = (v: unknown, fallback: V3): V3 =>
  Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === "number" && Number.isFinite(n))
    ? [Math.max(-1e6, Math.min(1e6, v[0])), Math.max(-1e6, Math.min(1e6, v[1])), Math.max(-1e6, Math.min(1e6, v[2]))]
    : fallback;
const ease = (v: unknown): TimelineEase => (TIMELINE_EASES.includes(v as TimelineEase) ? (v as TimelineEase) : "smooth");
const text = (v: unknown): string | null => {
  if (typeof v !== "string") return null;
  const s = v.trim().slice(0, NAME_MAX);
  return s.length > 0 ? s : null;
};
const list = (v: unknown, max: number): Record<string, unknown>[] =>
  Array.isArray(v) ? (v.slice(0, max).filter((x) => typeof x === "object" && x !== null) as Record<string, unknown>[]) : [];
const byTime = <T extends { time: number }>(items: T[]): T[] => items.sort((a, b) => a.time - b.time);

function readTrack(raw: Record<string, unknown>, duration: number): TimelineTrack | null {
  const time = (v: unknown) => num(v, 0, duration, 0);
  switch (raw.kind) {
    case "camera":
      return {
        kind: "camera",
        keys: byTime(
          list(raw.keys, TIMELINE_LIMITS.keys).map((k) => ({
            time: time(k.time),
            eye: vec(k.eye, [0, 2, 8]),
            target: vec(k.target, [0, 0, 0]),
            fov: num(k.fov, 5, 150, DEFAULT_TIMELINE_FOV),
            ease: ease(k.ease),
          })),
        ),
      };
    case "object": {
      const object = typeof raw.object === "string" && raw.object ? raw.object.slice(0, 128) : null;
      if (!object) return null;
      return {
        kind: "object",
        object,
        keys: byTime(
          list(raw.keys, TIMELINE_LIMITS.keys).map((k) => ({
            time: time(k.time),
            position: vec(k.position, [0, 0, 0]),
            rotation: vec(k.rotation, [0, 0, 0]),
            scale: vec(k.scale, [1, 1, 1]),
            ease: ease(k.ease),
          })),
        ),
      };
    }
    case "animation": {
      const object = typeof raw.object === "string" && raw.object ? raw.object.slice(0, 128) : null;
      if (!object) return null;
      const cues: AnimationCue[] = [];
      for (const c of list(raw.cues, TIMELINE_LIMITS.keys)) {
        const clip = text(c.clip);
        if (clip) cues.push({ time: time(c.time), clip, fade: num(c.fade, 0, 10, 0.2), loop: c.loop !== false });
      }
      return { kind: "animation", object, cues: byTime(cues) };
    }
    case "events": {
      const events: { time: number; name: string }[] = [];
      for (const e of list(raw.events, TIMELINE_LIMITS.keys)) {
        const name = text(e.name);
        if (name) events.push({ time: time(e.time), name });
      }
      return { kind: "events", events: byTime(events) };
    }
    default:
      return null;
  }
}

/** Read stored timelines (dropping anything unusable; names made unique by dropping later duplicates). */
export function readTimelines(value: unknown): SceneTimeline[] {
  const out: SceneTimeline[] = [];
  for (const raw of list(value, TIMELINE_LIMITS.timelines)) {
    const name = text(raw.name);
    if (!name || out.some((t) => t.name === name)) continue;
    const duration = num(raw.duration, 0.05, TIMELINE_LIMITS.duration, 5);
    const tracks = list(raw.tracks, TIMELINE_LIMITS.tracks)
      .map((t) => readTrack(t, duration))
      .filter((t): t is TimelineTrack => t !== null);
    out.push({ name, duration, loop: raw.loop === true, autoplay: raw.autoplay === true, hold: raw.hold === true, tracks });
  }
  return out;
}

/** A fresh timeline with a camera track. */
export function newTimeline(name: string): SceneTimeline {
  return { name, duration: 5, loop: false, autoplay: false, hold: false, tracks: [{ kind: "camera", keys: [] }] };
}

// --- Sampling -------------------------------------------------------------

/** The two keys around `t` and how far between them, eased by the first key's ease. */
function segment<K extends { time: number; ease: TimelineEase }>(keys: readonly K[], t: number): { i: number; j: number; u: number } | null {
  if (keys.length === 0) return null;
  if (t <= keys[0]!.time) return { i: 0, j: 0, u: 0 };
  const last = keys.length - 1;
  if (t >= keys[last]!.time) return { i: last, j: last, u: 0 };
  let i = 0;
  while (i < last - 1 && keys[i + 1]!.time <= t) i += 1;
  const a = keys[i]!;
  const b = keys[i + 1]!;
  const raw = b.time > a.time ? (t - a.time) / (b.time - a.time) : 1;
  const u = a.ease === "step" ? 0 : a.ease === "smooth" ? raw * raw * (3 - 2 * raw) : raw;
  return { i, j: i + 1, u };
}

/** A point between keys i and j: a Catmull-Rom curve through the neighbours when smooth, else a straight line. */
function interpolate(points: readonly V3[], i: number, j: number, u: number, smooth: boolean): [number, number, number] {
  const p1 = points[i]!;
  const p2 = points[j]!;
  if (!smooth || i === j) return [p1[0] + (p2[0] - p1[0]) * u, p1[1] + (p2[1] - p1[1]) * u, p1[2] + (p2[2] - p1[2]) * u];
  const p0 = points[Math.max(0, i - 1)]!;
  const p3 = points[Math.min(points.length - 1, j + 1)]!;
  const u2 = u * u;
  const u3 = u2 * u;
  const c = (k: 0 | 1 | 2) =>
    0.5 * (2 * p1[k] + (p2[k] - p0[k]) * u + (2 * p0[k] - 5 * p1[k] + 4 * p2[k] - p3[k]) * u2 + (3 * p1[k] - p0[k] - 3 * p2[k] + p3[k]) * u3);
  return [c(0), c(1), c(2)];
}

/** Where the camera is at `t`, or null when the timeline has no camera keys. */
export function sampleCamera(timeline: SceneTimeline, t: number): { eye: V3; target: V3; fov: number } | null {
  const track = timeline.tracks.find((k): k is Extract<TimelineTrack, { kind: "camera" }> => k.kind === "camera" && k.keys.length > 0);
  if (!track) return null;
  const s = segment(track.keys, t)!;
  const smooth = track.keys[s.i]!.ease === "smooth";
  const a = track.keys[s.i]!;
  const b = track.keys[s.j]!;
  return {
    eye: interpolate(track.keys.map((k) => k.eye), s.i, s.j, s.u, smooth),
    target: interpolate(track.keys.map((k) => k.target), s.i, s.j, s.u, smooth),
    fov: a.fov + (b.fov - a.fov) * s.u,
  };
}

/** Every object track's transform at `t` (object id → position, rotation, scale). */
export function sampleObjects(timeline: SceneTimeline, t: number): Map<string, { position: V3; rotation: V3; scale: V3 }> {
  const out = new Map<string, { position: V3; rotation: V3; scale: V3 }>();
  for (const track of timeline.tracks) {
    if (track.kind !== "object" || track.keys.length === 0) continue;
    const s = segment(track.keys, t)!;
    const smooth = track.keys[s.i]!.ease === "smooth";
    out.set(track.object, {
      position: interpolate(track.keys.map((k) => k.position), s.i, s.j, s.u, smooth),
      rotation: interpolate(track.keys.map((k) => k.rotation), s.i, s.j, s.u, false),
      scale: interpolate(track.keys.map((k) => k.scale), s.i, s.j, s.u, false),
    });
  }
  return out;
}

/**
 * The animation cues and events whose moment falls in (t0, t1] — what the
 * playhead passed moving from t0 to t1 (a cue at 0 fires as playback starts,
 * when t0 is just below 0).
 */
export function crossedMarks(
  timeline: SceneTimeline,
  t0: number,
  t1: number,
): { cues: { object: string; cue: AnimationCue }[]; events: string[] } {
  const cues: { object: string; cue: AnimationCue }[] = [];
  const events: string[] = [];
  for (const track of timeline.tracks) {
    if (track.kind === "animation") for (const cue of track.cues) if (cue.time > t0 && cue.time <= t1) cues.push({ object: track.object, cue });
    if (track.kind === "events") for (const e of track.events) if (e.time > t0 && e.time <= t1) events.push(e.name);
  }
  return { cues, events };
}
