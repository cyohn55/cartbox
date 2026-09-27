/**
 * Runs a cart's physics (ENGINE_ROADMAP.md, Phase 2): builds bodies for the scene
 * objects that have a physics spec, and each tick hands the cart their state,
 * applies the commands it wrote, steps the world, and casts the rays it asked for.
 *
 * The physics engine itself sits behind {@link PhysicsBackend}, so the player
 * stays small: the web app supplies a Rapier backend (loaded only for carts with
 * bodies), and tests can supply the same one in Node.
 *
 * Per tick: `beforeTick` writes the state after the last step (and last tick's
 * ray results) into the shared block; the cart runs, reading state and writing
 * commands; `afterTick` applies those commands, steps the world one fixed 1/60 s
 * step, and casts the requested rays for the next tick to read.
 */

import { meshBounds, type Mat4, type MeshAsset, type PhysicsSpec } from "@cartbox/editor";

import type { MeshScene } from "../mesh/meshScene.js";
import {
  PHYS_MAX_BODIES,
  PHYS_MAX_RAYS,
  PHYS_OP_IMPULSE,
  PHYS_OP_MOVE,
  PHYS_OP_RAY,
  PHYS_OP_TELEPORT,
  PHYS_OP_VELOCITY,
  takePhysicsCommands,
  writePhysicsState,
  type PhysicsBodyState,
  type PhysicsRayHit,
} from "./protocol.js";

export type Vec3 = readonly [number, number, number];
export type Quat = readonly [number, number, number, number];

/** A collider fitted to a scene object, in its body's local frame (scale applied). */
export type PhysicsShape =
  | { readonly kind: "box"; readonly halfExtents: Vec3; readonly offset: Vec3 }
  | { readonly kind: "sphere"; readonly radius: number; readonly offset: Vec3 }
  | { readonly kind: "capsule"; readonly halfHeight: number; readonly radius: number; readonly offset: Vec3 }
  | { readonly kind: "mesh"; readonly vertices: Float32Array; readonly indices: Uint32Array };

export interface PhysicsBodyDesc {
  readonly kind: PhysicsSpec["body"];
  readonly shape: PhysicsShape;
  readonly position: Vec3;
  readonly rotation: Quat;
  readonly mass: number;
  readonly friction: number;
  readonly bounce: number;
  /** The scene object this body belongs to (reported back by raycasts). */
  readonly object: number;
}

/** What a physics engine must provide. Handles are small integers the backend picks. */
export interface PhysicsBackend {
  addBody(desc: PhysicsBodyDesc): number;
  /** Advance the world by `dt` seconds. */
  step(dt: number): void;
  bodyState(handle: number): { position: Vec3; rotation: Quat; velocity: Vec3; sleeping: boolean };
  applyImpulse(handle: number, impulse: Vec3): void;
  setVelocity(handle: number, velocity: Vec3): void;
  teleport(handle: number, position: Vec3): void;
  /** Move a character by `delta`, sliding along what it hits. Returns whether it ended on the ground. */
  moveCharacter(handle: number, delta: Vec3): { grounded: boolean };
  /** The nearest hit along a unit `direction` within `maxDistance`, or null. */
  raycast(origin: Vec3, direction: Vec3, maxDistance: number): { object: number; point: Vec3; normal: Vec3; distance: number } | null;
  destroy(): void;
}

export const PHYSICS_DT = 1 / 60;

/** Position, rotation (unit quaternion) and scale of a world matrix without shear. */
export function splitWorldMatrix(m: Mat4): { position: Vec3; rotation: Quat; scale: Vec3 } {
  const sx = Math.hypot(m[0]!, m[1]!, m[2]!) || 1;
  const sy = Math.hypot(m[4]!, m[5]!, m[6]!) || 1;
  const sz = Math.hypot(m[8]!, m[9]!, m[10]!) || 1;
  const r00 = m[0]! / sx, r10 = m[1]! / sx, r20 = m[2]! / sx;
  const r01 = m[4]! / sy, r11 = m[5]! / sy, r21 = m[6]! / sy;
  const r02 = m[8]! / sz, r12 = m[9]! / sz, r22 = m[10]! / sz;
  const trace = r00 + r11 + r22;
  let x: number, y: number, z: number, w: number;
  if (trace > 0) {
    const s = Math.sqrt(trace + 1) * 2;
    w = s / 4;
    x = (r21 - r12) / s;
    y = (r02 - r20) / s;
    z = (r10 - r01) / s;
  } else if (r00 > r11 && r00 > r22) {
    const s = Math.sqrt(1 + r00 - r11 - r22) * 2;
    w = (r21 - r12) / s;
    x = s / 4;
    y = (r01 + r10) / s;
    z = (r02 + r20) / s;
  } else if (r11 > r22) {
    const s = Math.sqrt(1 + r11 - r00 - r22) * 2;
    w = (r02 - r20) / s;
    x = (r01 + r10) / s;
    y = s / 4;
    z = (r12 + r21) / s;
  } else {
    const s = Math.sqrt(1 + r22 - r00 - r11) * 2;
    w = (r10 - r01) / s;
    x = (r02 + r20) / s;
    y = (r12 + r21) / s;
    z = s / 4;
  }
  const n = Math.hypot(x, y, z, w) || 1;
  return { position: [m[12]!, m[13]!, m[14]!], rotation: [x / n, y / n, z / n, w / n], scale: [sx, sy, sz] };
}

