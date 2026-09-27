/**
 * The physics channel between the host (which runs the physics world) and the
 * cart's Lua (ENGINE_ROADMAP.md, Phase 2).
 *
 * pmem is too small for body state, so physics uses an 8 KB block at the very end
 * of the console's RAM — inside TIC-80's free RAM on every core, where Lua reads
 * and writes it with peek/poke and the host with a view of the WASM heap. Only a
 * cart that has physics bodies uses it.
 *
 * Each core has its own RAM layout (the era models enlarge VRAM and the map), so
 * the block's address comes from a per-model table, measured against the real
 * engine builds by a test (physics.test.ts) that fails if a rebuild moves them.
 * The host writes a magic word at load and the cart's first tick checks it, so a
 * mismatch disables physics rather than corrupting memory.
 *
 * All values are little-endian int32; positions, velocities and distances are
 * fixed point with 1/1024 precision (±2 million units of range).
 */

import type { ModelId } from "../models.js";

/** Where pmem word 0 sits in Lua's RAM address space, and how big RAM is, per core. */
export interface RamLayout {
  readonly pmemAddress: number;
  readonly ramSize: number;
}

const CLASSIC: RamLayout = { pmemAddress: 0x14004, ramSize: 98304 };
const PRO: RamLayout = { pmemAddress: 542304, ramSize: 786432 };
const ERA: RamLayout = { pmemAddress: 257632, ramSize: 393216 };
const HD: RamLayout = { pmemAddress: 3068512, ramSize: 8388608 };

/** RAM layout by console model (models sharing a core share its layout). */
export const RAM_LAYOUTS: Readonly<Record<ModelId, RamLayout>> = {
  classic: CLASSIC,
  voxel: CLASSIC,
  pro: PRO,
  portrait: PRO,
  ps1: ERA,
  n64: ERA,
  xbox360: HD,
  modern: HD,
};

export const PHYS_BLOCK_BYTES = 8192;
export const PHYS_MAGIC = 0x48504243; // "CBPH"
/** Fixed-point scale for positions, velocities, directions and distances. */
export const PHYS_FIX = 1024;

// Host → Lua (written before each tick).
export const PHYS_HDR_MAGIC = 0;
export const PHYS_HDR_BODIES = 4;
export const PHYS_HDR_TICK = 8;
/** A digest of every moving body's exact state after the last step (see physicsStateHash). */
export const PHYS_HDR_HASH = 12;
export const PHYS_BODIES = 64;
export const PHYS_BODY_BYTES = 32; // object, x, y, z, vx, vy, vz, flags
export const PHYS_MAX_BODIES = 64;
export const PHYS_RAYS = PHYS_BODIES + PHYS_MAX_BODIES * PHYS_BODY_BYTES; // 2112
export const PHYS_RAY_BYTES = 32; // hit word (0 miss, 1 non-object, n+2 object n), x, y, z, nx, ny, nz, distance
export const PHYS_MAX_RAYS = 16;
/** This tick's contact events: count, then (a, b, flags) — bit 0 started, bit 1 a trigger. */
export const PHYS_EVENTS = PHYS_RAYS + PHYS_MAX_RAYS * PHYS_RAY_BYTES; // 2624
export const PHYS_EVENT_BYTES = 12;
export const PHYS_MAX_EVENTS = 48;
/** What is inside each trigger now: count, then (trigger, object) pairs. */
export const PHYS_OVERLAPS = PHYS_EVENTS + 4 + PHYS_MAX_EVENTS * PHYS_EVENT_BYTES; // 3204
export const PHYS_OVERLAP_BYTES = 8;
export const PHYS_MAX_OVERLAPS = 64;
export const PHYS_EVENT_STARTED = 1;
export const PHYS_EVENT_TRIGGER = 2;

// Lua → host (written during the tick; read and cleared after it).
export const PHYS_CMDS = 4096;
export const PHYS_CMD_BYTES = 32; // op, a, v0..v5
export const PHYS_MAX_CMDS = 64;

/** Body flags. */
export const PHYS_FLAG_GROUNDED = 1;
export const PHYS_FLAG_SLEEPING = 2;

/** Command ops. */
export const PHYS_OP_IMPULSE = 1;
export const PHYS_OP_VELOCITY = 2;
export const PHYS_OP_TELEPORT = 3;
export const PHYS_OP_MOVE = 4;
export const PHYS_OP_RAY = 5;
/** Scene ops (the block carries them whether or not the cart has physics). */
export const PHYS_OP_SPAWN = 6; // a = the copy's root object, v = x, y, z, yaw, pitch, roll
export const PHYS_OP_DESPAWN = 7; // a = the copy's root object
/**
 * Options for the next ray in a slot this tick (sent just before its PHYS_OP_RAY):
 * a = slot, v0 = shape (CAST_RAY / SPHERE / BOX / CAPSULE), v1..v3 = size
 * (radius · box half-extents · radius and half height), v4 = object to ignore + 1.
 */
export const PHYS_OP_CAST = 8;
export const PHYS_CAST_RAY = 0;
export const PHYS_CAST_SPHERE = 1;
export const PHYS_CAST_BOX = 2;
export const PHYS_CAST_CAPSULE = 3;
/** Joints: a = the jointed object. MOTOR: v0 = speed (rad/s about the hinge), v1 = max force (0 = off). */
export const PHYS_OP_MOTOR = 9;
export const PHYS_OP_UNJOIN = 10;

