/**
 * GPU particle emitters (AAA_FIDELITY_ROADMAP.md F8a), authored as a stack of
 * modules (Niagara-lite) and compiled to the flat parameters the GPU's compute
 * passes read (gpuParticles.ts in @cartbox/player). The CPU here runs the same
 * simulation, term for term: the reference the GPU is held to, and what the
 * renderers without compute draw through the billboard system (H5).
 *
 * - **Spawning** is a ring: an emitter's particles live in slots handed out
 *   in turn, so a burst or a frame's spawns take the next slots (the oldest
 *   recycled when the ring is full). No free list, no atomics, and a ribbon's
 *   particles stay in the order they were born.
 * - **Each particle** starts from the emitter's shape (point, sphere, cone or
 *   box), with a speed along its direction, a life, and random numbers from
 *   its slot and birth (a hash, alike on both sides).
 * - **Forces:** gravity, drag, curl noise (the curl of a smooth vector field,
 *   so it swirls without gathering or thinning), an attractor and a vortex.
 * - **Collisions** with the depth buffer (the GPU's; the particle bounces off
 *   the G-buffer's normal where it passes behind the surface) and with signed
 *   distance shapes (spheres, boxes, planes), on both sides.
 * - **Rendering:** sprites (stretched along the velocity, a flipbook over
 *   their life with optional motion-vector blending), meshes, or ribbons (a
 *   strip through each emitter's particles in birth order); additive or
 *   blended, the blended sorted back to front on the GPU.
 */

import type { ParticleEffect } from "./particleEffects";

type V3 = [number, number, number];
type Rgba = readonly [number, number, number, number];

/** One module of an emitter's stack. */
export type EmitterModule =
  | { readonly type: "spawnRate"; readonly rate: number }
  | { readonly type: "spawnBurst"; readonly count: number }
  | { readonly type: "shape"; readonly kind: "point" | "sphere" | "cone" | "box"; readonly radius?: number; readonly angle?: number; readonly extents?: readonly [number, number, number] }
  | { readonly type: "velocity"; readonly speed: number; readonly jitter?: number }
  | { readonly type: "lifetime"; readonly seconds: number; readonly jitter?: number }
  | { readonly type: "size"; readonly start: number; readonly end?: number }
  | { readonly type: "color"; readonly start: Rgba; readonly end?: Rgba; readonly glow?: number }
  | { readonly type: "gravity"; readonly acceleration: readonly [number, number, number] }
  | { readonly type: "drag"; readonly amount: number }
  | { readonly type: "curlNoise"; readonly strength: number; readonly scale?: number; readonly speed?: number }
  | { readonly type: "attractor"; readonly position: readonly [number, number, number]; readonly strength: number }
  | { readonly type: "vortex"; readonly axis: readonly [number, number, number]; readonly strength: number }
  | { readonly type: "collideDepth"; readonly restitution?: number; readonly friction?: number }
  | { readonly type: "collideShapes"; readonly shapes: readonly SdfShape[]; readonly restitution?: number; readonly friction?: number }
  | { readonly type: "render"; readonly mode: "sprite" | "mesh" | "ribbon"; readonly blend?: "additive" | "alpha"; readonly stretch?: number; readonly frames?: number; readonly motionVectors?: boolean; readonly mesh?: number };

/** A collision shape: a sphere (centre, radius), a box (centre, half extents) or a plane (normal, offset). */
export type SdfShape =
  | { readonly kind: "sphere"; readonly center: readonly [number, number, number]; readonly radius: number }
  | { readonly kind: "box"; readonly center: readonly [number, number, number]; readonly half: readonly [number, number, number] }
  | { readonly kind: "plane"; readonly normal: readonly [number, number, number]; readonly offset: number };

export interface EmitterSpec {
  readonly name: string;
  /** Slots in its ring (rounded up to a power of two). */
  readonly capacity: number;
  readonly modules: readonly EmitterModule[];
}

