/**
 * The modular kit in the Mesh tab (EDITOR_PRO_ROADMAP.md P5): add a kit piece
 * or a parametric shape, change a shape's parameters (it's built again, its
 * materials kept), add CSG brushes, and join, cut or intersect one scene
 * object with another where they stand in the world. Pure: the Kit panel
 * uses it, and the tests check it.
 */

import {
  KIT_PIECES,
  brushSolid,
  buildKitPiece,
  buildParametric,
  csg,
  defaultParametric,
  invertAffine,
  meshClosure,
  rebuildParametric,
  type BrushShape,
  type CsgOp,
  type MeshAsset,
  type MeshMaterial,
  type MeshPrimitive,
  type ParametricKind,
  type ParametricShape,
} from "@cartbox/editor";

import { addMesh, meshWorldMatrices, readMeshEntry, removeMesh, setMeshAsset, setMeshTransform, type MeshSidecar } from "./meshSidecar";

/** Set (or with null, clear) an entry's parametric shape. */
function setShape(sidecar: MeshSidecar, id: string, shape: ParametricShape | null): MeshSidecar {
  return {
    ...sidecar,
    meshes: sidecar.meshes.map((m) => {
      if (m.id !== id) return m;
      const { shape: _old, ...rest } = m;
      void _old;
      return shape ? { ...rest, shape } : rest;
    }),
  };
}

/** Add a new scene object built from a shape (named, at `at`), remembering the shape. */
function addShaped(sidecar: MeshSidecar, mesh: MeshAsset, shape: ParametricShape, name: string, at: readonly [number, number, number]): { sidecar: MeshSidecar; id: string } {
  const added = addMesh(sidecar, mesh, name);
  const placed = setMeshTransform(added.sidecar, added.id, { position: [at[0], at[1], at[2]], rotation: [0, 0, 0], scale: [1, 1, 1] });
  return { sidecar: setShape(placed, added.id, shape), id: added.id };
}

/** Add a kit piece (by its id) at a spot. */
export function addKitPiece(sidecar: MeshSidecar, pieceId: string, at: readonly [number, number, number] = [0, 0, 0]): { sidecar: MeshSidecar; id: string } | null {
  const kit = KIT_PIECES.find((k) => k.id === pieceId);
  return kit ? addShaped(sidecar, buildKitPiece(kit), kit.shape, kit.label, at) : null;
}

/** Add a plain parametric shape at a spot. */
export function addParametric(sidecar: MeshSidecar, kind: ParametricKind, at: readonly [number, number, number] = [0, 0, 0]): { sidecar: MeshSidecar; id: string } {
  const shape = defaultParametric(kind);
  return addShaped(sidecar, buildParametric(shape), shape, kind[0]!.toUpperCase() + kind.slice(1), at);
}

/** Change one parameter of an object's shape: it's built again, keeping the materials it wears. */
export function setShapeParam(sidecar: MeshSidecar, id: string, key: string, value: number): MeshSidecar {
  const entry = sidecar.meshes.find((m) => m.id === id);
  if (!entry?.shape) return sidecar;
  const shape: ParametricShape = { kind: entry.shape.kind, params: { ...entry.shape.params, [key]: value } };
  const rebuilt = rebuildParametric(shape, readMeshEntry(entry));
  return setShape(setMeshAsset(sidecar, id, rebuilt), id, shape);
}

/** A CSG brush: see-through, so what it will cut or add shows while it's placed. */
const BRUSH_LOOK: MeshMaterial = { name: "brush", baseColorFactor: [0.55, 0.75, 1, 0.35], baseColorImage: null, metallicFactor: 0, roughnessFactor: 0.6, alphaMode: "blend" };

/** Add a CSG brush (a box, cylinder or wedge, 1 × 2 × 1 by default) at a spot. */
export function addBrush(sidecar: MeshSidecar, shape: BrushShape, at: readonly [number, number, number] = [0, 1, 0], size: readonly [number, number, number] = [1, 2, 1]): { sidecar: MeshSidecar; id: string } {
  const added = addMesh(sidecar, brushSolid(shape, size, BRUSH_LOOK), `${shape[0]!.toUpperCase()}${shape.slice(1)} brush`);
  return { sidecar: setMeshTransform(added.sidecar, added.id, { position: [at[0], at[1], at[2]], rotation: [0, 0, 0], scale: [1, 1, 1] }), id: added.id };
}

/** Every primitive of a mesh as one, for the closure check (a boolean's parts of several materials still make one solid). */
function oneOf(mesh: MeshAsset): MeshPrimitive | null {
  if (mesh.primitives.length === 0) return null;
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

/**
 * Join, cut or intersect: object `target` with object `tool`, where they
 * stand in the world. The target takes the result (no longer a parametric
 * shape: its mesh is what it is now); the tool is removed unless `keepTool`.
 * Faces a cut leaves take the target's material. Reports whether the result
 * is a closed solid.
 */
export function applyBoolean(sidecar: MeshSidecar, targetId: string, toolId: string, op: CsgOp, keepTool = false): { sidecar: MeshSidecar; closed: boolean } | { problem: string } {
  if (targetId === toolId) return { problem: "Pick another object to use on this one." };
  const ti = sidecar.meshes.findIndex((m) => m.id === targetId);
  const ui = sidecar.meshes.findIndex((m) => m.id === toolId);
  if (ti < 0 || ui < 0) return { problem: "One of those objects is gone." };
  const worlds = meshWorldMatrices(sidecar);
  const inverse = invertAffine(worlds[ti]!);
  if (!inverse) return { problem: "That object is scaled flat; it can't be cut." };
  // The tool in the target's own space.
  const a = inverse, b = worlds[ui]!;
  const bModel = new Float64Array(16);
  for (let c = 0; c < 4; c += 1) for (let r = 0; r < 4; r += 1) for (let k = 0; k < 4; k += 1) bModel[c * 4 + r] = bModel[c * 4 + r]! + a[k * 4 + r]! * b[c * 4 + k]!;
  const result = csg(readMeshEntry(sidecar.meshes[ti]!), readMeshEntry(sidecar.meshes[ui]!), op, { bModel });
  if (result.primitives.length === 0) return { problem: op === "intersect" ? "They don't overlap: nothing would be left." : "Nothing would be left of it." };
  let next = setShape(setMeshAsset(sidecar, targetId, result), targetId, null);
  if (!keepTool) next = removeMesh(next, toolId);
  const merged = oneOf(result);
  return { sidecar: next, closed: merged ? meshClosure(merged).closed : false };
}
