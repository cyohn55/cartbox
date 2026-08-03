/**
 * Pure reducer tests for the Anim tab (apps/web/.../animAuthoring.ts). Each
 * mutation is exercised on real specs and asserted on its outputs — and crucially
 * every result is fed through the runtime `parseAnim` so authoring can never build
 * a spec the player would reject (preview == saved-then-reloaded). Referential
 * integrity (clip removal orphaning placements, placement removal reindexing
 * tracks) is pinned because that is where an authoring bug silently corrupts a
 * saved animation.
 */

import { describe, expect, it } from "vitest";

import { parseAnim, type AnimSpec } from "@cartbox/player";
import {
  DEFAULT_GENERATOR_PARAMS,
  emptyAnim,
  withClipAdded,
  withClipFrameAdded,
  withClipFrameDuration,
  withClipFrameRemoved,
  withClipRemoved,
  withClipUpdated,
  withPlacementAdded,
  withPlacementRemoved,
  withPlacementUpdated,
  withTrackAdded,
  withTrackConstant,
  withTrackGenerator,
  withTrackRemoved,
  withTrackTarget,
} from "../apps/web/src/app/edit/[cartId]/animAuthoring";

/** Asserts a spec is non-null AND is exactly what the runtime parser accepts. */
function expectValid(spec: AnimSpec | null): AnimSpec {
  expect(spec).not.toBeNull();
  expect(parseAnim(spec)).toEqual(spec); // authoring output is already canonical
  return spec as AnimSpec;
}

describe("clip authoring", () => {
  it("adds a clip to a null animation and it parses", () => {
    const spec = expectValid(withClipAdded(null));
    expect(spec.clips.length).toBe(1);
    expect(spec.clips[0]!.frames.length).toBe(1);
  });

  it("gives added clips unique names", () => {
    const a = withClipAdded(null);
    const b = withClipAdded(a);
    expect(b.clips[0]!.name).not.toBe(b.clips[1]!.name);
  });

  it("renames a clip and follows the rename through to its placements", () => {
    let spec: AnimSpec | null = withClipAdded(null);
    const name = spec!.clips[0]!.name;
    spec = withPlacementAdded(spec, name, 10, 20);
    spec = withClipUpdated(spec!, 0, { name: "torch" });
    expect(spec.clips[0]!.name).toBe("torch");
    expect(spec.placements[0]!.clip).toBe("torch");
    expectValid(spec);
  });

  it("adds and removes frames, always keeping at least one", () => {
    let spec = withClipAdded(null);
    spec = withClipFrameAdded(spec, 0);
    expect(spec.clips[0]!.frames.length).toBe(2);
    expect(spec.clips[0]!.durations.length).toBe(2);
    spec = withClipFrameRemoved(spec, 0, 0);
    expect(spec.clips[0]!.frames.length).toBe(1);
    const floor = withClipFrameRemoved(spec, 0, 0); // cannot drop the last frame
    expect(floor.clips[0]!.frames.length).toBe(1);
    expectValid(spec);
  });

  it("clamps a frame's duration and region to runtime ranges", () => {
    let spec = withClipAdded(null);
    spec = withClipFrameDuration(spec, 0, 0, 99999);
    expect(spec.clips[0]!.durations[0]).toBeLessThanOrEqual(600);
    expectValid(spec);
  });
});

describe("placement authoring", () => {
  it("adds a placement only for an existing clip", () => {
    let spec: AnimSpec | null = withClipAdded(null);
    const name = spec!.clips[0]!.name;
    const ghost = withPlacementAdded(spec, "nope");
    expect(ghost.placements.length).toBe(0); // unknown clip → no placement
    spec = withPlacementAdded(spec, name, 5, 6);
    expect(spec.placements.length).toBe(1);
    expectValid(spec);
  });

  it("clamps placement opacity/scale/depth", () => {
    let spec: AnimSpec | null = withClipAdded(null);
    spec = withPlacementAdded(spec, spec!.clips[0]!.name);
    spec = withPlacementUpdated(spec, 0, { opacity: 9, scale: -3, depth: 9 });
    const p = spec.placements[0]!;
    expect(p.opacity).toBeLessThanOrEqual(1);
    expect(p.scale).toBeGreaterThan(0);
    expect(p.depth).toBeLessThanOrEqual(1);
    expectValid(spec);
  });

  it("removing a clip drops placements that referenced it", () => {
    let spec: AnimSpec | null = withClipAdded(null);
    spec = withPlacementAdded(spec, spec!.clips[0]!.name);
    const gone = withClipRemoved(spec!, 0);
    expect(gone).toBeNull(); // last clip + its only placement removed → empty → null
  });
});

