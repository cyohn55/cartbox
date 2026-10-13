/**
 * Splines (EDITOR_PRO_ROADMAP.md P3): the curve, a river's carve and its
 * flowing water, a path, a mesh bent along a spline, storage, and applying
 * them on the sidecar. (The river's water is checked against the GPU by
 * webgl-parity.test.ts and, on a real device, webgpu-parity.test.ts.)
 */

import { describe, expect, it } from "vitest";
import {
  carveRiver,
  layPath,
  nearestOnSpline,
  newTerrain,
  readSplines,
  riverFoam,
  riverFoamMaterial,
  riverProfile,
  riverSurface,
  riverWaterMaterial,
  sampleSpline,
  splineMesh,
  terrainHeight,
  waterTilt,
  waterTiltAlong,
  type MeshAsset,
  type Spline,
  type Terrain,
} from "@cartbox/editor";

import { addMesh, decodeMeshSidecar, emptyMeshSidecar, encodeMeshSidecar, readMeshEntry, type MeshSidecar } from "@/lib/meshSidecar";
import { SPLINE_PROP, addSpline, addSplinePoint, applySpline, findSpline, removeSpline, replaceSpline, splineOverlays } from "@/lib/splineEdit";
import { addTerrain, findTerrain, replaceTerrain } from "@/lib/terrainEdit";

const S: Spline = {
  id: "s",
  name: "S",
  kind: "river",
  points: [
    { p: [-20, 0, -10], width: 4 },
    { p: [-5, 0, 6], width: 4 },
    { p: [5, 0, -6], width: 6 },
    { p: [20, 0, 10], width: 6 },
  ],
};

const straight = (kind: Spline["kind"] = "river", y = 0): Spline => ({
  id: "line",
  name: "Line",
  kind,
  points: [
    { p: [-20, y, 0], width: 4 },
    { p: [20, y, 0], width: 4 },
  ],
});

/** A flat 64 m terrain, 65 heights a side, centred on the origin, hard layer edges. */
function flat(height = 0): Terrain {
  const t = newTerrain("t", { size: 64, samples: 65 });
  const { blend: _blend, ...rest } = t;
  void _blend;
  return { ...rest, heights: new Float32Array(65 * 65).fill(height) };
}

const groundAt = (t: Terrain, x: number, z: number) => t.origin[1] + (terrainHeight({ ...t, holes: undefined }, x, z) ?? NaN);

describe("the spline curve", () => {
  it("runs through every point, sampled evenly by length, its frame horizontal and unit", () => {
    const samples = sampleSpline(S, 0.5);
    expect(samples[0]!.p).toEqual([-20, 0, -10]);
    expect(samples.at(-1)!.p[0]).toBeCloseTo(20, 6);
    expect(samples.at(-1)!.p[2]).toBeCloseTo(10, 6);
    // Through the inner points too.
    for (const { p } of S.points.slice(1, 3)) expect(Math.min(...samples.map((s) => Math.hypot(s.p[0] - p[0], s.p[2] - p[2])))).toBeLessThan(0.3);
    for (let i = 1; i < samples.length; i += 1) {
      const d = Math.hypot(samples[i]!.p[0] - samples[i - 1]!.p[0], samples[i]!.p[2] - samples[i - 1]!.p[2]);
      expect(d).toBeGreaterThan(0.35);
      expect(d).toBeLessThan(0.65);
      expect(Math.hypot(...samples[i]!.tangent)).toBeCloseTo(1, 6);
      expect(samples[i]!.tangent[1]).toBe(0);
      // Neighbouring frames turn only a little (no cusps).
      const dot = samples[i]!.tangent[0] * samples[i - 1]!.tangent[0] + samples[i]!.tangent[2] * samples[i - 1]!.tangent[2];
      expect(dot).toBeGreaterThan(0.95);
    }
    // Widths ease from 4 to 6.
    expect(samples[0]!.width).toBe(4);
    expect(samples.at(-1)!.width).toBe(6);
    expect(sampleSpline({ points: [S.points[0]!] })).toEqual([]);
  });

  it("finds the nearest point: how far along, how far to the side, its height and width", () => {
    const samples = sampleSpline(straight("river", 2), 0.5);
    const near = nearestOnSpline(samples, 5, 3)!;
    expect(near.s).toBeCloseTo(25, 4);
    expect(Math.abs(near.side)).toBeCloseTo(3, 6);
    expect(near.y).toBeCloseTo(2, 6);
    expect(near.width).toBeCloseTo(4, 6);
    expect(Math.sign(nearestOnSpline(samples, 5, -3)!.side)).toBe(-Math.sign(near.side));
  });
});