export const MAX_EMITTER_CAPACITY = 1 << 20;
export const MAX_SDF_SHAPES = 8;

/** An emitter compiled: every parameter resolved. */
export interface EmitterParams {
  readonly capacity: number;
  readonly rate: number;
  readonly burst: number;
  readonly shape: number; // 0 point, 1 sphere, 2 cone, 3 box
  readonly radius: number;
  readonly angle: number;
  readonly extents: V3;
  readonly speed: number;
  readonly speedJitter: number;
  readonly life: number;
  readonly lifeJitter: number;
  readonly sizeStart: number;
  readonly sizeEnd: number;
  readonly colorStart: Rgba;
  readonly colorEnd: Rgba;
  readonly glow: number;
  readonly gravity: V3;
  readonly drag: number;
  readonly curl: number;
  readonly curlScale: number;
  readonly curlSpeed: number;
  readonly attractor: V3;
  readonly attract: number;
  readonly vortexAxis: V3;
  readonly vortex: number;
  readonly depthCollide: boolean;
  readonly restitution: number;
  readonly friction: number;
  readonly shapes: readonly SdfShape[];
  readonly render: number; // 0 sprite, 1 mesh, 2 ribbon
  readonly additive: boolean;
  readonly stretch: number;
  readonly frames: number;
  readonly motionVectors: boolean;
  readonly mesh: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Number.isFinite(v) ? v : lo));

/** The next power of two at or above `n`, within the cap. */
export function ringSize(n: number): number {
  let p = 1;
  while (p < Math.min(MAX_EMITTER_CAPACITY, Math.max(1, n))) p <<= 1;
  return p;
}

