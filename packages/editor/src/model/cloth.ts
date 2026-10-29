/**
 * Cloth and secondary motion (AAA_FIDELITY_ROADMAP.md F7d): position-based
 * dynamics for a skinned primitive's cloth, and spring bones for the joints
 * that should trail (straps, antennas, a ponytail).
 *
 * - **Cloth** is a primitive's vertices as particles, in the mesh's space. Each
 *   step predicts them from their velocity, gravity and the wind, then pulls
 *   them toward their rest lengths along the triangles' edges (stretch) and
 *   across neighbouring triangles (bend). The solve is **Jacobi**: every
 *   particle averages its constraints' corrections from the same positions, so
 *   the GPU's compute pass (clothGpu.ts in @cartbox/player) runs it a thread a
 *   particle and lands where this does.
 * - **Skinned constraints:** each vertex keeps within its `maxDistance` of
 *   where skinning puts it: 0 pins it (a collar, a belt), more lets it swing (a
 *   hem). The skinned mesh is the cloth's rest shape and its anchor.
 * - **Colliders** are capsules along the skeleton's bones, sized as the
 *   ragdoll sizes them (`ragdollRadii`), so a cape slides over the shoulders
 *   and a skirt over the thighs.
 * - **Wind** pushes each particle by how squarely its surface faces it.
 * - **Spring bones** (as VRM's): each listed joint's tail is a Verlet
 *   particle, dragged, pulled back toward where the animation holds it, pulled
 *   by gravity, kept at the bone's length and out of the capsules; the joint
 *   then turns to point at it.
 */

import type { MeshAsset, MeshPrimitive } from "./MeshAsset";
import { POSE_STRIDE, jointWorldMatrices, type MeshSkin } from "./skeleton";

type V3 = [number, number, number];

/** A primitive's cloth: how far each vertex may leave its skinned place, and the material. */
export interface ClothSettings {
  /** Metres, a vertex: 0 pinned to the skin. */
  readonly maxDistance: Float32Array;
  /** Stretch stiffness 0..1 an iteration (default 1). */
  readonly stretch?: number;
  /** Bend stiffness 0..1 an iteration (default 0.3). */
  readonly bend?: number;
  /** Velocity lost a step, 0..1 (default 0.02). */
  readonly damping?: number;
  /** How strongly the wind moves it (default 1). */
  readonly windResponse?: number;
  /** The collision margin over the capsules, metres (default 0.01). */
  readonly thickness?: number;
}

/** The solver's constants. */
export const CLOTH_ITERATIONS = 16;
export const CLOTH_GRAVITY: V3 = [0, -9.81, 0];
/** Jacobi's over-relaxation: averaged corrections converge slowly without it. */
export const CLOTH_RELAX = 1.5;
/** At most this many capsules collide. */
export const MAX_CLOTH_CAPSULES = 64;

/** A capsule: its two ends and radius, in the mesh's space. */
export interface Capsule {
  readonly a: readonly [number, number, number];
  readonly b: readonly [number, number, number];
  readonly radius: number;
}

/**
 * A cloth's topology, as the solver walks it: for each particle, its
 * neighbours (`starts[i]..starts[i + 1]` index `entries`, each the neighbour,
 * the rest length, and 0 for stretch or 1 for bend), and each particle's
 * inverse mass (0 pinned).
 */
export interface ClothTopology {
  readonly count: number;
  readonly starts: Uint32Array;
  readonly entries: Float32Array;
  readonly invMass: Float32Array;
  readonly maxDistance: Float32Array;
}

