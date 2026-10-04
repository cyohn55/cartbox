/**
 * Transform gizmos and snapping (ENGINE_PARITY_ROADMAP.md EP2): the handles'
 * placement and hit tests, move / rotate / scale drags measured from where they
 * started, snapping, local vs world axes, children under rotated parents, and
 * the triangle ray casts behind picking and "drop to surface".
 */

import { describe, expect, it } from "vitest";

import { composeModelMatrix, multiplyMat4, type MeshAsset } from "@cartbox/editor";

import {
  axisParameter,
  axisTip,
  dragMove,
  dragRotate,
  dragScale,
  gizmoFrame,
  hitHandle,
  localPositionFor,
  planeHit,
  rotatedTransform,
  type GizmoFrame,
  type Ray,
  type Vec3,
} from "@/lib/gizmo";
import { dropDistance, raycastMeshes, rayTriangle } from "@/lib/meshRaycast";
import { cameraLookingAt, cameraMatrices, viewportRay } from "@/lib/viewportCamera";

const close = (a: readonly number[], b: readonly number[], digits = 5) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i]!, digits));
const IDENTITY = composeModelMatrix([0, 0, 0], [0, 0, 0], [1, 1, 1]);
const ray = (origin: Vec3, dir: Vec3): Ray => {
  const l = Math.hypot(...dir);
  return { origin, dir: [dir[0] / l, dir[1] / l, dir[2] / l] };
};
const steps = { move: 0.5, rotate: 15, scale: 0.25 };

/** A unit cube centred at the origin. */
function cube(): MeshAsset {
  const p = [-1, -1, -1, 1, -1, -1, 1, 1, -1, -1, 1, -1, -1, -1, 1, 1, -1, 1, 1, 1, 1, -1, 1, 1].map((v) => v / 2);
  const idx = [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 3, 7, 6, 3, 6, 2, 0, 4, 7, 0, 7, 3, 1, 2, 6, 1, 6, 5];
  return { name: "cube", primitives: [{ positions: Float32Array.from(p), normals: null, uvs: null, indices: Uint32Array.from(idx), material: { name: "m", baseColorFactor: [1, 1, 1, 1], baseColorImage: null } }] };
}

describe("gizmo frame and handles", () => {
  it("stands at the object's origin on world axes, or its own normalised axes (always its own for scale)", () => {
    const world = composeModelMatrix([1, 2, 3], [0, 90, 0], [2, 2, 2]);
    const w = gizmoFrame(world, "move", "world", 1.5);
    close(w.origin, [1, 2, 3]);
    close(w.axes[0], [1, 0, 0]);
    const l = gizmoFrame(world, "move", "local", 1.5);
    close(l.axes[0], [0, 0, -1]); // +X turned 90° about Y
    close(gizmoFrame(world, "scale", "world", 1).axes[0], [0, 0, -1]);
    close(axisTip(w, 1), [1, 3.5, 3]);
  });

  it("finds the handle under the cursor: centre, plane squares, then the nearest arm or ring", () => {
    const camera = cameraLookingAt([0, 0, 0], 0.7, 0.5, 6);
    const { viewProj } = cameraMatrices(camera, 1, 0.05, 100);
    const project = (p: Vec3): [number, number] | null => {
      const w = viewProj[3]! * p[0] + viewProj[7]! * p[1] + viewProj[11]! * p[2] + viewProj[15]!;
      if (w <= 0) return null;
      return [((viewProj[0]! * p[0] + viewProj[4]! * p[1] + viewProj[8]! * p[2] + viewProj[12]!) / w * 0.5 + 0.5) * 400, (1 - ((viewProj[1]! * p[0] + viewProj[5]! * p[1] + viewProj[9]! * p[2] + viewProj[13]!) / w * 0.5 + 0.5)) * 400];
    };
    const frame = gizmoFrame(IDENTITY, "move", "world", 1);
    expect(hitHandle("move", frame, project, project([0, 0, 0])!)).toEqual({ kind: "center" });
    expect(hitHandle("move", frame, project, project([0.7, 0, 0])!)).toEqual({ kind: "axis", axis: 0 });
    expect(hitHandle("move", frame, project, project([0, 0.8, 0])!)).toEqual({ kind: "axis", axis: 1 });
    expect(hitHandle("move", frame, project, project([0.32, 0.32, 0])!)).toEqual({ kind: "plane", axis: 2 }); // the XY square
    expect(hitHandle("move", frame, project, [5, 5])).toBeNull();
    expect(hitHandle("scale", frame, project, project([0.32, 0.32, 0])!)).toBeNull(); // no planes on scale
    const ring = gizmoFrame(IDENTITY, "rotate", "world", 1);
    expect(hitHandle("rotate", ring, project, project([0, 0.95, 0])!)).toMatchObject({ kind: "ring" });
    expect(hitHandle("rotate", ring, project, project([0, 0.95 * Math.SQRT1_2, 0.95 * Math.SQRT1_2])!)).toEqual({ kind: "ring", axis: 0 });
  });
});

