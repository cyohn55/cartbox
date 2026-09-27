/**
 * Plays skeletal animation on a cart's skinned scene objects (ENGINE_ROADMAP.md,
 * Phase 3).
 *
 * Every object whose mesh has a skeleton gets a playback state. With an
 * animation state machine (its sidecar `animator`, see animatorSpec.ts) the
 * machine decides what plays: the cart sets its parameters (cartbox.set /
 * cartbox.trigger), transitions whose conditions hold move it between states
 * with a crossfade, and blend states mix clips by a parameter. Without one, the
 * object loops its first clip. Either way cartbox.play takes direct control of
 * the clip (pausing the machine until cartbox.setstate hands it back).
 *
 * Clip events (named moments in a clip, from the state machine) fire as the
 * playhead passes them and are reported to the cart for one tick.
 *
 * Time advances by a fixed 1/60 s per tick (never the wall clock), so playback
 * is as deterministic as the rest of the cart. The skinning matrices for the
 * current moment are computed on demand, once per tick, for the renderer.
 */

import {
  DEFAULT_ANIMATOR_FADE,
  blendPoses,
  clipTime,
  conditionHolds,
  isSkinned,
  restPose,
  sampleClip,
  skinMatrices,
  type AnimationClip,
  type AnimatorOp,
  type AnimatorSpec,
  type MeshAsset,
} from "@cartbox/editor";

import type { MeshScene } from "../mesh/meshScene.js";
import type { AnimationPlayback } from "../physics/protocol.js";

/** What one layer of playback is playing: a machine state, or (state -1) a clip the cart chose. */
interface Track {
  state: number;
  clip: number;
  /** Seconds into the clip (single clips; keeps counting past loops). */
  time: number;
  /** Fraction of the cycle (blend states: every clip plays at the same fraction; keeps counting). */
  phase: number;
  speed: number;
  loop: boolean;
  /** Just started: events at time 0 still fire. */
  fresh: boolean;
}

interface CompiledState {
  readonly name: string;
  readonly clip: number; // -1 = rest pose
  readonly speed: number;
  readonly loop: boolean;
  readonly blend: { readonly param: number; readonly points: readonly { readonly clip: number; readonly at: number }[] } | null;
}

interface CompiledMachine {
  readonly params: readonly { readonly name: string; readonly kind: string; readonly initial: number }[];
  readonly states: readonly CompiledState[];
  readonly transitions: readonly {
    readonly from: number; // -1 = any state
    readonly to: number;
    readonly when: readonly { readonly param: number; readonly op: AnimatorOp; readonly value: number }[];
    readonly fade: number;
    readonly exitTime?: number;
  }[];
  /** Events per clip index: seconds into the clip and the event's index in the spec. */
  readonly events: ReadonlyMap<number, readonly { readonly time: number; readonly index: number }[]>;
  readonly eventNames: readonly string[];
}

