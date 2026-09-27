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
 */

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
}

export const PHYSICS_BODY_KINDS: readonly PhysicsBodyKind[] = ["static", "dynamic", "kinematic", "character"];
export const PHYSICS_SHAPE_KINDS: readonly PhysicsShapeKind[] = ["box", "sphere", "capsule", "mesh"];

export const DEFAULT_PHYSICS_SPEC: PhysicsSpec = { body: "static", shape: "box", mass: 1, friction: 0.6, bounce: 0 };

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const num = (v: unknown, lo: number, hi: number, fallback: number) =>
  typeof v === "number" && Number.isFinite(v) ? clamp(v, lo, hi) : fallback;

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
  };
}
