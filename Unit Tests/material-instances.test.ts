/**
 * Material instances (EDITOR_PRO_ROADMAP.md P1b): a parent in the cart's
 * library, instances that take every field they don't override from it,
 * edits that become overrides, a parent's edit reaching every instance in
 * the sidecar, and the round trip through storage.
 */

import { describe, expect, it } from "vitest";

import {
  INSTANCE_FIELDS,
  addLibraryMaterial,
  applyToParent,
  deserializeMeshAsset,
  detachInstance,
  generateTextures,
  instanceOf,
  readInstanceLink,
  replaceMaterial,
  resolveInstance,
  revertOverride,
  serializeMeshAsset,
  setLibraryMaterial,
  trackOverrides,
  type MeshAsset,
  type MeshMaterial,
} from "@cartbox/editor";
import { addMesh, decodeMeshSidecar, encodeMeshSidecar, emptyMeshSidecar, readMeshEntry, setMaterialLibrary, setMeshAsset } from "@/lib/meshSidecar";

const ROCK: MeshMaterial = {
  name: "Canyon stone",
  baseColorFactor: [0.6, 0.55, 0.5, 1],
  baseColorImage: null,
  roughnessFactor: 0.9,
  metallicFactor: 0,
  generator: { kind: "rock", seed: 1, scale: 1, tint: [1, 1, 1], size: 64 },
};

function mesh(material: MeshMaterial, name = "boulder"): MeshAsset {
  return {
    name,
    primitives: [
      {
        positions: Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0]),
        normals: null,
        uvs: Float32Array.from([0, 0, 1, 0, 0, 1]),
        indices: Uint32Array.from([0, 1, 2]),
        material,
      },
    ],
  };
}

const own = (m: MeshAsset) => m.primitives[0]!.material;

describe("material instances", () => {
  it("take every field from the parent but the ones they override, and keep their own name and light map", () => {
    const parent = ROCK;
    const lightmap = { mime: "image/png" as const, bytes: new Uint8Array([1, 2, 3]) };
    const inst = resolveInstance(
      { name: "Boulder 3", baseColorFactor: [0.2, 0.2, 0.2, 1], baseColorImage: null, roughnessFactor: 0.4, lightmapImage: lightmap, instance: { of: "rock", overrides: ["roughnessFactor"] } },
      parent,
    );
    expect(inst.name).toBe("Boulder 3");
    expect(inst.baseColorFactor).toEqual(parent.baseColorFactor);
    expect(inst.roughnessFactor).toBe(0.4);
    expect(inst.generator).toEqual(parent.generator);
    expect(inst.lightmapImage).toBe(lightmap);
  });

  it("make an edited field an override, so the parent's edit of it leaves the instance alone", () => {
    const added = addLibraryMaterial([], ROCK)!;
    expect(added.id).toBe("canyon-stone");
    expect(added.material.instance).toEqual({ of: "canyon-stone", overrides: [] });
    const tinted = trackOverrides(added.material, { ...added.material, baseColorFactor: [0.7, 0.4, 0.3, 1] });
    expect(tinted.instance!.overrides).toEqual(["baseColorFactor"]);
    // The parent gets rougher and redder: the instance takes the roughness but keeps its colour.
    const library = setLibraryMaterial(added.library, "canyon-stone", { ...ROCK, roughnessFactor: 0.5, baseColorFactor: [1, 0, 0, 1] });
    const after = resolveInstance(tinted, library[0]!.material);
    expect(after.roughnessFactor).toBe(0.5);
    expect(after.baseColorFactor).toEqual([0.7, 0.4, 0.3, 1]);
    // Reverting the override takes the parent's colour again.
    const reverted = revertOverride(after, "baseColorFactor", library[0]!.material);
    expect(reverted.baseColorFactor).toEqual([1, 0, 0, 1]);
    expect(reverted.instance!.overrides).toEqual([]);
  });

  it("bake an overridden generator's maps from the instance's own recipe", () => {
    const parent = { ...ROCK, baseColorImage: generateTextures(ROCK.generator!).albedo };
    const reseeded = { ...ROCK.generator!, seed: 9 };
    const inst = resolveInstance({ ...instanceOf(ROCK, "rock", parent), generator: reseeded, instance: { of: "rock", overrides: ["generator"] } }, parent);
    expect(inst.baseColorImage).toBe(generateTextures(reseeded).albedo);
    expect(inst.normalImage).toBe(generateTextures(reseeded).normal);
  });

  it("push overrides up to the parent, and cut an instance loose keeping its values", () => {
    const added = addLibraryMaterial([], ROCK)!;
    const edited = trackOverrides(added.material, { ...added.material, roughnessFactor: 0.3 });
    const pushed = applyToParent(added.library, edited);
    expect(pushed.library[0]!.material.roughnessFactor).toBe(0.3);
    expect(pushed.library[0]!.material.name).toBe("Canyon stone");
    expect(pushed.library[0]!.material.instance).toBeUndefined();
    expect(pushed.material.instance!.overrides).toEqual([]);
    const loose = detachInstance(pushed.material);
    expect(loose.instance).toBeUndefined();
    expect(loose.roughnessFactor).toBe(0.3);
  });

  it("list every inheritable field once, and read stored links defensively", () => {
    const fields = INSTANCE_FIELDS.map(([f]) => f);
    expect(new Set(fields).size).toBe(fields.length);
    expect(fields).not.toContain("name");
    expect(fields).not.toContain("lightmapImage");
    expect(readInstanceLink({ of: "x", overrides: ["roughnessFactor", "bogus", "baseColorFactor", "roughnessFactor"] })).toEqual({ of: "x", overrides: ["baseColorFactor", "roughnessFactor"] });
    expect(readInstanceLink({ of: "" })).toBeUndefined();
    expect(readInstanceLink("x")).toBeUndefined();
  });

  it("round-trip the link with the mesh, and replace a material whole", () => {
    const inst = addLibraryMaterial([], ROCK)!.material;
    const edited = trackOverrides(inst, { ...inst, metallicFactor: 0.5 });
    const back = own(deserializeMeshAsset(serializeMeshAsset(mesh(edited))));
    expect(back.instance).toEqual({ of: "canyon-stone", overrides: ["metallicFactor"] });
    // Replacing (unlike patching) drops what the new material lacks.
    expect(own(replaceMaterial(mesh(edited), 0, detachInstance(edited))).instance).toBeUndefined();
  });
});

