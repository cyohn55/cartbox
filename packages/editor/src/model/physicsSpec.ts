/**
 * A scene object's physics settings (ENGINE_ROADMAP.md, Phase 2), stored on its
 * mesh sidecar entry. Absent means the object takes no part in physics.
 *
 * - `static`: never moves; others collide with it (floors, walls, level geometry).
 * - `dynamic`: simulated — falls, bounces, is pushed (crates, balls, debris).
 * - `kinematic`: moved only by the cart (cartbox.teleport / velocity), pushes
 *   dynamic bodies (lifts, doors, moving platforms).
 * - `character`: an upright capsule moved with cartbox.move, which slides along
 *   walls, climbs slopes and steps and reports whether it's on the ground.
 *
 * The collider is fitted to the object's mesh: a box or sphere around its bounds,
 * an upright capsule, or (static only) the mesh's own triangles.
 *
 * A dynamic body may also carry a joint (see {@link JointSpec}), which ties it to
 * its nearest ancestor in the Hierarchy that has a body — or, with none, to the
 * world. Tying to the hierarchy (rather than to an object by id) keeps joints
 * working inside prefabs, whose copies get fresh ids.
 */

export type JointKind = "hinge" | "ball" | "fixed" | "spring" | "rope";
export type JointAxis = "x" | "y" | "z";

/**
 * How a dynamic body is attached to its ancestor's body (or the world).
 *
 * - `hinge`: turns about one of its own axes through `anchor` (doors, wheels,
 *   levers); optional angle `limits`, and a motor driven by cartbox.motor.
 * - `ball`: swivels freely about `anchor` (ragdoll joints, chains).
 * - `fixed`: welded where it starts (breakable with cartbox.unjoin).
 * - `spring`: its centre is pulled toward `anchor` (a point that moves with the
 *   ancestor), resting at `length`.
 * - `rope`: its centre stays within `length` of `anchor` (pendulums, tethers).
 */
export interface JointSpec {
  readonly kind: JointKind;
  /** The attach point in the object's own coordinates (before its scale). Default: its origin. */
  readonly anchor: readonly [number, number, number];
  /** Hinge: which of the object's own axes it turns about. Default y. */
  readonly axis?: JointAxis;
  /** Hinge: [min, max] degrees either side of where it starts (-180..180). Absent = free. */
  readonly limits?: readonly [number, number];
  /** Spring rest length / rope's longest reach. Absent = the distance to `anchor` at the start. */
  readonly length?: number;
  /** Spring stiffness (0..100000). Absent = 50. */
  readonly stiffness?: number;
  /** Spring damping (0..10000). Absent = 1. */
  readonly damping?: number;
}

export const JOINT_KINDS: readonly JointKind[] = ["hinge", "ball", "fixed", "spring", "rope"];
export const DEFAULT_SPRING_STIFFNESS = 50;
export const DEFAULT_SPRING_DAMPING = 1;

export type PhysicsBodyKind = "static" | "dynamic" | "kinematic" | "character";
export type PhysicsShapeKind = "box" | "sphere" | "capsule" | "mesh";

export interface PhysicsSpec {
  readonly body: PhysicsBodyKind;
  readonly shape: PhysicsShapeKind;
  /** kg, dynamic bodies only (0.01..10000). */
  readonly mass: number;
  /** 0..2. */
  readonly friction: number;
  /** Restitution 0..1 (0 = no bounce). */
  readonly bounce: number;
  /**
   * A trigger zone: detects what enters and leaves it (cartbox.entered /
   * exited / inside) without blocking anything. Optional; absent = solid.
   */
  readonly trigger?: boolean;
  /** Gravity multiplier for a dynamic body (-10..10; 0 floats, negative rises). Absent = 1. */
  readonly gravity?: number;
  /** Linear damping 0..10 — how quickly a dynamic body slows (air drag). Absent = 0. */
  readonly damping?: number;
  /** Dynamic bodies: a joint to the nearest ancestor with a body, or the world. */
  readonly joint?: JointSpec;
}

export const PHYSICS_BODY_KINDS: readonly PhysicsBodyKind[] = ["static", "dynamic", "kinematic", "character"];
export const PHYSICS_SHAPE_KINDS: readonly PhysicsShapeKind[] = ["box", "sphere", "capsule", "mesh"];

