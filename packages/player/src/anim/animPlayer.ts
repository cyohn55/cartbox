/**
 * Cinematic gap #1 (animation timeline) — pure, deterministic playback.
 *
 * The host feeds the frame clock (the same counter scene auto-scroll uses) and
 * gets back the resolved animation state for that tick: which sprite frame each
 * clip is on, each track's sampled value routed to its target, and each foreground
 * placement's current transform. No engine, no DOM, no time — same tick in, same
 * state out — so the wiring half (Phase B) and the editor preview can share it and
 * it is fully unit-testable.
 *
 * Combine semantics (how a sampled value meets the thing it drives) are the
 * wiring's job, not this module's: `evaluate` returns absolute sampled numbers.
 */

import type {
  AnimClip,
  AnimSpec,
  AnimTrack,
  Keyframe,
  LayerChannel,
  PlacementChannel,
  SpriteRegion,
} from "./animModel.js";

/** The frame a clip shows at a given tick. */
export interface ClipSample {
  region: SpriteRegion;
  /** Index into the clip's original `frames` array. */
  frameIndex: number;
}

/** A foreground placement resolved for one tick. */
export interface ResolvedPlacement {
  region: SpriteRegion;
  frameIndex: number;
  x: number;
  y: number;
  opacity: number;
  scale: number;
  depth: number;
}

/** Everything animated at one tick. */
export interface AnimState {
  /** Scene-layer channel overrides, keyed by layer index. */
  layers: Record<number, Partial<Record<LayerChannel, number>>>;
  /** Post-FX value overrides, keyed by effect value key (e.g. "bloom.strength"). */
  postfx: Record<string, number>;
  placements: ResolvedPlacement[];
}

/** Positive modulo (JS `%` keeps the sign of the dividend). */
const mod = (a: number, m: number): number => ((a % m) + m) % m;

/**
 * The order of frame indices for one full period. Loop/once play forward; pingpong
 * appends the reverse EXCLUDING both endpoints so neither is held twice at the turn
 * (0,1,2 → 0,1,2,1). A single-frame clip is always frame 0.
 */
function frameSequence(clip: AnimClip): number[] {
  const count = clip.frames.length;
  if (count <= 1) return [0];
  const forward: number[] = [];
  for (let i = 0; i < count; i += 1) forward.push(i);
  if (clip.mode !== "pingpong") return forward;
  for (let i = count - 2; i >= 1; i -= 1) forward.push(i);
  return forward;
}

/**
 * Which frame a clip shows at `frame` ticks, honoring per-frame durations and the
 * clip's repeat mode. `once` clamps at the last frame; loop/pingpong wrap.
 * Assumes a non-empty clip with durations aligned to frames (parseAnim guarantees).
 */
export function sampleClipFrame(clip: AnimClip, frame: number): ClipSample {
  const lastIndex = clip.frames.length - 1;
  const at = (index: number): ClipSample => ({ region: clip.frames[index]!, frameIndex: index });

  const tick = Math.max(0, Math.floor(frame));

  if (clip.mode === "once") {
    let acc = 0;
    for (let i = 0; i < clip.frames.length; i += 1) {
      acc += clip.durations[i]!;
      if (tick < acc) return at(i);
    }
    return at(lastIndex); // past the end → hold the final frame
  }

  const sequence = frameSequence(clip);
  const sequenceDurations = sequence.map((index) => clip.durations[index]!);
  const period = sequenceDurations.reduce((sum, d) => sum + d, 0);
  if (period <= 0) return at(0);

  const local = mod(tick, period);
  let acc = 0;
  for (let step = 0; step < sequence.length; step += 1) {
    acc += sequenceDurations[step]!;
    if (local < acc) return at(sequence[step]!);
  }
  return at(sequence[sequence.length - 1]!);
}

/** Value of a sorted key list at `local`, clamped to the endpoints outside range. */
function valueAtLocalTime(keys: Keyframe[], local: number): number {
  const first = keys[0]!;
  const last = keys[keys.length - 1]!;
  if (local <= first.t) return first.value;
  if (local >= last.t) return last.value;

  for (let i = 0; i < keys.length - 1; i += 1) {
    const start = keys[i]!;
    const end = keys[i + 1]!;
    if (local < start.t || local > end.t) continue;

    const dt = end.t - start.t;
    if (dt <= 0) return end.value;
    if (start.ease === "step") return start.value;

    let u = (local - start.t) / dt;
    if (start.ease === "smooth") u = u * u * (3 - 2 * u); // smoothstep
    return start.value + (end.value - start.value) * u;
  }
  return last.value; // unreachable given the endpoint guards above
}

/**
 * A track's value at `frame`, folded into its key range by mode. `hold` clamps to
 * the end values; `loop` wraps over `loopLength` (defaulting to the key span);
 * `pingpong` reflects over the key span into a triangle wave.
 */
export function sampleTrack(track: AnimTrack, frame: number): number {
  const keys = track.keys;
  const firstT = keys[0]!.t;
  const lastT = keys[keys.length - 1]!.t;

  if (track.mode === "hold") {
    return valueAtLocalTime(keys, Math.min(Math.max(frame, firstT), lastT));
  }

  if (track.mode === "pingpong") {
    const span = lastT - firstT;
    if (span <= 0) return keys[0]!.value;
    const phase = mod(frame - firstT, span * 2);
    const local = phase <= span ? firstT + phase : firstT + (span * 2 - phase);
    return valueAtLocalTime(keys, local);
  }

  // loop
  const span = track.loopLength && track.loopLength > 0 ? track.loopLength : lastT - firstT;
  if (span <= 0) return keys[0]!.value;
  return valueAtLocalTime(keys, firstT + mod(frame - firstT, span));
}

/**
 * Resolve the whole animation set at one tick. Tracks are routed to their targets
 * (scene layer / post-fx / placement channel); placements resolve their clip's
 * current frame and apply any placement-channel track overrides over their base
 * transform. Placements whose clip is missing are skipped (parseAnim already drops
 * unknown-clip placements; this is belt-and-braces).
 */
export function evaluate(spec: AnimSpec, frame: number): AnimState {
  const clipByName = new Map<string, AnimClip>();
  for (const clip of spec.clips) clipByName.set(clip.name, clip);

  const layers: AnimState["layers"] = {};
  const postfx: Record<string, number> = {};
  const placementOverrides: Record<number, Partial<Record<PlacementChannel, number>>> = {};

  for (const track of spec.tracks) {
    const value = sampleTrack(track, frame);
    const target = track.target;
    if (target.kind === "sceneLayer") {
      (layers[target.index] ??= {})[target.channel] = value;
    } else if (target.kind === "postfx") {
      postfx[target.key] = value;
    } else {
      (placementOverrides[target.index] ??= {})[target.channel] = value;
    }
  }

  const placements: ResolvedPlacement[] = [];
  spec.placements.forEach((placement, index) => {
    const clip = clipByName.get(placement.clip);
    if (!clip) return;
    const sample = sampleClipFrame(clip, frame);
    const override = placementOverrides[index] ?? {};
    placements.push({
      region: sample.region,
      frameIndex: sample.frameIndex,
      x: override.x ?? placement.x,
      y: override.y ?? placement.y,
      opacity: override.opacity ?? placement.opacity,
      scale: override.scale ?? placement.scale,
      depth: placement.depth,
    });
  });

  return { layers, postfx, placements };
}
