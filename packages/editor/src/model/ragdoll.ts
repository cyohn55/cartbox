/**
 * Ragdolls (HALO2_STYLE_ROADMAP.md, H9): a killed soldier goes limp and tumbles.
 *
 * Cosmetic and local by design. The body is a small Verlet simulation of its
 * own — a particle at each joint of the skeleton, held together by distance
 * constraints — kept apart from the physics world, so it never feeds back into
 * the game: online play (and the deterministic physics mode's checksum) is
 * unaffected however each browser's copy of a corpse lands.
 *
 * - Bones keep their length; siblings (hip to hip, shoulder to shoulder, spine
 *   to each thigh) keep theirs, so the torso stays rigid; and each joint stays
 *   between 60% and 100% of its rest distance from its grandparent, so a knee
 *   or an elbow bends but never folds flat or hyperextends.
 * - Particles collide with boxes (the level) with friction, and the body goes
 *   to sleep once it has settled.
 * - Each frame the skeleton's pose is rebuilt from the particles: a joint turns
 *   so it points at its child (a joint with several children, like the hips or
 *   the chest, is fitted to all of them), and a leaf joint (head, forearm,
 *   foot) keeps its angle to its parent. The skinned mesh then draws as usual.
 *
 * Pure and DOM-free: the player runs it, the tests check it.
 */

import type { Mat4 } from "../render/meshRasterizer";
import type { MeshAsset } from "./MeshAsset";
import { POSE_STRIDE, jointWorldMatrices, restPose, type MeshSkin } from "./skeleton";

type V3 = [number, number, number];
type Q = [number, number, number, number];

/** A collider the body lands on: an oriented box (axes unit length). */
export interface RagdollBox {
  readonly center: readonly [number, number, number];
  readonly half: readonly [number, number, number];
  /** Unit axes; absent = the world axes (an axis-aligned box). */
  readonly axes?: readonly [readonly [number, number, number], readonly [number, number, number], readonly [number, number, number]];
}

export interface RagdollOptions {
  /** Velocity given to the body when it goes limp (world units per second). */
  readonly impulse?: readonly [number, number, number];
  /** The joint the impulse centres on (it falls off with distance along the skeleton); -1 = even. */
  readonly joint?: number;
  /** Gravity, world units per second² (downward). Default 9.81. */
  readonly gravity?: number;
  /** Each joint's collision radius in mesh units (see {@link ragdollRadii}); absent = 0.08 each. */
  readonly radii?: ArrayLike<number>;
}

/** Constraint iterations per step: enough to keep the limbs stiff at 60 steps a second. */
export const RAGDOLL_ITERATIONS = 10;
/** Velocity kept per step (air drag). */
export const RAGDOLL_DAMPING = 0.995;
/** Tangential velocity lost on a contact (0 = ice, 1 = glue). */
export const RAGDOLL_FRICTION = 0.4;
/** A body asleep after this long settled (steps). */
export const RAGDOLL_SETTLE_STEPS = 45;
/** Or after this long (seconds), wherever it is. */
export const RAGDOLL_MAX_LIFE = 10;
/** Particles below this height stop the body (it fell off the world). */
export const RAGDOLL_KILL_Y = -120;

