/**
 * Prefabs (ENGINE_ROADMAP.md, Phase 1): capturing an object and its children as a
 * reusable group, placing copies, Apply pushing one copy's edits to the prefab and
 * every other copy (keeping their overrides), Revert, Unlink, Delete, and the
 * sidecar round trip (prefab meshes deduplicated with the placed ones). The
 * runtime sees ordinary objects, so a placed copy plays like any other.
 */

import { describe, expect, it } from "vitest";

import type { MeshAsset } from "@cartbox/editor";
import { parseMeshScene } from "@cartbox/player";
import {
  addMesh,
  decodeMeshSidecar,
  emptyMeshSidecar,
  encodeMeshSidecar,
  renameMesh,
  setMeshParent,
  setMeshProp,
  setMeshTags,
  setMeshTransform,
  type MeshSidecar,
} from "../apps/web/src/lib/meshSidecar";
import {
  applyToPrefab,
  createPrefab,
  deletePrefab,
  overrideCount,
  placePrefab,
  prefabInstances,
  revertToPrefab,
  unlinkPrefab,
} from "../apps/web/src/lib/meshPrefabs";

function quad(r = 1): MeshAsset {
  return {
    name: "quad",
    primitives: [
      {
        positions: Float32Array.from([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]),
        normals: Float32Array.from([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
        uvs: null,
        indices: Uint32Array.from([0, 1, 2, 0, 2, 3]),
        material: { name: "m", baseColorFactor: [r, 0, 0, 1], baseColorImage: null },
      },
    ],
  };
}

const T = (position: [number, number, number]) => ({ position, rotation: [0, 0, 0] as [number, number, number], scale: [1, 1, 1] as [number, number, number] });

/** A turret (base + barrel with hp 40), saved as a prefab. */
function turretScene(): { sc: MeshSidecar; prefabId: string; baseId: string } {
  let sc = emptyMeshSidecar();
  const base = addMesh(sc, quad(), "turret");
  sc = base.sidecar;
  const barrel = addMesh(sc, quad(0.5), "barrel");
  sc = barrel.sidecar;
  sc = setMeshTransform(sc, base.id, T([5, 0, 0]));
  sc = setMeshTransform(sc, barrel.id, T([0, 1, 0]));
  sc = setMeshParent(sc, barrel.id, base.id, { keepWorld: false });
  sc = setMeshProp(sc, barrel.id, "hp", 40);
  sc = setMeshTags(sc, base.id, ["enemy"]);
  const made = createPrefab(sc, base.id, "Turret");
  return { sc: made.sidecar, prefabId: made.prefabId, baseId: base.id };
}

const copyOf = (sc: MeshSidecar, rootId: string) => sc.meshes.filter((m) => m.prefab?.instance === rootId);
const nodeIn = (sc: MeshSidecar, rootId: string, name: string) => copyOf(sc, rootId).find((m) => m.name === name)!;

describe("prefabs", () => {
  it("captures a subtree, links it as the first copy, and places more copies", () => {
    const { sc, prefabId, baseId } = turretScene();
    expect(sc.prefabs).toHaveLength(1);
    expect(sc.prefabs![0]!.nodes.map((n) => [n.name, n.parent ?? null])).toEqual([
      ["turret", null],
      ["barrel", "n0"],
    ]);
    expect(copyOf(sc, baseId)).toHaveLength(2);

    const placed = placePrefab(sc, prefabId, { transform: T([-5, 0, 3]) });
    expect(prefabInstances(placed.sidecar, prefabId)).toEqual([baseId, placed.rootId]);
    const barrel = nodeIn(placed.sidecar, placed.rootId, "barrel");
    expect(barrel.parent).toBe(placed.rootId);
    expect(barrel.props).toEqual({ hp: 40 });
    // Copies get their own names so code can find each one.
    expect(placed.sidecar.meshes.find((m) => m.id === placed.rootId)!.name).toBe("turret 2");
    expect(nodeIn(placed.sidecar, placed.rootId, "turret 2").tags).toEqual(["enemy"]);
    expect(overrideCount(placed.sidecar, placed.rootId)).toBe(0);
    // The runtime just sees objects: the new barrel sits 1 above its own base.
    const inst = parseMeshScene(encodeMeshSidecar(placed.sidecar))!.instances.find((i) => i.id === barrel.id)!;
    expect([inst.model[12], inst.model[13], inst.model[14]]).toEqual([-5, 1, 3]);
  });

  it("applies one copy's edits to the prefab and the others, keeping their overrides", () => {
    const { sc: s0, prefabId, baseId } = turretScene();
    let sc = placePrefab(s0, prefabId, { transform: T([-5, 0, 0]) }).sidecar;
    const second = prefabInstances(sc, prefabId)[1]!;
    const third = placePrefab(sc, prefabId, { transform: T([0, 0, 9]) });
    sc = third.sidecar;
    // The third copy overrides its barrel's hp.
    sc = setMeshProp(sc, nodeIn(sc, third.rootId, "barrel").id, "hp", 99);
    expect(overrideCount(sc, third.rootId)).toBe(1);

    // Edit the first copy: rename the barrel, raise it, give it hp 50, then Apply.
    const firstBarrel = nodeIn(sc, baseId, "barrel");
    sc = renameMesh(sc, firstBarrel.id, "cannon");
    sc = setMeshTransform(sc, firstBarrel.id, T([0, 2, 0]));
    sc = setMeshProp(sc, firstBarrel.id, "hp", 50);
    expect(overrideCount(sc, baseId)).toBe(3);
    sc = applyToPrefab(sc, baseId);
    expect(overrideCount(sc, baseId)).toBe(0);

    // The untouched second copy takes everything.
    const b2 = nodeIn(sc, second, "cannon");
    expect(b2.transform.position).toEqual([0, 2, 0]);
    expect(b2.props).toEqual({ hp: 50 });
    // The third keeps its hp override but takes the rest.
    const b3 = nodeIn(sc, third.rootId, "cannon");
    expect(b3.props).toEqual({ hp: 99 });
    expect(b3.transform.position).toEqual([0, 2, 0]);
    // Placements never move.
    expect(sc.meshes.find((m) => m.id === second)!.transform.position).toEqual([-5, 0, 0]);
  });

  it("adds objects placed under a copy to every copy on Apply, and removes deleted ones", () => {
    const { sc: s0, prefabId, baseId } = turretScene();
    let sc = placePrefab(s0, prefabId).sidecar;
    const other = prefabInstances(sc, prefabId)[1]!;
    const light = addMesh(sc, quad(0.2), "light");
    sc = setMeshParent(light.sidecar, light.id, baseId, { keepWorld: false });
    sc = applyToPrefab(sc, baseId);
    expect(copyOf(sc, other).map((m) => m.name).sort()).toEqual(["barrel", "light", "turret 2"]);
    expect(nodeIn(sc, other, "light").parent).toBe(other);

    // Remove the barrel from the first copy and Apply: it goes from the other too.
    sc = { ...sc, meshes: sc.meshes.filter((m) => m.id !== nodeIn(sc, baseId, "barrel").id) };
    sc = applyToPrefab(sc, baseId);
    expect(copyOf(sc, other).map((m) => m.name).sort()).toEqual(["light", "turret 2"]);
  });

  it("reverts a copy's overrides, and unlinks or deletes without losing objects", () => {
    const { sc: s0, prefabId, baseId } = turretScene();
    let sc = setMeshProp(s0, nodeIn(s0, baseId, "barrel").id, "hp", 1);
    sc = setMeshTransform(sc, baseId, T([7, 7, 7])); // the root's placement isn't an override
    expect(overrideCount(sc, baseId)).toBe(1);
    sc = revertToPrefab(sc, baseId);
    expect(nodeIn(sc, baseId, "barrel").props).toEqual({ hp: 40 });
    expect(sc.meshes.find((m) => m.id === baseId)!.transform.position).toEqual([7, 7, 7]);

    const unlinked = unlinkPrefab(sc, baseId);
    expect(unlinked.meshes.every((m) => !m.prefab)).toBe(true);
    const deleted = deletePrefab(sc, prefabId);
    expect(deleted.prefabs).toEqual([]);
    expect(deleted.meshes).toHaveLength(2);
  });

  it("round-trips through storage, sharing prefab meshes with placed ones", () => {
    const { sc: s0, prefabId } = turretScene();
    const sc = placePrefab(placePrefab(s0, prefabId).sidecar, prefabId).sidecar;
    const raw = encodeMeshSidecar(sc)!;
    const back = decodeMeshSidecar(raw);
    expect(back.prefabs![0]!.nodes.map((n) => n.name)).toEqual(["turret", "barrel"]);
    expect(back.meshes.filter((m) => m.prefab).length).toBe(6);
    // Two distinct meshes stored once each, however many copies and prefab nodes use them.
    const stored = JSON.parse(raw) as { library?: Record<string, string> };
    expect(Object.keys(stored.library ?? {})).toHaveLength(2);
    // A link to a prefab that's gone is dropped on load.
    const orphan = JSON.parse(raw) as { prefabs?: unknown };
    delete orphan.prefabs;
    expect(decodeMeshSidecar(JSON.stringify(orphan)).meshes.some((m) => m.prefab)).toBe(false);
  });
});
