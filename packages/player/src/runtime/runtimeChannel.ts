/**
 * The per-tick exchange between the host and a cart's Lua through the shared
 * block at the end of RAM (physics/protocol.ts): physics state out, and the
 * cart's commands in — physics ones for the {@link PhysicsSession}, scene ones
 * (spawning and despawning prefab copies) handled here, and animation ones for
 * the {@link AnimationSession}.
 *
 * A cart gets a channel when its scene has physics bodies, spawnable prefabs or
 * skinned (animated) objects.
 */

import {
  composeModelMatrix,
  invertAffine,
  jointPosition,
  multiplyMat4,
  solveLookAt,
  solveTwoBoneIK,
  type Mat4,
  type MeshAsset,
} from "@cartbox/editor";

import { AnimationSession, sceneHasAnimation } from "../anim/animationSession.js";
import { AgentCrowd } from "../nav/agentCrowd.js";
import { TimelineSession } from "../anim/timelineSession.js";
import type { MailboxMeshCamera } from "../mailbox.js";
import type { MeshScene } from "../mesh/meshScene.js";
import type { PhysicsSession } from "../physics/physicsSession.js";
import { PHYSICS_DT } from "../physics/physicsSession.js";
import {
  PHYS_OP_ANIM_GOTO,
  PHYS_OP_ANIM_SET,
  PHYS_OP_ANIM_TRIGGER,
  PHYS_MAX_JOINTS,
  PHYS_OP_DESPAWN,
  PHYS_OP_IK,
  PHYS_OP_IK_POLE,
  PHYS_OP_LOOKAT,
  PHYS_OP_PLAY,
  PHYS_OP_SPAWN,
  PHYS_OP_TIMELINE,
  PHYS_OP_LEVEL,
  PHYS_OP_WATCH,
  PHYS_OP_AGENT,
  PHYS_OP_AGENT_GOTO,
  PHYS_OP_AGENT_STOP,
  PHYS_OP_AGENT_REMOVE,
  PHYS_MAX_AGENTS,
  takePhysicsCommands,
  writeAgents,
  writeAnimationState,
  writeJointPositions,
  writePhysicsState,
  writeTimelineState,
  writeLevelState,
} from "../physics/protocol.js";

const DEG = 180 / Math.PI;

type Vec3 = readonly [number, number, number];

/** A standing IK or look-at request on one joint (world-space points). */
interface PoseRequest {
  readonly kind: "ik" | "look";
  readonly target: Vec3;
  readonly pole: Vec3 | null;
  readonly weight: number;
  /** Look-at limit, radians. */
  readonly max: number;
}

/** Transform a point by a column-major matrix. */
const transform = (m: Mat4, p: Vec3): [number, number, number] => [
  m[0]! * p[0] + m[4]! * p[1] + m[8]! * p[2] + m[12]!,
  m[1]! * p[0] + m[5]! * p[1] + m[9]! * p[2] + m[13]!,
  m[2]! * p[0] + m[6]! * p[1] + m[10]! * p[2] + m[14]!,
];

export class RuntimeChannel {
  /** Spawned copies: root object index → the root's world matrix. */
  private readonly active = new Map<number, Mat4>();
  /** Each reserve root's objects (itself first, then its descendants). */
  private readonly copyObjects = new Map<number, number[]>();
  /** The skeletal animation player, when the scene has skinned objects. */
  readonly animation: AnimationSession | null;
  /** The timeline player, when the scene has timelines. */
  readonly timeline: TimelineSession | null;
  /** Navigation agents, when the scene has a baked walkable surface. */
  readonly crowd: AgentCrowd | null;
  /** Standing IK / look-at requests: object → joint → request (IK before look-at). */
  private readonly requests = new Map<number, Map<number, PoseRequest>>();
  /** A pole for the next IK request on (object, joint). */
  private readonly poles = new Map<string, Vec3>();
  /** Levels: the current one, the one loading (-1), its progress, and a switch the cart asked for. */
  private level = { current: -1, loading: -1, progress: 0 };
  private levelRequest = -1;
  /** Joints whose world position the cart asked for, and where they were when last skinned. */
  private readonly watched = new Map<string, { object: number; joint: number; position: [number, number, number] | null }>();