/** A world matrix from position, unit quaternion and scale. */
export function composeWorldMatrix(p: Vec3, q: Quat, s: Vec3): Mat4 {
  const [x, y, z, w] = q;
  const m = new Float64Array(16);
  m[0] = (1 - 2 * (y * y + z * z)) * s[0];
  m[1] = 2 * (x * y + z * w) * s[0];
  m[2] = 2 * (x * z - y * w) * s[0];
  m[4] = 2 * (x * y - z * w) * s[1];
  m[5] = (1 - 2 * (x * x + z * z)) * s[1];
  m[6] = 2 * (y * z + x * w) * s[1];
  m[8] = 2 * (x * z + y * w) * s[2];
  m[9] = 2 * (y * z - x * w) * s[2];
  m[10] = (1 - 2 * (x * x + y * y)) * s[2];
  m[12] = p[0];
  m[13] = p[1];
  m[14] = p[2];
  m[15] = 1;
  return m;
}

/** Fit a collider of `spec.shape` to a mesh's bounds (or triangles), scaled. */
export function fitShape(spec: PhysicsSpec, mesh: MeshAsset, scale: Vec3): PhysicsShape {
  const b = meshBounds(mesh) ?? { min: [-0.5, -0.5, -0.5] as const, max: [0.5, 0.5, 0.5] as const };
  const half: Vec3 = [
    Math.max(0.005, ((b.max[0] - b.min[0]) / 2) * scale[0]),
    Math.max(0.005, ((b.max[1] - b.min[1]) / 2) * scale[1]),
    Math.max(0.005, ((b.max[2] - b.min[2]) / 2) * scale[2]),
  ];
  const offset: Vec3 = [
    ((b.max[0] + b.min[0]) / 2) * scale[0],
    ((b.max[1] + b.min[1]) / 2) * scale[1],
    ((b.max[2] + b.min[2]) / 2) * scale[2],
  ];
  switch (spec.shape) {
    case "sphere":
      return { kind: "sphere", radius: Math.max(half[0], half[1], half[2]), offset };
    case "capsule": {
      const radius = Math.max(0.01, Math.min(half[0], half[2]));
      return { kind: "capsule", radius, halfHeight: Math.max(0, half[1] - radius), offset };
    }
    case "mesh": {
      const positions: number[] = [];
      const indices: number[] = [];
      for (const prim of mesh.primitives) {
        const base = positions.length / 3;
        for (let i = 0; i < prim.positions.length; i += 3) {
          positions.push(prim.positions[i]! * scale[0], prim.positions[i + 1]! * scale[1], prim.positions[i + 2]! * scale[2]);
        }
        for (const idx of prim.indices) indices.push(base + idx);
      }
      return { kind: "mesh", vertices: Float32Array.from(positions), indices: Uint32Array.from(indices) };
    }
    default:
      return { kind: "box", halfExtents: half, offset };
  }
}

/** The scene objects with bodies the cart can read and drive (everything but static), in slot order. */
export function physicsSlots(scene: MeshScene): number[] {
  const out: number[] = [];
  scene.instances.forEach((inst, i) => {
    if (inst.physics && inst.physics.body !== "static" && out.length < PHYS_MAX_BODIES) out.push(i);
  });
  return out;
}

/** Whether a scene has any physics bodies at all. */
export function sceneHasPhysics(scene: MeshScene | null | undefined): boolean {
  return Boolean(scene?.instances.some((inst) => inst.physics));
}

