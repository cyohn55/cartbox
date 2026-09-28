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
/** Levels (see levels.ts in @cartbox/editor): the current level (-1 for none), the one loading (-1), its progress (fixed point, 0..1). */
export const PHYS_HDR_LEVEL = 16;
export const PHYS_HDR_LEVEL_LOADING = 20;
export const PHYS_HDR_LEVEL_PROGRESS = 24;
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

/**
 * Navigation agents (ENGINE_ROADMAP.md, Phase 6; host → Lua): count, then per
 * agent x, y, z (fixed point) and a word packing its key (bits 0-9), flags
 * (bits 10-15, see NAV_FLAG_*) and facing (bits 16-31, signed, 1/10000 rad).
 */
export const PHYS_AGENTS = 3720;
export const PHYS_AGENT_BYTES = 16;
export const PHYS_MAX_AGENTS = 16;
export const NAV_FLAG_MOVING = 1;
export const NAV_FLAG_AIR = 2;
/** It has reached its goal (or has none). */
export const NAV_FLAG_ARRIVED = 4;
/** No way to its goal was found. */
export const NAV_FLAG_NO_PATH = 8;
/** An obstacle the cart moves itself (agents keep clear of it). */
export const NAV_FLAG_OBSTACLE = 16;

/** Each animated object's playback: count, then (object, clip, time in 1/1024 s, state machine state or -1). */
export const PHYS_ANIMS = 6400;
export const PHYS_ANIM_BYTES = 16;
export const PHYS_MAX_ANIMS = 64;
/** Clip events that fired on the last step: count, then (object, event index). */
export const PHYS_ANIM_EVENTS = PHYS_ANIMS + 4 + PHYS_MAX_ANIMS * PHYS_ANIM_BYTES; // 7428
export const PHYS_ANIM_EVENT_BYTES = 8;
export const PHYS_MAX_ANIM_EVENTS = 32;
/** Watched joints' world positions: count, then (object, joint, x, y, z). */
export const PHYS_JOINTS = 7700;
export const PHYS_JOINT_BYTES = 20;
export const PHYS_MAX_JOINTS = 16;

/** The timeline playing: index (-1 none), time in 1/1024 s, flags (1 = playing). Then the events it passed: count + name indices. */
export const PHYS_TIMELINE = 8032;
export const PHYS_TIMELINE_EVENTS = PHYS_TIMELINE + 12; // 8044
export const PHYS_MAX_TIMELINE_EVENTS = 8;

/** Write the timeline's playback and the events it just passed (host → Lua). */
export function writeLevelState(block: DataView, level: { readonly current: number; readonly loading: number; readonly progress: number }): void {
  block.setInt32(PHYS_HDR_LEVEL, level.current, true);
  block.setInt32(PHYS_HDR_LEVEL_LOADING, level.loading, true);
  block.setInt32(PHYS_HDR_LEVEL_PROGRESS, toFix(Math.max(0, Math.min(1, level.progress))), true);
}

export function writeTimelineState(
  block: DataView,
  playback: { readonly index: number; readonly time: number; readonly playing: boolean },
  events: readonly number[] = [],
): void {
  block.setInt32(PHYS_TIMELINE, playback.index, true);
  block.setInt32(PHYS_TIMELINE + 4, toFix(playback.time), true);
  block.setInt32(PHYS_TIMELINE + 8, playback.playing ? 1 : 0, true);
  const n = Math.min(events.length, PHYS_MAX_TIMELINE_EVENTS);
  block.setInt32(PHYS_TIMELINE_EVENTS, n, true);
  for (let i = 0; i < n; i += 1) block.setInt32(PHYS_TIMELINE_EVENTS + 4 + i * 4, events[i]!, true);
}

/** One agent as the cart reads it. */
export interface AgentState {
  readonly key: number;
  readonly position: readonly [number, number, number];
  readonly facing: number;
  readonly flags: number;
}

/** Write the navigation agents (host → Lua). */
export function writeAgents(block: DataView, agents: readonly AgentState[]): void {
  const n = Math.min(agents.length, PHYS_MAX_AGENTS);
  block.setInt32(PHYS_AGENTS, n, true);
  for (let i = 0; i < n; i += 1) {
    const a = agents[i]!;
    const at = PHYS_AGENTS + 4 + i * PHYS_AGENT_BYTES;
    for (let k = 0; k < 3; k += 1) block.setInt32(at + k * 4, toFix(a.position[k]!), true);
    let f = a.facing;
    while (f > Math.PI) f -= 2 * Math.PI;
    while (f < -Math.PI) f += 2 * Math.PI;
    const facing = Math.round(f * 10000) & 0xffff;
    block.setUint32(at + 12, ((a.key & 0x3ff) | ((a.flags & 0x3f) << 10) | (facing << 16)) >>> 0, true);
  }
}

