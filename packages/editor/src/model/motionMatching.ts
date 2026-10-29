/**
 * Motion matching and root motion (AAA_FIDELITY_ROADMAP.md F7e).
 *
 * - **Root motion.** A clip's root joint carries the character across the
 *   ground. `rootMotion` reads how far (and how far round, about +Y) it went
 *   between two times, in the character's space, so a game can move the
 *   character by it; `inPlace` takes that travel out of a pose, so the body
 *   stays over its origin while the game moves it.
 * - **Motion matching** (Clavet, Ubisoft 2016; Holden et al. 2020): every
 *   frame of every clip becomes a feature vector: the feet's positions and
 *   velocities and the hips' velocity, relative to the root, and where the
 *   root will be and face 0.33, 0.67 and 1 s on. Features are normalised per
 *   group, by mean and deviation, and weighted. Every few frames the matcher
 *   builds the same vector from the pose now and the trajectory the player
 *   asks for, and jumps (crossfading) to the frame nearest it, unless the
 *   frame already playing is nearly as near.
 */

import { POSE_STRIDE, jointWorldMatrices, sampleClip, type AnimationClip, type MeshSkin } from "./skeleton";

type V3 = [number, number, number];

// --- Root motion --------------------------------------------------------------

/** The root's place on the ground at a pose: its x and z, and its heading (radians about +Y; 0 faces +Z). */
export function rootPlace(skin: MeshSkin, pose: Float32Array, root = 0): { x: number; z: number; heading: number } {
  const world = jointWorldMatrices(skin, pose);
  const o = root * 16;
  // The root's forward (+Z) on the ground.
  const fx = world[o + 8]!;
  const fz = world[o + 10]!;
  return { x: world[o + 12]!, z: world[o + 14]!, heading: Math.atan2(fx, fz) };
}

/**
 * How far the root moved between `t0` and `t1` of a clip (no wrap: `t1` ≥
 * `t0` within it), in the root's frame at `t0`: forward (+Z), sideways (+X)
 * and the turn about +Y.
 */
export function rootMotion(skin: MeshSkin, clip: AnimationClip, t0: number, t1: number, root = 0): { dx: number; dz: number; turn: number } {
  const a = rootPlace(skin, sampleClip(skin, clip, t0, false), root);
  const b = rootPlace(skin, sampleClip(skin, clip, t1, false), root);
  const wx = b.x - a.x;
  const wz = b.z - a.z;
  const c = Math.cos(-a.heading);
  const s = Math.sin(-a.heading);
  let turn = b.heading - a.heading;
  turn = Math.atan2(Math.sin(turn), Math.cos(turn));
  return { dx: c * wx + s * wz, dz: -s * wx + c * wz, turn };
}

/** Take the root's travel over the ground out of a pose (its x and z), leaving its height and its rotation. */
export function inPlace(pose: Float32Array, root = 0): void {
  pose[root * POSE_STRIDE] = 0;
  pose[root * POSE_STRIDE + 2] = 0;
}

// --- Motion matching ----------------------------------------------------------

/** What the matcher reads from a skeleton. */
export interface MatchSetup {
  /** The joint that carries the character (its ground position and heading). */
  readonly root: number;
  /** The joints whose position and velocity are matched (the feet), and the hips (velocity only). */
  readonly feet: readonly number[];
  readonly hips: number;
  /** Seconds ahead each trajectory sample looks. */
  readonly horizon?: readonly number[];
  /** The groups' weights: the feet (positions and velocities), the hips' velocity, the trajectory. */
  readonly weights?: readonly [number, number, number];
}

export const MATCH_RATE = 30;
export const DEFAULT_HORIZON = [1 / 3, 2 / 3, 1] as const;
const DEFAULT_WEIGHTS = [1, 1, 1.5] as const;

/** The feature vector's length for a setup. */
export function featureSize(setup: MatchSetup): number {
  return setup.feet.length * 6 + 3 + (setup.horizon ?? DEFAULT_HORIZON).length * 4;
}

