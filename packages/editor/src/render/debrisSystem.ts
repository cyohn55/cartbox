/**
 * The runtime side of cosmetic debris (HALO2_STYLE_ROADMAP.md, H10): each copy
 * a small rigid body, simulated on this machine only.
 *
 * A copy is the eight corners of its mesh's bounding box as Verlet particles,
 * every pair held at its distance so the box stays rigid. The corners collide
 * with the colliders (ragdoll.ts's boxes: the level) — pushed out, bouncing
 * off with the definition's `bounce`, losing `friction` of their sliding — so a
 * casing tumbles and skitters and a dropped rifle lands on its side and rocks
 * to rest. Its orientation is read back from the corners each frame. It sleeps
 * once settled, and shrinks away over the last half second of its life.
 */

import type { DebrisDef } from "../model/debris";
import { meshBounds, type MeshAsset } from "../model/MeshAsset";
import { pushOutOfBoxes, type RagdollBox } from "../model/ragdoll";
import type { Mat4, MeshSceneInstance } from "./meshRasterizer";

type V3 = [number, number, number];

/** Gravity, world units per second². */
export const DEBRIS_GRAVITY = 9.81;
/** Constraint iterations per step. */
const ITERATIONS = 6;
/** Seconds over which a copy shrinks away at the end of its life. */
export const DEBRIS_FADE = 0.5;
/** Velocity kept per step (air drag). */
const DAMPING = 0.998;

interface Piece {
  readonly def: number;
  readonly pos: Float64Array;
  readonly prev: Float64Array;
  readonly scale: number;
  age: number;
  asleep: boolean;
  quiet: number;
}

interface DefShape {
  readonly def: DebrisDef;
  readonly mesh: MeshAsset;
  /** The mesh's box (local units): centre and half extents (each at least a little, so a flat mesh still has a box). */
  readonly centre: V3;
  readonly half: V3;
  /** Rest distances between every pair of corners, at unit scale. */
  readonly rest: Float64Array;
}

const CORNER = (i: number, h: V3): V3 => [(i & 1 ? 1 : -1) * h[0], (i & 2 ? 1 : -1) * h[1], (i & 4 ? 1 : -1) * h[2]];

/** A small deterministic generator, so a replay throws debris the same way. */
function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}

export class DebrisSystem {
  private readonly shapes: (DefShape | null)[];
  private pieces: Piece[] = [];
  private readonly random = rng(0x9e3779b9);