describe("rivers", () => {
  it("carve a flat bed, banks rising to the water's edge, and ease back to the ground", () => {
    const t = flat(0.5);
    const river: Spline = { ...straight("river", 0), depth: 1.2, bank: 3 };
    const carved = carveRiver(t, river);
    expect(groundAt(carved, 0, 0)).toBeCloseTo(-1.2, 4); // the bed
    expect(groundAt(carved, 0, 1.5)).toBeCloseTo(riverProfile(1.5, 4, 1.2), 1);
    expect(groundAt(carved, 0, 2)).toBeCloseTo(0.05, 2); // the water's edge
    expect(groundAt(carved, 0, 3.5)).toBeGreaterThan(0.05);
    expect(groundAt(carved, 0, 3.5)).toBeLessThan(0.5);
    expect(groundAt(carved, 0, 8)).toBeCloseTo(0.5, 6); // beyond the banks, untouched
    // Low ground beside the water is built up into a bank that holds it.
    expect(groundAt(carveRiver(flat(-2), river), 0, 2)).toBeCloseTo(0.05, 2);
  });

  it("paint wet banks with a layer when given one", () => {
    const t = flat(0.5);
    const carved = carveRiver(t, { ...straight(), layer: 2 });
    const n = t.samples;
    const k = (x: number, z: number) => (Math.round(z - t.origin[2]) * n + Math.round(x - t.origin[0])) * t.layers.length;
    expect(carved.paint![k(0, 2) + 2]).toBeGreaterThan(200);
    expect(carved.paint![k(0, 12) + 2]).toBe(0);
  });

  it("lay a water surface whose UVs are metres across and along, facing up, and foam at both edges", () => {
    const surface = riverSurface(S, riverWaterMaterial())!;
    expect(surface.material.water?.along).toBe(true);
    const total = sampleSpline(S, 0.5).at(-1)!.s;
    const vs = Array.from({ length: surface.uvs!.length / 2 }, (_, i) => surface.uvs![i * 2 + 1]!);
    expect(Math.max(...vs)).toBeCloseTo(total, 4);
    const us = Array.from({ length: surface.uvs!.length / 2 }, (_, i) => surface.uvs![i * 2]!);
    expect(Math.min(...us)).toBeCloseTo(-(6 / 2 + 0.25), 4); // the widest point, plus the overlap under the banks
    // Every triangle faces up (counter-clockwise seen from above).
    const P = surface.positions;
    for (let i = 0; i < surface.indices.length; i += 3) {
      const [a, b, c] = [surface.indices[i]!, surface.indices[i + 1]!, surface.indices[i + 2]!];
      const ux = P[b * 3]! - P[a * 3]!, uz = P[b * 3 + 2]! - P[a * 3 + 2]!;
      const vx = P[c * 3]! - P[a * 3]!, vz = P[c * 3 + 2]! - P[a * 3 + 2]!;
      expect(uz * vx - ux * vz).toBeGreaterThan(-1e-9);
    }
    const foam = riverFoam(S, riverFoamMaterial())!;
    expect(foam.uvs!.every((u, i) => i % 2 === 1 || (u >= -1e-9 && u <= 1 + 1e-9))).toBe(true);
    expect(foam.material.baseColorImage).not.toBeNull();
  });

  it("flow their ripples along their course: the along-UV tilt is the world tilt turned by the UV gradients", () => {
    const uniform: [number, number, number, number] = [0.6, 2, 0.3, Math.PI / 2];
    for (const [u, v] of [[0.3, 4.1], [-1.2, 9.7], [2.5, 0.4]] as const) {
      const [tx, tz] = waterTilt(uniform, u, v);
      // UVs laid along the world's axes: the same tilt.
      const a = waterTiltAlong(uniform, u, v, [1, 0, 0], [0, 0, 1]);
      expect(a[0]).toBeCloseTo(tx, 9);
      expect(a[2]).toBeCloseTo(tz, 9);
      // A river running along +X instead of +Z: the same ripples, turned a quarter.
      const b = waterTiltAlong(uniform, u, v, [0, 0, 2], [-3, 0, 0]);
      expect(b[2]).toBeCloseTo(tx, 9);
      expect(b[0]).toBeCloseTo(-tz, 9);
    }
    expect(waterTiltAlong(uniform, 1, 1, [0, 0, 0], [0, 0, 1])).toEqual([0, 0, 0]);
  });
});

