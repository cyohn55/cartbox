/**
 * Shared sidecar-endpoint tests
 * (apps/web/src/lib/sidecarRoute.ts — the `resolveSidecarBody` half).
 *
 * Each of the eleven sidecar routes was its own ~70-line file doing the same
 * five things, differing only in a parser and a couple of error strings. They
 * are one-line delegates over a shared handler now, so the behaviour each of
 * them used to own individually is asserted here once — including the two
 * historical body shapes, because breaking either would silently stop a save.
 */

import { describe, expect, it } from "vitest";

import { CollisionMap } from "@cartbox/editor";
import { defaultPostFxSettings } from "@cartbox/player";

import { resolveSidecarBody } from "@/lib/sidecarRoute";
import { SIDECAR_KEYS } from "@/lib/sidecars";

function value<T>(result: { value: T } | { error: string }): T {
  if ("error" in result) throw new Error(`expected a value, got: ${result.error}`);
  return result.value;
}

function error(result: { value: unknown } | { error: string }): string {
  if (!("error" in result)) throw new Error("expected an error");
  return result.error;
}

describe("resolving a sidecar request body", () => {
  it("accepts the bare value, which most endpoints have always sent", () => {
    const fx = defaultPostFxSettings();
    expect(value(resolveSidecarBody("fx", fx))).toEqual(fx);
  });

  it("accepts the wrapped `{ key: value }` shape the opaque sidecars send", () => {
    const payload = JSON.stringify({ version: 1, meshes: [] });
    // Both shapes have to keep working: the editor sent one for some sidecars
    // and the other for the rest, and the verify scripts drive them directly.
    const bare = resolveSidecarBody("world", null);
    const wrapped = resolveSidecarBody("world", { world: null });
    expect(value(bare)).toBeNull();
    expect(value(wrapped)).toBeNull();
    // A well-formed payload the decoder empties clears the column; it is the
    // creator deleting their last mesh, not a malformed request.
    expect(value(resolveSidecarBody("mesh", { mesh: payload }))).toBeNull();
  });

  it("clears the column for an explicit null", () => {
    for (const key of SIDECAR_KEYS) {
      expect(value(resolveSidecarBody(key, null)), key).toBeNull();
    }
  });

  it("clears the column for an empty string, not just null", () => {
    expect(value(resolveSidecarBody("voxel", ""))).toBeNull();
    expect(value(resolveSidecarBody("world", { world: "" }))).toBeNull();
  });

  it("rejects a malformed payload rather than storing junk", () => {
    expect(error(resolveSidecarBody("fx", "not an fx stack"))).toBeTruthy();
    expect(error(resolveSidecarBody("collision", { nonsense: true }))).toBeTruthy();
  });

  it("keeps the wording each sidecar's own decision helper carries", () => {
    // These messages are what a creator reads on a 400; the helpers that own
    // them are unit-tested in their own right, so the registry defers to them.
    expect(error(resolveSidecarBody("scene", "garbage"))).toBe("Scene is malformed.");
    expect(error(resolveSidecarBody("anim", "garbage"))).toBe("Animation is malformed.");
    expect(error(resolveSidecarBody("collision", "garbage"))).toBe("Collision layer is malformed.");
  });

  it("names the sidecar in a message it has to generate itself", () => {
    expect(error(resolveSidecarBody("rig", { parts: "not an array" }))).toMatch(/character rig/i);
  });

  it("stores a valid payload for a sidecar with no helper of its own", () => {
    const collision = new CollisionMap(4, 4);
    collision.setSolid(0, 0, true);
    expect(value(resolveSidecarBody("collision", collision.serialize()))).toEqual(collision.serialize());
  });

  it("never throws, whatever arrives on the wire", () => {
    const hostile: unknown[] = [undefined, 0, false, [], "  ", { nested: { deep: true } }, Number.NaN];
    for (const key of SIDECAR_KEYS) {
      for (const body of hostile) {
        expect(() => resolveSidecarBody(key, body), `${key} / ${JSON.stringify(body) ?? "undefined"}`).not.toThrow();
      }
    }
  });
});