  constructor(
    private readonly scene: MeshScene,
    private readonly physics: PhysicsSession | null,
  ) {
    this.animation = sceneHasAnimation(scene) ? new AnimationSession(scene) : null;
    this.timeline = (scene.timelines?.length ?? 0) > 0 ? new TimelineSession(scene) : null;
    this.crowd = scene.navmesh ? new AgentCrowd(scene.navmesh) : null;
    if ((scene.levels?.length ?? 0) > 0) this.level.current = 0;
    scene.instances.forEach((inst, i) => {
      if (!inst.pooled) return;
      const list = this.copyObjects.get(inst.pooled.root) ?? [];
      if (inst.pooled.root === i) list.unshift(i);
      else list.push(i);
      this.copyObjects.set(inst.pooled.root, list);
    });
  }

  /** Write what the cart reads this tick (and the handshake word). */
  beforeTick(block: DataView): void {
    if (this.physics) this.physics.beforeTick(block);
    else writePhysicsState(block, 0, [], []);
    writeAnimationState(block, this.animation?.state() ?? [], this.animation?.events() ?? []);
    writeTimelineState(block, this.timeline?.state() ?? { index: -1, time: 0, playing: false }, this.timeline?.events() ?? []);
    writeLevelState(block, this.level);
    writeAgents(block, this.crowd?.state() ?? []);
    writeJointPositions(
      block,
      [...this.watched.values()].flatMap((w) => (w.position ? [{ object: w.object, joint: w.joint, position: w.position }] : [])),
    );
  }

  /** Take the cart's commands: scene ops here, the rest to physics (which then steps). */
  afterTick(block: DataView): void {
    const commands = takePhysicsCommands(block);
    for (const cmd of commands) {
      if (cmd.op === PHYS_OP_SPAWN) this.spawn(cmd.a, cmd.v);
      else if (cmd.op === PHYS_OP_DESPAWN) this.despawn(cmd.a);
      else if (cmd.op === PHYS_OP_PLAY) {
        const [clip, fade, speed, loop, start] = cmd.v;
        this.animation?.play(cmd.a, Math.round(clip!), fade!, speed!, loop! >= 0.5, start!);
      } else if (cmd.op === PHYS_OP_ANIM_SET) this.animation?.setParam(cmd.a, Math.round(cmd.v[0]), cmd.v[1]);
      else if (cmd.op === PHYS_OP_ANIM_TRIGGER) this.animation?.setParam(cmd.a, Math.round(cmd.v[0]), 1);
      else if (cmd.op === PHYS_OP_ANIM_GOTO) this.animation?.goto(cmd.a, Math.round(cmd.v[0]), cmd.v[1]);
      else if (cmd.op === PHYS_OP_IK_POLE) this.poles.set(`${cmd.a}:${Math.round(cmd.v[0])}`, [cmd.v[1], cmd.v[2], cmd.v[3]]);
      else if (cmd.op === PHYS_OP_IK || cmd.op === PHYS_OP_LOOKAT) this.request(cmd.op, cmd.a, cmd.v);
      else if (cmd.op === PHYS_OP_WATCH) this.watch(cmd.a, Math.round(cmd.v[0]));
      else if (cmd.op === PHYS_OP_LEVEL) {
        const n = this.scene.levels?.length ?? 0;
        if (cmd.a >= 0 && cmd.a < n && cmd.a !== this.level.current && cmd.a !== this.level.loading) this.levelRequest = cmd.a;
      } else if (cmd.op >= PHYS_OP_AGENT && cmd.op <= PHYS_OP_AGENT_REMOVE) this.agentCommand(cmd.op, cmd.a, cmd.v);
      else if (cmd.op === PHYS_OP_TIMELINE) {
        if (cmd.a < 0) this.timeline?.stop();
        else this.timeline?.play(cmd.a, cmd.v[0], cmd.v[1]);
      }
    }
    // The timeline's cues start clips (or state machine states) before animation steps.
    for (const { object, cue } of this.timeline?.step(PHYSICS_DT) ?? []) this.cue(object, cue.clip, cue.fade, cue.loop);
    this.physics?.run(commands.filter((c) => c.op < PHYS_OP_SPAWN || (c.op > PHYS_OP_DESPAWN && c.op < PHYS_OP_PLAY)));
    this.animation?.step(PHYSICS_DT);
    this.crowd?.step(PHYSICS_DT);
  }

