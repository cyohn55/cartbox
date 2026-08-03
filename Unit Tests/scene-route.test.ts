/**
 * Scene-sidecar save decision tests. `PUT /api/carts/:id/scene` delegates the
 * one non-plumbing choice it makes — what to write to the `scene` column for a
 * given request body — to the pure `resolveSceneUpdate`. These tests exercise
 * that decision through real bodies and assert the contract the play route and
 * the schema depend on, rather than snapshotting a stored shape:
 *   - an explicit null clears the column (author removed their backdrop)
 *   - a well-formed scene is accepted and comes back as the runtime's own
 *     canonical, clamped SceneSpec (same parser the player consumes)
 *   - a body the parser can't use — including a layer-less scene — is a 400,
 *     never a silently-stored empty backdrop
 */

import { describe, expect, it } from "vitest";

import { parseScene } from "@cartbox/player";
import { resolveSceneUpdate } from "../apps/web/src/lib/scene";

/** A minimal but valid single-layer scene body, as the editor would PUT it. */
function sampleSceneBody(): unknown {
  return {
    layers: [{ source: { page: 0, tile: 0, tilesW: 4, tilesH: 4 }, depth: 0.8 }],
    atmosphere: { fog: [90, 110, 150], density: 0.6, desaturate: 0.5, lift: 0.3 },
    camera: { autoScrollX: 0.25, autoScrollY: 0 },
    keyColor: 0,
  };
}

describe("resolveSceneUpdate", () => {
  it("clears the column when the body is an explicit null", () => {
    const update = resolveSceneUpdate(null);
    expect(update).toEqual({ scene: null });
  });

  it("accepts a well-formed scene and stores the parser's canonical form", () => {
    const body = sampleSceneBody();
    const update = resolveSceneUpdate(body);

    expect("error" in update).toBe(false);
    if ("error" in update) return; // narrow for the type checker
    // The stored value is exactly what the runtime would parse from the same
    // body, so the play route reads back what the player will render.
    expect(update.scene).toEqual(parseScene(body));
    expect(update.scene?.layers.length).toBe(1);
  });

  it("stores a scene the parser has clamped rather than the raw out-of-range body", () => {
    const body = sampleSceneBody() as { layers: Array<{ depth: number }>; atmosphere: { density: number } };
    body.layers[0].depth = 9; // beyond the 0..1 depth range
    body.atmosphere.density = 5; // beyond the 0..1 density range

    const update = resolveSceneUpdate(body);
    if ("error" in update) throw new Error("expected the clamped scene to be accepted");

    expect(update.scene?.layers[0].depth).toBeLessThanOrEqual(1);
    expect(update.scene?.atmosphere.density).toBeLessThanOrEqual(1);
  });

  const rejected: Array<[string, unknown]> = [
    ["a non-object body", "not-a-scene"],
    ["a scene with no layers", { layers: [], atmosphere: {} }],
    ["a scene whose only layer is malformed", { layers: [{ nonsense: true }] }],
  ];
  for (const [label, body] of rejected) {
    it(`rejects ${label} with a client error rather than storing it`, () => {
      const update = resolveSceneUpdate(body);
      expect("error" in update).toBe(true);
    });
  }
});
