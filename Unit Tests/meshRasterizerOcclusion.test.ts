/**
 * Phase 5 — occlusion culling (pure).
 *
 * Against a depth pre-pass (view-space eye distance, +Infinity = background), an
 * instance is dropped only when every pixel of its screen footprint holds a
 * nearer surface. These pin that: hidden behind a near wall → culled; in front of
 * it → kept; over background → kept (conservative).
 */

import { describe, expect, it } from "vitest";

import {
  aabbOccluded,
  composeModelMatrix,
  occlusionCull,
  projectionMatrix,
  viewMatrix,
  type Mat4,
  type MeshAsset,
  type MeshSceneInstance,
  type OcclusionInput,
} from "@cartbox/editor";

/** A unit cube centred at the origin. */
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
  return { name: "cube", primitives: [{ positions: Float32Array.from(p), normals: Float32Array.from(n), uvs: new Float32Array((p.length / 3) * 2), indices: Uint32Array.from(idx), material: { name: "m", baseColorFactor: [1, 1, 1, 1], baseColorImage: null } }] };
}

const S = 32;
const VIEW: Mat4 = viewMatrix([0, 0, 10], [0, 0, 0]);
const PROJ: Mat4 = projectionMatrix((50 * Math.PI) / 180, 1, 0.1, 100);
const at = (z: number): Mat4 => composeModelMatrix([0, 0, z], [0, 0, 0], [1, 1, 1]);

/** A depth buffer with a uniform near "wall" at eye distance `d` (Infinity = empty). */
function wall(d: number): OcclusionInput {
  const depth = new Float32Array(S * S).fill(d);
  return { view: VIEW, projection: PROJ, depth, width: S, height: S };
}

describe("aabbOccluded", () => {
  it("culls an instance entirely behind a nearer wall", () => {
    // Cube at the origin is ~10 units away; a wall at 2 hides it everywhere.
    expect(aabbOccluded({ mesh: cube(), model: at(0) }, wall(2))).toBe(true);
  });

  it("keeps an instance in front of the wall", () => {
    // Cube at z=9 is ~1 unit away — nearer than the wall at 2, so visible.
    expect(aabbOccluded({ mesh: cube(), model: at(9) }, wall(2))).toBe(false);
  });

  it("keeps an instance over background (nothing occludes it)", () => {
    const empty: OcclusionInput = { view: VIEW, projection: PROJ, depth: new Float32Array(S * S).fill(Infinity), width: S, height: S };
    expect(aabbOccluded({ mesh: cube(), model: at(0) }, empty)).toBe(false);
  });
});

describe("occlusionCull", () => {
  it("drops the hidden instance and keeps the visible one", () => {
    const hidden: MeshSceneInstance = { mesh: cube(), model: at(0) }; // far, behind the wall
    const visible: MeshSceneInstance = { mesh: cube(), model: at(9) }; // near, in front
    const kept = occlusionCull([hidden, visible], wall(2));
    expect(kept).toHaveLength(1);
    expect(kept[0]).toBe(visible);
  });

  it("returns the same array when nothing is occluded", () => {
    const list: MeshSceneInstance[] = [{ mesh: cube(), model: at(9) }];
    expect(occlusionCull(list, wall(2))).toBe(list);
  });
});