const EPS = 1e-9;
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a: V3) => Math.sqrt(dot(a, a));
const norm = (a: V3): V3 => {
  const l = len(a);
  return l > EPS ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0];
};
const qmul = (a: Q, b: Q): Q => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
];
const qconj = (q: Q): Q => [-q[0], -q[1], -q[2], q[3]];
const qnorm = (q: Q): Q => {
  const l = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  return [q[0] / l, q[1] / l, q[2] / l, q[3] / l];
};
function qrot(q: Q, v: V3): V3 {
  const r = qmul(qmul(q, [v[0], v[1], v[2], 0]), qconj(q));
  return [r[0], r[1], r[2]];
}
/** The rotation taking unit vector a onto unit vector b. */
function qFromTo(a: V3, b: V3): Q {
  const d = dot(a, b);
  if (d < -0.999999) {
    let axis = cross([1, 0, 0], a);
    if (len(axis) < 1e-6) axis = cross([0, 1, 0], a);
    const n = norm(axis);
    return [n[0], n[1], n[2], 0];
  }
  const c = cross(a, b);
  return qnorm([c[0], c[1], c[2], 1 + d]);
}
/** A rotation from a 3×3 given as three unit columns. */
function qFromBasis(x: V3, y: V3, z: V3): Q {
  const [m00, m10, m20] = x;
  const [m01, m11, m21] = y;
  const [m02, m12, m22] = z;
  const tr = m00 + m11 + m22;
  if (tr > 0) {
    const s = Math.sqrt(tr + 1) * 2;
    return qnorm([(m21 - m12) / s, (m02 - m20) / s, (m10 - m01) / s, s / 4]);
  }
  if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    return qnorm([s / 4, (m01 + m10) / s, (m02 + m20) / s, (m21 - m12) / s]);
  }
  if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    return qnorm([(m01 + m10) / s, s / 4, (m12 + m21) / s, (m02 - m20) / s]);
  }
  const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
  return qnorm([(m02 + m20) / s, (m12 + m21) / s, s / 4, (m10 - m01) / s]);
}
/** The rotation part of a column-major matrix (columns normalised: scale stripped). */
function qFromMat(m: ArrayLike<number>, o = 0): Q {
  return qFromBasis(norm([m[o]!, m[o + 1]!, m[o + 2]!]), norm([m[o + 4]!, m[o + 5]!, m[o + 6]!]), norm([m[o + 8]!, m[o + 9]!, m[o + 10]!]));
}
/** An orthonormal frame from a primary direction and a secondary one. */
function frame(a: V3, b: V3): [V3, V3, V3] | null {
  const e1 = norm(a);
  const e2 = norm(sub(b, [e1[0] * dot(b, e1), e1[1] * dot(b, e1), e1[2] * dot(b, e1)]));
  if (len(e1) < 0.5 || len(e2) < 0.5) return null;
  return [e1, e2, cross(e1, e2)];
}
const apply = (m: ArrayLike<number>, p: readonly number[]): V3 => [
  m[0]! * p[0]! + m[4]! * p[1]! + m[8]! * p[2]! + m[12]!,
  m[1]! * p[0]! + m[5]! * p[1]! + m[9]! * p[2]! + m[13]!,
  m[2]! * p[0]! + m[6]! * p[1]! + m[10]! * p[2]! + m[14]!,
];
function invert(m: ArrayLike<number>): Float64Array | null {
  const a = Array.from({ length: 16 }, (_, i) => m[i]!);
  const [a00, a01, a02, a03, a10, a11, a12, a13, a20, a21, a22, a23, a30, a31, a32, a33] = a as [number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number];
  const b00 = a00 * a11 - a01 * a10;
  const b01 = a00 * a12 - a02 * a10;
  const b02 = a00 * a13 - a03 * a10;
  const b03 = a01 * a12 - a02 * a11;
  const b04 = a01 * a13 - a03 * a11;
  const b05 = a02 * a13 - a03 * a12;
  const b06 = a20 * a31 - a21 * a30;
  const b07 = a20 * a32 - a22 * a30;
  const b08 = a20 * a33 - a23 * a30;
  const b09 = a21 * a32 - a22 * a31;
  const b10 = a21 * a33 - a23 * a31;
  const b11 = a22 * a33 - a23 * a32;
  const det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  if (Math.abs(det) < 1e-12) return null;
  const d = 1 / det;
  return Float64Array.from([
    (a11 * b11 - a12 * b10 + a13 * b09) * d,
    (a02 * b10 - a01 * b11 - a03 * b09) * d,
    (a31 * b05 - a32 * b04 + a33 * b03) * d,
    (a22 * b04 - a21 * b05 - a23 * b03) * d,
    (a12 * b08 - a10 * b11 - a13 * b07) * d,
    (a00 * b11 - a02 * b08 + a03 * b07) * d,
    (a32 * b02 - a30 * b05 - a33 * b01) * d,
    (a20 * b05 - a22 * b02 + a23 * b01) * d,
    (a10 * b10 - a11 * b08 + a13 * b06) * d,
    (a01 * b08 - a00 * b10 - a03 * b06) * d,
    (a30 * b04 - a31 * b02 + a33 * b00) * d,
    (a21 * b02 - a20 * b04 - a23 * b00) * d,
    (a11 * b07 - a10 * b09 - a12 * b06) * d,
    (a00 * b09 - a01 * b07 + a02 * b06) * d,
    (a31 * b01 - a30 * b03 - a32 * b00) * d,
    (a20 * b03 - a21 * b01 + a22 * b00) * d,
  ]);
}
function mul(a: ArrayLike<number>, b: ArrayLike<number>): Float64Array {
  const out = new Float64Array(16);
  for (let c = 0; c < 4; c += 1)
    for (let r = 0; r < 4; r += 1) out[c * 4 + r] = a[r]! * b[c * 4]! + a[4 + r]! * b[c * 4 + 1]! + a[8 + r]! * b[c * 4 + 2]! + a[12 + r]! * b[c * 4 + 3]!;
  return out;
}

