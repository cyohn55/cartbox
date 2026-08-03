/**
 * Animation-sidecar save decision tests. `PUT /api/carts/:id/anim` delegates the
 * one non-plumbing choice it makes — what to write to the `anim` column for a
 * given request body — to the pure `resolveAnimUpdate`. These tests exercise that
 * decision through real bodies and assert the contract the play route and the
 * schema depend on, rather than snapshotting a stored shape:
 *   - an explicit null clears the column (author removed their animation)
 *   - a well-formed animation is accepted and comes back as the runtime's own
 *     canonical, clamped AnimSpec (same parser the player consumes)
 *   - a body the parser can't use — including an empty animation — is a 400,
 *     never a silently-stored empty timeline
 */

import { describe, expect, it } from "vitest";

import { parseAnim } from "@cartbox/player";
import { resolveAnimUpdate } from "../apps/web/src/lib/anim";

/** A minimal but valid animation body, as the editor would PUT it. */
function sampleAnimBody(): unknown {
  return {
    clips: [
      {
        name: "flame",
        frames: [
          { page: 0, tile: 240, tilesW: 1, tilesH: 1 },
          { page: 0, tile: 241, tilesW: 1, tilesH: 1 },
        ],
        durations: [10, 10],
        mode: "loop",
      },
    ],
    placements: [{ clip: "flame", x: 100, y: 50, opacity: 1, scale: 1, depth: 0 }],
    tracks: [
      { target: { kind: "postfx", key: "bloom.strength" }, keys: [{ t: 0, value: 0.3 }, { t: 60, value: 0.6 }], mode: "pingpong" },
    ],
  };
}

describe("resolveAnimUpdate", () => {
  it("clears the column when the body is an explicit null", () => {
    const update = resolveAnimUpdate(null);
    expect(update).toEqual({ anim: null });
  });

  it("accepts a well-formed animation and stores the parser's canonical form", () => {
    const body = sampleAnimBody();
    const update = resolveAnimUpdate(body);

    expect("error" in update).toBe(false);
    if ("error" in update) return; // narrow for the type checker
    // The stored value is exactly what the runtime would parse from the same
    // body, so the play route reads back what the player will play.
    expect(update.anim).toEqual(parseAnim(body));
    expect(update.anim?.clips.length).toBe(1);
    expect(update.anim?.placements.length).toBe(1);
    expect(update.anim?.tracks.length).toBe(1);
  });

  it("stores an animation the parser has clamped rather than the raw out-of-range body", () => {
    const body = sampleAnimBody() as { placements: Array<{ depth: number; opacity: number }> };
    body.placements[0].depth = 9; // beyond the 0..1 depth range
    body.placements[0].opacity = 5; // beyond the 0..1 opacity range

    const update = resolveAnimUpdate(body);
    if ("error" in update) throw new Error("expected the clamped animation to be accepted");

    expect(update.anim?.placements[0].depth).toBeLessThanOrEqual(1);
    expect(update.anim?.placements[0].opacity).toBeLessThanOrEqual(1);
  });

  const rejected: Array<[string, unknown]> = [
    ["a non-object body", "not-an-animation"],
    ["an empty animation", { clips: [], tracks: [], placements: [] }],
    ["an animation whose only clip is malformed", { clips: [{ name: "", frames: [] }] }],
    ["an animation whose only placement references an unknown clip", { placements: [{ clip: "ghost" }] }],
  ];
  for (const [label, body] of rejected) {
    it(`rejects ${label} with a client error rather than storing it`, () => {
      const update = resolveAnimUpdate(body);
      expect("error" in update).toBe(true);
    });
  }
});