/** A primitive's cloth topology: its edges, and the far corners of each pair of triangles sharing one. */
export function clothTopology(positions: Float32Array, indices: Uint32Array, settings: ClothSettings): ClothTopology {
  const count = positions.length / 3;
  const links = Array.from({ length: count }, () => new Map<number, number>());
  const add = (i: number, j: number, kind: number) => {
    if (i === j || links[i]!.has(j)) return;
    links[i]!.set(j, kind);
    links[j]!.set(i, kind);
  };
  // Each edge's triangles' third corners: two make a bend.
  const opposite = new Map<string, number[]>();
  for (let t = 0; t + 2 < indices.length; t += 3) {
    const tri = [indices[t]!, indices[t + 1]!, indices[t + 2]!];
    for (let e = 0; e < 3; e += 1) {
      const a = tri[e]!;
      const b = tri[(e + 1) % 3]!;
      add(a, b, 0);
      const key = a < b ? `${a},${b}` : `${b},${a}`;
      const list = opposite.get(key) ?? [];
      list.push(tri[(e + 2) % 3]!);
      opposite.set(key, list);
    }
  }
  for (const corners of opposite.values()) if (corners.length === 2) add(corners[0]!, corners[1]!, 1);
  const starts = new Uint32Array(count + 1);
  const rows: number[] = [];
  const at = (i: number): V3 => [positions[i * 3]!, positions[i * 3 + 1]!, positions[i * 3 + 2]!];
  for (let i = 0; i < count; i += 1) {
    starts[i] = rows.length / 4;
    for (const [j, kind] of [...links[i]!].sort((x, y) => x[0] - y[0])) {
      const a = at(i);
      const b = at(j);
      rows.push(j, Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]), kind, 0);
    }
  }
  starts[count] = rows.length / 4;
  const maxDistance = Float32Array.from({ length: count }, (_, i) => Math.max(0, settings.maxDistance[i] ?? 0));
  return { count, starts, entries: Float32Array.from(rows.length > 0 ? rows : [0, 0, 0, 0]), invMass: maxDistance.map((m) => (m > 0 ? 1 : 0)), maxDistance };
}

/** Push a point out of a capsule (by `margin` more), or leave it. */
export function pushOutOfCapsule(p: V3, c: Capsule, margin: number): V3 {
  const ab: V3 = [c.b[0] - c.a[0], c.b[1] - c.a[1], c.b[2] - c.a[2]];
  const ap: V3 = [p[0] - c.a[0], p[1] - c.a[1], p[2] - c.a[2]];
  const len2 = ab[0] * ab[0] + ab[1] * ab[1] + ab[2] * ab[2];
  const t = len2 > 1e-12 ? Math.max(0, Math.min(1, (ap[0] * ab[0] + ap[1] * ab[1] + ap[2] * ab[2]) / len2)) : 0;
  const q: V3 = [c.a[0] + ab[0] * t, c.a[1] + ab[1] * t, c.a[2] + ab[2] * t];
  const d: V3 = [p[0] - q[0], p[1] - q[1], p[2] - q[2]];
  const dist = Math.hypot(d[0], d[1], d[2]);
  const r = c.radius + margin;
  if (dist >= r) return p;
  const n: V3 = dist > 1e-9 ? [d[0] / dist, d[1] / dist, d[2] / dist] : [0, 1, 0];
  return [q[0] + n[0] * r, q[1] + n[1] * r, q[2] + n[2] * r];
}

/** A cloth's state: its particles now and a step ago (mesh space). */
export interface ClothState {
  readonly position: Float32Array;
  readonly previous: Float32Array;
}

/** A cloth at rest where skinning puts it. */
export function clothState(skinned: Float32Array): ClothState {
  return { position: skinned.slice(), previous: skinned.slice() };
}

/** What one step needs: the skinned positions (the anchors), normals for the wind, the colliders, the wind (m/s, mesh space). */
export interface ClothStepInput {
  readonly skinned: Float32Array;
  readonly normals: Float32Array | null;
  readonly capsules: readonly Capsule[];
  readonly wind: readonly [number, number, number];
  readonly dt: number;
  readonly iterations?: number;
}

/**
 * One step of the cloth (the GPU's, term for term): predict, then
 * `iterations` Jacobi sweeps over the constraints, each ending with the
 * skinned distance and the capsules.
 */
