/**
 * Cinematic gap #1 (animation timeline) — the cart-facing `anim` model.
 *
 * A cart declares ambient motion the way it declares fx / scene / rig: a JSON
 * sidecar validated on load. The runtime plays it back host-side from the frame
 * clock (no cart Lua, no mailbox words — the mailbox is full), which is exactly
 * what the REPLACED / THE LAST NIGHT look needs: flickering neon, drifting fog,
 * a guttering candle, idle sway. See Working/cinematic-artstyle/anim-timeline-spec.md.
 *
 * This module is the pure, DOM-free data + validation half (mirrors the defensive
 * parse style of scene/sceneModel.ts + apps/web/src/lib/rig.ts): parse untrusted
 * JSON into a safe AnimSpec, dropping anything malformed rather than throwing. The
 * playback half is animPlayer.ts. Intended app homes: apps/web/src/lib/anim.ts
 * (parse) + packages/player/src/anim/ (playback).
 */

import type { SpriteRegion } from "../scene/sceneModel.js";

// Re-exported so the anim modules share a single type surface (a clip frame IS a
// sprite-sheet region, same shape scene layers use).
export type { SpriteRegion } from "../scene/sceneModel.js";

/** How a sprite clip repeats. */
export type AnimMode = "loop" | "pingpong" | "once";
/** How a property track repeats past its key range. */
export type TrackMode = "loop" | "pingpong" | "hold";
/** Interpolation on the segment beginning at a keyframe. */
export type Ease = "linear" | "step" | "smooth";

/** A named sprite-frame animation drawn from the cart's own sheet. */
export interface AnimClip {
  name: string;
  /** Ordered frames; each a region of the sprite sheet. */
  frames: SpriteRegion[];
  /** Ticks each frame is held; always aligned 1:1 with `frames`. */
  durations: number[];
  mode: AnimMode;
}

/** One control point on a property track. */
export interface Keyframe {
  /** Tick position (>= 0). */
  t: number;
  value: number;
  /** Ease applied from this key to the next. */
  ease: Ease;
}

/** Channels a track can drive on a parallax scene layer (by index). */
export type LayerChannel = "opacity" | "offsetX" | "offsetY" | "emissive";
/** Channels a track can drive on a foreground placement (by index). */
export type PlacementChannel = "x" | "y" | "opacity" | "scale";

/** What a track animates. Loosely coupled: scene layers are addressed by index. */
export type AnimTarget =
  | { kind: "sceneLayer"; index: number; channel: LayerChannel }
  | { kind: "postfx"; key: string }
  | { kind: "placement"; index: number; channel: PlacementChannel };

/** A keyframed scalar curve bound to one target channel. */
export interface AnimTrack {
  target: AnimTarget;
  /** Sorted ascending by `t`; at least one key. */
  keys: Keyframe[];
  mode: TrackMode;
  /** Loop period in ticks (loop mode only). Defaults to the last key's `t`. */
  loopLength?: number;
}

/** A clip instance drawn OVER the cart frame (animated set-dressing). */
export interface AnimPlacement {
  /** References an AnimClip by name. */
  clip: string;
  x: number;
  y: number;
  /** 0 (nearest) .. 1 (far) — for future ordering; not composited in Phase A. */
  depth: number;
  /** Base opacity 0..1 (tracks may override). */
  opacity: number;
  /** Base scale > 0 (tracks may override). */
  scale: number;
}

/** A full declared animation set. */
export interface AnimSpec {
  clips: AnimClip[];
  tracks: AnimTrack[];
  placements: AnimPlacement[];
}

const MAX_CLIPS = 32;
const MAX_TRACKS = 64;
const MAX_PLACEMENTS = 32;
const MAX_KEYS = 64;
const MAX_FRAMES = 64;
const MAX_TILE = 255;
const MAX_TILES_PER_SIDE = 32;
/** Matches scene/sceneModel.ts MAX_LAYERS (8) — the highest addressable layer. */
const MAX_LAYER_INDEX = 7;
/** Longest a single frame may be held: 10s at 60fps. Guards runaway JSON. */
const MAX_FRAME_TICKS = 600;

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown, fallback: number): number =>
  typeof v === "number" && Number.isFinite(v) ? v : fallback;
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const clampInt = (v: number, lo: number, hi: number) => Math.round(clamp(v, lo, hi));

const ANIM_MODES = new Set<AnimMode>(["loop", "pingpong", "once"]);
const TRACK_MODES = new Set<TrackMode>(["loop", "pingpong", "hold"]);
const EASES = new Set<Ease>(["linear", "step", "smooth"]);
const LAYER_CHANNELS = new Set<LayerChannel>(["opacity", "offsetX", "offsetY", "emissive"]);
const PLACEMENT_CHANNELS = new Set<PlacementChannel>(["x", "y", "opacity", "scale"]);

/** Parse one sprite-sheet region (mirrors scene/sceneModel.ts parseRegion). */
function parseRegion(raw: unknown): SpriteRegion | null {
  if (!isObject(raw)) return null;
  if (typeof raw.tile !== "number" || !Number.isFinite(raw.tile) || raw.tile < 0) return null;
  return {
    page: raw.page === 1 ? 1 : 0,
    tile: clampInt(raw.tile, 0, MAX_TILE),
    tilesW: clampInt(num(raw.tilesW, 1), 1, MAX_TILES_PER_SIDE),
    tilesH: clampInt(num(raw.tilesH, 1), 1, MAX_TILES_PER_SIDE),
  };
}