interface Playback {
  readonly mesh: MeshAsset;
  readonly machine: CompiledMachine | null;
  readonly params: Float64Array;
  current: Track;
  from: Track | null;
  fade: number;
  fadeElapsed: number;
  /** Event indices that fired during the last step. */
  fired: number[];
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

/** Resolve a state machine's names against a mesh's clips (missing clips play the rest pose). */
export function compileAnimator(spec: AnimatorSpec, mesh: MeshAsset): CompiledMachine {
  const clips = mesh.clips ?? [];
  const clipIndex = (name: string | null) => (name === null ? -1 : clips.findIndex((c) => c.name === name));
  const paramIndex = (name: string) => spec.params.findIndex((p) => p.name === name);
  const stateIndex = (name: string) => spec.states.findIndex((s) => s.name === name);
  const events = new Map<number, { time: number; index: number }[]>();
  spec.events.forEach((e, index) => {
    const c = clipIndex(e.clip);
    if (c < 0) return;
    events.set(c, [...(events.get(c) ?? []), { time: e.time, index }]);
  });
  return {
    params: spec.params,
    states: spec.states.map((s) => {
      const points = (s.blend?.points ?? []).map((p) => ({ clip: clipIndex(p.clip), at: p.at })).filter((p) => p.clip >= 0);
      const param = s.blend ? paramIndex(s.blend.param) : -1;
      return {
        name: s.name,
        clip: clipIndex(s.clip),
        speed: s.speed,
        loop: s.loop,
        blend: param >= 0 && points.length > 0 ? { param, points } : null,
      };
    }),
    transitions: spec.transitions
      .map((t) => ({
        from: t.from === "*" ? -1 : stateIndex(t.from),
        to: stateIndex(t.to),
        when: t.when.map((c) => ({ param: paramIndex(c.param), op: c.op, value: c.value })).filter((c) => c.param >= 0),
        fade: t.fade,
        ...(t.exitTime !== undefined ? { exitTime: t.exitTime } : {}),
      }))
      .filter((t) => t.to >= 0 && (t.from >= 0 || t.from === -1)),
    events,
    eventNames: spec.events.map((e) => e.name),
  };
}

const clipTrack = (clip: number, speed = 1, loop = true): Track => ({ state: -1, clip, time: 0, phase: 0, speed, loop, fresh: true });

function stateTrack(machine: CompiledMachine, state: number): Track {
  const s = machine.states[state]!;
  return { state, clip: s.clip, time: 0, phase: 0, speed: s.speed, loop: s.loop, fresh: true };
}

/** A blend state's two neighbouring clips and the second one's weight for parameter value `v`. */
function blendPair(points: readonly { clip: number; at: number }[], v: number): { a: number; b: number; w: number } {
  if (v <= points[0]!.at) return { a: points[0]!.clip, b: points[0]!.clip, w: 0 };
  for (let i = 0; i < points.length - 1; i += 1) {
    const p = points[i]!;
    const q = points[i + 1]!;
    if (v <= q.at) return { a: p.clip, b: q.clip, w: q.at > p.at ? (v - p.at) / (q.at - p.at) : 1 };
  }
  const last = points[points.length - 1]!.clip;
  return { a: last, b: last, w: 0 };
}

export class AnimationSession {
  private readonly playback = new Map<number, Playback>();
  private tick = 0;
  private cache: { tick: number; matrices: Map<number, Float32Array> } | null = null;

  constructor(private readonly scene: MeshScene) {
    for (const i of animatedObjects(scene)) this.playback.set(i, this.fresh(i));
  }

  private fresh(object: number): Playback {
    const inst = this.scene.instances[object]!;
    const machine = inst.animator ? compileAnimator(inst.animator, inst.mesh) : null;
    const params = new Float64Array(machine?.params.length ?? 0);
    machine?.params.forEach((p, i) => (params[i] = p.kind === "trigger" ? 0 : p.initial));
    const current = machine ? stateTrack(machine, 0) : clipTrack((inst.mesh.clips?.length ?? 0) > 0 ? 0 : -1);
    return { mesh: inst.mesh, machine, params, current, from: null, fade: 0, fadeElapsed: 0, fired: [] };
  }

  /** Crossfade `p` into `next` over `fade` seconds. */
  private switchTo(p: Playback, next: Track, fade: number): void {
    const seconds = Number.isFinite(fade) ? Math.max(0, Math.min(10, fade)) : 0;
    p.from = seconds > 0 ? { ...p.current, fresh: false } : null;
    p.current = next;
    p.fade = seconds;
    p.fadeElapsed = 0;
    this.cache = null;
  }

  /** Play `clip` directly on `object` (-1 = rest), pausing its state machine. */
  play(object: number, clip: number, fade: number, speed: number, loop: boolean, start = 0): void {
    const p = this.playback.get(object);
    if (!p) return;
    const clips = p.mesh.clips ?? [];
    const target = Number.isInteger(clip) && clip >= 0 && clip < clips.length ? clip : -1;
    const track = clipTrack(target, Number.isFinite(speed) ? Math.max(-10, Math.min(10, speed)) : 1, loop);
    track.time = Number.isFinite(start) ? Math.max(0, start) : 0;
    this.switchTo(p, track, fade);
  }

