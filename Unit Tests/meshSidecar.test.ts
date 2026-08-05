/**
 * Unit tests for the cart mesh sidecar: the round-trip through storage, the
 * immutable list operations the editor edits through, and the defensive decode
 * that must never let a corrupt entry blank the tab. Real {@link MeshAsset}
 * geometry goes in, and the assertions are on what would actually be stored.
 */

import { describe, expect, it } from "vitest";

import { type MeshAsset } from "@cartbox/editor";
import {
  addMesh,
  decodeMeshSidecar,
  encodeMeshSidecar,
  emptyMeshSidecar,
  readMeshEntry,
  removeMesh,
  renameMesh,
  setMeshTransform,
  defaultMeshTransform,
} from "@/lib/meshSidecar";

function triangle(): MeshAsset {
  return {
    name: "tri",
    primitives: [
      {
        positions: Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0]),
        normals: null,
        uvs: null,
        indices: Uint32Array.from([0, 1, 2]),
        material: { name: "m", baseColorFactor: [1, 0.5, 0, 1], baseColorImage: null },
      },
    ],
  };
}

describe("mesh sidecar", () => {
  it("round-trips an imported mesh and its geometry through encode → decode", () => {
    const { sidecar, id } = addMesh(emptyMeshSidecar(), triangle(), "Bot");
    const encoded = encodeMeshSidecar(sidecar);
    expect(encoded).not.toBeNull();

    const decoded = decodeMeshSidecar(encoded);
    expect(decoded.meshes).toHaveLength(1);
    expect(decoded.meshes[0]!.id).toBe(id);
    expect(decoded.meshes[0]!.name).toBe("Bot");
    expect(decoded.meshes[0]!.transform).toEqual(defaultMeshTransform());

    const mesh = readMeshEntry(decoded.meshes[0]!);
    expect(Array.from(mesh.primitives[0]!.positions)).toEqual([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    expect(mesh.primitives[0]!.material.baseColorFactor).toEqual([1, 0.5, 0, 1]);
  });

  it("stores nothing for an empty sidecar", () => {
    expect(encodeMeshSidecar(emptyMeshSidecar())).toBeNull();
  });

  it("edits transform, name, and membership immutably", () => {
    const { sidecar, id } = addMesh(emptyMeshSidecar(), triangle(), "A");
    const moved = setMeshTransform(sidecar, id, { position: [1, 2, 3], rotation: [0, 90, 0], scale: [2, 2, 2] });
    expect(moved.meshes[0]!.transform.position).toEqual([1, 2, 3]);
    expect(sidecar.meshes[0]!.transform).toEqual(defaultMeshTransform()); // original untouched

    const renamed = renameMesh(moved, id, "B");
    expect(renamed.meshes[0]!.name).toBe("B");

    const removed = removeMesh(renamed, id);
    expect(removed.meshes).toHaveLength(0);
  });

  it("drops a corrupt entry instead of throwing", () => {
    const { sidecar } = addMesh(emptyMeshSidecar(), triangle(), "good");
    const payload = JSON.parse(encodeMeshSidecar(sidecar)!);
    payload.meshes.push({ id: "x", name: "bad", mesh: "not-valid-json", transform: {} });
    const decoded = decodeMeshSidecar(JSON.stringify(payload));
    expect(decoded.meshes).toHaveLength(1); // only the good one survives
    expect(decoded.meshes[0]!.name).toBe("good");
  });

  it("returns an empty sidecar for null or unparseable input", () => {
    expect(decodeMeshSidecar(null).meshes).toHaveLength(0);
    expect(decodeMeshSidecar("}{").meshes).toHaveLength(0);
  });

  it("repairs a partial transform from the identity", () => {
    const { sidecar } = addMesh(emptyMeshSidecar(), triangle(), "t");
    const payload = JSON.parse(encodeMeshSidecar(sidecar)!);
    payload.meshes[0].transform = { position: [5, 5, 5] }; // rotation + scale missing
    const decoded = decodeMeshSidecar(JSON.stringify(payload));
    expect(decoded.meshes[0]!.transform).toEqual({ position: [5, 5, 5], rotation: [0, 0, 0], scale: [1, 1, 1] });
  });
});
