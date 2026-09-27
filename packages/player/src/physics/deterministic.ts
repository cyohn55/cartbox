/**
 * Deterministic physics (ENGINE_ROADMAP.md, Phase 2): the same scene and the same
 * inputs play out bit for bit the same in every browser.
 *
 * Two halves. The physics engine itself must be deterministic across platforms —
 * the web app loads Rapier's deterministic build for that. And every number the
 * host computes in JavaScript before handing it to the engine must be too: world
 * matrices come from Math.sin / Math.cos (spawn turns, authored rotations) and
 * Math.hypot, which browsers are free to round differently in the last bit. So
 * {@link deterministicBackend} rounds every such input onto a fixed grid (1/65536
 * for positions and sizes, 1/2^20 for rotations and directions): two browsers'
 * values a little apart land on the same grid point. The engine's own 32-bit
 * floats already absorb most single-bit differences; the grid is far coarser, so
 * it also absorbs the larger errors that build up through chains of matrix math
 * (a child under a turned parent under another). Only a value that happens to sit
 * within that error of a grid line could still split.
 *
 * What the cart sends is already exact (fixed-point commands from Lua, which runs
 * in WebAssembly and so rounds the same everywhere), and what it reads back is
 * rounded to 1/1024. {@link physicsStateHash} digests the exact state, so peers
 * can compare it to catch a desync.
 */

import type { CastShape, PhysicsBackend, PhysicsBodyDesc, PhysicsJointDesc, PhysicsShape, Quat, Vec3 } from "./physicsSession.js";

const GRID = 65536;
const FINE = 1048576;

/** Round a length onto the 1/65536 grid. */
export const snap = (v: number): number => (Number.isFinite(v) ? Math.round(v * GRID) / GRID : 0);
const fine = (v: number): number => (Number.isFinite(v) ? Math.round(v * FINE) / FINE : 0);
const snap3 = (v: Vec3): Vec3 => [snap(v[0]), snap(v[1]), snap(v[2])];
const fine3 = (v: Vec3): Vec3 => [fine(v[0]), fine(v[1]), fine(v[2])];
/** A unit quaternion on the fine grid (the engine renormalizes it). */
const fineQ = (q: Quat): Quat => [fine(q[0]), fine(q[1]), fine(q[2]), fine(q[3])];

function snapShape(shape: PhysicsShape): PhysicsShape {
  switch (shape.kind) {
    case "box":
      return { kind: "box", halfExtents: snap3(shape.halfExtents), offset: snap3(shape.offset) };
    case "sphere":
      return { kind: "sphere", radius: snap(shape.radius), offset: snap3(shape.offset) };
    case "capsule":
      return { kind: "capsule", radius: snap(shape.radius), halfHeight: snap(shape.halfHeight), offset: snap3(shape.offset) };
    case "mesh":
      return { kind: "mesh", vertices: shape.vertices.map(snap), indices: shape.indices };
  }
}

function snapCastShape(shape: CastShape): CastShape {
  switch (shape.kind) {
    case "sphere":
      return { kind: "sphere", radius: snap(shape.radius) };
    case "box":
      return { kind: "box", halfExtents: snap3(shape.halfExtents) };
    case "capsule":
      return { kind: "capsule", radius: snap(shape.radius), halfHeight: snap(shape.halfHeight) };
  }
}

/** Wrap a backend so every value the host computes reaches it on a fixed grid. */
export function deterministicBackend(inner: PhysicsBackend): PhysicsBackend {
  const out: PhysicsBackend = {
    addBody: (desc: PhysicsBodyDesc) =>
      inner.addBody({
        ...desc,
        shape: snapShape(desc.shape),
        position: snap3(desc.position),
        rotation: fineQ(desc.rotation),
        mass: snap(desc.mass),
        friction: snap(desc.friction),
        bounce: snap(desc.bounce),
        ...(desc.gravity !== undefined ? { gravity: snap(desc.gravity) } : {}),
        ...(desc.damping !== undefined ? { damping: snap(desc.damping) } : {}),
      }),
    step: (dt) => inner.step(dt),
    bodyState: (handle) => inner.bodyState(handle),
    applyImpulse: (handle, v) => inner.applyImpulse(handle, snap3(v)),
    setVelocity: (handle, v) => inner.setVelocity(handle, snap3(v)),
    teleport: (handle, p) => inner.teleport(handle, snap3(p)),
    moveCharacter: (handle, d) => inner.moveCharacter(handle, snap3(d)),
    raycast: (origin, direction, max, ignore) => inner.raycast(snap3(origin), fine3(direction), snap(max), ignore),
    setEnabled: (handle, enabled) => inner.setEnabled(handle, enabled),
    setPose: (handle, p, q) => inner.setPose(handle, snap3(p), fineQ(q)),
    drainContacts: () => inner.drainContacts(),
    overlaps: () => inner.overlaps(),
    destroy: () => inner.destroy(),
  };
  if (inner.shapecast) {
    const cast = inner.shapecast.bind(inner);
    out.shapecast = (shape, origin, direction, max, ignore) => cast(snapCastShape(shape), snap3(origin), fine3(direction), snap(max), ignore);
  }
  if (inner.addJoint) {
    const add = inner.addJoint.bind(inner);
    out.addJoint = (desc: PhysicsJointDesc) =>
      add({
        ...desc,
        anchor1: snap3(desc.anchor1),
        frame1: fineQ(desc.frame1),
        anchor2: snap3(desc.anchor2),
        frame2: fineQ(desc.frame2),
        ...(desc.limits ? { limits: [fine(desc.limits[0]), fine(desc.limits[1])] as const } : {}),
        length: snap(desc.length),
        stiffness: snap(desc.stiffness),
        damping: snap(desc.damping),
      });
  }
  if (inner.removeJoint) out.removeJoint = inner.removeJoint.bind(inner);
  if (inner.setMotor) {
    const motor = inner.setMotor.bind(inner);
    out.setMotor = (joint, speed, force) => motor(joint, snap(speed), snap(force));
  }
  return out;
}

const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);

/**
 * A 32-bit FNV-1a digest of bodies' exact state (positions, rotations and
 * velocities as the engine's 32-bit floats), in order: equal on two machines
 * exactly when their worlds match.
 */
export function physicsStateHash(states: Iterable<{ position: Vec3; rotation: Quat; velocity: Vec3 }>): number {
  let h = 0x811c9dc5;
  const mix = (v: number) => {
    f32[0] = v;
    let w = u32[0]!;
    for (let k = 0; k < 4; k += 1) {
      h ^= w & 0xff;
      h = Math.imul(h, 0x01000193);
      w >>>= 8;
    }
  };
  for (const s of states) {
    for (const v of s.position) mix(v);
    for (const v of s.rotation) mix(v);
    for (const v of s.velocity) mix(v);
  }
  return h | 0;
}