/** A joint's position in the root's ground frame (x, y, z with +Z its heading). */
function local(world: Float64Array, j: number, place: { x: number; z: number; heading: number }): V3 {
  const wx = world[j * 16 + 12]! - place.x;
  const wz = world[j * 16 + 14]! - place.z;
  const c = Math.cos(-place.heading);
  const s = Math.sin(-place.heading);
  return [c * wx + s * wz, world[j * 16 + 13]!, -s * wx + c * wz];
}

/** The pose part of a feature vector: the feet's places and velocities and the hips' velocity, root-relative, from two poses `dt` apart. */
export function poseFeatures(skin: MeshSkin, setup: MatchSetup, before: Float32Array, now: Float32Array, dt: number, out: Float64Array, at = 0): number {
  const placeNow = rootPlace(skin, now, setup.root);
  const placeBefore = rootPlace(skin, before, setup.root);
  const wNow = jointWorldMatrices(skin, now);
  const wBefore = jointWorldMatrices(skin, before);
  let k = at;
  for (const foot of setup.feet) {
    const p = local(wNow, foot, placeNow);
    const q = local(wBefore, foot, placeBefore);
    out.set(p, k);
    out.set([(p[0] - q[0]) / dt, (p[1] - q[1]) / dt, (p[2] - q[2]) / dt], k + 3);
    k += 6;
  }
  const h = local(wNow, setup.hips, placeNow);
  const g = local(wBefore, setup.hips, placeBefore);
  // The hips' velocity in the world, turned into the root's frame now.
  const c = Math.cos(-placeNow.heading);
  const s = Math.sin(-placeNow.heading);
  const vx = (wNow[setup.hips * 16 + 12]! - wBefore[setup.hips * 16 + 12]!) / dt;
  const vz = (wNow[setup.hips * 16 + 14]! - wBefore[setup.hips * 16 + 14]!) / dt;
  out.set([c * vx + s * vz, (h[1] - g[1]) / dt, -s * vx + c * vz], k);
  return k + 3;
}

/** A trajectory point: where the root will be (x, z in its frame now) and which way it will face (unit x, z). */
export interface TrajectoryPoint {
  readonly x: number;
  readonly z: number;
  readonly dx: number;
  readonly dz: number;
}

/** The pose database: every frame's features, normalised, with the clip and time each came from. */
export interface MatchDatabase {
  readonly setup: MatchSetup;
  readonly size: number;
  readonly features: Float64Array;
  readonly clip: Uint16Array;
  readonly time: Float32Array;
  /** Each feature's mean and deviation, and weight. */
  readonly mean: Float64Array;
  readonly scale: Float64Array;
}

/** Build the database: every clip sampled at {@link MATCH_RATE}, frames whose trajectory would run past the clip's end left out (looping clips wrap). */
export function buildMatchDatabase(skin: MeshSkin, clips: readonly AnimationClip[], setup: MatchSetup, loops: readonly boolean[] = []): MatchDatabase {
  const size = featureSize(setup);
  const horizon = setup.horizon ?? DEFAULT_HORIZON;
  const rows: number[][] = [];
  const clipOf: number[] = [];
  const timeOf: number[] = [];
  const dt = 1 / MATCH_RATE;
  clips.forEach((clip, c) => {
    const loop = loops[c] ?? false;
    const last = loop ? clip.duration : clip.duration - horizon[horizon.length - 1]!;
    for (let t = dt; t <= last + 1e-6; t += dt) {
      const row = new Float64Array(size);
      let k = poseFeatures(skin, setup, sampleClip(skin, clip, t - dt, loop), sampleClip(skin, clip, t, loop), dt, row);
      for (const h of horizon) {
        const m = futureMotion(skin, clip, t, h, loop, setup.root);
        row.set([m.dx, m.dz, Math.sin(m.turn), Math.cos(m.turn)], k);
        k += 4;
      }
      rows.push(Array.from(row));
      clipOf.push(c);
      timeOf.push(t);
    }
  });
  const n = rows.length;
  const mean = new Float64Array(size);
  const scale = new Float64Array(size).fill(1);
  for (const r of rows) for (let i = 0; i < size; i += 1) mean[i] = mean[i]! + r[i]! / Math.max(1, n);
  // One deviation a group, so a group's features keep their proportions, and its weight over it.
  const weights = setup.weights ?? DEFAULT_WEIGHTS;
  const groups = featureGroups(setup);
  groups.forEach(([from, to], g) => {
    let variance = 0;
    for (const r of rows) for (let i = from; i < to; i += 1) variance += (r[i]! - mean[i]!) ** 2;
    const deviation = Math.sqrt(variance / Math.max(1, n * (to - from))) || 1;
    for (let i = from; i < to; i += 1) scale[i] = weights[g]! / deviation;
  });
  const features = new Float64Array(n * size);
  rows.forEach((r, f) => {
    for (let i = 0; i < size; i += 1) features[f * size + i] = (r[i]! - mean[i]!) * scale[i]!;
  });
  return { setup, size, features, clip: Uint16Array.from(clipOf), time: Float32Array.from(timeOf), mean, scale };
}