  /** Set a state-machine parameter (bools as 0/1; a trigger is set by any non-zero value). */
  setParam(object: number, param: number, value: number): void {
    const p = this.playback.get(object);
    if (!p?.machine || param < 0 || param >= p.params.length || !Number.isFinite(value)) return;
    p.params[param] = p.machine.params[param]!.kind === "number" ? value : value !== 0 ? 1 : 0;
  }

  /** Jump to (crossfade into) a state, handing control back to the machine. */
  goto(object: number, state: number, fade = DEFAULT_ANIMATOR_FADE): void {
    const p = this.playback.get(object);
    if (!p?.machine || state < 0 || state >= p.machine.states.length) return;
    this.switchTo(p, stateTrack(p.machine, state), fade);
  }

  /** Put an object back to its starting playback (a prefab copy spawned afresh). */
  reset(object: number): void {
    if (!this.playback.has(object)) return;
    this.playback.set(object, this.fresh(object));
    this.cache = null;
  }

  /** Take any transition that's ready, then advance every playback one tick (firing clip events). */
  step(dt: number): void {
    for (const p of this.playback.values()) {
      p.fired = [];
      if (p.machine && p.current.state >= 0) this.transition(p);
      const before = this.cursor(p, p.current);
      this.advance(p, p.current, dt);
      if (p.machine) this.fireEvents(p, before, this.cursor(p, p.current));
      p.current.fresh = false;
      if (p.from) {
        this.advance(p, p.from, dt);
        p.fadeElapsed += dt;
        if (p.fadeElapsed >= p.fade) p.from = null;
      }
    }
    this.tick += 1;
  }

  /** How far through its cycle a track is (0..1 per pass of its clip; loops keep counting). */
  private progress(p: Playback, track: Track): number {
    const s = track.state >= 0 ? p.machine?.states[track.state] : undefined;
    if (s?.blend) return track.phase;
    const clip = track.clip >= 0 ? p.mesh.clips?.[track.clip] : undefined;
    return clip && clip.duration > 0 ? track.time / clip.duration : 1;
  }

  private transition(p: Playback): void {
    const m = p.machine!;
    for (const t of m.transitions) {
      if (t.from !== -1 && t.from !== p.current.state) continue;
      if (t.from === -1 && t.to === p.current.state) continue; // "any state" never re-enters the one it's in
      if (t.exitTime !== undefined && this.progress(p, p.current) < t.exitTime) continue;
      if (!t.when.every((c) => conditionHolds(c.op, p.params[c.param]!, c.value))) continue;
      // Triggers are used up by the transition that took them.
      for (const c of t.when) if (m.params[c.param]!.kind === "trigger") p.params[c.param] = 0;
      this.switchTo(p, stateTrack(m, t.to), t.fade);
      return;
    }
  }

  /** The blend state's weights now, or null for a single clip. */
  private blendOf(p: Playback, track: Track): { a: number; b: number; w: number } | null {
    const s = track.state >= 0 ? p.machine?.states[track.state] : undefined;
    return s?.blend ? blendPair(s.blend.points, p.params[s.blend.param]!) : null;
  }

  private advance(p: Playback, track: Track, dt: number): void {
    const blend = this.blendOf(p, track);
    if (!blend) {
      track.time += dt * track.speed;
      return;
    }
    // Every clip in a blend plays at the same fraction of its own length; the
    // cycle's length is the mix of theirs.
    const clips = p.mesh.clips ?? [];
    const length = (clips[blend.a]?.duration ?? 0) * (1 - blend.w) + (clips[blend.b]?.duration ?? 0) * blend.w;
    track.phase += length > 0 ? (dt * track.speed) / length : 0;
  }