  /** A navigation agent command (see PHYS_OP_AGENT). */
  private agentCommand(op: number, key: number, v: readonly number[]): void {
    const crowd = this.crowd;
    if (!crowd || key < 0 || key > 1023) return;
    const at: [number, number, number] = [v[0]!, v[1]!, v[2]!];
    if (op === PHYS_OP_AGENT) {
      if (crowd.state().length >= PHYS_MAX_AGENTS && !crowd.state().some((a) => a.key === key)) return;
      crowd.place(key, at, v[3]! > 0 ? v[3]! : 3, v[4]! > 0 ? v[4]! : crowd.graph.mesh.agent.radius, v[5]! >= 0.5);
    } else if (op === PHYS_OP_AGENT_GOTO) crowd.goto(key, at, v[3]!);
    else if (op === PHYS_OP_AGENT_STOP) crowd.stop(key);
    else crowd.remove(key);
  }

  /** A level switch the cart asked for since the last call (-1 for none); the player loads and activates it. */
  takeLevelRequest(): number {
    const request = this.levelRequest;
    this.levelRequest = -1;
    return request;
  }

  /** The level loading, and how far along (0..1), as the cart reads it. */
  setLevelLoading(level: number, progress: number): void {
    this.level = { ...this.level, loading: level, progress };
  }

  /** Make `level` the current one (the loading state clears). */
  setLevel(level: number): void {
    this.level = { current: level, loading: -1, progress: 0 };
  }

  /** The current level (-1 when the scene has none). */
  currentLevel(): number {
    return this.level.current;
  }

  /**
   * Skinning matrices for the animated objects being drawn (object → matrices);
   * reserve prefab copies not spawned are skipped. IK and look-at requests are
   * applied first, their world-space targets taken into each object's space with
   * `worldOf` (its world matrix this frame; by default its physics body, spawn
   * placement or authored placement).
   */
  skinning(worldOf: (object: number) => Mat4 | null = (o) => this.defaultWorld(o)): ReadonlyMap<number, Float32Array> {
    if (!this.animation) return new Map();
    const matrices = this.animation.matrices(
      (object) => {
        const pooled = this.scene.instances[object]?.pooled;
        return !pooled || this.active.has(pooled.root);
      },
      (object, mesh, pose) => this.solve(object, mesh, pose, worldOf),
    );
    // Watched joints: where they ended up, in the world.
    for (const w of this.watched.values()) {
      const pose = this.animation.finalPose(w.object);
      const mesh = this.scene.instances[w.object]?.mesh;
      const world = worldOf(w.object);
      if (pose && mesh?.skin && world) w.position = transform(world, jointPosition(mesh.skin, pose, w.joint));
    }
    return matrices;
  }

  /** Start a timeline cue on an object: a state of its state machine by that name, else a clip. */
  private cue(object: number, name: string, fade: number, loop: boolean): void {
    const inst = this.scene.instances[object];
    if (!inst || !this.animation) return;
    const state = inst.animator?.states.findIndex((s) => s.name === name) ?? -1;
    if (state >= 0) {
      this.animation.goto(object, state, fade);
      return;
    }
    const clip = inst.mesh.clips?.findIndex((c) => c.name === name) ?? -1;
    if (clip >= 0) this.animation.play(object, clip, fade, 1, loop);
  }

  /**
   * The camera a playing (or holding) timeline sets, as a mesh-camera override
   * (orbit about the scene centre, reproducing its eye and target), or null.
   */
  timelineCamera(hud = false): MailboxMeshCamera | null {
    const cam = this.timeline?.camera();
    if (!cam) return null;
    const c = this.scene.bounds.center;
    const dx = cam.eye[0] - cam.target[0];
    const dy = cam.eye[1] - cam.target[1];
    const dz = cam.eye[2] - cam.target[2];
    const distance = Math.max(1e-3, Math.hypot(dx, dy, dz));
    return {
      yaw: Math.atan2(dx, dz),
      pitch: Math.asin(Math.max(-1, Math.min(1, dy / distance))),
      distance,
      target: [cam.target[0] - c[0], cam.target[1] - c[1], cam.target[2] - c[2]],
      fov: (cam.fov * Math.PI) / 180,
      hud,
    };
  }

  /** World matrices of the objects a timeline is placing (object index → matrix). */
  timelinePlacements(): ReadonlyMap<number, Mat4> {
    return this.timeline?.placements() ?? new Map();
  }

  /** Whether IK, look-at or joint watching needs the objects' current world matrices. */
  needsWorld(): boolean {
    return this.requests.size > 0 || this.watched.size > 0;
  }