interface Link {
  readonly a: number;
  readonly b: number;
  readonly min: number;
  readonly max: number;
}

/** One body gone limp: its particles, its constraints and the pose it died in. */
export class Ragdoll {
  /** Particle positions and last positions (world), 3 floats per joint. */
  readonly pos: Float64Array;
  private readonly prev: Float64Array;
  private readonly links: Link[] = [];
  private readonly kids: number[][];
  private readonly order: number[];
  /** The pose it died in (local, mesh space), and its joints' mesh-space matrices. */
  private readonly deathPose: Float32Array;
  private readonly deathRot: Q[];
  private readonly deathPos: V3[];
  private readonly deathWorld: Float64Array;
  private readonly toDeathMesh: Float64Array;
  /** Each particle's collision radius (world units), and the smallest. */
  private readonly radius: Float64Array;
  private readonly minRadius: number;
  private readonly gravity: number;
  private quiet = 0;
  private life = 0;
  /** Settled (or fell off the world): no longer stepped. */
  asleep = false;

  constructor(
    private readonly skin: MeshSkin,
    pose: Float32Array,
    world: Mat4,
    options: RagdollOptions = {},
  ) {
    const n = skin.joints.length;
    this.deathPose = Float32Array.from(pose);
    this.deathWorld = Float64Array.from(world);
    this.toDeathMesh = invert(world) ?? Float64Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    const mats = jointWorldMatrices(skin, pose);
    this.deathRot = [];
    this.deathPos = [];
    this.pos = new Float64Array(n * 3);
    this.prev = new Float64Array(n * 3);
    for (let j = 0; j < n; j += 1) {
      const p: V3 = [mats[j * 16 + 12]!, mats[j * 16 + 13]!, mats[j * 16 + 14]!];
      this.deathPos.push(p);
      this.deathRot.push(qFromMat(mats, j * 16));
      const w = apply(world, p);
      this.pos.set(w, j * 3);
      this.prev.set(w, j * 3);
    }
    // Hierarchy: children lists, and an order with parents first.
    this.kids = Array.from({ length: n }, () => [] as number[]);
    skin.joints.forEach((joint, j) => {
      if (joint.parent >= 0 && joint.parent < n && joint.parent !== j) this.kids[joint.parent]!.push(j);
    });
    this.order = [];
    const seen = new Uint8Array(n);
    const visit = (j: number) => {
      if (seen[j]) return;
      seen[j] = 1;
      this.order.push(j);
      for (const c of this.kids[j]!) visit(c);
    };
    skin.joints.forEach((joint, j) => {
      if (joint.parent < 0 || joint.parent >= n) visit(j);
    });
    for (let j = 0; j < n; j += 1) visit(j);
    // Constraints, from the rest distances in the death pose (in world units).
    const dist = (a: number, b: number) => len(sub(this.at(a), this.at(b)));
    const link = (a: number, b: number, lo: number, hi: number) => {
      const d = dist(a, b);
      if (d > 1e-4) this.links.push({ a, b, min: d * lo, max: d * hi });
    };
    for (let j = 0; j < n; j += 1) {
      const p = skin.joints[j]!.parent;
      if (p < 0 || p >= n) continue;
      link(j, p, 1, 1); // the bone
      const g = skin.joints[p]!.parent;
      if (g >= 0 && g < n) link(j, g, 0.6, 1); // bends, never folds flat or overextends
    }
    for (const siblings of this.kids)
      for (let a = 0; a < siblings.length; a += 1) for (let b = a + 1; b < siblings.length; b += 1) link(siblings[a]!, siblings[b]!, 1, 1);
    // Scale: the world matrix's scale sets the particle size and the "settled" threshold.
    const s = Math.cbrt(Math.abs(world[0]! * (world[5]! * world[10]! - world[6]! * world[9]!) - world[4]! * (world[1]! * world[10]! - world[2]! * world[9]!) + world[8]! * (world[1]! * world[6]! - world[2]! * world[5]!))) || 1;
    this.radius = Float64Array.from({ length: n }, (_, j) => (options.radii?.[j] ?? 0.08) * s);
    this.minRadius = Math.min(...this.radius);
    this.gravity = options.gravity ?? 9.81;
    // The shove: the impulse's full strength at the hit joint, falling off along the skeleton.
    const impulse = options.impulse ?? [0, 0, 0];
    if (impulse[0] !== 0 || impulse[1] !== 0 || impulse[2] !== 0) {
      const hops = this.hops(options.joint ?? -1);
      const dt = 1 / 60;
      for (let j = 0; j < n; j += 1) {
        const w = hops ? 0.35 + 0.65 * Math.pow(0.5, hops[j]!) : 1;
        for (let k = 0; k < 3; k += 1) this.prev[j * 3 + k] = this.pos[j * 3 + k]! - impulse[k]! * dt * w;
      }
    }
  }