  /** Where the playhead is for events: which clip, and seconds into it (unwrapped). */
  private cursor(p: Playback, track: Track): { clip: number; time: number } {
    const blend = this.blendOf(p, track);
    if (!blend) return { clip: track.clip, time: track.fresh ? track.time - 1e-9 : track.time };
    const clip = blend.w < 0.5 ? blend.a : blend.b; // events follow the stronger clip
    const d = p.mesh.clips?.[clip]?.duration ?? 0;
    return { clip, time: track.phase * d - (track.fresh ? 1e-9 : 0) };
  }

  private fireEvents(p: Playback, before: { clip: number; time: number }, after: { clip: number; time: number }): void {
    if (before.clip !== after.clip || after.clip < 0) return;
    const list = p.machine!.events.get(after.clip);
    const clip = p.mesh.clips?.[after.clip];
    if (!list || !clip) return;
    const [lo, hi] = before.time <= after.time ? [before.time, after.time] : [after.time, before.time];
    const looping = p.current.loop && clip.duration > 0;
    for (const e of list) {
      if (!looping) {
        if (e.time > lo && e.time <= hi && e.time <= clip.duration) p.fired.push(e.index);
        continue;
      }
      // Each pass of a looping clip crosses the event once.
      for (let k = Math.ceil((lo - e.time) / clip.duration); e.time + k * clip.duration <= hi; k += 1) {
        const at = e.time + k * clip.duration;
        if (at > lo && p.fired.length < 16) p.fired.push(e.index);
      }
    }
  }

  /** Each animated object's clip, time and state, as the cart reads them. */
  state(): AnimationPlayback[] {
    const out: AnimationPlayback[] = [];
    for (const [object, p] of this.playback) {
      const shown = this.shownClip(p, p.current);
      out.push({ object, clip: shown.clip, time: shown.time, state: p.current.state });
    }
    return out;
  }

  /** Events that fired on the last step: object and the event's index in its state machine. */
  events(): { object: number; event: number }[] {
    const out: { object: number; event: number }[] = [];
    for (const [object, p] of this.playback) for (const event of p.fired) out.push({ object, event });
    return out;
  }

  /** The clip a track shows (a blend reports its stronger clip) and seconds into it. */
  private shownClip(p: Playback, track: Track): { clip: number; time: number } {
    const blend = this.blendOf(p, track);
    const clips = p.mesh.clips ?? [];
    if (blend) {
      const clip = blend.w < 0.5 ? blend.a : blend.b;
      const c = clips[clip];
      return { clip, time: c ? clipTime(c, track.phase * c.duration, track.loop) : 0 };
    }
    const c = track.clip >= 0 ? clips[track.clip] : undefined;
    return { clip: c ? track.clip : -1, time: c ? clipTime(c, track.time, track.loop) : 0 };
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
      const pose = this.pose(p, p.current);
      const faded = p.from && p.fade > 0 ? blendPoses(this.pose(p, p.from), pose, Math.min(1, p.fadeElapsed / p.fade)) : pose;
      out.set(object, skinMatrices(p.mesh.skin!, faded));
    }
    this.cache = { tick: this.tick, matrices: out };
    return out;
  }

  private pose(p: Playback, track: Track): Float32Array {
    const skin = p.mesh.skin!;
    const clips = p.mesh.clips ?? [];
    const blend = this.blendOf(p, track);
    if (blend) {
      const at = (c: AnimationClip) => track.phase * c.duration;
      const a = clips[blend.a]!;
      const b = clips[blend.b]!;
      const pa = sampleClip(skin, a, at(a), track.loop);
      return blend.w <= 0 || blend.a === blend.b ? pa : blendPoses(pa, sampleClip(skin, b, at(b), track.loop), blend.w);
    }
    const clip = track.clip >= 0 ? clips[track.clip] : undefined;
    return clip ? sampleClip(skin, clip, track.time, track.loop) : restPose(skin);
  }
}
