/**
 * Pure edit operations for the Anim tab's animation timeline.
 *
 * The Anim tab lets an author declare an `AnimSpec` — sprite-frame clips drawn as
 * foreground placements, plus tracks that drive scene-layer channels, post-FX
 * values, and placement transforms. This module owns every mutation as an
 * immutable transform on the spec, kept out of the React component so the
 * authoring logic can be tested on its own inputs and outputs. Values are clamped
 * to the same ranges the runtime parser enforces, so the live preview and the
 * saved-then-reloaded animation agree.
 *
 * Tracks are authored two ways (no keyframe timeline in this tab): a CONSTANT
 * override (a single held key) or a GENERATOR (flicker / pulse / drift / sway),
 * which covers the cinematic uses — a steady value, or ambient motion — without
 * hand-placing keyframes.
 */

import type {
  AnimSpec,
  AnimClip,
  AnimPlacement,
  AnimTarget,
  AnimTrack,
  GeneratedTrack,
  LayerChannel,
  PlacementChannel,
  SpriteRegion,
  TrackMode,
} from "@cartbox/player";
import { drift, flicker, pulse, sway } from "@cartbox/player";

/** Caps mirror the runtime parser (animModel.ts). */
export const MAX_CLIPS = 32;
export const MAX_TRACKS = 64;
export const MAX_PLACEMENTS = 32;
export const MAX_FRAMES = 64;
const MAX_TILE = 255;
const MAX_TILES_PER_SIDE = 32;
const MAX_FRAME_TICKS = 600;
const MAX_LAYER_INDEX = 7;

const clamp = (value: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, value));
const clampInt = (value: number, lo: number, hi: number): number => Math.round(clamp(value, lo, hi));

export const LAYER_CHANNELS: readonly LayerChannel[] = ["opacity", "offsetX", "offsetY", "emissive"];
export const PLACEMENT_CHANNELS: readonly PlacementChannel[] = ["x", "y", "opacity", "scale"];
/** Post-FX value keys worth animating; the author can drive any, these are the useful ones. */
export const POSTFX_KEYS: readonly string[] = [
  "bloom.strength",
  "bloom.radius",
  "vignette.strength",
  "grade.brightness",
  "chroma.amount",
  "fog.density",
];
/** The generator kinds the tab offers for a track. */
export type GeneratorKind = "flicker" | "pulse" | "drift" | "sway";

/** The empty animation an author starts from before adding anything. */
export function emptyAnim(): AnimSpec {
  return { clips: [], tracks: [], placements: [] };
}

/** Collapse to null when nothing is left, so an emptied timeline stores as none. */
function collapse(anim: AnimSpec): AnimSpec | null {
  return anim.clips.length === 0 && anim.tracks.length === 0 && anim.placements.length === 0 ? null : anim;
}

function defaultRegion(): SpriteRegion {
  return { page: 0, tile: 0, tilesW: 1, tilesH: 1 };
}
function clampRegion(region: SpriteRegion): SpriteRegion {
  return {
    page: region.page === 1 ? 1 : 0,
    tile: clampInt(region.tile, 0, MAX_TILE),
    tilesW: clampInt(region.tilesW, 1, MAX_TILES_PER_SIDE),
    tilesH: clampInt(region.tilesH, 1, MAX_TILES_PER_SIDE),
  };
}

