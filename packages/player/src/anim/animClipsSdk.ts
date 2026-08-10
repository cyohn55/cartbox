/**
 * The cart-facing animation-clip accessor, as injectable Lua (upgrade #4).
 *
 * The Anim tab already lets a creator author named sprite-frame clips (an ordered
 * set of sprite-sheet regions with per-frame durations and a loop/pingpong/once
 * mode). Until now those clips only drove host-played set-dressing; a gameplay
 * entity that wanted to animate had to swap sprite ids by hand in Lua. This
 * exposes the SAME authored clips to the cart's own code as
 * `cartbox.clip(name, tick) -> id, w, h`, so a cart draws the current frame with
 * `spr(id, x, y, key, 1, flip, 0, w, h)` and never re-derives the timing.
 *
 * Like the collision/flags accessors this is host data the cart *reads* and it
 * never changes during play, so the whole clip table is injected once as Lua data
 * (after the base SDK, so `cartbox` already exists). Pingpong is baked into a
 * forward+reverse loop sequence here so the Lua only needs loop/once logic, and
 * every value feeding an integer op is floored (the Pro core's Lua throws on a
 * bitwise/`%` of a float — see the lua-bitwise-float-trap note).
 *
 * Pure and import-free apart from the AnimSpec types, so it is unit-testable on
 * its own inputs and outputs.
 */

import type { AnimClip, AnimSpec } from "./animModel.js";

/** One frame of the flattened sequence a clip animates through. */
interface FlatFrame {
  tile: number;
  w: number;
  h: number;
  duration: number;
}

/** Flatten a clip to the sequence it plays: pingpong becomes forward+reverse. */
function flattenClip(clip: AnimClip): { frames: FlatFrame[]; once: boolean } {
  const base: FlatFrame[] = clip.frames.map((frame, i) => ({
    tile: frame.tile,
    w: Math.max(1, frame.tilesW),
    h: Math.max(1, frame.tilesH),
    duration: Math.max(1, Math.floor(clip.durations[i] ?? 1)),
  }));
  if (clip.mode === "pingpong" && base.length > 2) {
    // Append the interior frames in reverse (endpoints are not repeated), so the
    // motion reads A B C B A B C … as one continuous loop.
    const reverse = base.slice(1, -1).reverse();
    return { frames: [...base, ...reverse], once: false };
  }
  return { frames: base, once: clip.mode === "once" };
}

/** The encoded playback table for one clip — the exact data the Lua drives from. */
export interface ClipTableEntry {
  readonly name: string;
  /** Total cycle length in ticks. */
  readonly total: number;
  /** Once clips clamp to the last frame past the end; loops wrap. */
  readonly once: boolean;
  /** Sprite id per (flattened) frame. */
  readonly tile: readonly number[];
  readonly w: readonly number[];
  readonly h: readonly number[];
  /** Cumulative end-tick of each frame (cum[i-1] <= t < cum[i] selects frame i). */
  readonly cum: readonly number[];
}

/**
 * Build the per-clip playback tables from an AnimSpec — the pure step the Lua
 * generator and the tests share. Pingpong is flattened to a forward+reverse loop
 * sequence here, so the frame table is the single source of truth for timing.
 */
export function buildClipTable(anim: AnimSpec | null | undefined): ClipTableEntry[] {
  if (!anim || !Array.isArray(anim.clips)) return [];
  const table: ClipTableEntry[] = [];
  for (const clip of anim.clips) {
    if (!clip || typeof clip.name !== "string" || clip.name.length === 0) continue;
    const { frames, once } = flattenClip(clip);
    if (frames.length === 0) continue;
    let total = 0;
    const cum: number[] = [];
    for (const frame of frames) {
      total += frame.duration;
      cum.push(total);
    }
    table.push({
      name: clip.name,
      total,
      once,
      tile: frames.map((f) => f.tile),
      w: frames.map((f) => f.w),
      h: frames.map((f) => f.h),
      cum,
    });
  }
  return table;
}

/**
 * The frame index (1-based, as the Lua uses) an entry shows at `tick` — the exact
 * selection the emitted Lua implements. Exposed so the timing contract is tested
 * against real inputs without executing Lua (mirroring the collision SDK tests).
 */
export function clipFrameIndex(entry: ClipTableEntry, tick: number): number {
  if (entry.total <= 0) return 1;
  let t = Math.max(0, Math.floor(tick));
  if (entry.once) {
    if (t >= entry.total) return entry.cum.length;
  } else {
    t = t % entry.total;
  }
  for (let i = 0; i < entry.cum.length; i += 1) {
    if (t < entry.cum[i]!) return i + 1;
  }
  return entry.cum.length;
}

/** Escape a clip name for use inside a Lua double-quoted string key. */
function luaString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "");
}

/**
 * Build the Lua that exposes a cart's authored clips as
 * `cartbox.clip(name, tick)`. Returns an empty string when there are no usable
 * clips, so the caller injects nothing.
 *
 * `cartbox.clip(name, tick)` returns the current frame's top-left sprite id and
 * its width/height in tiles; an unknown clip returns `0, 1, 1`. `tick` is the
 * cart's own frame counter (durations are authored in ticks at 60Hz).
 */
export function animClipsSdkLua(anim: AnimSpec | null | undefined): string {
  const table = buildClipTable(anim);
  if (table.length === 0) return "";

  const entries = table.map(
    (entry) =>
      `  ["${luaString(entry.name)}"] = { total = ${entry.total}, once = ${entry.once}, ` +
      `tile = {${entry.tile.join(",")}}, w = {${entry.w.join(",")}}, h = {${entry.h.join(",")}}, ` +
      `cum = {${entry.cum.join(",")}} }`,
  );

  return `do
  cartbox = cartbox or {}
  local _clips = {
${entries.join(",\n")}
  }
  -- The frame whose cumulative window contains tick t (0-based t < total).
  local function _frameAt(c, t)
    local cum = c.cum
    for i = 1, #cum do
      if t < cum[i] then return i end
    end
    return #cum
  end
  cartbox.clip = function(name, tick)
    local c = _clips[name]
    if not c or c.total <= 0 then return 0, 1, 1 end
    local t = math.floor(tick or 0)
    if t < 0 then t = 0 end
    if c.once then
      if t >= c.total then
        local n = #c.tile
        return c.tile[n], c.w[n], c.h[n]
      end
    else
      t = t % c.total
    end
    local i = _frameAt(c, t)
    return c.tile[i], c.w[i], c.h[i]
  end
end`;
}
