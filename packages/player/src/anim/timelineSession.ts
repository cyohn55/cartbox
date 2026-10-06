/**
 * Plays a scene's timelines (ENGINE_ROADMAP.md, Phase 3): cutscenes and
 * scripted camera moves authored in the Mesh tab (see timeline.ts).
 *
 * One timeline plays at a time. Each tick its playhead advances a fixed 1/60 s
 * (times its speed); the animation cues and events it passes are handed back to
 * be applied (cues) and reported to the cart (events). While it plays — and after
 * it ends, if it holds — its camera keys drive the camera and its object keys
 * place their objects. A timeline marked autoplay starts with the cart.
 */

import { composeModelMatrix, crossedMarks, multiplyMat4, sampleCamera, sampleObjects, sampleValues, timelineValueNames, type AnimationCue, type Mat4, type SceneTimeline } from "@cartbox/editor";

import type { MeshScene } from "../mesh/meshScene.js";

export interface TimelinePlayback {
  /** The timeline's index, or -1 when none plays or holds. */
  readonly index: number;
  readonly time: number;
  /** False once a held timeline has ended (and for none). */
  readonly playing: boolean;
}

/** Each timeline's distinct event names, in order (what the cart's event indices refer to). */
export function timelineEventNames(timeline: SceneTimeline): string[] {
  const names: string[] = [];
  for (const track of timeline.tracks) {
    if (track.kind !== "events") continue;
    for (const e of track.events) if (!names.includes(e.name)) names.push(e.name);
  }
  return names;
}

export class TimelineSession {
  private readonly timelines: readonly SceneTimeline[];
  private readonly objectIndex = new Map<string, number>();
  private current: { index: number; time: number; speed: number; playing: boolean; fresh: boolean } | null = null;
  private fired: number[] = [];

  constructor(private readonly scene: MeshScene) {
    this.timelines = scene.timelines ?? [];
    scene.instances.forEach((inst, i) => {
      if (!this.objectIndex.has(inst.id)) this.objectIndex.set(inst.id, i);
    });
    const auto = this.timelines.findIndex((t) => t.autoplay);
    if (auto >= 0) this.play(auto);
  }

  /** Play timeline `index` from `from` seconds (an invalid index stops). */
  play(index: number, from = 0, speed = 1): void {
    const timeline = this.timelines[index];
    if (!timeline) {
      this.stop();
      return;
    }
    this.current = {
      index,
      time: Math.max(0, Math.min(timeline.duration, Number.isFinite(from) ? from : 0)),
      speed: Number.isFinite(speed) ? Math.max(0, Math.min(10, speed)) : 1,
      playing: true,
      fresh: true,
    };
  }

  stop(): void {
    this.current = null;
  }

  /**
   * Advance one tick. Returns the animation cues passed (object index + cue) for
   * the caller to apply; the events passed are kept for {@link events}.
   */
  step(dt: number): { object: number; cue: AnimationCue }[] {
    this.fired = [];
    const c = this.current;
    if (!c || !c.playing) return [];
    const timeline = this.timelines[c.index]!;
    const names = timelineEventNames(timeline);
    const cues: { object: number; cue: AnimationCue }[] = [];
    const collect = (t0: number, t1: number) => {
      const marks = crossedMarks(timeline, t0, t1);
      for (const { object, cue } of marks.cues) {
        const i = this.objectIndex.get(object);
        if (i !== undefined) cues.push({ object: i, cue });
      }
      for (const e of marks.events) this.fired.push(names.indexOf(e));
    };
    const t0 = c.fresh ? c.time - 1e-9 : c.time;
    c.fresh = false;
    let t1 = c.time + dt * c.speed;
    if (t1 >= timeline.duration) {
      collect(t0, timeline.duration);
      if (timeline.loop && timeline.duration > 0) {
        t1 -= timeline.duration;
        collect(-1e-9, t1);
        c.time = t1;
      } else if (timeline.hold) {
        c.time = timeline.duration;
        c.playing = false;
      } else {
        this.current = null;
      }
      return cues;
    }
    collect(t0, t1);
    c.time = t1;
    return cues;
  }

  /** What plays (or holds) now. */
  state(): TimelinePlayback {
    return this.current ? { index: this.current.index, time: this.current.time, playing: this.current.playing } : { index: -1, time: 0, playing: false };
  }

  /** Indices (into the playing timeline's event names) of the events passed on the last step. */
  events(): number[] {
    return this.fired;
  }

  /** Every value track name in the scene's timelines (the cart's value slots). */
  valueNames(): string[] {
    return timelineValueNames(this.timelines);
  }

  /** The playing (or held) timeline's values now (name → value); empty when none plays. */
  values(): Map<string, number> {
    const c = this.current;
    return c ? sampleValues(this.timelines[c.index]!, c.time) : new Map();
  }

  /** The timeline camera now (world eye, target, fov in degrees), or null. */
  camera(): { eye: readonly [number, number, number]; target: readonly [number, number, number]; fov: number } | null {
    const c = this.current;
    return c ? sampleCamera(this.timelines[c.index]!, c.time) : null;
  }

  /**
   * World matrices of the objects the timeline places (object index → matrix):
   * each key is relative to the object's parent, which may itself be placed by
   * the timeline.
   */
  placements(): Map<number, Mat4> {
    const out = new Map<number, Mat4>();
    const c = this.current;
    if (!c) return out;
    const locals = new Map<number, Mat4>();
    for (const [id, t] of sampleObjects(this.timelines[c.index]!, c.time)) {
      const i = this.objectIndex.get(id);
      if (i !== undefined) locals.set(i, composeModelMatrix(t.position, t.rotation, t.scale));
    }
    const worldOf = (i: number, depth = 0): Mat4 => {
      const known = out.get(i);
      if (known) return known;
      const inst = this.scene.instances[i]!;
      const local = locals.get(i);
      if (!local) return inst.model;
      const parent = inst.parent >= 0 && depth < this.scene.instances.length ? worldOf(inst.parent, depth + 1) : null;
      const world = parent ? multiplyMat4(parent, local) : local;
      out.set(i, world);
      return world;
    };
    for (const i of locals.keys()) worldOf(i);
    return out;
  }
}