/** A name not already used by another clip, for a new or renamed clip. */
function uniqueClipName(anim: AnimSpec, base: string, ignoreIndex = -1): string {
  const taken = new Set(anim.clips.filter((_, i) => i !== ignoreIndex).map((clip) => clip.name));
  if (base && !taken.has(base)) return base;
  const stem = base || "clip";
  for (let n = 1; ; n += 1) {
    const candidate = `${stem} ${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

// ---- clips --------------------------------------------------------------------

/** Append a clip (one default frame), creating the animation if there is none yet. */
export function withClipAdded(anim: AnimSpec | null): AnimSpec {
  const base = anim ?? emptyAnim();
  if (base.clips.length >= MAX_CLIPS) return base;
  const name = uniqueClipName(base, "clip");
  const clip: AnimClip = { name, frames: [defaultRegion()], durations: [8], mode: "loop" };
  return { ...base, clips: [...base.clips, clip] };
}

/** Remove a clip; drop placements that referenced it (and any of their tracks). */
export function withClipRemoved(anim: AnimSpec, index: number): AnimSpec | null {
  const removed = anim.clips[index];
  if (!removed) return collapse(anim);
  const clips = anim.clips.filter((_, i) => i !== index);
  let next: AnimSpec = { ...anim, clips };
  // Drop orphaned placements (and reindex their tracks) one at a time.
  for (let i = next.placements.length - 1; i >= 0; i -= 1) {
    if (next.placements[i]!.clip === removed.name) next = removePlacementAt(next, i);
  }
  return collapse(next);
}

/** Rename / re-mode a clip. Renames follow through to placements referencing it. */
export function withClipUpdated(anim: AnimSpec, index: number, patch: { name?: string; mode?: AnimClip["mode"] }): AnimSpec {
  const clip = anim.clips[index];
  if (!clip) return anim;
  const oldName = clip.name;
  const name = patch.name !== undefined ? uniqueClipName(anim, patch.name.trim(), index) : oldName;
  const updated: AnimClip = { ...clip, name, mode: patch.mode ?? clip.mode };
  const clips = anim.clips.map((c, i) => (i === index ? updated : c));
  const placements =
    name === oldName ? anim.placements : anim.placements.map((p) => (p.clip === oldName ? { ...p, clip: name } : p));
  return { ...anim, clips, placements };
}

export function withClipFrameAdded(anim: AnimSpec, clipIndex: number): AnimSpec {
  const clip = anim.clips[clipIndex];
  if (!clip || clip.frames.length >= MAX_FRAMES) return anim;
  const clips = anim.clips.map((c, i) =>
    i === clipIndex ? { ...c, frames: [...c.frames, defaultRegion()], durations: [...c.durations, 8] } : c,
  );
  return { ...anim, clips };
}

export function withClipFrameRemoved(anim: AnimSpec, clipIndex: number, frameIndex: number): AnimSpec {
  const clip = anim.clips[clipIndex];
  if (!clip || clip.frames.length <= 1) return anim; // a clip keeps at least one frame
  const clips = anim.clips.map((c, i) =>
    i === clipIndex
      ? { ...c, frames: c.frames.filter((_, f) => f !== frameIndex), durations: c.durations.filter((_, f) => f !== frameIndex) }
      : c,
  );
  return { ...anim, clips };
}

export function withClipFrameSource(anim: AnimSpec, clipIndex: number, frameIndex: number, patch: Partial<SpriteRegion>): AnimSpec {
  const clips = anim.clips.map((clip, i) =>
    i === clipIndex
      ? { ...clip, frames: clip.frames.map((region, f) => (f === frameIndex ? clampRegion({ ...region, ...patch }) : region)) }
      : clip,
  );
  return { ...anim, clips };
}

export function withClipFrameDuration(anim: AnimSpec, clipIndex: number, frameIndex: number, ticks: number): AnimSpec {
  const clips = anim.clips.map((clip, i) =>
    i === clipIndex
      ? { ...clip, durations: clip.durations.map((d, f) => (f === frameIndex ? clampInt(ticks, 1, MAX_FRAME_TICKS) : d)) }
      : clip,
  );
  return { ...anim, clips };
}

// ---- placements ---------------------------------------------------------------

/** Add a placement of `clipName` at (x, y). No-op if the clip does not exist. */
export function withPlacementAdded(anim: AnimSpec | null, clipName: string, x = 0, y = 0): AnimSpec {
  const base = anim ?? emptyAnim();
  if (base.placements.length >= MAX_PLACEMENTS || !base.clips.some((c) => c.name === clipName)) return base;
  const placement: AnimPlacement = { clip: clipName, x: Math.round(x), y: Math.round(y), depth: 0, opacity: 1, scale: 1 };
  return { ...base, placements: [...base.placements, placement] };
}

/** Remove the placement at `index`, dropping/reindexing tracks that target placements. */
export function withPlacementRemoved(anim: AnimSpec, index: number): AnimSpec | null {
  return collapse(removePlacementAt(anim, index));
}

/** The reindexing core (also used when a clip removal orphans a placement). */
function removePlacementAt(anim: AnimSpec, index: number): AnimSpec {
  if (!anim.placements[index]) return anim;
  const placements = anim.placements.filter((_, i) => i !== index);
  const tracks: AnimTrack[] = [];
  for (const track of anim.tracks) {
    if (track.target.kind !== "placement") {
      tracks.push(track);
    } else if (track.target.index === index) {
      // its placement is gone → drop the track
    } else {
      const shifted = track.target.index > index ? track.target.index - 1 : track.target.index;
      tracks.push({ ...track, target: { ...track.target, index: shifted } });
    }
  }
  return { ...anim, placements, tracks };
}

export function withPlacementUpdated(
  anim: AnimSpec,
  index: number,
  patch: Partial<Pick<AnimPlacement, "clip" | "x" | "y" | "depth" | "opacity" | "scale">>,
): AnimSpec {
  const placement = anim.placements[index];
  if (!placement) return anim;
  // A clip change must reference an existing clip, else it is ignored.
  const clip = patch.clip !== undefined && anim.clips.some((c) => c.name === patch.clip) ? patch.clip : placement.clip;
  const updated: AnimPlacement = {
    clip,
    x: patch.x !== undefined ? Math.round(patch.x) : placement.x,
    y: patch.y !== undefined ? Math.round(patch.y) : placement.y,
    depth: clamp(patch.depth ?? placement.depth, 0, 1),
    opacity: clamp(patch.opacity ?? placement.opacity, 0, 1),
    scale: Math.max(0.01, patch.scale ?? placement.scale),
  };
  return { ...anim, placements: anim.placements.map((p, i) => (i === index ? updated : p)) };
}

// ---- tracks -------------------------------------------------------------------

/** Clamp a target to a valid, addressable form for the current spec. */
function clampTarget(anim: AnimSpec, target: AnimTarget): AnimTarget {
  if (target.kind === "sceneLayer") {
    const channel = LAYER_CHANNELS.includes(target.channel) ? target.channel : "opacity";
    return { kind: "sceneLayer", index: clampInt(target.index, 0, MAX_LAYER_INDEX), channel };
  }
  if (target.kind === "placement") {
    const last = Math.max(0, anim.placements.length - 1);
    const channel = PLACEMENT_CHANNELS.includes(target.channel) ? target.channel : "y";
    return { kind: "placement", index: clampInt(target.index, 0, last), channel };
  }
  return { kind: "postfx", key: target.key || POSTFX_KEYS[0]! };
}

/** A sensible starting value for a channel, so a new constant track reads well. */
function defaultValueFor(target: AnimTarget): number {
  if (target.kind === "sceneLayer") return target.channel === "opacity" || target.channel === "emissive" ? 1 : 0;
  if (target.kind === "placement") return target.channel === "opacity" || target.channel === "scale" ? 1 : 0;
  return 0.5;
}

/** Add a constant (held) track driving `target`. Creates the animation if needed. */
export function withTrackAdded(anim: AnimSpec | null, target: AnimTarget): AnimSpec {
  const base = anim ?? emptyAnim();
  if (base.tracks.length >= MAX_TRACKS) return base;
  const clamped = clampTarget(base, target);
  const track: AnimTrack = { target: clamped, keys: [{ t: 0, value: defaultValueFor(clamped), ease: "linear" }], mode: "hold" };
  return { ...base, tracks: [...base.tracks, track] };
}

export function withTrackRemoved(anim: AnimSpec, index: number): AnimSpec | null {
  return collapse({ ...anim, tracks: anim.tracks.filter((_, i) => i !== index) });
}

export function withTrackTarget(anim: AnimSpec, index: number, target: AnimTarget): AnimSpec {
  const track = anim.tracks[index];
  if (!track) return anim;
  return { ...anim, tracks: anim.tracks.map((t, i) => (i === index ? { ...t, target: clampTarget(anim, target) } : t)) };
}

/** Make a track a constant held value (single keyframe). */
export function withTrackConstant(anim: AnimSpec, index: number, value: number): AnimSpec {
  const track = anim.tracks[index];
  if (!track) return anim;
  const updated: AnimTrack = { ...track, keys: [{ t: 0, value, ease: "linear" }], mode: "hold" };
  const { loopLength, ...rest } = updated as AnimTrack & { loopLength?: number };
  void loopLength;
  return { ...anim, tracks: anim.tracks.map((t, i) => (i === index ? rest : t)) };
}

/** Drive a track from a generator (flicker/pulse/drift/sway), replacing its keys. */
export function withTrackGenerator(anim: AnimSpec, index: number, kind: GeneratorKind, params: GeneratorParams): AnimSpec {
  const track = anim.tracks[index];
  if (!track) return anim;
  const generated = runGenerator(kind, params);
  const updated: AnimTrack = { ...track, keys: generated.keys, mode: generated.mode };
  if (generated.loopLength !== undefined) updated.loopLength = generated.loopLength;
  else delete (updated as { loopLength?: number }).loopLength;
  return { ...anim, tracks: anim.tracks.map((t, i) => (i === index ? updated : t)) };
}

/** Parameters a generator UI collects; unused ones are ignored per kind. */
export interface GeneratorParams {
  period: number;
  min: number;
  max: number;
  distance: number;
  amplitude: number;
  center: number;
  steps: number;
  seed: number;
}

export const DEFAULT_GENERATOR_PARAMS: GeneratorParams = {
  period: 60,
  min: 0.4,
  max: 1,
  distance: 32,
  amplitude: 4,
  center: 0,
  steps: 10,
  seed: 1,
};

function runGenerator(kind: GeneratorKind, p: GeneratorParams): GeneratedTrack {
  switch (kind) {
    case "flicker":
      return flicker(p.period, p.min, p.max, p.steps, p.seed);
    case "pulse":
      return pulse(p.period, p.min, p.max);
    case "drift":
      return drift(p.period, p.distance);
    case "sway":
      return sway(p.period, p.amplitude, p.center);
  }
}

/** A short human label for a target, for list rows. */
export function describeTarget(target: AnimTarget): string {
  if (target.kind === "sceneLayer") return `Layer ${target.index + 1} · ${target.channel}`;
  if (target.kind === "placement") return `Placement ${target.index + 1} · ${target.channel}`;
  return `FX · ${target.key}`;
}