/** Write watched joints' world positions (host → Lua). */
export function writeJointPositions(
  block: DataView,
  joints: readonly { readonly object: number; readonly joint: number; readonly position: readonly [number, number, number] }[],
): void {
  const n = Math.min(joints.length, PHYS_MAX_JOINTS);
  block.setInt32(PHYS_JOINTS, n, true);
  for (let i = 0; i < n; i += 1) {
    const at = PHYS_JOINTS + 4 + i * PHYS_JOINT_BYTES;
    block.setInt32(at, joints[i]!.object, true);
    block.setInt32(at + 4, joints[i]!.joint, true);
    for (let k = 0; k < 3; k += 1) block.setInt32(at + 8 + k * 4, toFix(joints[i]!.position[k]!), true);
  }
}

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
/**
 * Skeletal animation (the block carries it whether or not the cart has physics):
 * a = object, v0 = clip index (-1 = back to the rest pose), v1 = crossfade seconds,
 * v2 = speed, v3 = loop (1) or hold the last frame (0), v4 = start time.
 */
export const PHYS_OP_PLAY = 11;
/** State machines: a = object. SET: v0 = parameter index, v1 = value. TRIGGER: v0 = parameter. GOTO: v0 = state, v1 = fade. */
export const PHYS_OP_ANIM_SET = 12;
export const PHYS_OP_ANIM_TRIGGER = 13;
export const PHYS_OP_ANIM_GOTO = 14;
/**
 * Inverse kinematics (a = object; world-space points; each request stays until
 * its weight is 0): IK v0 = end joint, v1..v3 = target, v4 = weight; IK_POLE
 * (sent just before IK) v0 = end joint, v1..v3 = pole; LOOKAT v0 = joint,
 * v1..v3 = target, v4 = weight, v5 = max angle (degrees); WATCH v0 = joint, to
 * have its world position reported.
 */
export const PHYS_OP_IK = 15;
export const PHYS_OP_IK_POLE = 16;
export const PHYS_OP_LOOKAT = 17;
export const PHYS_OP_WATCH = 18;
/** Timelines: a = timeline index (-1 stops), v0 = start time, v1 = speed. */
export const PHYS_OP_TIMELINE = 19;
/** Levels: a = the level index to switch to. */
export const PHYS_OP_LEVEL = 20;
/**
 * Navigation agents (a = the agent's key, 0..1023): AGENT places one (creating
 * it) at v0..v2 with speed v3 (units/s) and radius v4; v5 = 1 makes it an
 * obstacle the cart moves itself. GOTO sends it toward v0..v2 (v3 = speed, 0 =
 * keep); STOP halts it; REMOVE takes it away.
 */
export const PHYS_OP_AGENT = 21;
export const PHYS_OP_AGENT_GOTO = 22;
export const PHYS_OP_AGENT_STOP = 23;
export const PHYS_OP_AGENT_REMOVE = 24;
/** Spatial loading's focus: a = 1 loads around v0..v2 from now on, a = 0 goes back to the camera. */
export const PHYS_OP_STREAM_FOCUS = 25;

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

/** One animated object's playback as the cart reads it. */
export interface AnimationPlayback {
  readonly object: number;
  /** Clip index, or -1 at rest. */
  readonly clip: number;
  /** Seconds into the clip (wrapped when looping, held at the end otherwise). */
  readonly time: number;
  /** The state machine's current state, or -1 (no machine, or the cart is playing a clip directly). */
  readonly state?: number;
}

/** Write every animated object's playback, and the clip events that just fired (host → Lua). */
export function writeAnimationState(
  block: DataView,
  playback: readonly AnimationPlayback[],
  events: readonly { readonly object: number; readonly event: number }[] = [],
): void {
  const n = Math.min(playback.length, PHYS_MAX_ANIMS);
  block.setInt32(PHYS_ANIMS, n, true);
  for (let i = 0; i < n; i += 1) {
    const at = PHYS_ANIMS + 4 + i * PHYS_ANIM_BYTES;
    block.setInt32(at, playback[i]!.object, true);
    block.setInt32(at + 4, playback[i]!.clip, true);
    block.setInt32(at + 8, toFix(playback[i]!.time), true);
    block.setInt32(at + 12, playback[i]!.state ?? -1, true);
  }
  const ne = Math.min(events.length, PHYS_MAX_ANIM_EVENTS);
  block.setInt32(PHYS_ANIM_EVENTS, ne, true);
  for (let i = 0; i < ne; i += 1) {
    const at = PHYS_ANIM_EVENTS + 4 + i * PHYS_ANIM_EVENT_BYTES;
    block.setInt32(at, events[i]!.object, true);
    block.setInt32(at + 4, events[i]!.event, true);
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