/** Compile an emitter's stack: later modules of a kind override earlier ones. */
export function compileEmitter(spec: EmitterSpec): EmitterParams {
  const p = {
    capacity: ringSize(spec.capacity),
    rate: 0,
    burst: 0,
    shape: 0,
    radius: 0,
    angle: 0.5,
    extents: [0.5, 0.5, 0.5] as V3,
    speed: 1,
    speedJitter: 0,
    life: 1,
    lifeJitter: 0,
    sizeStart: 0.1,
    sizeEnd: 0.1,
    colorStart: [1, 1, 1, 1] as Rgba,
    colorEnd: [1, 1, 1, 1] as Rgba,
    glow: 0,
    gravity: [0, 0, 0] as V3,
    drag: 0,
    curl: 0,
    curlScale: 1,
    curlSpeed: 0,
    attractor: [0, 0, 0] as V3,
    attract: 0,
    vortexAxis: [0, 1, 0] as V3,
    vortex: 0,
    depthCollide: false,
    restitution: 0.4,
    friction: 0.2,
    shapes: [] as SdfShape[],
    render: 0,
    additive: true,
    stretch: 0,
    frames: 1,
    motionVectors: false,
    mesh: -1,
  };
  for (const m of spec.modules) {
    switch (m.type) {
      case "spawnRate":
        p.rate = clamp(m.rate, 0, 1e7);
        break;
      case "spawnBurst":
        p.burst = Math.round(clamp(m.count, 0, MAX_EMITTER_CAPACITY));
        break;
      case "shape":
        p.shape = ["point", "sphere", "cone", "box"].indexOf(m.kind);
        p.radius = clamp(m.radius ?? 0, 0, 1e4);
        p.angle = clamp(m.angle ?? 0.5, 0, Math.PI);
        p.extents = (m.extents ? [clamp(m.extents[0], 0, 1e4), clamp(m.extents[1], 0, 1e4), clamp(m.extents[2], 0, 1e4)] : p.extents) as V3;
        break;
      case "velocity":
        p.speed = clamp(m.speed, -1e4, 1e4);
        p.speedJitter = clamp(m.jitter ?? 0, 0, 1);
        break;
      case "lifetime":
        p.life = clamp(m.seconds, 0.01, 600);
        p.lifeJitter = clamp(m.jitter ?? 0, 0, 1);
        break;
      case "size":
        p.sizeStart = clamp(m.start, 0, 1e3);
        p.sizeEnd = clamp(m.end ?? m.start, 0, 1e3);
        break;
      case "color":
        p.colorStart = m.start.map((c) => clamp(c, 0, 1)) as unknown as Rgba;
        p.colorEnd = (m.end ?? m.start).map((c) => clamp(c, 0, 1)) as unknown as Rgba;
        p.glow = clamp(m.glow ?? 0, 0, 1e3);
        break;
      case "gravity":
        p.gravity = [clamp(m.acceleration[0], -1e3, 1e3), clamp(m.acceleration[1], -1e3, 1e3), clamp(m.acceleration[2], -1e3, 1e3)];
        break;
      case "drag":
        p.drag = clamp(m.amount, 0, 100);
        break;
      case "curlNoise":
        p.curl = clamp(m.strength, 0, 1e3);
        p.curlScale = clamp(m.scale ?? 1, 1e-3, 1e3);
        p.curlSpeed = clamp(m.speed ?? 0, 0, 100);
        break;
      case "attractor":
        p.attractor = [m.position[0], m.position[1], m.position[2]];
        p.attract = clamp(m.strength, -1e4, 1e4);
        break;
      case "vortex": {
        const l = Math.hypot(m.axis[0], m.axis[1], m.axis[2]) || 1;
        p.vortexAxis = [m.axis[0] / l, m.axis[1] / l, m.axis[2] / l];
        p.vortex = clamp(m.strength, -1e4, 1e4);
        break;
      }
      case "collideDepth":
        p.depthCollide = true;
        p.restitution = clamp(m.restitution ?? p.restitution, 0, 1);
        p.friction = clamp(m.friction ?? p.friction, 0, 1);
        break;
      case "collideShapes":
        p.shapes = m.shapes.slice(0, MAX_SDF_SHAPES);
        p.restitution = clamp(m.restitution ?? p.restitution, 0, 1);
        p.friction = clamp(m.friction ?? p.friction, 0, 1);
        break;
      case "render":
        p.render = ["sprite", "mesh", "ribbon"].indexOf(m.mode);
        p.additive = (m.blend ?? "additive") === "additive";
        p.stretch = clamp(m.stretch ?? 0, 0, 10);
        p.frames = Math.round(clamp(m.frames ?? 1, 1, 256));
        p.motionVectors = m.motionVectors === true;
        p.mesh = m.mesh ?? -1;
        break;
    }
  }
  return p;
}

/** An H5 billboard effect as an emitter, so a cart's bursts draw on the GPU unchanged. */
export function emitterFromEffect(effect: ParticleEffect): EmitterSpec {
  const glow = effect.glow > 0;
  return {
    name: effect.name,
    capacity: Math.max(256, effect.count * 32),
    modules: [
      { type: "spawnBurst", count: effect.count },
      // A burst's spread: 1 is every way (a sphere's directions), less a cone about the burst's direction.
      { type: "shape", kind: "cone", radius: 0, angle: effect.spread * Math.PI },
      { type: "velocity", speed: effect.speed, jitter: effect.speedJitter },
      { type: "lifetime", seconds: effect.life, jitter: effect.lifeJitter },
      { type: "size", start: effect.size, end: effect.sizeEnd },
      { type: "color", start: [...effect.color, 1], end: [...effect.colorEnd, 0], glow: effect.glow },
      { type: "gravity", acceleration: [0, -effect.gravity, 0] },
      { type: "drag", amount: effect.drag },
      { type: "render", mode: "sprite", blend: glow ? "additive" : "alpha", stretch: effect.stretch, frames: 1 },
    ],
  };
}

// --- The shared simulation ----------------------------------------------------

/** PCG hash (u32 → u32), as the GPU computes it. */
export function pcg(v: number): number {
  const state = (Math.imul(v >>> 0, 747796405) + 2891336453) >>> 0;
  const word = Math.imul(((state >>> ((state >>> 28) + 4)) ^ state) >>> 0, 277803737) >>> 0;
  return ((word >>> 22) ^ word) >>> 0;
}