describe("the sidecar's material library", () => {
  it("is stored with the cart and read back", () => {
    const added = addLibraryMaterial([], ROCK)!;
    let sidecar = addMesh(emptyMeshSidecar(), mesh(added.material), "Boulder").sidecar;
    sidecar = setMaterialLibrary(sidecar, added.library);
    const back = decodeMeshSidecar(encodeMeshSidecar(sidecar));
    expect(back.materials?.map((m) => m.id)).toEqual(["canyon-stone"]);
    expect(back.materials![0]!.material.roughnessFactor).toBe(0.9);
    // The generator's maps are baked again on load, not stored.
    expect(back.materials![0]!.material.baseColorImage).toBe(generateTextures(ROCK.generator!).albedo);
    expect(decodeMeshSidecar(JSON.stringify({ meshes: [], materials: [{ id: "a", material: {} }, { id: "a", material: {} }, { id: 3 }] })).materials?.length).toBe(1);
  });

  it("carries a parent's edit to every instance of it, sparing overrides and other parents' instances", () => {
    const added = addLibraryMaterial([], ROCK)!;
    const other = addLibraryMaterial(added.library, { ...ROCK, name: "Moss" })!;
    let sidecar = emptyMeshSidecar();
    const a = addMesh(sidecar, mesh(added.material, "a"), "A");
    const b = addMesh(a.sidecar, mesh(trackOverrides(added.material, { ...added.material, roughnessFactor: 0.2 }), "b"), "B");
    const c = addMesh(b.sidecar, mesh(other.material, "c"), "C");
    sidecar = setMaterialLibrary(c.sidecar, other.library);
    const untouched = sidecar.meshes[2]!.mesh;

    const library = setLibraryMaterial(sidecar.materials!, "canyon-stone", { ...ROCK, roughnessFactor: 0.6, metallicFactor: 0.25 });
    const next = setMaterialLibrary(sidecar, library);
    const [ma, mb, mc] = next.meshes.map(readMeshEntry);
    expect(own(ma!).roughnessFactor).toBe(0.6);
    expect(own(ma!).metallicFactor).toBe(0.25);
    expect(own(mb!).roughnessFactor).toBe(0.2); // overridden
    expect(own(mb!).metallicFactor).toBe(0.25);
    expect(own(mc!).metallicFactor).toBe(0);
    expect(next.meshes[2]!.mesh).toBe(untouched); // another parent's instance isn't even decoded

    // Removing the parent cuts its instances loose, keeping their values.
    const gone = setMaterialLibrary(next, setLibraryMaterial(next.materials!, "canyon-stone", null));
    const loose = own(readMeshEntry(gone.meshes[0]!));
    expect(loose.instance).toBeUndefined();
    expect(loose.roughnessFactor).toBe(0.6);
    expect(gone.materials?.map((m) => m.id)).toEqual(["moss"]);
  });

  it("follows a part's own edit made with the library change", () => {
    const added = addLibraryMaterial([], ROCK)!;
    const placed = addMesh(emptyMeshSidecar(), mesh(ROCK), "A");
    const next = setMaterialLibrary(setMeshAsset(placed.sidecar, placed.id, mesh(added.material)), added.library);
    expect(own(readMeshEntry(next.meshes[0]!)).instance?.of).toBe("canyon-stone");
  });
});