  /** Joint `j`'s particle (world). */
  at(j: number): V3 {
    return [this.pos[j * 3]!, this.pos[j * 3 + 1]!, this.pos[j * 3 + 2]!];
  }

  /** Steps along the skeleton from `joint` to every joint, or null for none. */
  private hops(joint: number): number[] | null {
    const n = this.skin.joints.length;
    if (joint < 0 || joint >= n) return null;
    const out = new Array<number>(n).fill(Infinity);
    out[joint] = 0;
    const queue = [joint];
    while (queue.length > 0) {
      const j = queue.shift()!;
      const next = [...this.kids[j]!, this.skin.joints[j]!.parent].filter((k) => k >= 0 && k < n);
      for (const k of next) {
        if (out[k] !== Infinity) continue;
        out[k] = out[j]! + 1;
        queue.push(k);
      }
    }
    return out.map((h) => (Number.isFinite(h) ? h : n));
  }

  /** Advance one step (seconds); returns whether it is still awake. */
  step(dt: number, colliders: readonly RagdollBox[]): boolean {
    if (this.asleep) return false;
    const n = this.skin.joints.length;
    const g = this.gravity * dt * dt;
    let moved = 0;
    for (let j = 0; j < n; j += 1) {
      const o = j * 3;
      for (let k = 0; k < 3; k += 1) {
        const p = this.pos[o + k]!;
        const v = (p - this.prev[o + k]!) * RAGDOLL_DAMPING;
        this.prev[o + k] = p;
        this.pos[o + k] = p + v - (k === 1 ? g : 0);
      }
    }
    const contact = new Uint8Array(n);
    for (let it = 0; it < RAGDOLL_ITERATIONS; it += 1) {
      for (const l of this.links) this.satisfy(l);
      for (let j = 0; j < n; j += 1) if (this.collide(j, colliders)) contact[j] = 1;
    }
    for (let j = 0; j < n; j += 1) {
      const o = j * 3;
      const v: V3 = [this.pos[o]! - this.prev[o]!, this.pos[o + 1]! - this.prev[o + 1]!, this.pos[o + 2]! - this.prev[o + 2]!];
      moved = Math.max(moved, len(v));
      // Friction on a contact: lose some of the sliding (not the vertical, which the push-out handles).
      if (contact[j]) {
        this.prev[o] = this.pos[o]! - v[0] * (1 - RAGDOLL_FRICTION);
        this.prev[o + 2] = this.pos[o + 2]! - v[2] * (1 - RAGDOLL_FRICTION);
      }
      if (this.pos[o + 1]! < RAGDOLL_KILL_Y) this.asleep = true;
    }
    this.life += dt;
    this.quiet = moved < this.minRadius * 0.02 ? this.quiet + 1 : 0;
    if (this.quiet >= RAGDOLL_SETTLE_STEPS || this.life >= RAGDOLL_MAX_LIFE) this.asleep = true;
    return !this.asleep;
  }

