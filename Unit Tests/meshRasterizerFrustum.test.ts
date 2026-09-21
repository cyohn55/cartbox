/**
 * Phase 5 — frustum culling (pure).
 *
 * A correct frustum cull only removes geometry that rasterises to nothing, so it
 * must be output-identical: rendering the culled set equals rendering the whole
 * set, just with the off-screen instances skipped. These pin the plane
 * extraction, the AABB test, and that end-to-end invariant.
 */

import { describe, expect, it } from "vitest";

import {
  aabbOutsideFrustum,
  composeModelMatrix,
  cullInstances,
  frustumPlanes,
  multiplyMat4,
  projectionMatrix,
  renderMeshScene,
  viewMatrix,
  worldAabb,
  type Mat4,
  type MeshAsset,
  type MeshSceneInstance,
} from "@cartbox/editor";

/** A unit cube centred at the origin (half-extent 0.5). */
function cube(): MeshAsset {
  const p: number[] = [];
  const n: number[] = [];
  const idx: number[] = [];
  const faces: [number[], number[]][] = [
    [[-0.5, -0.5, 0.5, 0.5, -0.5, 0.5, 0.5, 0.5, 0.5, -0.5, 0.5, 0.5], [0, 0, 1]],
    [[0.5, -0.5, -0.5, -0.5, -0.5, -0.5, -0.5, 0.5, -0.5, 0.5, 0.5, -0.5], [0, 0, -1]],
    [[-0.5, -0.5, -0.5, -0.5, -0.5, 0.5, -0.5, 0.5, 0.5, -0.5, 0.5, -0.5], [-1, 0, 0]],
    [[0.5, -0.5, 0.5, 0.5, -0.5, -0.5, 0.5, 0.5, -0.5, 0.5, 0.5, 0.5], [1, 0, 0]],
    [[-0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, -0.5, -0.5, 0.5, -0.5], [0, 1, 0]],
    [[-0.5, -0.5, -0.5, 0.5, -0.5, -0.5, 0.5, -0.5, 0.5, -0.5, -0.5, 0.5], [0, -1, 0]],
  ];
  let base = 0;
  for (const [verts, nrm] of faces) {
    for (let i = 0; i < 4; i += 1) {
      p.push(verts[i * 3]!, verts[i * 3 + 1]!, verts[i * 3 + 2]!);
      n.push(nrm[0]!, nrm[1]!, nrm[2]!);
    }
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    base += 4;
  }
  return { name: "cube", primitives: [{ positions: Float32Array.from(p), normals: Float32Array.from(n), uvs: new Float32Array((p.length / 3) * 2), indices: Uint32Array.from(idx), material: { name: "m", baseColorFactor: [0.8, 0.8, 0.8, 1], baseColorImage: null } }] };
}

const VIEW: Mat4 = viewMatrix([0, 0, 6], [0, 0, 0]);
const PROJ: Mat4 = projectionMatrix((50 * Math.PI) / 180, 1, 0.1, 100);
const at = (x: number, y: number, z: number): Mat4 => composeModelMatrix([x, y, z], [0, 0, 0], [1, 1, 1]);

describe("frustum plane extraction", () => {
  it("keeps a point at the origin inside all six planes", () => {
    const planes = frustumPlanes(multiplyMat4(PROJ, VIEW));
    expect(planes).toHaveLength(6);
    for (const [a, b, c, d] of planes) {
      expect(a * 0 + b * 0 + c * 0 + d).toBeGreaterThan(0); // origin is in front of every plane
    }
  });
});

describe("aabbOutsideFrustum + worldAabb", () => {
  it("keeps a box in view and rejects one far to the side or behind", () => {
    const planes = frustumPlanes(multiplyMat4(PROJ, VIEW));
    const boxAt = (m: Mat4) => worldAabb(cube(), m)!;
    expect(aabbOutsideFrustum(planes, boxAt(at(0, 0, 0)).min, boxAt(at(0, 0, 0)).max)).toBe(false); // centred
    expect(aabbOutsideFrustum(planes, boxAt(at(100, 0, 0)).min, boxAt(at(100, 0, 0)).max)).toBe(true); // far right
    expect(aabbOutsideFrustum(planes, boxAt(at(0, 0, 60)).min, boxAt(at(0, 0, 60)).max)).toBe(true); // behind camera
  });

  it("transforms the mesh AABB by the model matrix", () => {
    const box = worldAabb(cube(), at(10, 0, 0))!;
    expect(box.min[0]).toBeCloseTo(9.5, 6);
    expect(box.max[0]).toBeCloseTo(10.5, 6);
  });
});

describe("cullInstances", () => {
  const scene = (): MeshSceneInstance[] => [
    { mesh: cube(), model: at(0, 0, 0) }, // in view
    { mesh: cube(), model: at(100, 0, 0) }, // far right, off-screen
    { mesh: cube(), model: at(0, 0, 60) }, // behind
  ];

  it("drops the off-screen instances, keeps the visible one", () => {
    const s = scene();
    const kept = cullInstances(s, VIEW, PROJ);
    expect(kept).toHaveLength(1);
    expect(kept[0]).toBe(s[0]); // the in-view instance, by identity
  });

  it("returns the same array when nothing is culled (no allocation)", () => {
    const allVisible: MeshSceneInstance[] = [{ mesh: cube(), model: at(0, 0, 0) }, { mesh: cube(), model: at(1.2, 0, 0) }];
    expect(cullInstances(allVisible, VIEW, PROJ)).toBe(allVisible);
  });

  it("is output-identical: rendering the culled set matches the full set", () => {
    const S = 40;
    const render = (instances: readonly MeshSceneInstance[]): Uint8ClampedArray => {
      const out = new Uint8ClampedArray(S * S * 4);
      const depth = new Float32Array(S * S);
      renderMeshScene(instances, { width: S, height: S, out, depth, view: VIEW, projection: PROJ, background: [0, 0, 0, 255] });
      return out;
    };
    const full = render(scene());
    const culled = render(cullInstances(scene(), VIEW, PROJ));
    expect(Array.from(culled)).toEqual(Array.from(full)); // the dropped instances contributed nothing
  });
});