export function stepCloth(topology: ClothTopology, settings: ClothSettings, state: ClothState, input: ClothStepInput): void {
  const { count, starts, entries, invMass, maxDistance } = topology;
  const p = state.position;
  const prev = state.previous;
  const s = input.skinned;
  const dt = input.dt;
  const damping = settings.damping ?? 0.02;
  const response = settings.windResponse ?? 1;
  const stretch = settings.stretch ?? 1;
  const bend = settings.bend ?? 0.3;
  const margin = settings.thickness ?? 0.01;
  // Predict.
  for (let i = 0; i < count; i += 1) {
    const o = i * 3;
    if (invMass[i] === 0) {
      for (let k = 0; k < 3; k += 1) p[o + k] = prev[o + k] = s[o + k]!;
      continue;
    }
    // The wind's push: its speed relative to the particle, by how squarely the surface faces it.
    const v: V3 = [(p[o]! - prev[o]!) * (1 - damping), (p[o + 1]! - prev[o + 1]!) * (1 - damping), (p[o + 2]! - prev[o + 2]!) * (1 - damping)];
    const rel: V3 = [input.wind[0] - v[0] / dt, input.wind[1] - v[1] / dt, input.wind[2] - v[2] / dt];
    const facing = input.normals ? Math.abs(input.normals[o]! * rel[0] + input.normals[o + 1]! * rel[1] + input.normals[o + 2]! * rel[2]) / (Math.hypot(...rel) || 1) : 1;
    for (let k = 0; k < 3; k += 1) {
      prev[o + k] = p[o + k]!;
      p[o + k] = p[o + k]! + v[k]! + (CLOTH_GRAVITY[k]! + rel[k]! * response * facing) * dt * dt;
    }
  }
  // Solve: Jacobi, from a copy, so the order doesn't matter.
  const read = new Float32Array(p.length);
  const iterations = input.iterations ?? CLOTH_ITERATIONS;
  for (let it = 0; it < iterations; it += 1) {
    read.set(p);
    for (let i = 0; i < count; i += 1) {
      const o = i * 3;
      if (invMass[i] === 0) continue;
      let cx = 0;
      let cy = 0;
      let cz = 0;
      const n = starts[i + 1]! - starts[i]!;
      for (let e = starts[i]!; e < starts[i + 1]!; e += 1) {
        const j = entries[e * 4]!;
        const rest = entries[e * 4 + 1]!;
        const k = entries[e * 4 + 2]! > 0.5 ? bend : stretch;
        const dx = read[j * 3]! - read[o]!;
        const dy = read[j * 3 + 1]! - read[o + 1]!;
        const dz = read[j * 3 + 2]! - read[o + 2]!;
        const d = Math.hypot(dx, dy, dz);
        if (d < 1e-9) continue;
        const w = invMass[i]! / (invMass[i]! + invMass[j]!);
        const c = (k * w * (d - rest)) / d;
        cx += dx * c;
        cy += dy * c;
        cz += dz * c;
      }
      const scale = n > 0 ? CLOTH_RELAX / n : 0;
      let q: V3 = [read[o]! + cx * scale, read[o + 1]! + cy * scale, read[o + 2]! + cz * scale];
      // Within its distance of the skin.
      const fx = q[0] - s[o]!;
      const fy = q[1] - s[o + 1]!;
      const fz = q[2] - s[o + 2]!;
      const f = Math.hypot(fx, fy, fz);
      const m = maxDistance[i]!;
      if (f > m) q = [s[o]! + (fx * m) / f, s[o + 1]! + (fy * m) / f, s[o + 2]! + (fz * m) / f];
      for (const capsule of input.capsules) q = pushOutOfCapsule(q, capsule, margin);
      p[o] = q[0];
      p[o + 1] = q[1];
      p[o + 2] = q[2];
    }
  }
}

/**
 * The body's capsules from its skinning matrices: one along each bone (joint
 * to its first child), the joint's ragdoll radius, in the mesh's space. A
 * joint's position is its skinning matrix applied to where it was bound.
 */
