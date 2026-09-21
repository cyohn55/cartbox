/**
 * Phase 5 — level-of-detail selection (pure).
 *
 * `applyLods` swaps each LOD-carrying instance's mesh for the level its camera
 * distance selects; instances without a chain pass through. These pin the level
 * math, the camera-position recovery from the view matrix, and the end-to-end
 * swap.
 */

import { describe, expect, it } from "vitest";

import {
  applyLods,
  cameraPositionFromView,
  composeModelMatrix,
  resolveLodMesh,
  selectLodIndex,
  viewMatrix,
  type MeshAsset,
  type MeshSceneInstance,
} from "@cartbox/editor";

/** A named 1-triangle mesh, so which LOD was chosen is identifiable. */
function tri(name: string): MeshAsset {
  return {
    name,
    primitives: [
      {
        positions: Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0]),
        normals: Float32Array.from([0, 0, 1, 0, 0, 1, 0, 0, 1]),
        uvs: null,
        indices: Uint32Array.from([0, 1, 2]),
        material: { name: "m", baseColorFactor: [1, 1, 1, 1], baseColorImage: null },
      },
    ],
  };
}

describe("selectLodIndex", () => {
  it("picks the level by ascending switch points", () => {
    const d = [5, 15]; // 3 levels
    expect(selectLodIndex(d, 2)).toBe(0);
    expect(selectLodIndex(d, 5)).toBe(1); // at the switch point, step down
    expect(selectLodIndex(d, 10)).toBe(1);
    expect(selectLodIndex(d, 30)).toBe(2);
  });
});

describe("cameraPositionFromView", () => {
  it("recovers the eye from a look-at view", () => {
    const eye: [number, number, number] = [3, 4, 5];
    const p = cameraPositionFromView(viewMatrix(eye, [0, 0, 0]));
    expect(p[0]).toBeCloseTo(3, 5);
    expect(p[1]).toBeCloseTo(4, 5);
    expect(p[2]).toBeCloseTo(5, 5);
  });
});

describe("applyLods", () => {
  const hi = tri("hi");
  const chain = { meshes: [hi, tri("mid"), tri("lo")], distances: [5, 15] };
  const model = (x: number) => composeModelMatrix([x, 0, 0], [0, 0, 0], [1, 1, 1]);

  it("resolves the mesh for a distance", () => {
    const inst: MeshSceneInstance = { mesh: hi, model: model(0), lod: chain };
    expect(resolveLodMesh(inst, 2).name).toBe("hi");
    expect(resolveLodMesh(inst, 10).name).toBe("mid");
    expect(resolveLodMesh(inst, 40).name).toBe("lo");
  });

  it("swaps each instance's mesh by camera distance to its origin", () => {
    const near: MeshSceneInstance = { mesh: hi, model: model(0), lod: chain };
    const far: MeshSceneInstance = { mesh: hi, model: model(30), lod: chain };
    const out = applyLods([near, far], 0, 0, 0);
    expect(out[0]!.mesh.name).toBe("hi"); // distance 0
    expect(out[1]!.mesh.name).toBe("lo"); // distance 30
  });

  it("leaves instances without a chain untouched and returns the same array when unchanged", () => {
    const plain: MeshSceneInstance = { mesh: tri("base"), model: model(0) };
    const list = [plain];
    expect(applyLods(list, 0, 0, 0)).toBe(list);
    // An instance already at its selected level (mesh === level 0) is not rebuilt.
    const near: MeshSceneInstance = { mesh: hi, model: model(0), lod: chain };
    const out = applyLods([near], 0, 0, 0);
    expect(out[0]).toBe(near);
  });
});
