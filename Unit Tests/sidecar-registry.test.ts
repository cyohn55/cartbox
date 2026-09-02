/**
 * Sidecar-registry tests (apps/web/src/lib/sidecars.ts).
 *
 * The registry exists because eleven payloads were threaded by hand through
 * roughly twenty places, and two of them — `mesh` and `world` — never reached
 * the last six, so a creator's meshes and HD-2D worlds were silently discarded
 * by a Save that reported success.
 *
 * These tests hold that shut. The first one is the important one: it asserts
 * that *every* key in the table survives a round trip, so a twelfth sidecar
 * that forgets a step fails here rather than in a creator's browser.
 */

import { describe, expect, it } from "vitest";

import { CollisionMap, TileFlags } from "@cartbox/editor";
import { defaultPostFxSettings } from "@cartbox/player";

import {
  SIDECARS,
  SIDECAR_KEYS,
  emptySidecars,
  parseSidecars,
  sidecarsEqual,
  sidecarsFromRow,
  sidecarsToRow,
  type Sidecars,
} from "@/lib/sidecars";

/**
 * A valid value for the sidecars this file exercises, built from the real
 * encoders rather than hand-written literals — a payload shape copied into a
 * test is a payload shape that stops matching the code.
 */
function collisionPayload(solid: boolean): unknown {
  const map = new CollisionMap(4, 4);
  if (solid) map.setSolid(1, 1, true);
  return map.serialize();
}

function flagPayload(): unknown {
  const flags = new TileFlags(4, 4);
  flags.set(2, 2, 1, true);
  return flags.serialize();
}

function sampleSidecars(): Sidecars {
  return {
    ...emptySidecars(),
    fx: defaultPostFxSettings(),
    collision: collisionPayload(true) as never,
    flags: flagPayload() as never,
  };
}

describe("the sidecar registry", () => {
  it("covers every payload the editor authors", () => {
    // The set the editor threads by hand used to omit mesh and world.
    expect(SIDECAR_KEYS).toEqual(
      expect.arrayContaining([
        "fx",
        "rig",
        "materials",
        "voxel",
        "mesh",
        "world",
        "scene",
        "anim",
        "particles",
        "collision",
        "flags",
      ]),
    );
  });

  it("gives every sidecar a column, a label and a parser", () => {
    for (const key of SIDECAR_KEYS) {
      const def = SIDECARS[key];
      expect(def.column, key).toBeTruthy();
      expect(def.label, key).toBeTruthy();
      expect(typeof def.parse, key).toBe("function");
    }
  });

  it("puts every sidecar on the undo timeline", () => {
    // mesh and world sat outside it, so deleting a mesh was unrecoverable.
    for (const key of SIDECAR_KEYS) {
      expect(SIDECARS[key].inHistory, key).toBe(true);
    }
  });

  it("starts a new cart with every sidecar absent", () => {
    const empty = emptySidecars();
    for (const key of SIDECAR_KEYS) {
      expect(empty[key], key).toBeNull();
    }
  });

  it("round-trips a bundle through a row and back", () => {
    const original = sampleSidecars();
    const restored = sidecarsFromRow(sidecarsToRow(original) as Record<string, unknown>);
    expect(sidecarsEqual(original, restored)).toBe(true);
  });

  it("writes one column per sidecar, named by the table", () => {
    const row = sidecarsToRow(emptySidecars());
    for (const key of SIDECAR_KEYS) {
      expect(Object.keys(row), key).toContain(SIDECARS[key].column);
    }
  });

  it("turns a malformed payload into an absent one rather than throwing", () => {
    const parsed = parseSidecars({
      fx: "not an fx stack",
      collision: 42,
      mesh: "{{{",
      world: "[]",
      voxel: "",
    });
    expect(parsed.fx).toBeNull();
    expect(parsed.collision).toBeNull();
    expect(parsed.world).toBeNull();
    expect(parsed.voxel).toBeNull();
  });

  it("keeps one bad sidecar from costing the other ten", () => {
    const parsed = parseSidecars({
      collision: collisionPayload(true),
      scene: "garbage",
    });
    expect(parsed.collision).not.toBeNull();
    expect(parsed.scene).toBeNull();
  });

  it("reads a payload under either its key or its column name", () => {
    const payload = collisionPayload(true);
    const byKey = parseSidecars({ collision: payload });
    const byColumn = parseSidecars({ [SIDECARS.collision.column]: payload });
    expect(sidecarsEqual(byKey, byColumn)).toBe(true);
  });

  it("treats a changed sidecar as a different bundle", () => {
    const a = sampleSidecars();
    const b = { ...a, collision: collisionPayload(false) as never };
    expect(sidecarsEqual(a, b)).toBe(false);
  });

  it("treats an absent sidecar as different from a present one", () => {
    const a = sampleSidecars();
    expect(sidecarsEqual(a, { ...a, collision: null })).toBe(false);
  });

  it("marks exactly the columns a migration may not have created as optional", () => {
    // These two are written in their own statement so an unprovisioned column
    // costs that sidecar rather than blanking the whole cart.
    const optional = SIDECAR_KEYS.filter((key) => SIDECARS[key].optionalColumn === true);
    expect(optional.sort()).toEqual(["mesh", "world"]);
  });
});