export const DEFAULT_PHYSICS_SPEC: PhysicsSpec = { body: "static", shape: "box", mass: 1, friction: 0.6, bounce: 0 };

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const num = (v: unknown, lo: number, hi: number, fallback: number) =>
  typeof v === "number" && Number.isFinite(v) ? clamp(v, lo, hi) : fallback;

/** Read a stored joint, or null when absent or unusable; fields irrelevant to its kind are dropped. */
export function readJointSpec(value: unknown): JointSpec | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as Record<string, unknown>;
  const kind = JOINT_KINDS.includes(raw.kind as JointKind) ? (raw.kind as JointKind) : null;
  if (!kind) return null;
  const a = Array.isArray(raw.anchor) ? raw.anchor : [];
  const anchor = [0, 1, 2].map((i) => num(a[i], -1000, 1000, 0)) as unknown as JointSpec["anchor"];
  const out: { -readonly [K in keyof JointSpec]: JointSpec[K] } = { kind, anchor };
  if (kind === "hinge") {
    if (raw.axis === "x" || raw.axis === "z") out.axis = raw.axis;
    if (Array.isArray(raw.limits) && raw.limits.length === 2) {
      const lo = num(raw.limits[0], -180, 180, NaN);
      const hi = num(raw.limits[1], -180, 180, NaN);
      if (Number.isFinite(lo) && Number.isFinite(hi)) out.limits = [Math.min(lo, hi), Math.max(lo, hi)];
    }
  }
  if (kind === "spring" || kind === "rope") {
    const length = num(raw.length, 0, 1000, NaN);
    if (Number.isFinite(length)) out.length = length;
  }
  if (kind === "spring") {
    const stiffness = num(raw.stiffness, 0, 100000, DEFAULT_SPRING_STIFFNESS);
    const damping = num(raw.damping, 0, 10000, DEFAULT_SPRING_DAMPING);
    if (stiffness !== DEFAULT_SPRING_STIFFNESS) out.stiffness = stiffness;
    if (damping !== DEFAULT_SPRING_DAMPING) out.damping = damping;
  }
  return out;
}

/**
 * Read a stored physics spec, or null when absent or unusable. The shape is made
 * consistent with the body: a character is always a capsule, and only a static
 * body may use its mesh's triangles (moving triangle meshes are not supported).
 */
export function readPhysicsSpec(value: unknown): PhysicsSpec | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as Record<string, unknown>;
  const body = PHYSICS_BODY_KINDS.includes(raw.body as PhysicsBodyKind) ? (raw.body as PhysicsBodyKind) : null;
  if (!body) return null;
  let shape = PHYSICS_SHAPE_KINDS.includes(raw.shape as PhysicsShapeKind) ? (raw.shape as PhysicsShapeKind) : "box";
  if (body === "character") shape = "capsule";
  else if (shape === "mesh" && body !== "static") shape = "box";
  const gravity = num(raw.gravity, -10, 10, 1);
  const damping = num(raw.damping, 0, 10, 0);
  // Only a simulated body hangs, swings or springs.
  const joint = body === "dynamic" ? readJointSpec(raw.joint) : null;
  return {
    body,
    shape,
    mass: num(raw.mass, 0.01, 10000, DEFAULT_PHYSICS_SPEC.mass),
    friction: num(raw.friction, 0, 2, DEFAULT_PHYSICS_SPEC.friction),
    bounce: num(raw.bounce, 0, 1, DEFAULT_PHYSICS_SPEC.bounce),
    // Characters walk into triggers but aren't one; optional fields are kept only when set.
    ...(raw.trigger === true && body !== "character" ? { trigger: true } : {}),
    ...(gravity !== 1 ? { gravity } : {}),
    ...(damping !== 0 ? { damping } : {}),
    ...(joint ? { joint } : {}),
  };
}

/**
 * Scene-wide physics settings (the sidecar's `physicsWorld`), absent by default.
 *
 * `deterministic`: run Rapier's cross-platform deterministic build and round every
 * number the host computes before it reaches the physics world, so a scene plays
 * out bit for bit the same in every browser — for replays and for netplay carts
 * that simulate shared objects on each player's machine. A little slower.
 */
export interface PhysicsWorldSettings {
  readonly deterministic?: boolean;
}

/** Read stored world settings, or null when none are set. */
export function readPhysicsWorld(value: unknown): PhysicsWorldSettings | null {
  if (typeof value !== "object" || value === null) return null;
  return (value as Record<string, unknown>).deterministic === true ? { deterministic: true } : null;
}