export function bodyCapsules(skin: MeshSkin, matrices: Float32Array, radii: ArrayLike<number>): Capsule[] {
  const n = skin.joints.length;
  const at = (j: number): V3 => {
    // The bind position: the inverse bind's inverse's translation, −Rᵀt for a rigid inverse bind.
    const ib = skin.inverseBind.subarray(j * 16, j * 16 + 16);
    const sx = ib[0]! ** 2 + ib[1]! ** 2 + ib[2]! ** 2 || 1;
    const sy = ib[4]! ** 2 + ib[5]! ** 2 + ib[6]! ** 2 || 1;
    const sz = ib[8]! ** 2 + ib[9]! ** 2 + ib[10]! ** 2 || 1;
    const t = [ib[12]!, ib[13]!, ib[14]!];
    const bind: V3 = [
      -(ib[0]! * t[0]! + ib[1]! * t[1]! + ib[2]! * t[2]!) / sx,
      -(ib[4]! * t[0]! + ib[5]! * t[1]! + ib[6]! * t[2]!) / sy,
      -(ib[8]! * t[0]! + ib[9]! * t[1]! + ib[10]! * t[2]!) / sz,
    ];
    const m = matrices.subarray(j * 16, j * 16 + 16);
    return [m[0]! * bind[0] + m[4]! * bind[1] + m[8]! * bind[2] + m[12]!, m[1]! * bind[0] + m[5]! * bind[1] + m[9]! * bind[2] + m[13]!, m[2]! * bind[0] + m[6]! * bind[1] + m[10]! * bind[2] + m[14]!];
  };
  const out: Capsule[] = [];
  for (let j = 0; j < n && out.length < MAX_CLOTH_CAPSULES; j += 1) {
    const child = skin.joints.findIndex((c, i) => i !== j && c.parent === j);
    if (child < 0) continue;
    out.push({ a: at(j), b: at(child), radius: radii[j] ?? 0.05 });
  }
  return out;
}

/**
 * Author a cloth's distances by height: vertices within `pinned` metres of
 * its top held to the skin, then free up to `reach` metres at `falloff`
 * metres below that (a cape from its collar, a skirt from its waist).
 */
export function clothFromHeight(primitive: Pick<MeshPrimitive, "positions">, pinned: number, falloff: number, reach: number): Float32Array {
  const n = primitive.positions.length / 3;
  let top = -Infinity;
  for (let v = 0; v < n; v += 1) top = Math.max(top, primitive.positions[v * 3 + 1]!);
  return Float32Array.from({ length: n }, (_, v) => {
    const below = top - primitive.positions[v * 3 + 1]! - pinned;
    return below <= 0 ? 0 : reach * Math.min(1, below / Math.max(falloff, 1e-6));
  });
}

/** Read a stored cloth's settings against `vertexCount`; undefined when malformed. */
export function readClothSettings(raw: unknown, maxDistance: Float32Array | null, vertexCount: number): ClothSettings | undefined {
  if (!raw || typeof raw !== "object" || !maxDistance || maxDistance.length !== vertexCount || !maxDistance.every((m) => Number.isFinite(m) && m >= 0)) return undefined;
  const r = raw as Record<string, unknown>;
  const num = (v: unknown, lo: number, hi: number) => (typeof v === "number" && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : undefined);
  const out: { -readonly [K in keyof ClothSettings]: ClothSettings[K] } = { maxDistance: maxDistance.map((m) => Math.min(m, 10)) };
  const stretch = num(r.stretch, 0, 1);
  const bend = num(r.bend, 0, 1);
  const damping = num(r.damping, 0, 1);
  const windResponse = num(r.windResponse, 0, 10);
  const thickness = num(r.thickness, 0, 0.5);
  if (stretch !== undefined) out.stretch = stretch;
  if (bend !== undefined) out.bend = bend;
  if (damping !== undefined) out.damping = damping;
  if (windResponse !== undefined) out.windResponse = windResponse;
  if (thickness !== undefined) out.thickness = thickness;
  return out;
}

// --- Spring bones -------------------------------------------------------------

/** A chain of joints that trail: each turns toward a tail particle (the next joint in the chain). */
export interface SpringChain {
  readonly joints: readonly number[];
  /** How strongly the animation's pose pulls back, a second (default 8). */
  readonly stiffness?: number;
  /** Velocity lost a step, 0..1 (default 0.15). */
  readonly drag?: number;
  /** Gravity's share, 0..1 (default 0.5). */
  readonly gravity?: number;
  /** The tail's collision radius, metres (default 0.02). */
  readonly radius?: number;
}

