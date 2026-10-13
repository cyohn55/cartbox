/**
 * The modular kit and CSG (EDITOR_PRO_ROADMAP.md P5): booleans that leave
 * closed solids of the right volume, the same every time; parametric shapes
 * closed at every parameter's limits and rebuilt keeping their materials; the
 * stone and Forerunner kit; and the Kit panel's edits on the sidecar.
 */

import { describe, expect, it } from "vitest";
import {
  KIT_PIECES,
  PARAMETRIC_KINDS,
  PARAMETRIC_SHAPES,
  boxSolid,
  buildKitPiece,
  buildParametric,
  csg,
  cylinderSolid,
  defaultParametric,
  meshBounds,
  meshClosure,
  readParametric,
  rebuildParametric,
  serializeMeshAsset,
  wedgeSolid,
  type MeshAsset,
  type MeshPrimitive,
} from "@cartbox/editor";

import { addBrush, addKitPiece, addParametric, applyBoolean, setShapeParam } from "@/lib/kitEdit";
import { kitSnap } from "@/lib/kitSnap";
import { decodeMeshSidecar, emptyMeshSidecar, encodeMeshSidecar, readMeshEntry, setMeshTransform } from "@/lib/meshSidecar";

/** Every primitive as one (a solid of several materials is still one solid). */
function one(mesh: MeshAsset): MeshPrimitive {
  let offset = 0;
  const positions: number[] = [];
  const indices: number[] = [];
  for (const p of mesh.primitives) {
    positions.push(...p.positions);
    for (const i of p.indices) indices.push(i + offset);
    offset += p.positions.length / 3;
  }
  return { ...mesh.primitives[0]!, positions: Float32Array.from(positions), indices: Uint32Array.from(indices), normals: null, uvs: null };
}

/** A closed mesh's volume (the divergence theorem over its triangles). */
function volume(mesh: MeshAsset): number {
  let v = 0;
  for (const p of mesh.primitives) {
    for (let t = 0; t < p.indices.length; t += 3) {
      const [a, b, c] = [p.indices[t]!, p.indices[t + 1]!, p.indices[t + 2]!].map((i) => [p.positions[i * 3]!, p.positions[i * 3 + 1]!, p.positions[i * 3 + 2]!]);
      v += (a![0]! * (b![1]! * c![2]! - b![2]! * c![1]!) - a![1]! * (b![0]! * c![2]! - b![2]! * c![0]!) + a![2]! * (b![0]! * c![1]! - b![1]! * c![0]!)) / 6;
    }
  }
  return v;
}

const at = (x: number, y: number, z: number) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];
const closed = (m: MeshAsset) => meshClosure(one(m)).closed;

describe("CSG", () => {
  it("cuts, joins and intersects into closed solids of the right volume", () => {
    // A 4 × 3 × 0.4 wall, a 1.2 × 2 doorway through it.
    const wall = boxSolid([4, 3, 0.4]);
    const door = csg(wall, boxSolid([1.2, 2, 1]), "subtract", { bModel: at(0, -0.5, 0) });
    expect(closed(door)).toBe(true);
    expect(volume(door)).toBeCloseTo(4 * 3 * 0.4 - 1.2 * 2 * 0.4, 4);
    // Two 2 m cubes overlapping by 1 × 1 × 1.5.
    const union = csg(boxSolid([2, 2, 2]), boxSolid([2, 2, 2]), "union", { bModel: at(1, 1, 0.5) });
    expect(closed(union)).toBe(true);
    expect(volume(union)).toBeCloseTo(8 + 8 - 1 * 1 * 1.5, 4);
    const inter = csg(boxSolid([2, 2, 2]), boxSolid([2, 2, 2]), "intersect", { bModel: at(1, 1, 0.5) });
    expect(closed(inter)).toBe(true);
    expect(volume(inter)).toBeCloseTo(1.5, 4);
    // A round window and a wedge too.
    expect(closed(csg(wall, cylinderSolid([1, 1, 1]), "subtract", { bModel: [1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, -1, 0.5, 0, 1] }))).toBe(true);
    expect(closed(csg(boxSolid([3, 1, 3]), wedgeSolid([2, 1, 2]), "union", { bModel: at(0, 1, 0) }))).toBe(true);
  });

  it("gives the cut faces the target's material, and is the same every time", () => {
    const stone = { ...boxSolid([4, 3, 0.4]).primitives[0]!.material, name: "stone" };
    const wall = boxSolid([4, 3, 0.4], stone);
    const cut = csg(wall, boxSolid([1, 1, 1]), "subtract", { bModel: at(0, 0, 0) });
    expect(cut.primitives.map((p) => p.material.name)).toEqual(["stone"]);
    expect(serializeMeshAsset(csg(wall, boxSolid([1, 1, 1]), "subtract", { bModel: at(0, 0, 0) }))).toBe(serializeMeshAsset(cut));
  });
});

