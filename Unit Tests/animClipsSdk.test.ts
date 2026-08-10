/**
 * Tests for the cart-facing animation-clip accessor (upgrade #4).
 *
 * Like the collision/flags SDK tests, the generator is pure so it is validated
 * directly rather than by executing Lua: buildClipTable is asserted to flatten
 * clips (incl. pingpong) to the exact frame/duration table, clipFrameIndex is
 * asserted to reproduce the loop/once/pingpong selection over real ticks — this
 * IS the algorithm the emitted Lua encodes — and a light check confirms the Lua
 * embeds that table and defines cartbox.clip.
 */

import { describe, expect, it } from "vitest";

import { animClipsSdkLua, buildClipTable, clipFrameIndex } from "@cartbox/player";
import type { AnimSpec, AnimClip } from "@cartbox/player";

function makeClip(name: string, tiles: number[], durations: number[], mode: AnimClip["mode"], w = 4, h = 4): AnimClip {
  return { name, frames: tiles.map((tile) => ({ page: 0, tile, tilesW: w, tilesH: h })), durations, mode };
}
function spec(clips: AnimClip[]): AnimSpec {
  return { clips, tracks: [], placements: [] } as AnimSpec;
}
/** The sprite id shown at each tick, via the same selection the Lua encodes. */
function idsOverTicks(anim: AnimSpec, name: string, ticks: number[]): number[] {
  const entry = buildClipTable(anim).find((e) => e.name === name)!;
  return ticks.map((t) => entry.tile[clipFrameIndex(entry, t) - 1]!);
}

describe("buildClipTable", () => {
  it("flattens a loop clip to its frames + cumulative durations", () => {
    const [entry] = buildClipTable(spec([makeClip("walk", [0, 4], [3, 3], "loop")]));
    expect(entry).toMatchObject({ name: "walk", total: 6, once: false, tile: [0, 4], cum: [3, 6] });
    expect(entry!.w).toEqual([4, 4]);
  });

  it("flattens pingpong to forward+reverse without repeating endpoints", () => {
    const [entry] = buildClipTable(spec([makeClip("idle", [0, 4, 8], [1, 1, 1], "pingpong")]));
    // A B C B — period 4, endpoints (A, C) not doubled.
    expect(entry!.tile).toEqual([0, 4, 8, 4]);
    expect(entry!.total).toBe(4);
    expect(entry!.once).toBe(false);
  });

  it("marks a once clip and drops empty/blank clips", () => {
    const table = buildClipTable(
      spec([
        makeClip("die", [8, 12], [2, 2], "once"),
        { name: "", frames: [{ page: 0, tile: 0, tilesW: 1, tilesH: 1 }], durations: [1], mode: "loop" },
      ]),
    );
    expect(table).toHaveLength(1);
    expect(table[0]).toMatchObject({ name: "die", once: true, total: 4 });
  });

  it("returns nothing for missing/empty specs", () => {
    expect(buildClipTable(null)).toEqual([]);
    expect(buildClipTable(spec([]))).toEqual([]);
  });
});

describe("clipFrameIndex selection (the timing the Lua encodes)", () => {
  it("loops by tick and wraps at total", () => {
    const anim = spec([makeClip("walk", [0, 4], [3, 3], "loop")]);
    expect(idsOverTicks(anim, "walk", [0, 2, 3, 5, 6, 9])).toEqual([0, 0, 4, 4, 0, 4]);
  });

  it("clamps a once clip to its last frame past the end", () => {
    const anim = spec([makeClip("die", [8, 12, 16], [2, 2, 2], "once")]);
    expect(idsOverTicks(anim, "die", [0, 2, 4, 6, 100])).toEqual([8, 12, 16, 16, 16]);
  });

  it("plays pingpong forward then back", () => {
    const anim = spec([makeClip("idle", [0, 4, 8], [1, 1, 1], "pingpong")]);
    expect(idsOverTicks(anim, "idle", [0, 1, 2, 3, 4, 5])).toEqual([0, 4, 8, 4, 0, 4]);
  });
});

describe("animClipsSdkLua", () => {
  it("emits nothing when there are no clips", () => {
    expect(animClipsSdkLua(null)).toBe("");
    expect(animClipsSdkLua(spec([]))).toBe("");
  });

  it("embeds the clip table and defines cartbox.clip", () => {
    const lua = animClipsSdkLua(spec([makeClip("walk", [0, 4], [3, 3], "loop")]));
    expect(lua).toContain('["walk"]');
    expect(lua).toContain("tile = {0,4}");
    expect(lua).toContain("cum = {3,6}");
    expect(lua).toContain("cartbox.clip = function");
    // Names are escaped so a quote in a clip name can't break the Lua string.
    const tricky = animClipsSdkLua(spec([makeClip('a"b', [0], [1], "loop")]));
    expect(tricky).toContain('["a\\"b"]');
  });
});