  /** `meshes[i]` is definition i's mesh (null = it has none and throws nothing). */
  constructor(
    readonly defs: readonly DebrisDef[],
    meshes: readonly (MeshAsset | null)[],
  ) {
    this.shapes = defs.map((def, i) => {
      const mesh = meshes[i] ?? null;
      const b = mesh ? meshBounds(mesh) : null;
      if (!mesh || !b) return null;
      const centre: V3 = [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2];
      const size = Math.max(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2], 1e-3);
      const half: V3 = [0, 1, 2].map((k) => Math.max((b.max[k]! - b.min[k]!) / 2, size * 0.08)) as V3;
      const rest = new Float64Array(64);
      for (let a = 0; a < 8; a += 1)
        for (let c = 0; c < 8; c += 1) {
          const pa = CORNER(a, half);
          const pc = CORNER(c, half);
          rest[a * 8 + c] = Math.hypot(pa[0] - pc[0], pa[1] - pc[1], pa[2] - pc[2]);
        }
      return { def, mesh, centre, half, rest };
    });
  }

  /** Definition `name`'s index (or -1). */
  indexOf(name: string): number {
    return this.defs.findIndex((d) => d.name === name);
  }

  /** Copies alive. */
  count(): number {
    return this.pieces.length;
  }

  /**
   * Throw a copy of definition `def` from `at` with velocity `v` (world units
   * per second), turned `yaw` radians about the vertical, spun a little at
   * random (more the faster it's thrown), at `scale`.
   */
  throw(def: number, at: readonly [number, number, number], v: readonly [number, number, number], scale = 1, yaw = Math.atan2(v[0], v[2])): void {
    const shape = this.shapes[def];
    if (!shape || !(scale > 0)) return;
    // Past the definition's cap, the oldest copy of it makes way.
    const own = this.pieces.filter((p) => p.def === def);
    if (own.length >= shape.def.max) this.pieces.splice(this.pieces.indexOf(own[0]!), 1);
    const speed = Math.hypot(v[0], v[1], v[2]);
    const spin: V3 = [0, 1, 2].map(() => (this.random() - 0.5) * (4 + speed * 3)) as V3;
    const c = Math.cos(yaw);
    const s = Math.sin(yaw);
    const pos = new Float64Array(24);
    const prev = new Float64Array(24);
    const dt = 1 / 60;
    for (let i = 0; i < 8; i += 1) {
      const l = CORNER(i, shape.half);
      // Local corner → turned about Y → scaled → placed.
      const r: V3 = [(l[0] * c + l[2] * s) * scale, l[1] * scale, (-l[0] * s + l[2] * c) * scale];
      const w: V3 = [at[0] + r[0], at[1] + r[1], at[2] + r[2]];
      // Each corner's velocity: the throw plus the spin about the centre (ω × r).
      const vel: V3 = [v[0] + spin[1] * r[2] - spin[2] * r[1], v[1] + spin[2] * r[0] - spin[0] * r[2], v[2] + spin[0] * r[1] - spin[1] * r[0]];
      pos.set(w, i * 3);
      prev.set([w[0] - vel[0] * dt, w[1] - vel[1] * dt, w[2] - vel[2] * dt], i * 3);
    }
    this.pieces.push({ def, pos, prev, scale, age: 0, asleep: false, quiet: 0 });
  }

  /** Advance every copy by `dt` seconds; those past their life go. */
  step(dt: number, colliders: readonly RagdollBox[]): void {
    const g = DEBRIS_GRAVITY * dt * dt;
    this.pieces = this.pieces.filter((p) => {
      p.age += dt;
      const shape = this.shapes[p.def]!;
      if (p.age >= shape.def.life) return false;
      if (!p.asleep) this.stepPiece(p, shape, g, colliders);
      return true;
    });
  }

  private stepPiece(p: Piece, shape: DefShape, g: number, colliders: readonly RagdollBox[]): void {
    const { pos, prev } = p;
    for (let i = 0; i < 24; i += 1) {
      const x = pos[i]!;
      const v = (x - prev[i]!) * DAMPING;
      prev[i] = x;
      pos[i] = x + v - (i % 3 === 1 ? g : 0);
    }
    const r = 0.004 * p.scale;
    const hit = new Array<V3 | null>(8).fill(null);
    for (let it = 0; it < ITERATIONS; it += 1) {
      for (let a = 0; a < 8; a += 1)
        for (let b = a + 1; b < 8; b += 1) {
          const target = shape.rest[a * 8 + b]! * p.scale;
          const dx = pos[b * 3]! - pos[a * 3]!;
          const dy = pos[b * 3 + 1]! - pos[a * 3 + 1]!;
          const dz = pos[b * 3 + 2]! - pos[a * 3 + 2]!;
          const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
          if (d < 1e-9) continue;
          const k = ((d - target) / d) * 0.5;
          pos[a * 3] = pos[a * 3]! + dx * k;
          pos[a * 3 + 1] = pos[a * 3 + 1]! + dy * k;
          pos[a * 3 + 2] = pos[a * 3 + 2]! + dz * k;
          pos[b * 3] = pos[b * 3]! - dx * k;
          pos[b * 3 + 1] = pos[b * 3 + 1]! - dy * k;
          pos[b * 3 + 2] = pos[b * 3 + 2]! - dz * k;
        }
      for (let i = 0; i < 8; i += 1) {
        const n = pushOutOfBoxes(pos, i * 3, r, colliders);
        if (n) hit[i] = n;
      }
    }
    // Contacts: bounce off the surface, lose some sliding.
    let moved = 0;
    for (let i = 0; i < 8; i += 1) {
      const o = i * 3;
      const v: V3 = [pos[o]! - prev[o]!, pos[o + 1]! - prev[o + 1]!, pos[o + 2]! - prev[o + 2]!];
      const n = hit[i];
      if (n) {
        const vn = v[0] * n[0] + v[1] * n[1] + v[2] * n[2];
        const t: V3 = [v[0] - n[0] * vn, v[1] - n[1] * vn, v[2] - n[2] * vn];
        const out = vn < 0 ? -vn * shape.def.bounce : vn;
        const keep = 1 - shape.def.friction;
        const nv: V3 = [t[0] * keep + n[0] * out, t[1] * keep + n[1] * out, t[2] * keep + n[2] * out];
        prev[o] = pos[o]! - nv[0];
        prev[o + 1] = pos[o + 1]! - nv[1];
        prev[o + 2] = pos[o + 2]! - nv[2];
      }
      moved = Math.max(moved, Math.hypot(v[0], v[1], v[2]));
      if (pos[o + 1]! < -150) p.asleep = true;
    }
    p.quiet = moved < 0.0015 * p.scale ? p.quiet + 1 : 0;
    if (p.quiet >= 30) p.asleep = true;
  }

  /** A copy's world matrix now: its box's frame from the corners, scaled (and shrinking at the end of its life). */
  private matrix(p: Piece, shape: DefShape): Mat4 {
    const at = (i: number): V3 => [p.pos[i * 3]!, p.pos[i * 3 + 1]!, p.pos[i * 3 + 2]!];
    const centre: V3 = [0, 0, 0];
    for (let i = 0; i < 8; i += 1) for (let k = 0; k < 3; k += 1) centre[k] = centre[k]! + at(i)[k]! / 8;
    // The box's axes: the mean of its four edges along each.
    const axis = (bit: number): V3 => {
      const a: V3 = [0, 0, 0];
      for (let i = 0; i < 8; i += 1) {
        if (i & bit) continue;
        const p0 = at(i);
        const p1 = at(i | bit);
        for (let k = 0; k < 3; k += 1) a[k] = a[k]! + p1[k]! - p0[k]!;
      }
      const l = Math.hypot(a[0], a[1], a[2]) || 1;
      return [a[0] / l, a[1] / l, a[2] / l];
    };
    const x = axis(1);
    let y = axis(2);
    const d = x[0] * y[0] + x[1] * y[1] + x[2] * y[2];
    y = [y[0] - x[0] * d, y[1] - x[1] * d, y[2] - x[2] * d];
    const ly = Math.hypot(y[0], y[1], y[2]) || 1;
    y = [y[0] / ly, y[1] / ly, y[2] / ly];
    const z: V3 = [x[1] * y[2] - x[2] * y[1], x[2] * y[0] - x[0] * y[2], x[0] * y[1] - x[1] * y[0]];
    const left = shape.def.life - p.age;
    const s = p.scale * (left < DEBRIS_FADE ? Math.max(0, left / DEBRIS_FADE) : 1);
    // world = T(centre) · R · S · T(−mesh box centre)
    const c = shape.centre;
    const tx = centre[0] - s * (x[0] * c[0] + y[0] * c[1] + z[0] * c[2]);
    const ty = centre[1] - s * (x[1] * c[0] + y[1] * c[1] + z[1] * c[2]);
    const tz = centre[2] - s * (x[2] * c[0] + y[2] * c[1] + z[2] * c[2]);
    return Float64Array.from([x[0] * s, x[1] * s, x[2] * s, 0, y[0] * s, y[1] * s, y[2] * s, 0, z[0] * s, z[1] * s, z[2] * s, 0, tx, ty, tz, 1]);
  }

  /** The copies to draw this frame, one scene instance each. */
  instances(): MeshSceneInstance[] {
    return this.pieces.map((p) => {
      const shape = this.shapes[p.def]!;
      return { mesh: shape.mesh, model: this.matrix(p, shape) };
    });
  }

  /** Copy `i`'s centre (world), for tests and tooling. */
  centreOf(i: number): [number, number, number] {
    const p = this.pieces[i]!;
    const c: [number, number, number] = [0, 0, 0];
    for (let k = 0; k < 8; k += 1) for (let a = 0; a < 3; a += 1) c[a] = c[a]! + p.pos[k * 3 + a]! / 8;
    return c;
  }

  /** Whether copy `i` has settled. */
  settled(i: number): boolean {
    return this.pieces[i]?.asleep ?? false;
  }

  /** Drop every copy. */
  clear(): void {
    this.pieces = [];
  }
}