describe("paths and walls", () => {
  it("level a path's tread to the spline's height, ease its shoulders, and paint it", () => {
    const t = flat(0);
    const path: Spline = { ...straight("path", 1.5), bank: 2, layer: 2 };
    const laid = layPath(t, path);
    expect(groundAt(laid, 0, 0)).toBeCloseTo(1.5, 6);
    expect(groundAt(laid, 0, 1.9)).toBeCloseTo(1.5, 1);
    expect(groundAt(laid, 0, 3)).toBeGreaterThan(0);
    expect(groundAt(laid, 0, 3)).toBeLessThan(1.5);
    expect(groundAt(laid, 0, 10)).toBe(0);
    const n = t.samples;
    expect(laid.paint![(Math.round(0 - t.origin[2]) * n + Math.round(0 - t.origin[0])) * t.layers.length + 2]).toBe(255);
  });

  it("bend a mesh along a wall, a whole number of copies spanning it exactly", () => {
    const block: MeshAsset = {
      name: "block",
      primitives: [
        {
          positions: Float32Array.from([0, 0, -0.5, 2, 0, -0.5, 2, 1, -0.5, 0, 1, 0.5]),
          normals: Float32Array.from([0, 0, -1, 0, 0, -1, 0, 0, -1, 0, 0, 1]),
          uvs: null,
          indices: Uint32Array.from([0, 1, 2, 0, 2, 3]),
          material: { name: "stone", baseColorFactor: [1, 1, 1, 1], baseColorImage: null },
        },
      ],
    };
    const bent = splineMesh({ ...straight("wall"), points: [{ p: [0, 0, 0], width: 1 }, { p: [9, 0, 0], width: 1 }] }, block)!;
    const p = bent.primitives[0]!;
    // 9 m of 2 m blocks: 4 or 5 copies, each stretched to fit.
    const copies = p.positions.length / block.primitives[0]!.positions.length;
    expect([4, 5]).toContain(copies);
    const xs = Array.from({ length: p.positions.length / 3 }, (_, i) => p.positions[i * 3]!);
    expect(Math.min(...xs)).toBeCloseTo(0, 6);
    expect(Math.max(...xs)).toBeCloseTo(9, 4);
    // The block's -Z face now faces sideways, still unit.
    expect(Math.hypot(p.normals![0]!, p.normals![1]!, p.normals![2]!)).toBeCloseTo(1, 6);
    expect(Math.abs(p.normals![2]!)).toBeCloseTo(1, 6);
  });
});

