/**
 * Phase 6 — the pure material edit behind the material editor. `updateMeshMaterial`
 * patches one primitive's material and shares everything else by reference, so an
 * edit is cheap and never mutates the input. An out-of-range index is a no-op.
 */

import { describe, expect, it } from "vitest";

import { updateMeshMaterial, type MeshAsset } from "@cartbox/editor";

function twoPrim(): MeshAsset {
  const prim = (name: string) => ({
    positions: Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    normals: null,
    uvs: null,
    indices: Uint32Array.from([0, 1, 2]),
    material: { name, baseColorFactor: [1, 1, 1, 1] as [number, number, number, number], baseColorImage: null },
  });
  return { name: "m", primitives: [prim("a"), prim("b")] };
}

describe("updateMeshMaterial", () => {
  it("patches only the named fields of the target primitive's material", () => {
    const mesh = twoPrim();
    const next = updateMeshMaterial(mesh, 0, { baseColorFactor: [0.2, 0.4, 0.6, 1], metallicFactor: 0.5, roughnessFactor: 0.3 });

    const m = next.primitives[0]!.material;
    expect(m.baseColorFactor).toEqual([0.2, 0.4, 0.6, 1]);
    expect(m.metallicFactor).toBe(0.5);
    expect(m.roughnessFactor).toBe(0.3);
    expect(m.name).toBe("a"); // untouched field survives
    expect(m.baseColorImage).toBeNull();
  });

  it("does not mutate the input mesh", () => {
    const mesh = twoPrim();
    updateMeshMaterial(mesh, 0, { emissiveFactor: [1, 0, 0] });
    expect(mesh.primitives[0]!.material.emissiveFactor).toBeUndefined();
  });

  it("shares the other primitives by reference", () => {
    const mesh = twoPrim();
    const next = updateMeshMaterial(mesh, 0, { roughnessFactor: 0.9 });
    expect(next.primitives[1]).toBe(mesh.primitives[1]);
    expect(next).not.toBe(mesh);
  });

  it("returns the mesh unchanged for an out-of-range index", () => {
    const mesh = twoPrim();
    expect(updateMeshMaterial(mesh, 5, { roughnessFactor: 0.1 })).toBe(mesh);
    expect(updateMeshMaterial(mesh, -1, { roughnessFactor: 0.1 })).toBe(mesh);
  });
});