describe("parametric shapes and the kit", () => {
  it("are closed solids at every parameter's default and limits", () => {
    for (const kind of PARAMETRIC_KINDS) {
      expect(closed(buildParametric(defaultParametric(kind))), kind).toBe(true);
      for (const q of PARAMETRIC_SHAPES[kind].params) {
        for (const v of [q.min, q.max]) expect(closed(buildParametric({ kind, params: { ...defaultParametric(kind).params, [q.key]: v } })), `${kind} ${q.key}=${v}`).toBe(true);
      }
    }
  });

  it("stand on the ground at the size asked, an arch with its opening and stairs with their steps", () => {
    const stairs = buildParametric({ kind: "stairs", params: { width: 2, height: 1.8, depth: 3, steps: 9 } });
    const b = meshBounds(stairs)!;
    expect([b.min[1], b.max[1]]).toEqual([0, expect.closeTo(1.8, 5)]);
    // Half the box of a flight of 9 steps is air, give or take a step.
    expect(volume(stairs)).toBeCloseTo((2 * 1.8 * 3 * 10) / 18, 3);
    const arch = buildParametric(defaultParametric("arch"));
    const ab = meshBounds(arch)!;
    expect(ab.min[1]).toBeCloseTo(0, 5);
    expect(volume(arch)).toBeLessThan((ab.max[0] - ab.min[0]) * (ab.max[1] - ab.min[1]) * (ab.max[2] - ab.min[2]) * 0.7);
  });

  it("read a stored shape defensively, and rebuild keeping the creator's materials", () => {
    expect(readParametric({ kind: "stairs", params: { steps: 400, width: "x" } })).toEqual({ kind: "stairs", params: { width: 2, height: 1.8, depth: 3, steps: 32 } });
    expect(readParametric({ kind: "spaceship" })).toBeNull();
    const before = buildParametric(defaultParametric("wall"));
    const painted = { ...before, primitives: before.primitives.map((p) => ({ ...p, material: { ...p.material, name: "painted" } })) };
    const after = rebuildParametric({ kind: "wall", params: { ...defaultParametric("wall").params, width: 9 } }, painted);
    expect(after.primitives.every((p) => p.material.name === "painted")).toBe(true);
    expect(meshBounds(after)!.max[0]).toBeCloseTo(4.5, 5);
  });

  it("builds every kit piece closed, in its style's generated material, projected triplanar", () => {
    for (const kit of KIT_PIECES) {
      const mesh = buildKitPiece(kit);
      expect(closed(mesh), kit.id).toBe(true);
      const m = mesh.primitives[0]!.material;
      expect(m.generator?.kind, kit.id).toBe(kit.style === "stone" ? "stone" : "forerunner");
      expect(m.triplanar, kit.id).toBeGreaterThan(0);
    }
  });

  it("snaps kit pieces edge to edge", () => {
    const slab = meshBounds(buildKitPiece(KIT_PIECES.find((k) => k.id === "stone-slab")!))!;
    const moving = { min: [slab.min[0] + 4.2, slab.min[1], slab.min[2] + 0.1], max: [slab.max[0] + 4.2, slab.max[1], slab.max[2] + 0.1] };
    const snap = kitSnap(moving, [slab])!;
    expect(snap.delta[0]).toBeCloseTo(-0.2, 6);
    expect(snap.delta[2]).toBeCloseTo(-0.1, 6);
  });
});

describe("the Kit panel's edits", () => {
  it("adds a kit piece that remembers its shape, and rebuilds it as a parameter changes", () => {
    const made = addKitPiece(emptyMeshSidecar(), "stone-arch", [3, 0, 0])!;
    const entry = made.sidecar.meshes.find((m) => m.id === made.id)!;
    expect(entry.shape?.kind).toBe("arch");
    expect(entry.transform.position).toEqual([3, 0, 0]);
    const wider = setShapeParam(made.sidecar, made.id, "span", 6);
    const mesh = readMeshEntry(wider.meshes.find((m) => m.id === made.id)!);
    expect(meshBounds(mesh)!.max[0] - meshBounds(mesh)!.min[0]).toBeGreaterThan(6);
    expect(mesh.primitives[0]!.material.generator?.kind).toBe("stone");
    // Stored with the cart.
    expect(decodeMeshSidecar(encodeMeshSidecar(wider)).meshes[0]!.shape?.params.span).toBe(6);
  });

  it("cuts a brush out of a wall where they stand in the world, removing the brush", () => {
    let sidecar = addParametric(emptyMeshSidecar(), "wall", [10, 0, 5]).sidecar;
    const wallId = sidecar.meshes[0]!.id;
    // A plain wall (no doorway), and a brush through it 1 m along.
    sidecar = setShapeParam(sidecar, wallId, "door", 0);
    const brush = addBrush(sidecar, "box", [11, 1, 5], [1, 1.5, 1]);
    const result = applyBoolean(brush.sidecar, wallId, brush.id, "subtract");
    if ("problem" in result) throw new Error(result.problem);
    expect(result.closed).toBe(true);
    expect(result.sidecar.meshes.map((m) => m.id)).toEqual([wallId]);
    const wall = result.sidecar.meshes[0]!;
    expect(wall.shape).toBeUndefined();
    const v = volume(readMeshEntry(wall));
    expect(v).toBeCloseTo(6 * 3.4 * 0.4 - 1 * 1.5 * 0.4, 3);
    // Moving the wall first moves where the cut lands (it's in world space).
    const moved = setMeshTransform(brush.sidecar, wallId, { position: [30, 0, 5], rotation: [0, 0, 0], scale: [1, 1, 1] });
    const missed = applyBoolean(moved, wallId, brush.id, "subtract");
    if ("problem" in missed) throw new Error(missed.problem);
    expect(volume(readMeshEntry(missed.sidecar.meshes[0]!))).toBeCloseTo(6 * 3.4 * 0.4, 3);
    expect(applyBoolean(brush.sidecar, wallId, wallId, "union")).toEqual({ problem: "Pick another object to use on this one." });
  });
});