interface Tracked {
  readonly object: number;
  readonly handle: number;
  readonly kind: PhysicsSpec["body"];
  readonly scale: Vec3;
  grounded: boolean;
  /** Characters: last move, for the velocity the cart reads. */
  lastMove: Vec3;
}

export class PhysicsSession {
  private readonly tracked: Tracked[] = [];
  private readonly byObject = new Map<number, Tracked>();
  private rayRequests: ({ origin: Vec3; direction: Vec3; max: number } | null)[] = [];
  private rayResults: (PhysicsRayHit | null)[] = [];
  private tick = 0;

  constructor(
    scene: MeshScene,
    private readonly backend: PhysicsBackend,
  ) {
    const slots = new Set(physicsSlots(scene));
    scene.instances.forEach((inst, i) => {
      const spec = inst.physics;
      if (!spec || (spec.body !== "static" && !slots.has(i))) return;
      const { position, rotation, scale } = splitWorldMatrix(inst.model);
      const handle = backend.addBody({
        kind: spec.body,
        shape: fitShape(spec, inst.mesh, scale),
        position,
        rotation,
        mass: spec.mass,
        friction: spec.friction,
        bounce: spec.bounce,
        object: i,
      });
      if (spec.body === "static") return;
      const t: Tracked = { object: i, handle, kind: spec.body, scale, grounded: false, lastMove: [0, 0, 0] };
      this.tracked.push(t);
      this.byObject.set(i, t);
    });
  }

  /** Write body state and last tick's ray results for the cart to read. */
  beforeTick(block: DataView): void {
    const bodies: PhysicsBodyState[] = this.tracked.map((t) => {
      const s = this.backend.bodyState(t.handle);
      const velocity: Vec3 = t.kind === "character" ? (t.lastMove.map((v) => v / PHYSICS_DT) as unknown as Vec3) : s.velocity;
      return { object: t.object, position: s.position, velocity, grounded: t.grounded, sleeping: s.sleeping };
    });
    writePhysicsState(block, this.tick, bodies, this.rayResults);
  }

  /** Apply the cart's commands, step the world, and cast the rays it asked for. */
  afterTick(block: DataView): void {
    this.rayRequests = [];
    for (const t of this.tracked) if (t.kind === "character") t.lastMove = [0, 0, 0];
    for (const cmd of takePhysicsCommands(block)) {
      const [a, b, c, d, e, f] = cmd.v;
      if (cmd.op === PHYS_OP_RAY) {
        if (cmd.a >= 0 && cmd.a < PHYS_MAX_RAYS) {
          const len = Math.hypot(d, e, f);
          this.rayRequests[cmd.a] = len > 1e-9 ? { origin: [a, b, c], direction: [d / len, e / len, f / len], max: len } : null;
        }
        continue;
      }
      const t = this.byObject.get(cmd.a);
      if (!t) continue;
      if (cmd.op === PHYS_OP_IMPULSE && t.kind === "dynamic") this.backend.applyImpulse(t.handle, [a, b, c]);
      else if (cmd.op === PHYS_OP_VELOCITY && t.kind !== "character") this.backend.setVelocity(t.handle, [a, b, c]);
      else if (cmd.op === PHYS_OP_TELEPORT) this.backend.teleport(t.handle, [a, b, c]);
      else if (cmd.op === PHYS_OP_MOVE && t.kind === "character") {
        const before = this.backend.bodyState(t.handle).position;
        t.grounded = this.backend.moveCharacter(t.handle, [a, b, c]).grounded;
        const after = this.backend.bodyState(t.handle).position;
        t.lastMove = [after[0] - before[0], after[1] - before[1], after[2] - before[2]];
      }
    }
    this.backend.step(PHYSICS_DT);
    this.tick += 1;
    this.rayResults = [];
    for (let slot = 0; slot < PHYS_MAX_RAYS; slot += 1) {
      const req = this.rayRequests[slot];
      this.rayResults[slot] = req ? this.backend.raycast(req.origin, req.direction, req.max) : null;
    }
  }

  /** World matrices for every moving body this frame (scene object index → matrix). */
  overrides(): Map<number, Mat4> {
    const out = new Map<number, Mat4>();
    for (const t of this.tracked) {
      const s = this.backend.bodyState(t.handle);
      out.set(t.object, composeWorldMatrix(s.position, s.rotation, t.scale));
    }
    return out;
  }

  destroy(): void {
    this.backend.destroy();
  }
}