  private defaultWorld(object: number): Mat4 | null {
    const inst = this.scene.instances[object];
    if (!inst) return null;
    const body = this.physics?.overrides().get(object);
    if (body) return body;
    if (inst.pooled) {
      const root = this.active.get(inst.pooled.root);
      if (!root) return null;
      if (inst.pooled.root === object) return root;
      const chain: Mat4[] = [];
      for (let i = object; i !== inst.pooled.root && i >= 0; i = this.scene.instances[i]!.parent) chain.unshift(this.scene.instances[i]!.local);
      return chain.reduce((m, local) => multiplyMat4(m, local), root);
    }
    return inst.model;
  }

  private request(op: number, object: number, v: readonly number[]): void {
    const inst = this.scene.instances[object];
    const joints = inst?.mesh.skin?.joints.length ?? 0;
    const joint = Math.round(v[0]!);
    if (!inst || joint < 0 || joint >= joints) return;
    const byJoint = this.requests.get(object) ?? new Map<number, PoseRequest>();
    const weight = Math.max(0, Math.min(1, v[4]!));
    const poleKey = `${object}:${joint}`;
    if (weight <= 0) byJoint.delete(joint);
    else
      byJoint.set(joint, {
        kind: op === PHYS_OP_IK ? "ik" : "look",
        target: [v[1]!, v[2]!, v[3]!],
        pole: op === PHYS_OP_IK ? (this.poles.get(poleKey) ?? null) : null,
        weight,
        max: op === PHYS_OP_LOOKAT ? (Math.max(0, Math.min(180, v[5]! > 0 ? v[5]! : 60)) * Math.PI) / 180 : 0,
      });
    this.poles.delete(poleKey);
    if (byJoint.size > 0) this.requests.set(object, byJoint);
    else this.requests.delete(object);
    this.animation?.invalidate();
  }

  private watch(object: number, joint: number): void {
    const key = `${object}:${joint}`;
    const joints = this.scene.instances[object]?.mesh.skin?.joints.length ?? 0;
    if (this.watched.has(key) || joint < 0 || joint >= joints || this.watched.size >= PHYS_MAX_JOINTS) return;
    this.watched.set(key, { object, joint, position: null });
  }

  /** Apply an object's standing IK (first) and look-at requests to its pose. */
  private solve(object: number, mesh: MeshAsset, pose: Float32Array, worldOf: (object: number) => Mat4 | null): void {
    const requests = this.requests.get(object);
    const skin = mesh.skin;
    if (!requests || !skin) return;
    const world = worldOf(object);
    if (!world) return;
    const toMesh = invertAffine(world);
    if (!toMesh) return;
    const local = (p: Vec3) => transform(toMesh, p);
    for (const kind of ["ik", "look"] as const) {
      for (const [joint, r] of requests) {
        if (r.kind !== kind) continue;
        if (kind === "ik") solveTwoBoneIK(skin, pose, joint, local(r.target), r.pole ? local(r.pole) : null, r.weight);
        else solveLookAt(skin, pose, joint, local(r.target), r.weight, r.max);
      }
    }
  }

  /** Spawned copies' root world matrices (root object index → matrix). */
  spawned(): ReadonlyMap<number, Mat4> {
    return this.active;
  }

  private spawn(root: number, v: readonly number[]): void {
    const objects = this.copyObjects.get(root);
    if (!objects) return;
    const [x, y, z, yaw, pitch, roll] = v;
    const world = composeModelMatrix([x!, y!, z!], [pitch! * DEG, yaw! * DEG, roll! * DEG], [1, 1, 1]);
    this.active.set(root, world);
    for (const object of objects) this.animation?.reset(object);
    // Where each of the copy's objects now is: the root's placement · its authored chain.
    const placed = new Map<number, Mat4>([[root, world]]);
    const worldOf = (i: number): Mat4 | null => {
      const known = placed.get(i);
      if (known) return known;
      const inst = this.scene.instances[i];
      if (!inst || inst.parent < 0) return null;
      const parent = worldOf(inst.parent);
      if (!parent) return null;
      const m = multiplyMat4(parent, inst.local);
      placed.set(i, m);
      return m;
    };
    this.physics?.setCopyActive(objects, worldOf, true);
  }

  private despawn(root: number): void {
    const objects = this.copyObjects.get(root);
    if (!objects || !this.active.has(root)) return;
    this.active.delete(root);
    this.physics?.setCopyActive(objects, () => null, false);
  }

  destroy(): void {
    this.physics?.destroy();
  }
}