/** A particle's k-th random number in [0, 1), from its slot and birth (the spawn counter). */
export function particleRandom(birth: number, k: number): number {
  return pcg((Math.imul(birth >>> 0, 16) + k) >>> 0) / 4294967296;
}

/**
 * Curl noise: the curl of the potential ψ = (sin(s·y + t) + sin(2s·z + 1.7t)/2,
 * sin(s·z + 1.3t) + sin(2s·x + 0.9t)/2, sin(s·x + 0.7t) + sin(2s·y + 1.1t)/2),
 * which is divergence-free, so particles swirl without bunching.
 */
export function curlNoise(x: number, y: number, z: number, scale: number, t: number): V3 {
  const s = scale;
  // ∂ψz/∂y − ∂ψy/∂z, ∂ψx/∂z − ∂ψz/∂x, ∂ψy/∂x − ∂ψx/∂y.
  const dpzdy = s * Math.cos(2 * s * y + 1.1 * t);
  const dpydz = s * Math.cos(s * z + 1.3 * t);
  const dpxdz = s * Math.cos(2 * s * z + 1.7 * t);
  const dpzdx = s * Math.cos(s * x + 0.7 * t);
  const dpydx = s * Math.cos(2 * s * x + 0.9 * t);
  const dpxdy = s * Math.cos(s * y + t);
  return [dpzdy - dpydz, dpxdz - dpzdx, dpydx - dpxdy];
}

/** A shape's signed distance at a point, and its outward normal. */
export function sdfShape(shape: SdfShape, p: readonly number[]): { d: number; n: V3 } {
  if (shape.kind === "sphere") {
    const v: V3 = [p[0]! - shape.center[0], p[1]! - shape.center[1], p[2]! - shape.center[2]];
    const l = Math.hypot(...v) || 1;
    return { d: l - shape.radius, n: [v[0] / l, v[1] / l, v[2] / l] };
  }
  if (shape.kind === "plane") {
    const l = Math.hypot(...shape.normal) || 1;
    const n: V3 = [shape.normal[0] / l, shape.normal[1] / l, shape.normal[2] / l];
    return { d: p[0]! * n[0] + p[1]! * n[1] + p[2]! * n[2] - shape.offset, n };
  }
  const q: V3 = [Math.abs(p[0]! - shape.center[0]) - shape.half[0], Math.abs(p[1]! - shape.center[1]) - shape.half[1], Math.abs(p[2]! - shape.center[2]) - shape.half[2]];
  const outside = Math.hypot(Math.max(q[0], 0), Math.max(q[1], 0), Math.max(q[2], 0));
  const inside = Math.min(Math.max(q[0], q[1], q[2]), 0);
  // The normal along the axis nearest the surface.
  const axis = q[0] > q[1] && q[0] > q[2] ? 0 : q[1] > q[2] ? 1 : 2;
  const n: V3 = [0, 0, 0];
  n[axis] = Math.sign(p[axis]! - shape.center[axis]) || 1;
  return { d: outside + inside, n };
}

/** A particle in the reference: position, velocity, age, life, birth. */
export interface CpuParticle {
  p: V3;
  v: V3;
  age: number;
  life: number;
  birth: number;
}

/** Floats a particle takes on the GPU: position + age, velocity + life, the birth (as bits) and three spare. */
export const PARTICLE_FLOATS = 12;

/**
 * The reference simulation: an emitter's ring, spawned and stepped as the
 * GPU's passes do (the depth collision aside, which needs a frame).
 */
export class CpuEmitter {
  readonly particles: (CpuParticle | null)[];
  /** The next slot, and how many have ever been born (the birth counter). */
  head = 0;
  born = 0;
  time = 0;
  private carry = 0;
  constructor(readonly params: EmitterParams) {
    this.particles = new Array(params.capacity).fill(null);
  }

