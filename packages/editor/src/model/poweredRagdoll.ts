/**
 * Powered ragdolls (AAA_FIDELITY_ROADMAP.md F7e): the ragdoll (H9) driven
 * toward the animation instead of going wholly limp, so a hit body staggers
 * and recovers rather than playing a canned reaction.
 *
 * - **Power** pulls each particle toward where the animation puts its joint,
 *   a fraction of the way each step (a stiff spring at 1, limp at 0), after
 *   the ragdoll's own step, so gravity, collisions and impulses still act.
 * - **Blend:** the pose shown is the ragdoll's mixed with the animation's.
 * - **Recovery:** after a hit the power and the blend ramp back to full over
 *   `recover` seconds, and the body hands back to the animation; a fall with
 *   the power off stays limp.
 */

import type { Mat4 } from "../render/meshRasterizer";
import { Ragdoll, type RagdollBox, type RagdollOptions } from "./ragdoll";
import { blendPoses, jointWorldMatrices, type MeshSkin } from "./skeleton";

export interface PoweredOptions extends RagdollOptions {
  /** The pull toward the animation at full power, a step (0..1; default 0.35). */
  readonly stiffness?: number;
  /** Seconds to come back to full power after a hit (default 1). */
  readonly recover?: number;
  /** The power the hit leaves it with, 0..1 (default 0.15). */
  readonly power?: number;
}

export class PoweredRagdoll {
  readonly doll: Ragdoll;
  /** 0 limp .. 1 following the animation wholly. */
  power: number;
  private readonly stiffness: number;
  private readonly recover: number;
  private readonly target: Float64Array;

  constructor(
    private readonly skin: MeshSkin,
    pose: Float32Array,
    world: Mat4,
    options: PoweredOptions = {},
  ) {
    this.doll = new Ragdoll(skin, pose, world, options);
    this.power = options.power ?? 0.15;
    this.stiffness = options.stiffness ?? 0.35;
    this.recover = options.recover ?? 1;
    this.target = new Float64Array(skin.joints.length * 3);
  }

  /** Whether it has handed back to the animation. */
  get recovered(): boolean {
    return this.power >= 1;
  }

  /**
   * Step with the animation's pose and world matrix now (rewrites `pose` to the
   * shown one): the ragdoll steps, is pulled toward the animation by the power,
   * and its pose blends into the animation's by the same.
   */
  update(dt: number, pose: Float32Array, world: Mat4, colliders: readonly RagdollBox[], ramp = true): void {
    const n = this.skin.joints.length;
    const mats = jointWorldMatrices(this.skin, pose);
    for (let j = 0; j < n; j += 1) {
      const x = mats[j * 16 + 12]!, y = mats[j * 16 + 13]!, z = mats[j * 16 + 14]!;
      this.target.set([world[0]! * x + world[4]! * y + world[8]! * z + world[12]!, world[1]! * x + world[5]! * y + world[9]! * z + world[13]!, world[2]! * x + world[6]! * y + world[10]! * z + world[14]!], j * 3);
    }
    // A driven body never sleeps: the animation can move it any time.
    this.doll.asleep = false;
    this.doll.step(dt, colliders);
    const pull = this.stiffness * this.power;
    for (let k = 0; k < n * 3; k += 1) this.doll.pos[k] = this.doll.pos[k]! + (this.target[k]! - this.doll.pos[k]!) * pull;
    const ragPose = Float32Array.from(pose);
    this.doll.writePose(ragPose, world);
    pose.set(blendPoses(ragPose, pose, this.power));
    if (ramp && this.recover > 0) this.power = Math.min(1, this.power + dt / this.recover);
  }

  /** A hit: the power knocked down to `power`, and a shove of `velocity` (m/s) at every particle. */
  hit(power: number, velocity: readonly [number, number, number], dt = 1 / 60): void {
    this.power = Math.max(0, Math.min(this.power, power));
    for (let k = 0; k < this.doll.pos.length; k += 1) this.doll.pos[k] = this.doll.pos[k]! + velocity[k % 3]! * dt;
  }
}
