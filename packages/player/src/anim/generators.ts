/**
 * Cinematic gap #1 (animation timeline) — procedural track generators.
 *
 * The artist-friendly path: instead of hand-placing dozens of keyframes for a
 * neon buzz or a drifting cloud, call a generator and get a ready `keys`/`mode`
 * shape to drop onto a target. Output is plain keyframes (not a hidden analytic
 * evaluator) so the sidecar stays self-describing and the editor can show and tweak
 * the generated curve — Phase-A pragmatism over the spec's analytic option, which
 * can come later if periodic-noise JSON size ever bites.
 *
 * All generators are deterministic (flicker is seeded), so preview == reload.
 */

import type { Keyframe, TrackMode } from "./animModel.js";

/** A generated track shape: merge with a target to form an AnimTrack. */
export interface GeneratedTrack {
  keys: Keyframe[];
  mode: TrackMode;
  loopLength?: number;
}

/** Deterministic LCG (Numerical Recipes constants) in [0, 1). */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

/**
 * A breathing glow: smoothly rises from `min` to `max` and back over `period`
 * ticks. Pingpong makes the return automatic, so two keys suffice.
 */
export function pulse(period: number, min: number, max: number): GeneratedTrack {
  const half = Math.max(1, Math.round(period / 2));
  return {
    keys: [
      { t: 0, value: min, ease: "smooth" },
      { t: half, value: max, ease: "smooth" },
    ],
    mode: "pingpong",
  };
}

/**
 * A sinusoid-like sway of `±amplitude` around `center` over `period` ticks — for
 * idle bob, gentle offset drift on a foreground element, or a swaying sign.
 */
export function sway(period: number, amplitude: number, center = 0): GeneratedTrack {
  const half = Math.max(1, Math.round(period / 2));
  return {
    keys: [
      { t: 0, value: center - amplitude, ease: "smooth" },
      { t: half, value: center + amplitude, ease: "smooth" },
    ],
    mode: "pingpong",
  };
}

/**
 * Linear travel from 0 to `distance` over `period` ticks, then a seamless jump
 * back to 0 — for drifting fog/clouds on a wrapX scene layer (the wrap hides the
 * reset). Bind to a layer's offsetX/offsetY.
 */
export function drift(period: number, distance: number): GeneratedTrack {
  const length = Math.max(1, Math.round(period));
  return {
    keys: [
      { t: 0, value: 0, ease: "linear" },
      { t: length, value: distance, ease: "linear" },
    ],
    mode: "loop",
    loopLength: length,
  };
}

/**
 * Erratic buzz between `min` and `max` — for neon flicker or a failing lamp.
 * `steps` random hard-switch levels are spread over `period` ticks and loop; the
 * same `seed` always yields the same pattern. Bind to a layer's emissive/opacity.
 */
export function flicker(period: number, min: number, max: number, steps = 8, seed = 1): GeneratedTrack {
  const length = Math.max(2, Math.round(period));
  const count = Math.max(2, Math.min(64, Math.min(Math.round(steps), length)));
  const random = seededRandom(seed);

  const keys: Keyframe[] = [];
  let previousT = -1;
  for (let i = 0; i < count; i += 1) {
    let t = Math.floor((i / count) * length);
    if (t <= previousT) t = previousT + 1; // keep strictly increasing after rounding
    previousT = t;
    keys.push({ t, value: min + (max - min) * random(), ease: "step" });
  }
  return { keys, mode: "loop", loopLength: length };
}