  /** Spawn `count` at `at` toward `dir` (zero: up), into the next slots. */
  spawn(count: number, at: readonly number[], dir: readonly number[] = [0, 0, 0]): void {
    for (let i = 0; i < count; i += 1) {
      const birth = this.born + i;
      this.particles[(this.head + i) % this.params.capacity] = spawnParticle(this.params, birth, at, dir);
    }
    this.head = (this.head + count) % this.params.capacity;
    this.born += count;
  }

  /** The spawns a step of `dt` makes at the emitter's rate (the fraction carried). */
  rateSpawns(dt: number): number {
    this.carry += this.params.rate * dt;
    const n = Math.floor(this.carry);
    this.carry -= n;
    return n;
  }

  step(dt: number): void {
    this.time += dt;
    for (const q of this.particles) if (q && q.age < q.life) stepParticle(this.params, q, dt, this.time);
  }

  get alive(): number {
    return this.particles.reduce((n, q) => n + (q && q.age < q.life ? 1 : 0), 0);
  }
}

/** A new particle, as the GPU's spawn pass makes it. */
export function spawnParticle(e: EmitterParams, birth: number, at: readonly number[], dir: readonly number[]): CpuParticle {
  const r = (k: number) => particleRandom(birth, k);
  // A direction: uniform on the sphere, or within the cone's angle of `dir`.
  const len = Math.hypot(dir[0]!, dir[1]!, dir[2]!);
  const axis: V3 = len > 1e-6 ? [dir[0]! / len, dir[1]! / len, dir[2]! / len] : [0, 1, 0];
  const cosMax = e.shape === 2 ? Math.cos(e.angle) : -1;
  const cosT = 1 - r(0) * (1 - cosMax);
  const sinT = Math.sqrt(Math.max(0, 1 - cosT * cosT));
  const phi = 2 * Math.PI * r(1);
  // A frame about the axis.
  const helper: V3 = Math.abs(axis[1]) < 0.99 ? [0, 1, 0] : [1, 0, 0];
  let tx = helper[1] * axis[2] - helper[2] * axis[1];
  let ty = helper[2] * axis[0] - helper[0] * axis[2];
  let tz = helper[0] * axis[1] - helper[1] * axis[0];
  const tl = Math.hypot(tx, ty, tz) || 1;
  tx /= tl;
  ty /= tl;
  tz /= tl;
  const bx = axis[1] * tz - axis[2] * ty;
  const by = axis[2] * tx - axis[0] * tz;
  const bz = axis[0] * ty - axis[1] * tx;
  const d: V3 = [
    axis[0] * cosT + (tx * Math.cos(phi) + bx * Math.sin(phi)) * sinT,
    axis[1] * cosT + (ty * Math.cos(phi) + by * Math.sin(phi)) * sinT,
    axis[2] * cosT + (tz * Math.cos(phi) + bz * Math.sin(phi)) * sinT,
  ];
  // Where: the point, within the sphere (along the direction, by the cube root for an even fill), or the box.
  let p: V3 = [at[0]!, at[1]!, at[2]!];
  if (e.shape === 1 || e.shape === 2) {
    const reach = e.radius * Math.cbrt(r(2));
    p = [p[0] + d[0] * reach, p[1] + d[1] * reach, p[2] + d[2] * reach];
  } else if (e.shape === 3) {
    p = [p[0] + (r(2) * 2 - 1) * e.extents[0], p[1] + (r(3) * 2 - 1) * e.extents[1], p[2] + (r(4) * 2 - 1) * e.extents[2]];
  }
  const speed = e.speed * (1 + e.speedJitter * (r(5) * 2 - 1));
  const life = e.life * (1 + e.lifeJitter * (r(6) * 2 - 1));
  return { p, v: [d[0] * speed, d[1] * speed, d[2] * speed], age: 0, life: Math.max(0.01, life), birth };
}

