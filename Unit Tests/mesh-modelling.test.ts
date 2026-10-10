/**
 * Modelling in the editor (LOCKOUT_MULTIPLAYER_ROADMAP.md L15): vertex, edge
 * and face selection (click, box and loop), a move, rotate and scale for the
 * selection, and merge, delete, loop cut, subdivide, mirror and add
 * primitive. Every operation leaves a closed mesh closed and consistently
 * wound; on a skinned mesh a moved vertex keeps its weights, new ones blend
 * their neighbours', and every vertex's weights still sum to 1. On Lockout's
 * own Spartan and battle rifle viewmodel: the helmet and the stock reshaped,
 * and every clip still plays through the animator the cart runs.
 */

import { describe, expect, it } from "vitest";
import {
  addShape,
  boxSelect,
  combineSelection,
  convertSelection,
  deleteSelection,
  deserializeMeshAsset,
  editMeshFace,
  emptySelection,
  gizmoDrag,
  lockoutMeshSidecar,
  loopCut,
  loopSelect,
  meshClosure,
  mergeSelection,
  mirrorSelection,
  mirroredJoints,
  orbitView,
  pickElement,
  pickMeshTriangle,
  primitiveTopology,
  projectPoint,
  selectAll,
  selectByJoint,
  selectLinked,
  selectionPivot,
  selectionSize,
  selectionWelds,
  singleSelection,
  skinMatrices,
  skinVertices,
  sampleClip,
  subdivideSelection,
  transformSelection,
  weightError,
  SHAPE_KINDS,
  type MeshAsset,
  type MeshPrimitive,
  type MeshSelection,
} from "@cartbox/editor";
import { AnimationSession, parseMeshScene } from "@cartbox/player";

import { decodeMeshSidecar, encodeMeshSidecar, type MeshSidecar } from "../apps/web/src/lib/meshSidecar";
import { replaceModel } from "../apps/web/src/lib/meshReplace";