describe("track authoring", () => {
  it("adds a constant scene-layer track and it parses", () => {
    const spec = expectValid(withTrackAdded(null, { kind: "sceneLayer", index: 2, channel: "emissive" }));
    expect(spec.tracks[0]!.target).toEqual({ kind: "sceneLayer", index: 2, channel: "emissive" });
    expect(spec.tracks[0]!.keys.length).toBe(1);
    expect(spec.tracks[0]!.mode).toBe("hold");
  });

  it("sets a constant value and later swaps to a generator", () => {
    let spec = withTrackAdded(null, { kind: "postfx", key: "bloom.strength" });
    spec = withTrackConstant(spec, 0, 0.9);
    expect(spec.tracks[0]!.keys[0]!.value).toBe(0.9);
    spec = withTrackGenerator(spec, 0, "flicker", DEFAULT_GENERATOR_PARAMS);
    expect(spec.tracks[0]!.keys.length).toBeGreaterThan(1); // flicker expands to many keys
    expect(spec.tracks[0]!.mode).toBe("loop");
    expectValid(spec);
  });

  it("clamps an out-of-range scene-layer target index", () => {
    const spec = withTrackAdded(null, { kind: "sceneLayer", index: 99, channel: "opacity" });
    expect((spec.tracks[0]!.target as { index: number }).index).toBeLessThanOrEqual(7);
    expectValid(spec);
  });

  it("changing a track target re-validates it", () => {
    let spec = withTrackAdded(null, { kind: "postfx", key: "bloom.strength" });
    spec = withTrackTarget(spec, 0, { kind: "sceneLayer", index: 1, channel: "offsetX" });
    expect(spec.tracks[0]!.target).toEqual({ kind: "sceneLayer", index: 1, channel: "offsetX" });
    expectValid(spec);
  });
});

describe("referential integrity on placement removal", () => {
  it("drops a placement's own tracks and reindexes tracks of later placements", () => {
    // Two clips → two placements (index 0, 1). Track A targets placement 0, track B
    // targets placement 1. Removing placement 0 must drop A and shift B to index 0.
    let spec: AnimSpec | null = withClipAdded(withClipAdded(null));
    const [c0, c1] = [spec!.clips[0]!.name, spec!.clips[1]!.name];
    spec = withPlacementAdded(spec, c0);
    spec = withPlacementAdded(spec, c1);
    spec = withTrackAdded(spec, { kind: "placement", index: 0, channel: "y" });
    spec = withTrackAdded(spec, { kind: "placement", index: 1, channel: "x" });

    spec = withPlacementRemoved(spec!, 0);
    expectValid(spec);
    expect(spec!.placements.length).toBe(1);
    const placementTracks = spec!.tracks.filter((t) => t.target.kind === "placement");
    expect(placementTracks.length).toBe(1); // track A (index 0) dropped
    expect((placementTracks[0]!.target as { index: number }).index).toBe(0); // track B reindexed 1→0
  });
});

describe("emptying", () => {
  it("collapses to null when the last item is removed", () => {
    let spec = withTrackAdded(null, { kind: "postfx", key: "bloom.strength" });
    expect(withTrackRemoved(spec, 0)).toBeNull();

    spec = withClipAdded(null);
    expect(withClipRemoved(spec, 0)).toBeNull();
  });

  it("emptyAnim parses as null (nothing usable)", () => {
    expect(parseAnim(emptyAnim())).toBeNull();
  });
});