/** Step one particle (the GPU's update pass, without the depth buffer). */
export function stepParticle(e: EmitterParams, q: CpuParticle, dt: number, time: number): void {
  let [vx, vy, vz] = q.v;
  let ax = e.gravity[0];
  let ay = e.gravity[1];
  let az = e.gravity[2];
  if (e.curl > 0) {
    const c = curlNoise(q.p[0], q.p[1], q.p[2], e.curlScale, time * e.curlSpeed);
    ax += c[0] * e.curl;
    ay += c[1] * e.curl;
    az += c[2] * e.curl;
  }
  if (e.attract !== 0) {
    const d: V3 = [e.attractor[0] - q.p[0], e.attractor[1] - q.p[1], e.attractor[2] - q.p[2]];
    const l = Math.max(0.1, Math.hypot(...d));
    ax += (d[0] / l) * e.attract;
    ay += (d[1] / l) * e.attract;
    az += (d[2] / l) * e.attract;
  }
  if (e.vortex !== 0) {
    // About the axis through the attractor's point: a push round it.
    const r: V3 = [q.p[0] - e.attractor[0], q.p[1] - e.attractor[1], q.p[2] - e.attractor[2]];
    const a = e.vortexAxis;
    ax += (a[1] * r[2] - a[2] * r[1]) * e.vortex;
    ay += (a[2] * r[0] - a[0] * r[2]) * e.vortex;
    az += (a[0] * r[1] - a[1] * r[0]) * e.vortex;
  }
  vx += ax * dt;
  vy += ay * dt;
  vz += az * dt;
  const keep = Math.exp(-e.drag * dt);
  vx *= keep;
  vy *= keep;
  vz *= keep;
  let p: V3 = [q.p[0] + vx * dt, q.p[1] + vy * dt, q.p[2] + vz * dt];
  for (const shape of e.shapes) {
    const hit = sdfShape(shape, p);
    if (hit.d >= 0) continue;
    // Out to the surface; the velocity's normal part bounced back by the restitution, its tangent slowed by friction.
    p = [p[0] - hit.n[0] * hit.d, p[1] - hit.n[1] * hit.d, p[2] - hit.n[2] * hit.d];
    const vn = vx * hit.n[0] + vy * hit.n[1] + vz * hit.n[2];
    if (vn < 0) {
      const tx = vx - vn * hit.n[0];
      const ty = vy - vn * hit.n[1];
      const tz = vz - vn * hit.n[2];
      vx = tx * (1 - e.friction) - vn * e.restitution * hit.n[0];
      vy = ty * (1 - e.friction) - vn * e.restitution * hit.n[1];
      vz = tz * (1 - e.friction) - vn * e.restitution * hit.n[2];
    }
  }
  q.p = p;
  q.v = [vx, vy, vz];
  q.age += dt;
}

/** The flipbook frame and the blend into the next, for an age fraction (the sprite's frames over its life). */
export function flipbookFrame(t: number, frames: number): { frame: number; next: number; blend: number } {
  const f = Math.max(0, Math.min(0.9999, t)) * frames;
  const frame = Math.floor(f);
  return { frame, next: Math.min(frames - 1, frame + 1), blend: f - frame };
}

/** Read stored emitters defensively (a list of specs); malformed ones dropped. */
export function parseEmitters(value: unknown): EmitterSpec[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 32).flatMap((e: Record<string, unknown>) => {
    if (!e || typeof e.name !== "string" || !Array.isArray(e.modules)) return [];
    const capacity = typeof e.capacity === "number" && Number.isFinite(e.capacity) ? e.capacity : 1024;
    const types = new Set(["spawnRate", "spawnBurst", "shape", "velocity", "lifetime", "size", "color", "gravity", "drag", "curlNoise", "attractor", "vortex", "collideDepth", "collideShapes", "render"]);
    const modules = e.modules.filter((m: { type?: unknown }) => m && typeof m === "object" && types.has(m.type as string)) as EmitterModule[];
    return [{ name: e.name.slice(0, 64), capacity: Math.min(MAX_EMITTER_CAPACITY, Math.max(1, capacity)), modules }];
  });
}