export const MAX_SPRING_CHAINS = 32;

type Q = [number, number, number, number];
const qmul = (a: Q, b: Q): Q => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
];
const qconj = (q: Q): Q => [-q[0], -q[1], -q[2], q[3]];
/** The shortest rotation taking unit `a` to unit `b`. */
function fromTo(a: V3, b: V3): Q {
  const d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  if (d < -0.999999) {
    const axis: V3 = Math.abs(a[0]) < 0.9 ? [0, -a[2], a[1]] : [a[2], 0, -a[0]];
    const l = Math.hypot(...axis);
    return [axis[0] / l, axis[1] / l, axis[2] / l, 0];
  }
  const c: V3 = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const q: Q = [c[0], c[1], c[2], 1 + d];
  const l = Math.hypot(...q);
  return [q[0] / l, q[1] / l, q[2] / l, q[3] / l];
}
/** A world matrix's rotation (its 3×3 with the scale taken out) as a quaternion. */
function matrixQuat(m: ArrayLike<number>, o: number): Q {
  const sx = Math.hypot(m[o]!, m[o + 1]!, m[o + 2]!) || 1;
  const sy = Math.hypot(m[o + 4]!, m[o + 5]!, m[o + 6]!) || 1;
  const sz = Math.hypot(m[o + 8]!, m[o + 9]!, m[o + 10]!) || 1;
  const r00 = m[o]! / sx, r10 = m[o + 1]! / sx, r20 = m[o + 2]! / sx;
  const r01 = m[o + 4]! / sy, r11 = m[o + 5]! / sy, r21 = m[o + 6]! / sy;
  const r02 = m[o + 8]! / sz, r12 = m[o + 9]! / sz, r22 = m[o + 10]! / sz;
  const tr = r00 + r11 + r22;
  if (tr > 0) {
    const s = Math.sqrt(tr + 1) * 2;
    return [(r21 - r12) / s, (r02 - r20) / s, (r10 - r01) / s, s / 4];
  }
  if (r00 > r11 && r00 > r22) {
    const s = Math.sqrt(1 + r00 - r11 - r22) * 2;
    return [s / 4, (r01 + r10) / s, (r02 + r20) / s, (r21 - r12) / s];
  }
  if (r11 > r22) {
    const s = Math.sqrt(1 + r11 - r00 - r22) * 2;
    return [(r01 + r10) / s, s / 4, (r12 + r21) / s, (r02 - r20) / s];
  }
  const s = Math.sqrt(1 + r22 - r00 - r11) * 2;
  return [(r02 + r20) / s, (r12 + r21) / s, s / 4, (r10 - r01) / s];
}

/** Spring bones' state: each chain's tails now and a step ago (world positions of the pose's space). */
export interface SpringState {
  tails: Float64Array[];
  previous: Float64Array[];
}

const at = (world: Float64Array, j: number): V3 => [world[j * 16 + 12]!, world[j * 16 + 13]!, world[j * 16 + 14]!];

/**
 * Step the spring bones over an animated `pose` (rewritten in place): each
 * chain from its root, each joint turned toward its tail particle. `state`
 * starts empty and is kept between calls; `capsules` in the skeleton's space.
 */
