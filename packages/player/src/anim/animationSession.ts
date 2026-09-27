/**
 * Plays skeletal animation clips on a cart's skinned scene objects
 * (ENGINE_ROADMAP.md, Phase 3).
 *
 * Every object whose mesh has a skeleton gets a playback state: which clip, how
 * far in, how fast, whether it loops — and, during a crossfade, the clip it is
 * fading from. By default an object with clips plays its first one, looping, so
 * an imported character idles without any code; the cart changes that with
 * cartbox.play (the PHYS_OP_PLAY command).
 *
 * Time advances by a fixed 1/60 s per tick (never the wall clock), so playback
 * is as deterministic as the rest of the cart. The skinning matrices for the
 * current moment are computed on demand, once per tick, for the renderer.
 */

import { blendPoses, clipTime, isSkinned, restPose, sampleClip, skinMatrices, type MeshAsset } from "@cartbox/editor";

import type { MeshScene } from "../mesh/meshScene.js";
import type { AnimationPlayback } from "../physics/protocol.js";

interface Track {
  clip: number;
  time: number;
  speed: number;
  loop: boolean;
}

interface Playback extends Track {
  /** The clip being faded out, and how far through the fade we are (seconds of `fade`). */
  from: Track | null;
  fade: number;
  fadeElapsed: number;
}

/** The scene objects with a skeleton, in index order. */
export function animatedObjects(scene: MeshScene | null | undefined): number[] {
  const out: number[] = [];
  scene?.instances.forEach((inst, i) => {
    if (isSkinned(inst.mesh)) out.push(i);
  });
  return out;
}

/** Whether a scene has anything to animate. */
export function sceneHasAnimation(scene: MeshScene | null | undefined): boolean {
  return animatedObjects(scene).length > 0;
}

const DEFAULT_TRACK = (mesh: MeshAsset): Playback => ({
  clip: (mesh.clips?.length ?? 0) > 0 ? 0 : -1,
  time: 0,
  speed: 1,
  loop: true,
  from: null,
  fade: 0,
  fadeElapsed: 0,
});

export class AnimationSession {
  private readonly playback = new Map<number, Playback>();
  private tick = 0;
  private cache: { tick: number; matrices: Map<number, Float32Array> } | null = null;

  constructor(private readonly scene: MeshScene) {
    for (const i of animatedObjects(scene)) this.playback.set(i, DEFAULT_TRACK(scene.instances[i]!.mesh));
  }

  /** Start `clip` on `object` (-1 = back to rest), crossfading from what was playing over `fade` seconds. */
  play(object: number, clip: number, fade: number, speed: number, loop: boolean, start = 0): void {
    const current = this.playback.get(object);
    if (!current) return;
    const clips = this.scene.instances[object]!.mesh.clips ?? [];
    const target = Number.isInteger(clip) && clip >= 0 && clip < clips.length ? clip : -1;
    const fadeSeconds = Number.isFinite(fade) ? Math.max(0, Math.min(10, fade)) : 0;
    const from: Track | null =
      fadeSeconds > 0 ? { clip: current.clip, time: current.time, speed: current.speed, loop: current.loop } : null;
    this.playback.set(object, {
      clip: target,
      time: Number.isFinite(start) ? Math.max(0, start) : 0,
      speed: Number.isFinite(speed) ? Math.max(-10, Math.min(10, speed)) : 1,
      loop,
      from,
      fade: fadeSeconds,
      fadeElapsed: 0,
    });
    this.cache = null;
  }

  /** Put an object back to its default playback (a prefab copy being spawned afresh). */
  reset(object: number): void {
    if (!this.playback.has(object)) return;
    this.playback.set(object, DEFAULT_TRACK(this.scene.instances[object]!.mesh));
    this.cache = null;
  }

  /** Advance every playback by one tick. */
  step(dt: number): void {
    for (const p of this.playback.values()) {
      p.time += dt * p.speed;
      if (p.from) {
        p.from.time += dt * p.from.speed;
        p.fadeElapsed += dt;
        if (p.fadeElapsed >= p.fade) p.from = null;
      }
    }
    this.tick += 1;
  }

  /** Each animated object's clip and time, as the cart reads them. */
  state(): AnimationPlayback[] {
    const out: AnimationPlayback[] = [];
    for (const [object, p] of this.playback) {
      const clip = p.clip >= 0 ? this.scene.instances[object]!.mesh.clips![p.clip]! : null;
      out.push({ object, clip: p.clip, time: clip ? clipTime(clip, p.time, p.loop) : 0 });
    }
    return out;
  }

  /**
   * The skinning matrices for every animated object now (object → matrices),
   * computed once per tick. `visible` skips objects not being drawn (a reserve
   * prefab copy), which then keep their last pose.
   */
  matrices(visible: (object: number) => boolean = () => true): Map<number, Float32Array> {
    if (this.cache?.tick === this.tick) return this.cache.matrices;
    const out = new Map<number, Float32Array>();
    for (const [object, p] of this.playback) {
      if (!visible(object)) continue;
      const mesh = this.scene.instances[object]!.mesh;
      const skin = mesh.skin!;
      const pose = this.pose(mesh, p);
      const faded = p.from && p.fade > 0 ? blendPoses(this.pose(mesh, p.from), pose, Math.min(1, p.fadeElapsed / p.fade)) : pose;
      out.set(object, skinMatrices(skin, faded));
    }
    this.cache = { tick: this.tick, matrices: out };
    return out;
  }

  private pose(mesh: MeshAsset, track: Track): Float32Array {
    const clip = track.clip >= 0 ? mesh.clips?.[track.clip] : undefined;
    return clip ? sampleClip(mesh.skin!, clip, track.time, track.loop) : restPose(mesh.skin!);
  }
}