  private satisfy(l: Link): void {
    const a = l.a * 3;
    const b = l.b * 3;
    const dx = this.pos[b]! - this.pos[a]!;
    const dy = this.pos[b + 1]! - this.pos[a + 1]!;
    const dz = this.pos[b + 2]! - this.pos[a + 2]!;
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (d < EPS) return;
    const target = d < l.min ? l.min : d > l.max ? l.max : d;
    if (target === d) return;
    const k = ((d - target) / d) * 0.5;
    this.pos[a] = this.pos[a]! + dx * k;
    this.pos[a + 1] = this.pos[a + 1]! + dy * k;
    this.pos[a + 2] = this.pos[a + 2]! + dz * k;
    this.pos[b] = this.pos[b]! - dx * k;
    this.pos[b + 1] = this.pos[b + 1]! - dy * k;
    this.pos[b + 2] = this.pos[b + 2]! - dz * k;
  }

  /** Push joint j's particle out of any box it is inside; returns whether it touched one. */
  private collide(j: number, colliders: readonly RagdollBox[]): boolean {
    const o = j * 3;
    const r = this.radius[j]!;
    let touched = false;
    for (const box of colliders) {
      const axes = box.axes ?? ([[1, 0, 0], [0, 1, 0], [0, 0, 1]] as const);
      const rel: V3 = [this.pos[o]! - box.center[0], this.pos[o + 1]! - box.center[1], this.pos[o + 2]! - box.center[2]];
      let best = Infinity;
      let axis = -1;
      let sign = 1;
      let inside = true;
      for (let a = 0; a < 3; a += 1) {
        const d = dot(rel, axes[a] as V3);
        const pen = box.half[a]! + r - Math.abs(d);
        if (pen <= 0) {
          inside = false;
          break;
        }
        if (pen < best) {
          best = pen;
          axis = a;
          sign = d >= 0 ? 1 : -1;
        }
      }
      if (!inside || axis < 0) continue;
      const n = axes[axis]!;
      this.pos[o] = this.pos[o]! + n[0] * best * sign;
      this.pos[o + 1] = this.pos[o + 1]! + n[1] * best * sign;
      this.pos[o + 2] = this.pos[o + 2]! + n[2] * best * sign;
      touched = true;
    }
    return touched;
  }

