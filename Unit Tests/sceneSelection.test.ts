/**
 * Selection and object operations (ENGINE_PARITY_ROADMAP.md EP3): selection
 * roots, duplicating and deleting whole subtrees, copy and paste through the
 * clipboard (strictly checked, landing where the copies were in the world),
 * click and box selection.
 */

import { describe, expect, it } from "vitest";

import { composeModelMatrix, multiplyMat4, serializeMeshAsset, type MeshAsset } from "@cartbox/editor";

import { decodeMeshSidecar, emptyMeshSidecar, encodeMeshSidecar, type MeshSidecar, type MeshSidecarEntry } from "@/lib/meshSidecar";
import {
  CLIPBOARD_KIND,
  boxSelect,
  clickSelection,
  copyPayload,
  duplicateEntries,
  nextName,
  pasteEntries,
  removeEntries,
  selectionRoots,
  withSubtrees,
} from "@/lib/sceneSelection";

const quad: MeshAsset = {
  name: "q",
  primitives: [{ positions: Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0]), normals: null, uvs: null, indices: Uint32Array.from([0, 1, 2]), material: { name: "m", baseColorFactor: [1, 1, 1, 1], baseColorImage: null } }],
};
const mesh = serializeMeshAsset(quad);
const entry = (id: string, over: Partial<MeshSidecarEntry> = {}): MeshSidecarEntry => ({ id, name: id, mesh, transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }, ...over });

/** car ← wheel ← bolt, a lone crate, and a prefab copy (door, with its handle). */
function scene(): MeshSidecar {
  return {
    ...emptyMeshSidecar(),
    meshes: [
      entry("car", { transform: { position: [10, 0, 0], rotation: [0, 90, 0], scale: [2, 2, 2] } }),
      entry("wheel", { parent: "car", transform: { position: [1, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] } }),
      entry("bolt", { parent: "wheel" }),
      entry("crate", { tags: ["loot"], props: { hp: 5 } }),
      entry("door", { prefab: { id: "p1", node: "root", instance: "door" } }),
      entry("handle", { parent: "door", prefab: { id: "p1", node: "handle", instance: "door" } }),
    ],
  };
}

describe("selection roots and subtrees", () => {
  it("keeps only the selected objects whose ancestors aren't selected", () => {
    expect(selectionRoots(scene(), ["bolt", "car", "crate"])).toEqual(["car", "crate"]);
    expect(selectionRoots(scene(), ["wheel", "bolt"])).toEqual(["wheel"]);
    expect(selectionRoots(scene(), ["nope"])).toEqual([]);
  });

  it("adds everything under the given objects", () => {
    expect(withSubtrees(scene(), ["car"])).toEqual(["car", "wheel", "bolt"]);
    expect(withSubtrees(scene(), ["wheel", "crate"])).toEqual(["wheel", "bolt", "crate"]);
  });

  it("names copies like an engine does", () => {
    expect(nextName("Crate", new Set())).toBe("Crate (1)");
    expect(nextName("Crate (1)", new Set(["Crate (2)"]))).toBe("Crate (3)");
  });
});

describe("duplicate and delete", () => {
  it("duplicates whole subtrees in place under the same parents, with fresh ids, and selects the copies", () => {
    const base = scene();
    const { sidecar, ids } = duplicateEntries(base, ["wheel", "crate"]);
    expect(sidecar.meshes).toHaveLength(base.meshes.length + 3);
    const copies = sidecar.meshes.slice(base.meshes.length);
    expect(ids).toEqual([copies[0]!.id, copies[2]!.id]);
    expect(copies.map((c) => c.name)).toEqual(["wheel (1)", "bolt", "crate (1)"]);
    expect(copies[0]!.parent).toBe("car"); // a root copy stays beside its original
    expect(copies[1]!.parent).toBe(copies[0]!.id); // its child follows the copy
    expect(copies[2]!.tags).toEqual(["loot"]);
    expect(new Set(sidecar.meshes.map((m) => m.id)).size).toBe(sidecar.meshes.length);
  });

  it("keeps a prefab link only when the whole placed copy came along", () => {
    const whole = duplicateEntries(scene(), ["door"]).sidecar.meshes.slice(-2);
    expect(whole[0]!.prefab?.instance).toBe(whole[0]!.id);
    expect(whole[1]!.prefab?.instance).toBe(whole[0]!.id);
    const part = duplicateEntries(scene(), ["handle"]).sidecar.meshes.at(-1)!;
    expect(part.prefab).toBeUndefined();
  });

  it("deletes the selection with everything under it", () => {
    expect(removeEntries(scene(), ["wheel"]).meshes.map((m) => m.id)).toEqual(["car", "crate", "door", "handle"]);
    expect(removeEntries(scene(), []).meshes).toHaveLength(6);
  });
});