describe("drag maths", () => {
  const frame: GizmoFrame = gizmoFrame(IDENTITY, "move", "world", 1);

  it("finds where a ray passes an axis, and where it meets a plane", () => {
    expect(axisParameter(ray([3, 1, 5], [0, 0, -1]), [0, 0, 0], [1, 0, 0])).toBeCloseTo(3, 9);
    expect(axisParameter(ray([0, 0, 5], [1, 0, 0]), [0, 0, 0], [1, 0, 0])).toBeNull(); // along the axis
    close(planeHit(ray([1, 5, 2], [0, -1, 0]), [0, 0, 0], [0, 1, 0])!, [1, 0, 2]);
  });

  it("moves along one axis, a plane, or the camera-facing plane, by how far the cursor went", () => {
    const r0 = ray([0.5, 1, 5], [0, 0, -1]);
    const r1 = ray([2.5, 1, 5], [0, 0, -1]);
    close(dragMove({ kind: "axis", axis: 0 }, frame, [0, 0, 0], r0, r1, [0, 0, -1], null, "world"), [2, 0, 0]);
    const p0 = ray([1, 5, 1], [0, -1, 0]);
    const p1 = ray([2, 5, -1], [0, -1, 0]);
    close(dragMove({ kind: "plane", axis: 1 }, frame, [0, 0, 0], p0, p1, [0, -1, 0], null, "world"), [1, 0, -2]);
    close(dragMove({ kind: "center" }, frame, [0, 0, 0], r0, ray([1.5, 2, 5], [0, 0, -1]), [0, 0, -1], null, "world"), [1, 1, 0]);
  });

  it("snaps the moved coordinates to the grid in world space, and the distance along the axis in local space", () => {
    const r0 = ray([0.3, 1, 5], [0, 0, -1]);
    const r1 = ray([1.4, 1, 5], [0, 0, -1]);
    // From x = 0.2, moved 1.1: lands on 1.5 (the nearest half step); y and z stay put.
    close(dragMove({ kind: "axis", axis: 0 }, frame, [0.2, 0.3, 0.7], r0, r1, [0, 0, -1], steps, "world"), [1.5, 0.3, 0.7]);
    // Local: the 1.1 moved becomes 1.0, from wherever it started.
    close(dragMove({ kind: "axis", axis: 0 }, frame, [0.2, 0.3, 0.7], r0, r1, [0, 0, -1], steps, "local"), [1.2, 0.3, 0.7]);
  });

  it("turns by the angle swept around a ring, snapped to the angle step", () => {
    const ring = gizmoFrame(IDENTITY, "rotate", "world", 1);
    const r0 = ray([1, 5, 0], [0, -1, 0]);
    const r1 = ray([Math.cos(0.5), 5, -Math.sin(0.5)], [0, -1, 0]);
    // From +X toward −Z is a positive (right-handed) turn about +Y.
    expect(dragRotate({ kind: "ring", axis: 1 }, ring, r0, r1, null)).toBeCloseTo(0.5, 6);
    expect(dragRotate({ kind: "ring", axis: 1 }, ring, r0, r1, steps)).toBeCloseTo((30 * Math.PI) / 180, 9);
  });

  it("scales an arm by how far along it the cursor went, and all three from the centre by screen distance, snapping the result", () => {
    const r0 = ray([0.5, 0, 5], [0, 0, -1]);
    const r1 = ray([1, 0, 5], [0, 0, -1]);
    const screen = { origin: [100, 100] as const, cursor0: [100, 100] as const, cursor: [100, 100] as const };
    close(dragScale({ kind: "axis", axis: 0 }, frame, [1, 2, 3], r0, r1, screen, null), [2, 2, 3]);
    close(dragScale({ kind: "center" }, frame, [1, 2, 3], r0, r0, { origin: [100, 100], cursor0: [120, 100], cursor: [130, 100] }, null), [1.5, 3, 4.5]);
    close(dragScale({ kind: "axis", axis: 0 }, frame, [1, 2, 3], r0, ray([0.68, 0, 5], [0, 0, -1]), screen, steps), [1.25, 2, 3]);
    // Never to nothing.
    expect(dragScale({ kind: "axis", axis: 0 }, frame, [1, 1, 1], r0, ray([0, 0, 5], [0, 0, -1]), screen, null)[0]).toBeGreaterThan(0);
  });
});