  /**
   * The body's pose now (local, mesh space, {@link POSE_STRIDE} floats per
   * joint), for an object whose world matrix is `world` this frame — so the
   * corpse stays where it fell even if the object is moved.
   */
  writePose(out: Float32Array, world: Mat4): void {
    const n = this.skin.joints.length;
    out.set(this.deathPose.subarray(0, n * POSE_STRIDE));
    // The particles in the death pose's mesh space.
    const cur: V3[] = [];
    for (let j = 0; j < n; j += 1) cur.push(apply(this.toDeathMesh, [this.pos[j * 3]!, this.pos[j * 3 + 1]!, this.pos[j * 3 + 2]!]));
    const rot: Q[] = new Array(n);
    const dir = (from: V3[], a: number, b: number) => norm(sub(from[b]!, from[a]!));
    for (const j of this.order) {
      const p = this.skin.joints[j]!.parent;
      const parentTurn: Q = p >= 0 && p < n && rot[p] ? qmul(rot[p]!, qconj(this.deathRot[p]!)) : [0, 0, 0, 1];
      const inherited = qmul(parentTurn, this.deathRot[j]!);
      const kids = this.kids[j]!;
      let q = inherited;
      if (kids.length >= 2) {
        // Fitted to its children: the first for the main direction, the spread of the others for the twist.
        const a0 = dir(this.deathPos, j, kids[0]!);
        const a1 = dir(cur, j, kids[0]!);
        const b0 = kids.length >= 3 ? sub(this.deathPos[kids[2]!]!, this.deathPos[kids[1]!]!) : dir(this.deathPos, j, kids[1]!);
        const b1 = kids.length >= 3 ? sub(cur[kids[2]!]!, cur[kids[1]!]!) : dir(cur, j, kids[1]!);
        const f0 = frame(a0, b0);
        const f1 = frame(a1, b1);
        if (f0 && f1) {
          // R = F1 · F0ᵀ, applied to the death rotation.
          const col = (c: number): V3 => {
            const k = [f0[0][c]!, f0[1][c]!, f0[2][c]!];
            return [
              f1[0][0] * k[0]! + f1[1][0] * k[1]! + f1[2][0] * k[2]!,
              f1[0][1] * k[0]! + f1[1][1] * k[1]! + f1[2][1] * k[2]!,
              f1[0][2] * k[0]! + f1[1][2] * k[1]! + f1[2][2] * k[2]!,
            ];
          };
          q = qmul(qFromBasis(col(0), col(1), col(2)), this.deathRot[j]!);
        }
      } else if (kids.length === 1) {
        // Swung to point at its child, twist carried from its parent.
        const predicted = qrot(parentTurn, dir(this.deathPos, j, kids[0]!));
        const now = dir(cur, j, kids[0]!);
        if (len(predicted) > 0.5 && len(now) > 0.5) q = qmul(qFromTo(predicted, now), inherited);
      }
      rot[j] = qnorm(q);
    }
    // Local rotations; the roots also take the hips' place, moved into this frame's mesh space.
    const toNow = mul(invert(world) ?? new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]), this.deathWorld);
    for (let j = 0; j < n; j += 1) {
      const joint = this.skin.joints[j]!;
      const o = j * POSE_STRIDE;
      let local: Q;
      if (joint.parent >= 0 && joint.parent < n) local = qmul(qconj(rot[joint.parent]!), rot[j]!);
      else {
        const qnow = qmul(qFromMat(toNow), rot[j]!);
        const t = apply(toNow, cur[j]!);
        const base = joint.base && joint.base.length === 16 ? invert(joint.base) : null;
        if (base) {
          local = qmul(qconj(qFromMat(joint.base!)), qnow);
          const lt = apply(base, t);
          out[o] = lt[0];
          out[o + 1] = lt[1];
          out[o + 2] = lt[2];
        } else {
          local = qnow;
          out[o] = t[0];
          out[o + 1] = t[1];
          out[o + 2] = t[2];
        }
      }
      const l = qnorm(local);
      out[o + 3] = l[0];
      out[o + 4] = l[1];
      out[o + 5] = l[2];
      out[o + 6] = l[3];
    }
  }
}