export function stepSpringBones(skin: MeshSkin, pose: Float32Array, chains: readonly SpringChain[], state: SpringState, dt: number, capsules: readonly Capsule[] = []): void {
  chains.forEach((chain, c) => {
    const links = chain.joints.filter((j) => j >= 0 && j < skin.joints.length);
    if (links.length < 2) return;
    let world = jointWorldMatrices(skin, pose);
    if (!state.tails[c] || state.tails[c]!.length !== (links.length - 1) * 3) {
      state.tails[c] = new Float64Array((links.length - 1) * 3);
      for (let k = 1; k < links.length; k += 1) state.tails[c]!.set(at(world, links[k]!), (k - 1) * 3);
      state.previous[c] = state.tails[c]!.slice();
    }
    const tails = state.tails[c]!;
    const previous = state.previous[c]!;
    const stiffness = chain.stiffness ?? 8;
    const drag = chain.drag ?? 0.15;
    const gravity = chain.gravity ?? 0.5;
    const radius = chain.radius ?? 0.02;
    for (let k = 0; k + 1 < links.length; k += 1) {
      const j = links[k]!;
      const head = at(world, j);
      const animated = at(world, links[k + 1]!);
      const length = Math.hypot(animated[0] - head[0], animated[1] - head[1], animated[2] - head[2]);
      const o = k * 3;
      const cur: V3 = [tails[o]!, tails[o + 1]!, tails[o + 2]!];
      let next: V3 = [0, 0, 0];
      for (let a = 0; a < 3; a += 1) {
        const velocity = (cur[a]! - previous[o + a]!) * (1 - drag);
        next[a] = cur[a]! + velocity + (animated[a]! - cur[a]!) * Math.min(1, stiffness * dt) + CLOTH_GRAVITY[a]! * gravity * dt * dt;
      }
      // Keep the bone's length, then out of the body.
      const d: V3 = [next[0] - head[0], next[1] - head[1], next[2] - head[2]];
      const l = Math.hypot(...d) || 1;
      next = [head[0] + (d[0] / l) * length, head[1] + (d[1] / l) * length, head[2] + (d[2] / l) * length];
      for (const capsule of capsules) next = pushOutOfCapsule(next, capsule, radius);
      previous.set(cur, o);
      tails.set(next, o);
      // Turn the joint: the rotation from where the animation points it to where the tail is, in its parent's frame.
      const from: V3 = [(animated[0] - head[0]) / (length || 1), (animated[1] - head[1]) / (length || 1), (animated[2] - head[2]) / (length || 1)];
      const toLen = Math.hypot(next[0] - head[0], next[1] - head[1], next[2] - head[2]) || 1;
      const to: V3 = [(next[0] - head[0]) / toLen, (next[1] - head[1]) / toLen, (next[2] - head[2]) / toLen];
      const turn = fromTo(from, to);
      const p = j * POSE_STRIDE + 3;
      const local: Q = [pose[p]!, pose[p + 1]!, pose[p + 2]!, pose[p + 3]!];
      // The parent's world rotation: the joint's world rotation without its own local one.
      const parentRot = qmul(matrixQuat(world, j * 16), qconj(local));
      const turned = qmul(qmul(qmul(qconj(parentRot), turn), parentRot), local);
      const len = Math.hypot(...turned) || 1;
      pose.set([turned[0] / len, turned[1] / len, turned[2] / len, turned[3] / len], p);
      world = jointWorldMatrices(skin, pose);
    }
  });
}

/** Read stored spring chains against a skeleton of `jointCount` joints. */
export function readSpringChains(raw: unknown, jointCount: number): SpringChain[] {
  if (!Array.isArray(raw)) return [];
  const num = (v: unknown, lo: number, hi: number) => (typeof v === "number" && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : undefined);
  return raw.slice(0, MAX_SPRING_CHAINS).flatMap((c: Record<string, unknown>) => {
    if (!c || !Array.isArray(c.joints)) return [];
    const joints = c.joints.filter((j): j is number => Number.isInteger(j) && (j as number) >= 0 && (j as number) < jointCount).slice(0, 64);
    if (joints.length < 2) return [];
    const out: { -readonly [K in keyof SpringChain]: SpringChain[K] } = { joints };
    const stiffness = num(c.stiffness, 0, 100);
    const drag = num(c.drag, 0, 1);
    const gravity = num(c.gravity, 0, 4);
    const radius = num(c.radius, 0, 1);
    if (stiffness !== undefined) out.stiffness = stiffness;
    if (drag !== undefined) out.drag = drag;
    if (gravity !== undefined) out.gravity = gravity;
    if (radius !== undefined) out.radius = radius;
    return [out];
  });
}

/** Whether a mesh has cloth or spring bones to simulate. */
export function hasSecondaryMotion(mesh: MeshAsset): boolean {
  return mesh.primitives.some((p) => p.cloth) || (mesh.springs?.length ?? 0) > 0;
}