/** The feature groups' ranges: the feet (position and velocity, 6 a foot), the hips' velocity, the trajectory (4 a sample). */
function featureGroups(setup: MatchSetup): [number, number][] {
  const f = setup.feet.length * 6;
  return [
    [0, f],
    [f, f + 3],
    [f + 3, f + 3 + (setup.horizon ?? DEFAULT_HORIZON).length * 4],
  ];
}

/** Where the root goes over `h` seconds from `t` (wrapping a looping clip). */
function futureMotion(skin: MeshSkin, clip: AnimationClip, t: number, h: number, loop: boolean, root: number): { dx: number; dz: number; turn: number } {
  if (!loop || t + h <= clip.duration) return rootMotion(skin, clip, t, Math.min(clip.duration, t + h), root);
  // Wrapped: to the end, then on from the start, chained in the first's frame.
  const a = rootMotion(skin, clip, t, clip.duration, root);
  const b = rootMotion(skin, clip, 0, (t + h) % clip.duration, root);
  const c = Math.cos(a.turn);
  const s = Math.sin(a.turn);
  return { dx: a.dx + c * b.dx + s * b.dz, dz: a.dz - s * b.dx + c * b.dz, turn: a.turn + b.turn };
}

/** A query's features in the database's space. */
export function normaliseQuery(db: MatchDatabase, raw: Float64Array): Float64Array {
  return Float64Array.from(raw, (v, i) => (v - db.mean[i]!) * db.scale[i]!);
}

/** The frame nearest a (normalised) query, and its distance (squared). */
export function nearestFrame(db: MatchDatabase, query: Float64Array): { frame: number; cost: number } {
  let best = -1;
  let cost = Infinity;
  const n = db.features.length / db.size;
  for (let f = 0; f < n; f += 1) {
    let d = 0;
    const o = f * db.size;
    for (let i = 0; i < db.size && d < cost; i += 1) d += (db.features[o + i]! - query[i]!) ** 2;
    if (d < cost) {
      cost = d;
      best = f;
    }
  }
  return { frame: best, cost };
}

/** A frame's cost against a query. */
export function frameCost(db: MatchDatabase, frame: number, query: Float64Array): number {
  let d = 0;
  for (let i = 0; i < db.size; i += 1) d += (db.features[frame * db.size + i]! - query[i]!) ** 2;
  return d;
}

/**
 * The trajectory a character asks for: moving at `velocity` (m/s, in its own
 * frame: x sideways, z forward) and turning to face `facing` (radians from its
 * heading now), reached smoothly (a critically damped spring of `halfLife` s).
 */
export function desiredTrajectory(velocity: readonly [number, number], facing: number, horizon: readonly number[] = DEFAULT_HORIZON, current: readonly [number, number] = [0, 0], halfLife = 0.2): TrajectoryPoint[] {
  const k = Math.LN2 / halfLife;
  return horizon.map((h) => {
    // The velocity's spring: v(t) = goal + (v0 − goal)·e^(−kt)(1 + kt); its integral to h.
    const decay = (t: number) => (Math.exp(-k * t) * (2 + k * t) - 2) / -k;
    const share = h - decay(h);
    const x = velocity[0] * share + current[0] * decay(h);
    const z = velocity[1] * share + current[1] * decay(h);
    const turn = facing * (1 - Math.exp(-k * h) * (1 + k * h));
    return { x, z, dx: Math.sin(turn), dz: Math.cos(turn) };
  });
}