describe("splines on the sidecar", () => {
  it("are stored with the cart and read back defensively", () => {
    const sidecar = replaceSpline(addSpline(emptyMeshSidecar(), "river").sidecar, { ...S, id: "river-1", depth: 2 });
    const back = decodeMeshSidecar(encodeMeshSidecar(sidecar));
    expect(back.splines).toEqual([{ ...S, id: "river-1", depth: 2 }]);
    expect(readSplines([{ id: "a", kind: "lake", points: [] }, { id: "b", kind: "path", points: [{ p: [0, 0], width: 1 }, { p: [1, 2, 3], width: 900 }] }, { id: "b", kind: "path", points: [] }])).toEqual([
      { id: "b", name: "path", kind: "path", points: [{ p: [1, 2, 3], width: 200 }] },
    ]);
  });

  it("place points on the ground, growing whichever end is nearer", () => {
    let sidecar: MeshSidecar = addTerrain(emptyMeshSidecar(), { size: 64, samples: 65 }).sidecar;
    const terrain = sidecar.terrains![0]!.id;
    const made = addSpline(sidecar, "path");
    sidecar = made.sidecar;
    expect(findSpline(sidecar, made.id)!.terrain).toBe(terrain);
    // Terrain space: the grid's corner is (−32, −32).
    sidecar = addSplinePoint(sidecar, made.id, terrain, 32, 32);
    sidecar = addSplinePoint(sidecar, made.id, terrain, 42, 32);
    sidecar = addSplinePoint(sidecar, made.id, terrain, 22, 32);
    expect(findSpline(sidecar, made.id)!.points.map((p) => p.p[0])).toEqual([-10, 0, 10]);
    expect(splineOverlays(sidecar)[0]!.points).toHaveLength(3);
  });

  it("apply a river: the terrain carved, its water and foam one object, replaced when applied again, gone with the spline", () => {
    let sidecar: MeshSidecar = addTerrain(emptyMeshSidecar(), { size: 64, samples: 65 }).sidecar;
    const terrain = sidecar.terrains![0]!.id;
    sidecar = replaceTerrain(sidecar, { ...findTerrain(sidecar, terrain)!, heights: new Float32Array(65 * 65).fill(1) });
    const made = addSpline(sidecar, "river");
    sidecar = replaceSpline(made.sidecar, { ...straight("river", 0.5), id: made.id, name: "Creek", terrain });
    expect("problem" in applySpline(addSpline(sidecar, "river").sidecar, "river-2")).toBe(true); // no points yet
    const once = applySpline(sidecar, made.id);
    if ("problem" in once) throw new Error(once.problem);
    const water = once.sidecar.meshes.filter((m) => m.props?.[SPLINE_PROP] === made.id);
    expect(water).toHaveLength(1);
    expect(readMeshEntry(water[0]!).primitives.map((p) => p.material.name)).toEqual(["river-water", "river-foam"]);
    expect(groundAt(findTerrain(once.sidecar, terrain)!, 0, 0)).toBeCloseTo(-0.5, 4);
    const twice = applySpline(once.sidecar, made.id);
    if ("problem" in twice) throw new Error(twice.problem);
    expect(twice.sidecar.meshes.filter((m) => m.props?.[SPLINE_PROP] === made.id)).toHaveLength(1);
    const gone = removeSpline(twice.sidecar, made.id);
    expect(gone.meshes.some((m) => m.props?.[SPLINE_PROP] === made.id)).toBe(false);
    expect(gone.splines).toBeUndefined();
  });

  it("apply a wall once it has an object to bend", () => {
    const block: MeshAsset = {
      name: "block",
      primitives: [{ positions: Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0]), normals: null, uvs: null, indices: Uint32Array.from([0, 1, 2]), material: { name: "m", baseColorFactor: [1, 1, 1, 1], baseColorImage: null } }],
    };
    const placed = addMesh(emptyMeshSidecar(), block, "Block");
    const made = addSpline(placed.sidecar, "wall");
    let sidecar = replaceSpline(made.sidecar, { ...straight("wall"), id: made.id, name: "Fence" });
    expect(applySpline(sidecar, made.id)).toEqual({ problem: "Pick the object to bend along it." });
    sidecar = replaceSpline(sidecar, { ...findSpline(sidecar, made.id)!, mesh: placed.id });
    const applied = applySpline(sidecar, made.id);
    if ("problem" in applied) throw new Error(applied.problem);
    expect(applied.sidecar.meshes.find((m) => m.props?.[SPLINE_PROP] === made.id)?.name).toBe("Fence");
  });
});