/** A clip with no valid frames or a blank name is dropped, not defaulted. */
function parseClip(raw: unknown): AnimClip | null {
  if (!isObject(raw)) return null;
  if (typeof raw.name !== "string" || raw.name.length === 0) return null;

  const framesRaw = Array.isArray(raw.frames) ? raw.frames : [];
  const frames: SpriteRegion[] = [];
  for (const entry of framesRaw) {
    if (frames.length >= MAX_FRAMES) break;
    const region = parseRegion(entry);
    if (region) frames.push(region);
  }
  if (frames.length === 0) return null;

  // Durations are forced 1:1 with frames: a missing entry defaults to 1 tick.
  const durationsRaw = Array.isArray(raw.durations) ? raw.durations : [];
  const durations = frames.map((_, i) => clampInt(num(durationsRaw[i], 1), 1, MAX_FRAME_TICKS));

  const mode = ANIM_MODES.has(raw.mode as AnimMode) ? (raw.mode as AnimMode) : "loop";
  return { name: raw.name, frames, durations, mode };
}

function parseKeyframe(raw: unknown): Keyframe | null {
  if (!isObject(raw)) return null;
  if (typeof raw.t !== "number" || !Number.isFinite(raw.t) || raw.t < 0) return null;
  if (typeof raw.value !== "number" || !Number.isFinite(raw.value)) return null;
  return { t: raw.t, value: raw.value, ease: EASES.has(raw.ease as Ease) ? (raw.ease as Ease) : "linear" };
}

/** Validate a target; placement targets are bounds-checked against placementCount. */
function parseTarget(raw: unknown, placementCount: number): AnimTarget | null {
  if (!isObject(raw)) return null;
  if (raw.kind === "sceneLayer") {
    if (typeof raw.index !== "number" || !Number.isInteger(raw.index) || raw.index < 0 || raw.index > MAX_LAYER_INDEX) return null;
    if (!LAYER_CHANNELS.has(raw.channel as LayerChannel)) return null;
    return { kind: "sceneLayer", index: raw.index, channel: raw.channel as LayerChannel };
  }
  if (raw.kind === "postfx") {
    if (typeof raw.key !== "string" || raw.key.length === 0) return null;
    return { kind: "postfx", key: raw.key };
  }
  if (raw.kind === "placement") {
    if (typeof raw.index !== "number" || !Number.isInteger(raw.index) || raw.index < 0 || raw.index >= placementCount) return null;
    if (!PLACEMENT_CHANNELS.has(raw.channel as PlacementChannel)) return null;
    return { kind: "placement", index: raw.index, channel: raw.channel as PlacementChannel };
  }
  return null;
}

function parseTrack(raw: unknown, placementCount: number): AnimTrack | null {
  if (!isObject(raw)) return null;
  const target = parseTarget(raw.target, placementCount);
  if (!target) return null;

  const keysRaw = Array.isArray(raw.keys) ? raw.keys : [];
  const keys: Keyframe[] = [];
  for (const entry of keysRaw) {
    if (keys.length >= MAX_KEYS) break;
    const key = parseKeyframe(entry);
    if (key) keys.push(key);
  }
  if (keys.length === 0) return null;
  keys.sort((a, b) => a.t - b.t);

  const track: AnimTrack = {
    target,
    keys,
    mode: TRACK_MODES.has(raw.mode as TrackMode) ? (raw.mode as TrackMode) : "loop",
  };
  if (typeof raw.loopLength === "number" && Number.isFinite(raw.loopLength) && raw.loopLength > 0) {
    track.loopLength = raw.loopLength;
  }
  return track;
}

/** A placement referencing an unknown clip is dropped (clips are parsed first). */
function parsePlacement(raw: unknown, clipNames: Set<string>): AnimPlacement | null {
  if (!isObject(raw)) return null;
  if (typeof raw.clip !== "string" || !clipNames.has(raw.clip)) return null;
  return {
    clip: raw.clip,
    x: num(raw.x, 0),
    y: num(raw.y, 0),
    depth: clamp(num(raw.depth, 0), 0, 1),
    opacity: clamp(num(raw.opacity, 1), 0, 1),
    scale: Math.max(0.01, num(raw.scale, 1)),
  };
}

/**
 * Parse untrusted sidecar JSON into an AnimSpec, or null when there is nothing
 * usable (no object, or no valid clips/tracks/placements). Entries are validated
 * individually and bad ones dropped — losing one clip beats refusing the whole
 * animation. Order matters: clips first (placements reference clip names), then
 * placements (tracks bounds-check placement indices), then tracks.
 */
export function parseAnim(raw: unknown): AnimSpec | null {
  if (!isObject(raw)) return null;

  const clips: AnimClip[] = [];
  const clipNames = new Set<string>();
  for (const entry of Array.isArray(raw.clips) ? raw.clips : []) {
    if (clips.length >= MAX_CLIPS) break;
    const clip = parseClip(entry);
    if (clip && !clipNames.has(clip.name)) {
      clipNames.add(clip.name);
      clips.push(clip);
    }
  }

  const placements: AnimPlacement[] = [];
  for (const entry of Array.isArray(raw.placements) ? raw.placements : []) {
    if (placements.length >= MAX_PLACEMENTS) break;
    const placement = parsePlacement(entry, clipNames);
    if (placement) placements.push(placement);
  }

  const tracks: AnimTrack[] = [];
  for (const entry of Array.isArray(raw.tracks) ? raw.tracks : []) {
    if (tracks.length >= MAX_TRACKS) break;
    const track = parseTrack(entry, placements.length);
    if (track) tracks.push(track);
  }

  if (clips.length === 0 && tracks.length === 0 && placements.length === 0) return null;
  return { clips, tracks, placements };
}
