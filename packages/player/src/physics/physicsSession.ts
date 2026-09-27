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
 * step, and casts the requested rays (and shape sweeps) for the next tick to read.
 */

import { DEFAULT_SPRING_DAMPING, DEFAULT_SPRING_STIFFNESS, meshBounds, type JointKind, type JointSpec, type Mat4, type MeshAsset, type PhysicsSpec } from "@cartbox/editor";

import type { MeshScene } from "../mesh/meshScene.js";
import { deterministicBackend, physicsStateHash } from "./deterministic.js";
import {
  PHYS_MAX_BODIES,
  PHYS_CAST_BOX,
  PHYS_CAST_CAPSULE,
  PHYS_CAST_SPHERE,
  PHYS_MAX_RAYS,
  PHYS_OP_CAST,
  PHYS_OP_IMPULSE,
  PHYS_OP_MOTOR,
  PHYS_OP_MOVE,
  PHYS_OP_RAY,
  PHYS_OP_TELEPORT,
  PHYS_OP_UNJOIN,
  PHYS_OP_VELOCITY,
  takePhysicsCommands,
  writePhysicsState,
  type PhysicsBodyState,
  type PhysicsCommand,
  type PhysicsContactEvent,
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

/** A shape swept through the world by a shape cast (upright, unrotated). */
export type CastShape =
  | { readonly kind: "sphere"; readonly radius: number }
  | { readonly kind: "box"; readonly halfExtents: Vec3 }
  | { readonly kind: "capsule"; readonly radius: number; readonly halfHeight: number };

/** What a ray or shape cast hit. */
export interface CastHit {
  readonly object: number;
  readonly point: Vec3;
  readonly normal: Vec3;
  readonly distance: number;
}

export interface PhysicsBodyDesc {
  readonly kind: PhysicsSpec["body"];
  readonly shape: PhysicsShape;
  readonly position: Vec3;
  readonly rotation: Quat;
  readonly mass: number;
  readonly friction: number;
  readonly bounce: number;
  /** A trigger zone: reports overlaps, blocks nothing. */
  readonly trigger?: boolean;
  /** Gravity multiplier (dynamic bodies). */
  readonly gravity?: number;
  /** Linear damping (dynamic bodies). */
  readonly damping?: number;
  /** The scene object this body belongs to (reported back by raycasts). */
  readonly object: number;
}

/**
 * A joint between a body and another (or the world), as local frames on each:
 * at the start the two frames coincide in the world. A hinge turns about its
 * frames' X axis; limits are radians from that start.
 */
export interface PhysicsJointDesc {
  readonly kind: JointKind;
  readonly body: number;
  /** The other body's handle, or null for the world (frame2 is then in world space). */
  readonly target: number | null;
  readonly anchor1: Vec3;
  readonly frame1: Quat;
  readonly anchor2: Vec3;
  readonly frame2: Quat;
  readonly limits?: readonly [number, number];
  /** Spring rest length / rope's longest reach. */
  readonly length: number;
  readonly stiffness: number;
  readonly damping: number;
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
  /**
   * The nearest hit along a unit `direction` within `maxDistance`, or null.
   * `ignore` is a scene object whose body the ray passes through.
   */
  raycast(origin: Vec3, direction: Vec3, maxDistance: number, ignore?: number): CastHit | null;
  /**
   * Sweep `shape` from `origin` along a unit `direction`: the first hit within
   * `maxDistance` (distance = how far the shape's centre travelled before touching;
   * point and normal are on the surface hit), or null.
   */
  shapecast?(shape: CastShape, origin: Vec3, direction: Vec3, maxDistance: number, ignore?: number): CastHit | null;
  /** Take a body out of (or back into) the world — a spawnable copy waiting in reserve. */
  setEnabled(handle: number, enabled: boolean): void;
  /** Place a body at a position and rotation at once, at rest. */
  setPose(handle: number, position: Vec3, rotation: Quat): void;
  /** Contacts that began or ended during the last step (scene object indices). */
  drainContacts(): PhysicsContactEvent[];
  /** What is inside each trigger now, as (trigger object, other object) pairs. */
  overlaps(): [number, number][];
  /** Joints (optional: a backend without them leaves bodies unjointed). */
  addJoint?(desc: PhysicsJointDesc): number;
  removeJoint?(joint: number): void;
  /** Drive a hinge at `speed` rad/s with at most `force` (0 turns the motor off). */
  setMotor?(joint: number, speed: number, force: number): void;
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

const qmul = (a: Quat, b: Quat): Quat => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
];
const qconj = (q: Quat): Quat => [-q[0], -q[1], -q[2], q[3]];
/** Rotate v by unit quaternion q. */
function qrot(q: Quat, v: Vec3): Vec3 {
  const r = qmul(qmul(q, [v[0], v[1], v[2], 0]), qconj(q));
  return [r[0], r[1], r[2]];
}
const S = Math.SQRT1_2;
/** Rotations taking a hinge frame's X axis onto the object's own x / y / z axis. */
const HINGE_FRAME: Readonly<Record<string, Quat>> = { x: [0, 0, 0, 1], y: [0, 0, S, S], z: [0, -S, 0, S] };

/**
 * The joint frames for a body posed by world matrix `self`, tied to a target posed
 * by `target` (null: the world). The anchor is in the object's own coordinates, so
 * it's scaled with the object; a spring or rope pulls the object's centre toward it.
 */
export function jointFrames(
  spec: JointSpec,
  self: Mat4,
  target: Mat4 | null,
): Omit<PhysicsJointDesc, "body" | "target"> {
  const a = splitWorldMatrix(self);
  const b = target ? splitWorldMatrix(target) : { position: [0, 0, 0] as Vec3, rotation: [0, 0, 0, 1] as Quat };
  const local: Vec3 = [spec.anchor[0] * a.scale[0], spec.anchor[1] * a.scale[1], spec.anchor[2] * a.scale[2]];
  const offset = qrot(a.rotation, local);
  const world: Vec3 = [a.position[0] + offset[0], a.position[1] + offset[1], a.position[2] + offset[2]];
  const inB = qconj(b.rotation);
  const anchor2 = qrot(inB, [world[0] - b.position[0], world[1] - b.position[1], world[2] - b.position[2]]);
  const pulls = spec.kind === "spring" || spec.kind === "rope";
  const frame1 = spec.kind === "hinge" ? HINGE_FRAME[spec.axis ?? "y"]! : ([0, 0, 0, 1] as Quat);
  const deg = Math.PI / 180;
  return {
    kind: spec.kind,
    anchor1: pulls ? [0, 0, 0] : local,
    frame1,
    anchor2,
    frame2: qmul(qmul(inB, a.rotation), frame1),
    ...(spec.kind === "hinge" && spec.limits ? { limits: [spec.limits[0] * deg, spec.limits[1] * deg] as const } : {}),
    length: spec.length ?? Math.hypot(local[0], local[1], local[2]),
    stiffness: spec.stiffness ?? DEFAULT_SPRING_STIFFNESS,
    damping: spec.damping ?? DEFAULT_SPRING_DAMPING,
  };
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

/** The shape a PHYS_OP_CAST asks to sweep (sizes at least 1 mm), or null for a plain ray. */
function castShape(kind: number, a: number, b: number, c: number): CastShape | null {
  const size = (v: number) => Math.max(0.001, Math.abs(v));
  switch (Math.round(kind)) {
    case PHYS_CAST_SPHERE:
      return { kind: "sphere", radius: size(a) };
    case PHYS_CAST_BOX:
      return { kind: "box", halfExtents: [size(a), size(b), size(c)] };
    case PHYS_CAST_CAPSULE:
      return { kind: "capsule", radius: size(a), halfHeight: Math.max(0, b) };
    default:
      return null;
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
  /** Part of a prefab copy in reserve: out of the world until spawned. */
  enabled: boolean;
}

export class PhysicsSession {
  private readonly tracked: Tracked[] = [];
  private readonly byObject = new Map<number, Tracked>();
  /** Bodies of reserve prefab copies (static ones too), by object index. */
  private readonly pooledBodies = new Map<number, { handle: number; enabled: boolean }>();
  /** Every body's handle, by object index. */
  private readonly handleOf = new Map<number, number>();
  /** Jointed objects: what they're tied to (object, or null for the world) and the live joint. */
  private readonly joints = new Map<number, { spec: JointSpec; target: number | null; handle: number | null; pooled: boolean }>();
  private rayRequests: ({ origin: Vec3; direction: Vec3; max: number; shape: CastShape | null; ignore?: number } | null)[] = [];
  private rayResults: (PhysicsRayHit | null)[] = [];
  private events: PhysicsContactEvent[] = [];
  private overlapPairs: [number, number][] = [];
  private tick = 0;
  private stateHash = 0;
  private readonly backend: PhysicsBackend;
  /** Whether inputs are rounded for cross-browser determinism (the scene's setting unless overridden). */
  readonly deterministic: boolean;

  constructor(scene: MeshScene, backend: PhysicsBackend, { deterministic }: { deterministic?: boolean } = {}) {
    this.deterministic = deterministic ?? scene.physicsWorld?.deterministic === true;
    this.backend = this.deterministic ? deterministicBackend(backend) : backend;
    const slots = new Set(physicsSlots(scene));
    scene.instances.forEach((inst, i) => {
      const spec = inst.physics;
      if (!spec || (spec.body !== "static" && !slots.has(i))) return;
      const pooled = Boolean(inst.pooled);
      const { position, rotation, scale } = splitWorldMatrix(inst.model);
      const handle = this.backend.addBody({
        kind: spec.body,
        shape: fitShape(spec, inst.mesh, scale),
        position,
        rotation,
        mass: spec.mass,
        friction: spec.friction,
        bounce: spec.bounce,
        ...(spec.trigger ? { trigger: true } : {}),
        ...(spec.gravity !== undefined ? { gravity: spec.gravity } : {}),
        ...(spec.damping !== undefined ? { damping: spec.damping } : {}),
        object: i,
      });
      this.handleOf.set(i, handle);
      if (pooled) {
        this.backend.setEnabled(handle, false);
        this.pooledBodies.set(i, { handle, enabled: false });
      }
      if (spec.body === "static") return;
      const t: Tracked = { object: i, handle, kind: spec.body, scale, grounded: false, lastMove: [0, 0, 0], enabled: !pooled };
      this.tracked.push(t);
      this.byObject.set(i, t);
    });
    // Joints tie a body to its nearest ancestor with a body, or the world.
    scene.instances.forEach((inst, i) => {
      const spec = inst.physics?.joint;
      if (!spec || !this.handleOf.has(i)) return;
      let target: number | null = null;
      for (let p = inst.parent; p >= 0; p = scene.instances[p]!.parent) {
        if (this.handleOf.has(p)) {
          target = p;
          break;
        }
      }
      this.joints.set(i, { spec, target, handle: null, pooled: Boolean(inst.pooled) });
    });
    // A reserve copy's joints are made when it spawns, where it's placed.
    const model = (object: number) => scene.instances[object]?.model ?? null;
    for (const [object, joint] of this.joints) if (!joint.pooled) this.join(object, model);
  }

  /** Create `object`'s joint from where it and its target are now (`world` gives world matrices). */
  private join(object: number, world: (object: number) => Mat4 | null): void {
    const joint = this.joints.get(object);
    const handle = this.handleOf.get(object);
    const self = world(object);
    if (!joint || handle === undefined || !self || !this.backend.addJoint) return;
    this.unjoin(object);
    const target = joint.target === null ? null : world(joint.target);
    if (joint.target !== null && !target) return;
    joint.handle = this.backend.addJoint({
      ...jointFrames(joint.spec, self, target),
      body: handle,
      target: joint.target === null ? null : this.handleOf.get(joint.target)!,
    });
  }

  private unjoin(object: number): void {
    const joint = this.joints.get(object);
    if (joint?.handle == null) return;
    this.backend.removeJoint?.(joint.handle);
    joint.handle = null;
  }

  /** Write body state and last tick's ray results for the cart to read. */
  beforeTick(block: DataView): void {
    const bodies: PhysicsBodyState[] = this.tracked.map((t) => {
      const s = this.backend.bodyState(t.handle);
      const velocity: Vec3 = t.kind === "character" ? (t.lastMove.map((v) => v / PHYSICS_DT) as unknown as Vec3) : s.velocity;
      return { object: t.object, position: s.position, velocity, grounded: t.grounded, sleeping: s.sleeping };
    });
    writePhysicsState(block, this.tick, bodies, this.rayResults, this.events, this.overlapPairs, this.stateHash);
  }

  /** Apply the cart's commands, step the world, and cast the rays it asked for. */
  afterTick(block: DataView): void {
    this.run(takePhysicsCommands(block));
  }

  /**
   * Take the bodies of objects in unloaded levels out of the world, and bring the
   * rest back (see levels.ts in @cartbox/editor). Prefab copies aren't in levels.
   */
  setInactive(objects: ReadonlySet<number>): void {
    for (const t of this.byObject.values()) {
      if (this.pooledBodies.has(t.object)) continue;
      const active = !objects.has(t.object);
      if (t.enabled === active) continue;
      this.backend.setEnabled(t.handle, active);
      t.enabled = active;
      t.grounded = false;
    }
  }

  /**
   * Bring a spawned prefab copy's bodies into the world, placed where the copy's
   * objects now are (`world` gives each object's world matrix), or take them out.
   */
  setCopyActive(objects: readonly number[], world: (object: number) => Mat4 | null, active: boolean): void {
    for (const object of objects) {
      const body = this.pooledBodies.get(object);
      if (!body) continue;
      if (active) {
        const m = world(object);
        if (m) {
          const { position, rotation } = splitWorldMatrix(m);
          this.backend.setPose(body.handle, position, rotation);
        }
      }
      if (body.enabled !== active) this.backend.setEnabled(body.handle, active);
      body.enabled = active;
      const t = this.byObject.get(object);
      if (t) {
        t.enabled = active;
        t.grounded = false;
      }
    }
    // Once every body is placed, a spawned copy's joints are made afresh (even
    // ones the cart broke last time); a despawned copy's are removed.
    for (const object of objects) {
      if (!this.joints.has(object)) continue;
      if (active) this.join(object, (o) => (objects.includes(o) ? world(o) : this.currentWorld(o)));
      else this.unjoin(object);
    }
  }

  /** A body's world matrix now (position and rotation from physics; unit scale). */
  private currentWorld(object: number): Mat4 | null {
    const handle = this.handleOf.get(object);
    if (handle === undefined) return null;
    const s = this.backend.bodyState(handle);
    return composeWorldMatrix(s.position, s.rotation, this.byObject.get(object)?.scale ?? [1, 1, 1]);
  }

  /** Apply a tick's commands (already taken from the block), step, and cast rays. */
  run(commands: readonly PhysicsCommand[]): void {
    this.rayRequests = [];
    // Shape and ignore options for the next ray in each slot (see PHYS_OP_CAST).
    const castOptions = new Map<number, { shape: CastShape | null; ignore?: number }>();
    for (const t of this.tracked) if (t.kind === "character") t.lastMove = [0, 0, 0];
    for (const cmd of commands) {
      const [a, b, c, d, e, f] = cmd.v;
      if (cmd.op === PHYS_OP_CAST) {
        if (cmd.a >= 0 && cmd.a < PHYS_MAX_RAYS) {
          const ignore = Math.round(e) - 1;
          castOptions.set(cmd.a, { shape: castShape(a, b, c, d), ...(ignore >= 0 ? { ignore } : {}) });
        }
        continue;
      }
      if (cmd.op === PHYS_OP_RAY) {
        if (cmd.a >= 0 && cmd.a < PHYS_MAX_RAYS) {
          const len = Math.hypot(d, e, f);
          const options = castOptions.get(cmd.a) ?? { shape: null };
          castOptions.delete(cmd.a);
          this.rayRequests[cmd.a] = len > 1e-9 ? { origin: [a, b, c], direction: [d / len, e / len, f / len], max: len, ...options } : null;
        }
        continue;
      }
      const t = this.byObject.get(cmd.a);
      if (!t || !t.enabled) continue;
      if (cmd.op === PHYS_OP_MOTOR || cmd.op === PHYS_OP_UNJOIN) {
        const joint = this.joints.get(cmd.a);
        if (joint?.handle == null) continue;
        if (cmd.op === PHYS_OP_UNJOIN) this.unjoin(cmd.a);
        else if (joint.spec.kind === "hinge") this.backend.setMotor?.(joint.handle, a, Math.max(0, b));
        continue;
      }
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
    this.events = this.backend.drainContacts();
    this.overlapPairs = this.backend.overlaps();
    this.tick += 1;
    this.stateHash = this.hash();
    this.rayResults = [];
    for (let slot = 0; slot < PHYS_MAX_RAYS; slot += 1) {
      const req = this.rayRequests[slot];
      if (!req) this.rayResults[slot] = null;
      else if (req.shape) this.rayResults[slot] = this.backend.shapecast?.(req.shape, req.origin, req.direction, req.max, req.ignore) ?? null;
      else this.rayResults[slot] = this.backend.raycast(req.origin, req.direction, req.max, req.ignore);
    }
  }

  /**
   * A digest of every moving body's exact state (reserve copies count as absent),
   * equal on two machines exactly when their worlds match — in deterministic mode,
   * across browsers too.
   */
  hash(): number {
    return physicsStateHash(
      this.tracked.map((t) => (t.enabled ? this.backend.bodyState(t.handle) : { position: [0, 0, 0], rotation: [0, 0, 0, 0], velocity: [0, 0, 0] })),
    );
  }

  /** Last step's contact events and current trigger overlaps (live inspection, tests). */
  contacts(): { events: readonly PhysicsContactEvent[]; overlaps: readonly (readonly [number, number])[] } {
    return { events: this.events, overlaps: this.overlapPairs };
  }

  /** Each moving body's live state, by object index (live inspection). */
  inspect(): Map<number, { kind: string; velocity: Vec3; grounded: boolean; active: boolean }> {
    const out = new Map<number, { kind: string; velocity: Vec3; grounded: boolean; active: boolean }>();
    for (const t of this.tracked) {
      const s = this.backend.bodyState(t.handle);
      const velocity = t.kind === "character" ? (t.lastMove.map((v) => v / PHYSICS_DT) as unknown as Vec3) : s.velocity;
      out.set(t.object, { kind: t.kind, velocity, grounded: t.grounded, active: t.enabled });
    }
    return out;
  }

  /** World matrices for every moving body this frame (scene object index → matrix). */
  overrides(): Map<number, Mat4> {
    const out = new Map<number, Mat4>();
    for (const t of this.tracked) {
      if (!t.enabled) continue;
      const s = this.backend.bodyState(t.handle);
      out.set(t.object, composeWorldMatrix(s.position, s.rotation, t.scale));
    }
    return out;
  }

  destroy(): void {
    this.backend.destroy();
  }
}