describe("applying a drag to a transform", () => {
  it("places a child at a world position through its parent", () => {
    const parent = composeModelMatrix([10, 0, 0], [0, 90, 0], [2, 2, 2]);
    const local = localPositionFor([10, 0, -4], parent);
    const world = multiplyMat4(parent, composeModelMatrix(local, [0, 0, 0], [1, 1, 1]));
    close([world[12]!, world[13]!, world[14]!], [10, 0, -4]);
  });

  it("turns an object about a world axis through its own origin, keeping its position and scale", () => {
    const start = { position: [1, 2, 3] as const, rotation: [0, 0, 0] as const, scale: [1, 2, 1] as const };
    const turned = rotatedTransform(start, null, [0, 1, 0], Math.PI / 2);
    close(turned.rotation, [0, 90, 0]);
    expect(turned.position).toEqual(start.position);
    expect(turned.scale).toEqual(start.scale);
    // Under a parent turned 90° about Y, a world turn about X is a local turn about Z.
    const parent = composeModelMatrix([0, 0, 0], [0, 90, 0], [1, 1, 1]);
    const child = rotatedTransform({ position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }, parent, [1, 0, 0], Math.PI / 2);
    const world = multiplyMat4(parent, composeModelMatrix([0, 0, 0], child.rotation, [1, 1, 1]));
    // The child's +Y now points where a world +X turn sends it: +Z.
    close([world[4]!, world[5]!, world[6]!], [0, 0, 1]);
  });
});

describe("ray casts", () => {
  it("hits triangles from either side and misses beside them", () => {
    expect(rayTriangle(ray([0.2, 0.2, 5], [0, 0, -1]), [0, 0, 0], [1, 0, 0], [0, 1, 0])).toBeCloseTo(5, 9);
    expect(rayTriangle(ray([0.2, 0.2, -5], [0, 0, 1]), [0, 0, 0], [1, 0, 0], [0, 1, 0])).toBeCloseTo(5, 9);
    expect(rayTriangle(ray([0.8, 0.8, 5], [0, 0, -1]), [0, 0, 0], [1, 0, 0], [0, 1, 0])).toBeNull();
  });

  it("picks the mesh actually under the cursor, not the nearest bounding box", () => {
    // A big hollow frame (four thin bars around an empty middle) with a small cube inside it.
    const bar = (x: number, y: number, sx: number, sy: number) => composeModelMatrix([x, y, 0], [0, 0, 0], [sx, sy, 1]);
    const targets = [
      { key: "top", mesh: cube(), model: bar(0, 4, 9, 1) },
      { key: "bottom", mesh: cube(), model: bar(0, -4, 9, 1) },
      { key: "small", mesh: cube(), model: composeModelMatrix([0, 0, -1], [0, 0, 0], [1, 1, 1]) },
    ];
    const camera = cameraLookingAt([0, 0, 0], 0, 0, 10);
    expect(raycastMeshes(viewportRay(camera, 1, 0, 0), targets)?.key).toBe("small");
    expect(raycastMeshes(viewportRay(camera, 1, 0, 0), targets, new Set(["small"]))).toBeNull();
    const hit = raycastMeshes(ray([0, 4, 10], [0, 0, -1]), targets)!;
    expect(hit.key).toBe("top");
    close(hit.point, [0, 4, 0.5]);
  });

  it("drops an object onto the mesh beneath it, onto the terrain, or onto the ground", () => {
    const table = { key: "table", mesh: cube(), model: composeModelMatrix([0, 1, 0], [0, 0, 0], [4, 1, 4]) }; // top at y = 1.5
    const box = { min: [-0.5, 5, -0.5] as Vec3, max: [0.5, 6, 0.5] as Vec3 };
    expect(dropDistance(box, [table], new Set())).toBeCloseTo(-3.5, 6);
    // Nothing below but the ground at y = 0, or a terrain at y = 2.
    const aside = { min: [9.5, 5, -0.5] as Vec3, max: [10.5, 6, 0.5] as Vec3 };
    expect(dropDistance(aside, [table], new Set())).toBeCloseTo(-5, 6);
    expect(dropDistance(aside, [table], new Set(), () => 2)).toBeCloseTo(-3, 6);
    // The object itself is no surface.
    expect(dropDistance(box, [{ ...table, key: "self" }], new Set(["self"]))).toBeCloseTo(-5, 6);
  });
});
