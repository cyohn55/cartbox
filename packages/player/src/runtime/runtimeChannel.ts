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

import { composeModelMatrix, multiplyMat4, type Mat4 } from "@cartbox/editor";

import { AnimationSession, sceneHasAnimation } from "../anim/animationSession.js";
import type { MeshScene } from "../mesh/meshScene.js";
import type { PhysicsSession } from "../physics/physicsSession.js";
import { PHYSICS_DT } from "../physics/physicsSession.js";
import {
  PHYS_OP_DESPAWN,
  PHYS_OP_PLAY,
  PHYS_OP_SPAWN,
  takePhysicsCommands,
  writeAnimationState,
  writePhysicsState,
} from "../physics/protocol.js";

const DEG = 180 / Math.PI;

export class RuntimeChannel {
  /** Spawned copies: root object index → the root's world matrix. */
  private readonly active = new Map<number, Mat4>();
  /** Each reserve root's objects (itself first, then its descendants). */
  private readonly copyObjects = new Map<number, number[]>();
  /** The skeletal animation player, when the scene has skinned objects. */
  readonly animation: AnimationSession | null;

  constructor(
    private readonly scene: MeshScene,
    private readonly physics: PhysicsSession | null,
  ) {
    this.animation = sceneHasAnimation(scene) ? new AnimationSession(scene) : null;
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
    writeAnimationState(block, this.animation?.state() ?? []);
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
      }
    }
    this.physics?.run(commands.filter((c) => c.op !== PHYS_OP_SPAWN && c.op !== PHYS_OP_DESPAWN && c.op !== PHYS_OP_PLAY));
    this.animation?.step(PHYSICS_DT);
  }

  /**
   * Skinning matrices for the animated objects being drawn (object → matrices);
   * reserve prefab copies not spawned are skipped.
   */
  skinning(): ReadonlyMap<number, Float32Array> {
    if (!this.animation) return new Map();
    return this.animation.matrices((object) => {
      const pooled = this.scene.instances[object]?.pooled;
      return !pooled || this.active.has(pooled.root);
    });
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