/** A matcher: which clip and time to play, chosen every few frames. */
export class MotionMatcher {
  clip = -1;
  time = 0;
  private sinceSearch = Infinity;
  /** How many searches have jumped. */
  jumps = 0;
  constructor(
    private readonly skin: MeshSkin,
    private readonly clips: readonly AnimationClip[],
    readonly db: MatchDatabase,
    private readonly loops: readonly boolean[] = [],
    /** Seconds between searches. */
    private readonly interval = 0.1,
    /** A jump must beat the frame playing by this much of its cost. */
    private readonly hysteresis = 0.9,
  ) {}

  /**
   * Advance by `dt` with the trajectory asked for; returns whether it jumped
   * (the caller crossfades into the new clip and time).
   */
  update(dt: number, trajectory: readonly TrajectoryPoint[]): boolean {
    if (this.clip >= 0) {
      const clip = this.clips[this.clip]!;
      this.time += dt;
      if (this.time > clip.duration) this.time = this.loops[this.clip] ? this.time % clip.duration : clip.duration;
    }
    this.sinceSearch += dt;
    if (this.sinceSearch < this.interval && this.clip >= 0) return false;
    this.sinceSearch = 0;
    const raw = new Float64Array(this.db.size);
    const loop = this.loops[this.clip] ?? false;
    const pose = this.clip >= 0 ? sampleClip(this.skin, this.clips[this.clip]!, this.time, loop) : null;
    // The pose a database frame before, as the database measured its velocities.
    let k = pose ? poseFeatures(this.skin, this.db.setup, sampleClip(this.skin, this.clips[this.clip]!, loop ? this.time - 1 / MATCH_RATE : Math.max(0, this.time - 1 / MATCH_RATE), loop), pose, 1 / MATCH_RATE, raw) : this.db.setup.feet.length * 6 + 3;
    for (const p of trajectory) {
      raw.set([p.x, p.z, p.dx, p.dz], k);
      k += 4;
    }
    const query = normaliseQuery(this.db, raw);
    // Without a pose yet, only the trajectory counts.
    if (!pose) query.fill(0, 0, this.db.setup.feet.length * 6 + 3);
    const best = nearestFrame(this.db, query);
    if (best.frame < 0) return false;
    // Keep playing when the frame now is nearly as good (or is the one found).
    const nowFrame = this.frameNow();
    if (nowFrame >= 0 && (nowFrame === best.frame || frameCost(this.db, nowFrame, query) * this.hysteresis <= best.cost)) return false;
    this.clip = this.db.clip[best.frame]!;
    this.time = this.db.time[best.frame]!;
    this.jumps += 1;
    return true;
  }

  /** The database frame nearest what's playing, or −1. */
  private frameNow(): number {
    if (this.clip < 0) return -1;
    let best = -1;
    let gap = Infinity;
    for (let f = 0; f < this.db.clip.length; f += 1) {
      if (this.db.clip[f] !== this.clip) continue;
      const d = Math.abs(this.db.time[f]! - this.time);
      if (d < gap) {
        gap = d;
        best = f;
      }
    }
    return gap <= 1 / MATCH_RATE ? best : -1;
  }
}

/**
 * A skeleton's matching setup by its joints' names: the first root, the hips
 * (`hips` or `pelvis`; else the root's first child), and the feet (`foot` or
 * `ankle`, one each side). Null when it has no two feet.
 */
export function matchSetupFor(skin: MeshSkin): MatchSetup | null {
  const names = skin.joints.map((j) => j.name.toLowerCase());
  const root = skin.joints.findIndex((j) => j.parent < 0);
  if (root < 0) return null;
  let hips = names.findIndex((n) => /hips?$|pelvis/.test(n) && !/thigh/.test(n));
  if (hips < 0) hips = skin.joints.findIndex((j) => j.parent === root);
  const feet = names.flatMap((n, j) => (/foot|ankle/.test(n) && !/toe|ball|end/.test(n) ? [j] : [])).slice(0, 2);
  if (hips < 0 || feet.length < 2) return null;
  return { root, hips, feet };
}