/** Axis-aligned boxes as ragdoll colliders, from [centre x, y, z, half x, y, z] rows. */
export function ragdollBoxesFromCentreHalf(rows: readonly (readonly number[])[]): RagdollBox[] {
  return rows.map((r) => ({ center: [r[0]!, r[1]!, r[2]!], half: [Math.abs(r[3]!), Math.abs(r[4]!), Math.abs(r[5]!)] }));
}

/**
 * Each joint's collision radius (mesh units), from the geometry bound to it: the
 * mean distance of its vertices from the bone (joint → child, or the joint alone
 * for a leaf, capped at a little over its parent's) at rest — so a chest plate
 * rests on the floor rather than sinking into it, and a forearm lies close to
 * it. Clamped to 0.03..0.35.
 */
export function ragdollRadii(mesh: MeshAsset): Float64Array | null {
  const skin = mesh.skin;
  if (!skin) return null;
  const n = skin.joints.length;
  const mats = jointWorldMatrices(skin, restPose(skin));
  const at = (j: number): V3 => [mats[j * 16 + 12]!, mats[j * 16 + 13]!, mats[j * 16 + 14]!];
  const child = new Array<number>(n).fill(-1);
  skin.joints.forEach((joint, j) => {
    if (joint.parent >= 0 && joint.parent < n && child[joint.parent] === -1) child[joint.parent] = j;
  });
  const sum = new Float64Array(n);
  const count = new Float64Array(n);
  for (const prim of mesh.primitives) {
    const joints = (prim as { joints?: Uint16Array | null }).joints;
    const weights = (prim as { weights?: Float32Array | null }).weights;
    if (!joints || !weights) continue;
    const verts = prim.positions.length / 3;
    for (let v = 0; v < verts; v += 1) {
      let best = 0;
      for (let k = 1; k < 4; k += 1) if (weights[v * 4 + k]! > weights[v * 4 + best]!) best = k;
      const j = joints[v * 4 + best]!;
      if (j >= n) continue;
      const p: V3 = [prim.positions[v * 3]!, prim.positions[v * 3 + 1]!, prim.positions[v * 3 + 2]!];
      const a = at(j);
      const c = child[j]! >= 0 ? at(child[j]!) : a;
      const ab = sub(c, a);
      const t = dot(ab, ab) > EPS ? Math.max(0, Math.min(1, dot(sub(p, a), ab) / dot(ab, ab))) : 0;
      sum[j] = sum[j]! + len(sub(p, [a[0] + ab[0] * t, a[1] + ab[1] * t, a[2] + ab[2] * t]));
      count[j] = count[j]! + 1;
    }
  }
  const radii = Float64Array.from({ length: n }, (_, j) => Math.max(0.03, Math.min(0.35, count[j]! > 0 ? (sum[j]! / count[j]!) * 0.9 : 0.08)));
  // A leaf's geometry reaches past its one point (a hand, a held rifle), which
  // overstates its thickness: it is no thicker than a little over its parent.
  skin.joints.forEach((joint, j) => {
    if (child[j] === -1 && joint.parent >= 0 && joint.parent < n) radii[j] = Math.min(radii[j]!, radii[joint.parent]! * 1.2);
  });
  return radii;
}

/** At most this many authored ragdoll colliders on a scene. */
export const MAX_RAGDOLL_COLLIDERS = 256;

/** Read authored ragdoll colliders (boxes: centre, half extents) defensively. */
export function parseRagdollColliders(value: unknown): RagdollBox[] {
  if (!Array.isArray(value)) return [];
  const triple = (v: unknown): [number, number, number] | null =>
    Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === "number" && Number.isFinite(n)) ? [v[0], v[1], v[2]] : null;
  const out: RagdollBox[] = [];
  for (const raw of value) {
    if (out.length >= MAX_RAGDOLL_COLLIDERS) break;
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const center = triple(r.center);
    const half = triple(r.half);
    if (!center || !half) continue;
    out.push({ center, half: [Math.abs(half[0]), Math.abs(half[1]), Math.abs(half[2])] });
  }
  return out;
}