describe("copy and paste", () => {
  it("pastes copies where the originals were in the world, at the top level, with their children", () => {
    const base = scene();
    const text = copyPayload(base, ["wheel"])!;
    expect(JSON.parse(text).kind).toBe(CLIPBOARD_KIND);
    const { sidecar, ids } = pasteEntries(emptyMeshSidecar(), text);
    expect(sidecar.meshes.map((m) => m.name)).toEqual(["wheel (1)", "bolt"]);
    const root = sidecar.meshes[0]!;
    expect(root.parent).toBeUndefined();
    expect(ids).toEqual([root.id]);
    // The wheel sat at car · wheel in the world.
    const was = multiplyMat4(composeModelMatrix([10, 0, 0], [0, 90, 0], [2, 2, 2]), composeModelMatrix([1, 0, 0], [0, 0, 0], [1, 1, 1]));
    const now = composeModelMatrix(root.transform.position, root.transform.rotation, root.transform.scale);
    for (let k = 0; k < 16; k += 1) expect(now[k]).toBeCloseTo(was[k]!, 5);
    // Pasting twice gives two independent copies.
    const again = pasteEntries(sidecar, text);
    expect(new Set(again.sidecar.meshes.map((m) => m.id)).size).toBe(4);
  });

  it("refuses anything that isn't Cartbox scene objects, and drops malformed entries", () => {
    const base = scene();
    expect(pasteEntries(base, "not json").ids).toEqual([]);
    expect(pasteEntries(base, JSON.stringify({ meshes: base.meshes })).ids).toEqual([]); // no marker
    const bad = JSON.stringify({ kind: CLIPBOARD_KIND, meshes: [{ id: "x", name: "x", mesh: 42, transform: "nope" }] });
    expect(pasteEntries(base, bad).sidecar).toBe(base);
    const mixed = JSON.stringify({ kind: CLIPBOARD_KIND, meshes: [{ id: "x", name: "x", mesh: 42 }, entry("ok")] });
    expect(pasteEntries(base, mixed).sidecar.meshes.at(-1)!.name).toBe("ok (1)");
  });

  it("pastes into a cart that round-trips through storage", () => {
    const { sidecar } = pasteEntries(emptyMeshSidecar(), copyPayload(scene(), ["car"])!);
    expect(decodeMeshSidecar(encodeMeshSidecar(sidecar)).meshes).toEqual(sidecar.meshes);
  });
});

describe("click and box selection", () => {
  it("replaces, adds and toggles, with the clicked one last", () => {
    expect(clickSelection(["a", "b"], "c", {})).toEqual(["c"]);
    expect(clickSelection(["a", "b"], "a", { add: true })).toEqual(["b", "a"]);
    expect(clickSelection(["a", "b"], "a", { toggle: true })).toEqual(["b"]);
    expect(clickSelection(["a"], "c", { toggle: true })).toEqual(["a", "c"]);
    expect(clickSelection(["a"], null, {})).toEqual([]);
    expect(clickSelection(["a"], null, { add: true })).toEqual(["a"]);
  });

  it("takes the objects whose box centres fall inside the rectangle", () => {
    const objects = [
      { id: "in", min: [0, 0, 0] as const, max: [2, 2, 2] as const },
      { id: "out", min: [10, 0, 0] as const, max: [12, 2, 2] as const },
      { id: "behind", min: [0, 0, 0] as const, max: [1, 1, 1] as const },
    ];
    const project = (p: readonly [number, number, number]) => (p[0] < 1 ? null : ([p[0] * 10, p[1] * 10] as const));
    expect(boxSelect(objects, { x0: 30, y0: 30, x1: 0, y1: 0 }, project)).toEqual(["in"]);
  });
});