/** A 2 × 2 × 2 cube centred on the origin, each face's corners its own (as exported), with UVs; optionally skinned. */
function cube(skinned = false): MeshPrimitive {
  const positions: number[] = [], normals: number[] = [], uvs: number[] = [], indices: number[] = [];
  const joints: number[] = [], weights: number[] = [];
  const faces: [number[], number[], number[]][] = [
    [[0, 1, 0], [1, 0, 0], [0, 0, -1]],
    [[0, -1, 0], [1, 0, 0], [0, 0, 1]],
    [[1, 0, 0], [0, 0, -1], [0, 1, 0]],
    [[-1, 0, 0], [0, 0, 1], [0, 1, 0]],
    [[0, 0, 1], [1, 0, 0], [0, 1, 0]],
    [[0, 0, -1], [-1, 0, 0], [0, 1, 0]],
  ];
  for (const [n, u, v] of faces) {
    const base = positions.length / 3;
    for (const [su, sv] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      const p = [0, 1, 2].map((k) => n[k]! + u[k]! * su! + v[k]! * sv!);
      positions.push(...p);
      normals.push(...n);
      uvs.push((su! + 1) / 2, (sv! + 1) / 2);
      // The top half rides joint 1, the bottom joint 0: a bend through the middle.
      const top = p[1]! > 0;
      joints.push(top ? 1 : 0, 0, 0, 0);
      weights.push(1, 0, 0, 0);
    }
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  return {
    positions: Float32Array.from(positions),
    normals: Float32Array.from(normals),
    uvs: Float32Array.from(uvs),
    indices: Uint32Array.from(indices),
    material: { name: "block", baseColorFactor: [1, 1, 1, 1], baseColorImage: null },
    ...(skinned ? { joints: Uint16Array.from(joints), weights: Float32Array.from(weights) } : {}),
  };
}

/** A mesh of one cube, with a two-joint skeleton when skinned. */
function block(skinned = false): MeshAsset {
  const inverseBind = new Float32Array(32);
  inverseBind.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], 0);
  inverseBind.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], 16);
  return {
    name: "block",
    primitives: [cube(skinned)],
    ...(skinned
      ? {
          skin: {
            joints: [
              { name: "base", parent: -1, translation: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
              { name: "top", parent: 0, translation: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
            ],
            inverseBind,
          },
        }
      : {}),
  } as MeshAsset;
}

const at = (p: MeshPrimitive, i: number) => [p.positions[i * 3]!, p.positions[i * 3 + 1]!, p.positions[i * 3 + 2]!];

/** Enclosed volume (divergence theorem): positive for outward winding. */
function volume(p: MeshPrimitive): number {
  let v = 0;
  for (let t = 0; t < p.indices.length; t += 3) {
    const [a, b, c] = [0, 1, 2].map((k) => at(p, p.indices[t + k]!)) as [number[], number[], number[]];
    v += (a[0]! * (b[1]! * c[2]! - b[2]! * c[1]!) - a[1]! * (b[0]! * c[2]! - b[2]! * c[0]!) + a[2]! * (b[0]! * c[1]! - b[1]! * c[0]!)) / 6;
  }
  return v;
}

/** Every primitive closed and consistently wound, outward, and (skinned) its weights normalised. */
function expectSound(mesh: MeshAsset, label = "") {
  mesh.primitives.forEach((p, i) => {
    const closure = meshClosure(p);
    expect(closure, `${label} primitive ${i}`).toEqual({ openEdges: 0, repeatedEdges: 0, degenerate: 0, closed: true });
    expect(volume(p), `${label} primitive ${i} faces outward`).toBeGreaterThan(0);
    expect(weightError(p), `${label} primitive ${i} weights`).toBeLessThan(1e-5);
    if (p.joints) expect(p.joints.length).toBe((p.positions.length / 3) * 4);
    for (const stream of [p.normals, p.uvs, p.weights]) expect(stream ? Array.from(stream).every(Number.isFinite) : true).toBe(true);
  });
}

/** An edge of the top face of the cube, by its welds' positions. */
function edgeWhere(p: MeshPrimitive, test: (a: number[], b: number[]) => boolean): number {
  const topo = primitiveTopology(p);
  const pos = (w: number) => Array.from(topo.weldPositions.subarray(w * 3, w * 3 + 3));
  return topo.edges.findIndex((e) => test(pos(e.a), pos(e.b)));
}
const sel = (mode: MeshSelection["mode"], ids: number[]): MeshSelection => ({ mode, parts: [ids] });

describe("a primitive as a modelling tool sees it", () => {
  it("has welded vertices, polygon faces and their edges", () => {
    const topo = primitiveTopology(cube());
    expect(topo.weldVertices).toHaveLength(8);
    expect(topo.faces).toHaveLength(6);
    expect(topo.edges).toHaveLength(12);
    for (const face of topo.faces) expect(face.loop).toHaveLength(4);
    for (const edge of topo.edges) expect(edge.faces).toHaveLength(2);
    for (const edges of topo.weldEdges) expect(edges).toHaveLength(3);
    expect(meshClosure(cube()).closed).toBe(true);
  });

  it("converts selections between modes, and combines them", () => {
    const mesh = block();
    const top = selectAll(mesh, "face");
    expect(selectionSize(top)).toBe(6);
    const face = sel("face", [primitiveTopology(mesh.primitives[0]!).faceOfTriangle[0]!]);
    expect(selectionSize(convertSelection(mesh, face, "vertex"))).toBe(4);
    expect(selectionSize(convertSelection(mesh, face, "edge"))).toBe(4);
    // Four corners of the top: its one face (and no other) back in face mode.
    expect(convertSelection(mesh, convertSelection(mesh, face, "vertex"), "face").parts[0]).toEqual(face.parts[0]);
    const a = singleSelection("vertex", 0, 1);
    const b = singleSelection("vertex", 0, 2);
    expect(combineSelection(a, b, "add").parts[0]).toEqual([1, 2]);
    expect(combineSelection(combineSelection(a, b, "add"), a, "toggle").parts[0]).toEqual([2]);
    expect(combineSelection(a, b, "replace")).toBe(b);
    expect(emptySelection("edge").parts).toEqual([]);
  });
});

describe("selecting in the preview", () => {
  const mesh = block();
  const camera = { yaw: 0.6, pitch: 0.5 };
  const viewProj = orbitView({ min: [-1, -1, -1], max: [1, 1, 1] }, camera).viewProj;
  const topo = primitiveTopology(mesh.primitives[0]!);
  const screen = (w: number) => projectPoint(viewProj, Array.from(topo.weldPositions.subarray(w * 3, w * 3 + 3)))!;

  it("clicks a face, the nearest corner or side of the face under the pointer, never one behind it", () => {
    const above = pickMeshTriangle(mesh, { yaw: 0, pitch: 1.5 }, 0, 0)!;
    const face = pickElement(mesh, orbitView({ min: [-1, -1, -1], max: [1, 1, 1] }, { yaw: 0, pitch: 1.5 }).viewProj, [0, 0], "face", above)!;
    expect(topo.faces[face.id]!.normal[1]).toBeCloseTo(1, 6);
    // Click right on the screen position of the top front-right corner.
    const corner = topo.weldPositions.findIndex((_, k) => k % 3 === 0 && topo.weldPositions[k] === 1 && topo.weldPositions[k + 1] === 1 && topo.weldPositions[k + 2] === 1) / 3;
    const s = screen(corner);
    const hit = pickMeshTriangle(mesh, camera, s[0] - 0.01, s[1] - 0.01);
    expect(pickElement(mesh, viewProj, [s[0], s[1]], "vertex", hit)).toEqual({ primitive: 0, id: corner });
    // The corner at the very back (−1, −1, −1) is hidden: a click there picks the front face's own corner.
    const back = topo.weldPositions.findIndex((_, k) => k % 3 === 0 && topo.weldPositions[k] === -1 && topo.weldPositions[k + 1] === -1 && topo.weldPositions[k + 2] === -1) / 3;
    const sb = screen(back);
    const hitBack = pickMeshTriangle(mesh, camera, sb[0], sb[1]);
    if (hitBack) expect(pickElement(mesh, viewProj, [sb[0], sb[1]], "vertex", hitBack)!.id).not.toBe(back);
    // An edge: the midpoint of a side.
    const edge = topo.edges.findIndex((e) => e.a === corner || e.b === corner);
    const { a, b } = topo.edges[edge]!;
    const mid: [number, number] = [(screen(a)[0] + screen(b)[0]) / 2, (screen(a)[1] + screen(b)[1]) / 2];
    expect(pickElement(mesh, viewProj, mid, "edge", null)).toEqual({ primitive: 0, id: edge });
  });

  it("box-selects what the rectangle holds: welds, edges with both ends, faces with every corner", () => {
    const all = boxSelect(mesh, viewProj, [-1, -1], [1, 1], "vertex");
    expect(selectionSize(all)).toBe(8);
    expect(selectionSize(boxSelect(mesh, viewProj, [-1, -1], [1, 1], "face"))).toBe(6);
    // Just around the top corner: one weld, no edges.
    const corner = topo.weldPositions.findIndex((_, k) => k % 3 === 0 && topo.weldPositions[k] === 1 && topo.weldPositions[k + 1] === 1 && topo.weldPositions[k + 2] === 1) / 3;
    const s = screen(corner);
    const one = boxSelect(mesh, viewProj, [s[0] - 0.01, s[1] - 0.01], [s[0] + 0.01, s[1] + 0.01], "vertex");
    expect(one.parts[0]).toEqual([corner]);
    expect(selectionSize(boxSelect(mesh, viewProj, [s[0] - 0.01, s[1] - 0.01], [s[0] + 0.01, s[1] + 0.01], "edge"))).toBe(0);
  });

  it("loop-selects round a ring of quads: an edge loop, its vertices, or the faces it crosses", () => {
    // Cut the cube round its middle, then select that new loop.
    const p = mesh.primitives[0]!;
    const side = edgeWhere(p, (a, b) => a[0] === 1 && b[0] === 1 && a[2] === 1 && b[2] === 1); // a vertical edge
    const cut = loopCut(mesh, 0, side);
    const cp = cut.primitives[0]!;
    const middle = edgeWhere(cp, (a, b) => Math.abs(a[1]!) < 1e-6 && Math.abs(b[1]!) < 1e-6);
    expect(middle).toBeGreaterThanOrEqual(0);
    const loop = loopSelect(cut, 0, middle, "edge");
    expect(selectionSize(loop)).toBe(4);
    expect(selectionSize(loopSelect(cut, 0, middle, "vertex"))).toBe(4);
    // The faces a vertical side crosses: the four round the middle band, top half.
    const vertical = edgeWhere(cp, (a, b) => a[0] === 1 && b[0] === 1 && a[2] === 1 && b[2] === 1 && Math.max(a[1]!, b[1]!) === 1);
    expect(selectionSize(loopSelect(cut, 0, vertical, "face"))).toBe(4);
  });
});

describe("every operation keeps the mesh closed and consistently wound", () => {
  const mesh = block();
  const top = selectByJointFree(mesh, (y) => y > 0); // the top four corners

  function selectByJointFree(m: MeshAsset, test: (y: number) => boolean): MeshSelection {
    const topo = primitiveTopology(m.primitives[0]!);
    return sel("vertex", topo.weldVertices.map((_, w) => w).filter((w) => test(topo.weldPositions[w * 3 + 1]!)));
  }

  it("moves, turns and scales the selection about its centre", () => {
    expect(selectionPivot(mesh, top)).toEqual([0, 1, 0]);
    const moved = transformSelection(mesh, top, { kind: "move", offset: [0, 1, 0] });
    expectSound(moved, "move");
    expect(volume(moved.primitives[0]!)).toBeCloseTo(12, 5);
    const turned = transformSelection(mesh, top, { kind: "rotate", axis: 1, angle: Math.PI / 4 });
    expectSound(turned, "rotate");
    // The top's corner (1, 1, 1) turned an eighth about the vertical through (0, 1, 0).
    const tp = turned.primitives[0]!;
    const corners = Array.from({ length: tp.positions.length / 3 }, (_, v) => at(tp, v)).filter((q) => q[1] === 1);
    expect(corners.some((q) => Math.abs(q[0]! - Math.SQRT2) < 1e-6 && Math.abs(q[2]!) < 1e-6)).toBe(true);
    const scaled = transformSelection(mesh, top, { kind: "scale", factor: [0.5, 1, 0.5] });
    expectSound(scaled, "scale");
    // A frustum from 2 × 2 to 1 × 1 over a height of 2.
    expect(volume(scaled.primitives[0]!)).toBeCloseTo((2 / 3) * (4 + 1 + 2), 5);
    // The flat normals follow: the sides now lean in.
    const n = scaled.primitives[0]!.normals!;
    expect(Array.from({ length: n.length / 3 }, (_, i) => n[i * 3 + 1]!).some((y) => y > 0.2 && y < 0.9)).toBe(true);
  });

  it("drags a gizmo handle: along the axis as drawn, round it, or out along it", () => {
    const viewProj = orbitView({ min: [-1, -1, -1], max: [1, 1, 1] }, { yaw: 0, pitch: 0 }).viewProj;
    const up = projectPoint(viewProj, [0, 1.5, 0])![1] - projectPoint(viewProj, [0, 1, 0])![1];
    const move = gizmoDrag(viewProj, [0, 1, 0], 1, "move", [0, up], 0.5)!;
    expect(move.kind).toBe("move");
    if (move.kind === "move") expect(move.offset[1]).toBeCloseTo(0.5, 6);
    const scale = gizmoDrag(viewProj, [0, 1, 0], 1, "scale", [0, up], 0.5)!;
    if (scale.kind === "scale") expect(scale.factor[1]).toBeCloseTo(2, 6);
    const rotate = gizmoDrag(viewProj, [0, 1, 0], 0, "rotate", [0, 1], 0.5)!;
    if (rotate.kind === "rotate") expect(Math.abs(rotate.angle)).toBeCloseTo(Math.PI / 2, 6);
  });

  it("merges vertices: an edge collapsed, a face drawn to a point", () => {
    const p = mesh.primitives[0]!;
    const edge = edgeWhere(p, (a, b) => a[1] === 1 && b[1] === 1 && a[2] === 1 && b[2] === 1);
    const collapsed = mergeSelection(mesh, sel("edge", [edge]));
    expectSound(collapsed, "edge collapse");
    expect(primitiveTopology(collapsed.primitives[0]!).weldVertices).toHaveLength(7);
    const point = mergeSelection(mesh, top);
    expectSound(point, "face to point");
    // A pyramid of height 2 on a 2 × 2 base.
    expect(volume(point.primitives[0]!)).toBeCloseTo(8 / 3, 5);
  });

  it("deletes vertices, edges or faces and fills the hole; a whole piece just goes", () => {
    const p = mesh.primitives[0]!;
    const topo = primitiveTopology(p);
    const corner = topo.weldVertices.findIndex((_, w) => [0, 1, 2].every((k) => topo.weldPositions[w * 3 + k] === 1));
    const cut = deleteSelection(mesh, sel("vertex", [corner]));
    expectSound(cut, "delete vertex");
    // The corner sliced off: the cube less a corner tetrahedron (a third of 2·2·2/2... = 4/3).
    expect(volume(cut.primitives[0]!)).toBeCloseTo(8 - 4 / 3, 5);
    const edge = edgeWhere(p, (a, b) => a[1] === 1 && b[1] === 1 && a[2] === 1 && b[2] === 1);
    expectSound(deleteSelection(mesh, sel("edge", [edge])), "delete edge");
    const face = topo.faceOfTriangle[0]!;
    const capped = deleteSelection(mesh, sel("face", [face]));
    expectSound(capped, "delete face");
    expect(volume(capped.primitives[0]!)).toBeCloseTo(8, 5);
    // Two cubes in one primitive: delete one whole (linked) and the other is left as it was.
    const two: MeshAsset = { ...mesh, primitives: [joinPrimitives(cube(), offset(cube(), [4, 0, 0]))] };
    const linked = selectLinked(two, sel("vertex", [0]));
    expect(selectionSize(linked)).toBe(8);
    const one = deleteSelection(two, linked);
    expectSound(one, "delete shell");
    expect(volume(one.primitives[0]!)).toBeCloseTo(8, 5);
    expect(one.primitives[0]!.indices.length).toBe(36);
  });

  it("cuts a loop round a ring of quads, or as far as the ring goes, splitting the faces where it stops", () => {
    const p = mesh.primitives[0]!;
    const vertical = edgeWhere(p, (a, b) => a[0] === 1 && b[0] === 1 && a[2] === 1 && b[2] === 1);
    const cut = loopCut(mesh, 0, vertical, 0.25);
    expectSound(cut, "loop cut");
    const topo = primitiveTopology(cut.primitives[0]!);
    expect(topo.faces).toHaveLength(10);
    expect(topo.weldVertices).toHaveLength(12);
    // A quarter of the way along each vertical side from the first weld's end.
    const ys = new Set(Array.from({ length: topo.weldVertices.length }, (_, w) => Math.round(topo.weldPositions[w * 3 + 1]! * 1e4) / 1e4));
    expect([...ys].sort()).toHaveLength(3);
    expect(volume(cut.primitives[0]!)).toBeCloseTo(8, 5);
    // A ring that stops at a non-quad: cut through the corner-sliced cube.
    const corner = primitiveTopology(p).weldVertices.findIndex((_, w) => [0, 1, 2].every((k) => primitiveTopology(p).weldPositions[w * 3 + k] === 1));
    const sliced = deleteSelection(mesh, sel("vertex", [corner]));
    const sp = sliced.primitives[0]!;
    const bottomEdge = edgeWhere(sp, (a, b) => a[1] === -1 && b[1] === -1 && a[0] === -1 && b[0] === -1);
    const partial = loopCut(sliced, 0, bottomEdge);
    expectSound(partial, "partial loop cut");
    expect(partial.primitives[0]!.indices.length).toBeGreaterThan(sp.indices.length);
  });

  it("subdivides faces, and the faces beside them take the new vertices", () => {
    const p = mesh.primitives[0]!;
    const face = primitiveTopology(p).faceOfTriangle[0]!;
    const one = subdivideSelection(mesh, sel("face", [face]));
    expectSound(one, "subdivide one face");
    expect(primitiveTopology(one.primitives[0]!).faces).toHaveLength(6 + 3);
    const all = subdivideSelection(mesh, selectAll(mesh, "face"));
    expectSound(all, "subdivide all");
    expect(primitiveTopology(all.primitives[0]!).faces).toHaveLength(24);
    expect(volume(all.primitives[0]!)).toBeCloseTo(8, 5);
    // A triangle face becomes three quads round its centre.
    const tri = deleteSelection(mesh, sel("vertex", [primitiveTopology(p).weldVertices.findIndex((_, w) => [0, 1, 2].every((k) => primitiveTopology(p).weldPositions[w * 3 + k] === 1))]));
    expectSound(subdivideSelection(tri, selectAll(tri, "face")), "subdivide with a triangle");
  });

  it("mirrors a piece in place or as a copy across the centre line", () => {
    const moved: MeshAsset = { ...mesh, primitives: [offset(cube(), [3, 0, 0])] };
    const flipped = mirrorSelection(moved, sel("vertex", [0]), 0);
    expectSound(flipped, "mirror");
    const box = flipped.primitives[0]!;
    expect(Math.max(...Array.from({ length: box.positions.length / 3 }, (_, i) => box.positions[i * 3]!))).toBeCloseTo(-2, 6);
    const pair = mirrorSelection(moved, sel("vertex", [0]), 0, { duplicate: true });
    expectSound(pair, "mirror copy");
    expect(volume(pair.primitives[0]!)).toBeCloseTo(16, 5);
  });

  it("adds closed primitives of each kind", () => {
    for (const kind of SHAPE_KINDS) {
      const added = addShape(mesh, 0, { kind, center: [5, 0, 0], size: 2, segments: 16 });
      expectSound(added, kind);
      const v = volume(added.primitives[0]!) - 8;
      const expected = { cube: 8, cylinder: Math.PI * 2, cone: (Math.PI * 2) / 3, sphere: (4 / 3) * Math.PI }[kind];
      // Polygonal versions of the round ones run a little under.
      expect(v / expected).toBeGreaterThan(kind === "cube" ? 0.999 : 0.85);
      expect(v / expected).toBeLessThan(1.001);
    }
  });
});

describe("skinned edits", () => {
  const mesh = block(true);
  const p = mesh.primitives[0]!;
  const vertical = edgeWhere(p, (a, b) => a[0] === 1 && b[0] === 1 && a[2] === 1 && b[2] === 1);

  it("keep a moved vertex's own weights", () => {
    const moved = transformSelection(mesh, sel("vertex", [0]), { kind: "move", offset: [0, 0.3, 0] });
    expect(Array.from(moved.primitives[0]!.joints!)).toEqual(Array.from(p.joints!));
    expect(Array.from(moved.primitives[0]!.weights!)).toEqual(Array.from(p.weights!));
  });

  it("give new vertices their neighbours' weights blended, normalised to 1", () => {
    // A cut halfway up the sides: its vertices are half bottom joint, half top.
    const cut = loopCut(mesh, 0, vertical, 0.5);
    expectSound(cut, "skinned loop cut");
    const q = cut.primitives[0]!;
    let middle = 0;
    for (let v = 0; v < q.positions.length / 3; v += 1) {
      if (Math.abs(q.positions[v * 3 + 1]!) > 1e-6) continue;
      middle += 1;
      const w = new Map<number, number>();
      for (let k = 0; k < 4; k += 1) if (q.weights![v * 4 + k]! > 0) w.set(q.joints![v * 4 + k]!, q.weights![v * 4 + k]!);
      expect(w.get(0)).toBeCloseTo(0.5, 6);
      expect(w.get(1)).toBeCloseTo(0.5, 6);
    }
    expect(middle).toBeGreaterThan(0);
    for (const [label, edited] of [
      ["merge", mergeSelection(mesh, sel("edge", [vertical]))],
      ["subdivide", subdivideSelection(mesh, selectAll(mesh, "face"))],
      ["delete", deleteSelection(mesh, sel("vertex", [0]))],
      ["mirror", mirrorSelection(mesh, sel("vertex", [0]), 1, { duplicate: true, origin: 2 })],
      ["add", addShape(mesh, 0, { kind: "sphere", center: [0, 2, 0], size: 1 })],
      ["extrude", editMeshFace(mesh, 0, 0, { kind: "extrude", distance: 0.5 })],
    ] as const) {
      expectSound(edited, label);
    }
    // An added shape near the top rides the top joint.
    const crest = addShape(mesh, 0, { kind: "cube", center: [0, 1.5, 0], size: 0.5 });
    const added = crest.primitives[0]!;
    expect(added.joints![added.joints!.length - 4]).toBe(1);
  });
});

// --- Lockout -----------------------------------------------------------------

const base: MeshSidecar = decodeMeshSidecar(lockoutMeshSidecar());
const entry = (s: MeshSidecar, id: string) => s.meshes.find((m) => m.id === id)!;
const soldier: MeshAsset = deserializeMeshAsset(entry(base, "bot-1").mesh);
const rifle: MeshAsset = deserializeMeshAsset(entry(base, "viewmodel-br").mesh);
const jointIndex = (mesh: MeshAsset, name: string) => mesh.skin!.joints.findIndex((j) => j.name === name);

/**
 * Play every clip of `edited` (put on every bot or viewmodel of the cart as
 * the editor saves it) through the animator, a second each, and check the
 * skinned vertices are finite and that `follows` vertices still ride `joint`.
 */
function playsEveryClip(id: string, edited: MeshAsset, joint: number, follows: (p: number, v: number) => boolean) {
  const { sidecar } = replaceModel(base, id, edited);
  const scene = parseMeshScene(encodeMeshSidecar(sidecar))!;
  const object = scene.instances.findIndex((_, i) => sidecar.meshes[i]?.id === id);
  expect(object).toBeGreaterThanOrEqual(0);
  const mesh = scene.instances[object]!.mesh;
  expect(mesh.primitives.map((p) => p.indices.length)).toEqual(edited.primitives.map((p) => p.indices.length));
  const session = new AnimationSession(scene);
  let checked = 0;
  (mesh.clips ?? []).forEach((clip, c) => {
    session.play(object, c, 0, 1, true);
    for (let tick = 0; tick < 60; tick += 1) session.step(1 / 60);
    const matrices = session.matrices().get(object)!;
    expect(matrices).toBeDefined();
    // The pose the animator plays is the clip's own.
    const t = session.state().find((s) => s.object === object)!.time;
    const expected = skinMatrices(mesh.skin!, sampleClip(mesh.skin!, clip, t));
    for (let k = 0; k < matrices.length; k += 1) expect(matrices[k]).toBeCloseTo(expected[k]!, 4);
    mesh.primitives.forEach((p, pi) => {
      const out = new Float32Array(p.positions.length);
      skinVertices(p.joints!, p.weights!, matrices, p.positions, null, out, null);
      expect(out.every(Number.isFinite), `${clip.name}`).toBe(true);
      const m = matrices.subarray(joint * 16, joint * 16 + 16);
      for (let v = 0; v < p.positions.length / 3; v += 1) {
        if (!follows(pi, v)) continue;
        const [x, y, z] = [p.positions[v * 3]!, p.positions[v * 3 + 1]!, p.positions[v * 3 + 2]!];
        expect(out[v * 3]).toBeCloseTo(m[0]! * x + m[4]! * y + m[8]! * z + m[12]!, 4);
        expect(out[v * 3 + 1]).toBeCloseTo(m[1]! * x + m[5]! * y + m[9]! * z + m[13]!, 4);
        checked += 1;
      }
    });
  });
  return checked;
}

describe("Lockout: a Spartan's helmet reshaped in the editor still animates", () => {
  const head = jointIndex(soldier, "head");
  const helmet = selectByJoint(soldier, head, "vertex");

  it("selects the helmet by its bone, on every part it spans: plates, trim and visor", () => {
    const welds = selectionWelds(soldier, helmet);
    expect(welds.filter((s) => s.size > 0).length).toBeGreaterThanOrEqual(3);
    const pivot = selectionPivot(soldier, helmet)!;
    expect(pivot[1]).toBeGreaterThan(1.6);
    expect(pivot[1]).toBeLessThan(1.8);
  });

  it("is taller and broader, closed, and every vertex's weights still sum to 1", () => {
    const reshaped = transformSelection(soldier, helmet, { kind: "scale", factor: [1.15, 1.25, 1.1] });
    expectSound(reshaped, "helmet");
    const top = (m: MeshAsset) => Math.max(...m.primitives.flatMap((p) => Array.from({ length: p.positions.length / 3 }, (_, v) => p.positions[v * 3 + 1]!)));
    expect(top(reshaped)).toBeGreaterThan(top(soldier) + 0.02);
    // Nothing below the neck moved.
    reshaped.primitives.forEach((p, i) => {
      const was = soldier.primitives[i]!;
      for (let v = 0; v < p.positions.length / 3; v += 1) {
        if (was.joints![v * 4] === head) continue;
        expect(p.positions[v * 3 + 1]).toBe(was.positions[v * 3 + 1]);
      }
    });
    // Every clip plays, with the reshaped helmet riding the head.
    const checked = playsEveryClip("bot-1", reshaped, head, (pi, v) => reshaped.primitives[pi]!.joints![v * 4] === head && reshaped.primitives[pi]!.weights![v * 4] === 1);
    expect(checked).toBeGreaterThan(500);
  });

  it("takes a crest, a loop cut, a subdivided brow and an extruded chin, still closed, weighted and animating", () => {
    const armor = soldier.primitives.findIndex((p) => p.material.name === "armor");
    // A crest along the top of the helmet: a box riding the head.
    let edited = addShape(soldier, armor, { kind: "cube", center: [0, 1.82, 0], size: 0.05 }, head);
    // The helmet crown's faces (the paint plates on the head): subdivide the topmost one, cut a loop across it.
    const plates = selectByJoint(edited, head, "face");
    const topo = primitiveTopology(edited.primitives[armor]!);
    const crown = (plates.parts[armor] ?? []).filter((f) => topo.faces[f]!.normal[1] > 0.99 && isQuadFace(topo, f));
    expect(crown.length).toBeGreaterThan(0);
    const highest = crown.sort((a, b) => topo.weldPositions[topo.faces[b]!.loop[0]! * 3 + 1]! - topo.weldPositions[topo.faces[a]!.loop[0]! * 3 + 1]!)[0]!;
    const edge = topo.edgeIndex.get(edgeKeyOf(topo.faces[highest]!.loop[0]!, topo.faces[highest]!.loop[1]!))!;
    edited = loopCut(edited, armor, edge);
    expectSound(edited, "crest + loop cut");
    const plates2 = selectByJoint(edited, head, "face");
    const topo2 = primitiveTopology(edited.primitives[armor]!);
    const brow = (plates2.parts[armor] ?? []).filter((f) => topo2.faces[f]!.normal[2] > 0.99);
    edited = subdivideSelection(edited, { mode: "face", parts: edited.primitives.map((_, i) => (i === armor ? brow.slice(0, 2) : [])) });
    expectSound(edited, "subdivided brow");
    const tri = primitiveTopology(edited.primitives[armor]!).faces.findIndex((f, k) => f.normal[2] > 0.99 && (selectByJoint(edited, head, "face").parts[armor] ?? []).includes(k));
    edited = editMeshFace(edited, armor, primitiveTopology(edited.primitives[armor]!).faces[tri]!.triangles[0]!, { kind: "extrude", distance: 0.01 });
    expectSound(edited, "extruded chin");
    const checked = playsEveryClip("bot-1", edited, head, (pi, v) => pi === armor && edited.primitives[pi]!.joints![v * 4] === head && edited.primitives[pi]!.weights![v * 4] === 1);
    expect(checked).toBeGreaterThan(100);
  });

  it("mirrors the ear module onto the other side of the helmet; a mirrored arm piece would ride the other arm", () => {
    const trim = soldier.primitives.findIndex((p) => p.material.name === "armor-trim");
    const p = soldier.primitives[trim]!;
    // The helmet's one ear module, on its right (+x): the head's outermost trim.
    let ear = -1;
    for (let v = 0; v < p.positions.length / 3; v += 1) if (p.joints![v * 4] === head && (ear < 0 || p.positions[v * 3]! > p.positions[ear * 3]!)) ear = v;
    const module = selectLinked(soldier, { mode: "vertex", parts: soldier.primitives.map((_, i) => (i === trim ? [primitiveTopology(p).weldOf[ear]!] : [])) });
    // A bevelled box: eight corners, each cut in two.
    expect(selectionSize(module)).toBe(16);
    const shellVertices = selectionWelds(soldier, module)[trim]!;
    const copies = [...shellVertices].reduce((n, w) => n + primitiveTopology(p).weldVertices[w]!.length, 0);
    const both = mirrorSelection(soldier, module, 0, { duplicate: true });
    expectSound(both, "mirrored ear");
    const q = both.primitives[trim]!;
    expect(q.positions.length - p.positions.length).toBe(copies * 3);
    const xs = Array.from({ length: copies }, (_, k) => q.positions[(p.positions.length / 3 + k) * 3]!);
    expect(Math.max(...xs)).toBeLessThan(-0.1);
    for (let v = p.positions.length / 3; v < q.positions.length / 3; v += 1) expect(q.joints![v * 4]).toBe(head);
    // Joints with a side swap sides; the rest stay.
    const map = mirroredJoints(soldier.skin);
    expect(map[jointIndex(soldier, "upperarm_l")]).toBe(jointIndex(soldier, "upperarm_r"));
    expect(map[jointIndex(soldier, "foot_r")]).toBe(jointIndex(soldier, "foot_l"));
    expect(map[head]).toBe(head);
    expect(checkedEar(both)).toBeGreaterThan(0);
  });

  function checkedEar(mesh: MeshAsset) {
    const trim = mesh.primitives.findIndex((p) => p.material.name === "armor-trim");
    const from = soldier.primitives[trim]!.positions.length / 3;
    return playsEveryClip("bot-1", mesh, head, (pi, v) => pi === trim && v >= from);
  }
});

describe("Lockout: a battle rifle's stock reshaped in the editor still animates", () => {
  it("is longer, closed, weighted, and every viewmodel clip plays with it on the weapon", () => {
    const weapon = jointIndex(rifle, "weapon");
    // The rearmost piece of the gun: its stock.
    let rear = { primitive: -1, vertex: -1, z: Infinity };
    rifle.primitives.forEach((p, i) => {
      if (p.material.name !== "polymer") return;
      for (let v = 0; v < p.positions.length / 3; v += 1) if (p.positions[v * 3 + 2]! < rear.z) rear = { primitive: i, vertex: v, z: p.positions[v * 3 + 2]! };
    });
    expect(rear.primitive).toBeGreaterThanOrEqual(0);
    const topo = primitiveTopology(rifle.primitives[rear.primitive]!);
    const stock = selectLinked(rifle, { mode: "vertex", parts: rifle.primitives.map((_, i) => (i === rear.primitive ? [topo.weldOf[rear.vertex]!] : [])) });
    expect(selectionSize(stock)).toBeGreaterThan(4);
    // Its butt end pulled 4 cm further back.
    const centre = selectionPivot(rifle, stock)!;
    const butt = { mode: "vertex" as const, parts: stock.parts.map((ids) => ids.filter((w) => topo.weldPositions[w * 3 + 2]! < centre[2])) };
    expect(selectionSize(butt)).toBeGreaterThan(0);
    const longer = transformSelection(rifle, butt, { kind: "move", offset: [0, 0, -0.04] });
    expectSound(longer, "stock");
    const back = (m: MeshAsset) => {
      const p = m.primitives[rear.primitive]!;
      return Math.min(...Array.from({ length: p.positions.length / 3 }, (_, v) => p.positions[v * 3 + 2]!));
    };
    expect(back(longer)).toBeCloseTo(back(rifle) - 0.04, 5);
    const moved = selectionWelds(longer, stock)[rear.primitive]!;
    const checked = playsEveryClip("viewmodel-br", longer, weapon, (pi, v) => pi === rear.primitive && moved.has(topo.weldOf[v]!) && longer.primitives[pi]!.joints![v * 4] === weapon);
    expect(checked).toBeGreaterThan(0);
  });
});

// --- Helpers ---------------------------------------------------------------------

function isQuadFace(topo: ReturnType<typeof primitiveTopology>, f: number) {
  return topo.faces[f]!.loops.length === 1 && topo.faces[f]!.loop.length === 4;
}
function edgeKeyOf(a: number, b: number) {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}
function offset(p: MeshPrimitive, by: [number, number, number]): MeshPrimitive {
  return { ...p, positions: p.positions.map((v, k) => v + by[k % 3]!) };
}
function joinPrimitives(a: MeshPrimitive, b: MeshPrimitive): MeshPrimitive {
  const n = a.positions.length / 3;
  return {
    ...a,
    positions: Float32Array.from([...a.positions, ...b.positions]),
    normals: Float32Array.from([...a.normals!, ...b.normals!]),
    uvs: Float32Array.from([...a.uvs!, ...b.uvs!]),
    indices: Uint32Array.from([...a.indices, ...Array.from(b.indices, (i) => i + n)]),
  };
}