/** Where the physics block starts in Lua's RAM space for a model. */
export function physicsBlockAddress(layout: RamLayout): number {
  return layout.ramSize - PHYS_BLOCK_BYTES;
}

export const toFix = (v: number): number => {
  const n = Math.round(v * PHYS_FIX);
  return Math.max(-0x7fffffff, Math.min(0x7fffffff, Number.isFinite(n) ? n : 0));
};
export const fromFix = (n: number): number => n / PHYS_FIX;

/** A command the cart wrote this tick. */
export interface PhysicsCommand {
  readonly op: number;
  readonly a: number;
  readonly v: readonly [number, number, number, number, number, number];
}

/** One body's state as the cart reads it. */
export interface PhysicsBodyState {
  readonly object: number;
  readonly position: readonly [number, number, number];
  readonly velocity: readonly [number, number, number];
  readonly grounded: boolean;
  readonly sleeping: boolean;
}

/** One ray result (slot order), or null for a miss / no request. */
export interface PhysicsRayHit {
  readonly object: number; // -1 when the hit collider isn't a scene object
  readonly point: readonly [number, number, number];
  readonly normal: readonly [number, number, number];
  readonly distance: number;
}

/** A contact that began or ended during the last step, between two scene objects. */
export interface PhysicsContactEvent {
  readonly a: number;
  readonly b: number;
  readonly started: boolean;
  /** One of the two is a trigger zone (an overlap, not a collision). */
  readonly trigger: boolean;
}

/** Write the host → Lua half of the block. */
export function writePhysicsState(
  block: DataView,
  tick: number,
  bodies: readonly PhysicsBodyState[],
  rays: readonly (PhysicsRayHit | null)[],
  events: readonly PhysicsContactEvent[] = [],
  overlaps: readonly (readonly [number, number])[] = [],
  hash = 0,
): void {
  block.setInt32(PHYS_HDR_HASH, hash | 0, true);
  const ne = Math.min(events.length, PHYS_MAX_EVENTS);
  block.setInt32(PHYS_EVENTS, ne, true);
  for (let i = 0; i < ne; i += 1) {
    const e = events[i]!;
    const at = PHYS_EVENTS + 4 + i * PHYS_EVENT_BYTES;
    block.setInt32(at, e.a, true);
    block.setInt32(at + 4, e.b, true);
    block.setInt32(at + 8, (e.started ? PHYS_EVENT_STARTED : 0) | (e.trigger ? PHYS_EVENT_TRIGGER : 0), true);
  }
  const no = Math.min(overlaps.length, PHYS_MAX_OVERLAPS);
  block.setInt32(PHYS_OVERLAPS, no, true);
  for (let i = 0; i < no; i += 1) {
    const at = PHYS_OVERLAPS + 4 + i * PHYS_OVERLAP_BYTES;
    block.setInt32(at, overlaps[i]![0], true);
    block.setInt32(at + 4, overlaps[i]![1], true);
  }
  block.setInt32(PHYS_HDR_MAGIC, PHYS_MAGIC, true);
  const n = Math.min(bodies.length, PHYS_MAX_BODIES);
  block.setInt32(PHYS_HDR_BODIES, n, true);
  block.setInt32(PHYS_HDR_TICK, tick | 0, true);
  for (let i = 0; i < n; i += 1) {
    const b = bodies[i]!;
    const at = PHYS_BODIES + i * PHYS_BODY_BYTES;
    block.setInt32(at, b.object, true);
    for (let k = 0; k < 3; k += 1) block.setInt32(at + 4 + k * 4, toFix(b.position[k]!), true);
    for (let k = 0; k < 3; k += 1) block.setInt32(at + 16 + k * 4, toFix(b.velocity[k]!), true);
    block.setInt32(at + 28, (b.grounded ? PHYS_FLAG_GROUNDED : 0) | (b.sleeping ? PHYS_FLAG_SLEEPING : 0), true);
  }
  for (let i = 0; i < PHYS_MAX_RAYS; i += 1) {
    const r = rays[i] ?? null;
    const at = PHYS_RAYS + i * PHYS_RAY_BYTES;
    if (!r) {
      block.setInt32(at, 0, true);
      continue;
    }
    // 0 = miss (above), 1 = hit something that isn't a scene object, n + 2 = hit object n.
    block.setInt32(at, r.object >= 0 ? r.object + 2 : 1, true);
    for (let k = 0; k < 3; k += 1) block.setInt32(at + 4 + k * 4, toFix(r.point[k]!), true);
    for (let k = 0; k < 3; k += 1) block.setInt32(at + 16 + k * 4, toFix(r.normal[k]!), true);
    block.setInt32(at + 28, toFix(r.distance), true);
  }
}

/** Read (and clear) the commands the cart wrote this tick. */
export function takePhysicsCommands(block: DataView): PhysicsCommand[] {
  const n = Math.max(0, Math.min(PHYS_MAX_CMDS, block.getInt32(PHYS_CMDS, true)));
  const out: PhysicsCommand[] = [];
  for (let i = 0; i < n; i += 1) {
    const at = PHYS_CMDS + 4 + i * PHYS_CMD_BYTES;
    const v = [0, 0, 0, 0, 0, 0].map((_, k) => fromFix(block.getInt32(at + 8 + k * 4, true))) as unknown as PhysicsCommand["v"];
    out.push({ op: block.getInt32(at, true), a: block.getInt32(at + 4, true), v });
  }
  block.setInt32(PHYS_CMDS, 0, true);
  return out;
}
