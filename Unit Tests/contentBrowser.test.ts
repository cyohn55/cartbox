/**
 * The content browser (ENGINE_PARITY_ROADMAP.md EP4): collecting a scene's
 * assets (shared meshes, prefabs, materials, textures, effects, decals,
 * debris), searching them, finding what uses them in the scene and the code,
 * renaming them safely, and placing them.
 */

import { describe, expect, it } from "vitest";

import { deserializeMeshAsset, lockoutMeshSidecar, particlePreset, serializeMeshAsset, type MeshAsset } from "@cartbox/editor";

import { codeReferences, collectAssets, filterAssets, hashString, placeAsset, renameAsset, renameInCode, sceneReferences } from "@/lib/contentBrowser";
import { createPrefab } from "@/lib/meshPrefabs";
import { decodeMeshSidecar, emptyMeshSidecar, type MeshSidecar, type MeshSidecarEntry } from "@/lib/meshSidecar";

const png = new Uint8Array([137, 80, 78, 71, 1, 2, 3, 4]);
function brick(material: string, image = false): MeshAsset {
  return {
    name: `${material}-brick`,
    primitives: [
      {
        positions: Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0]),
        normals: null,
        uvs: Float32Array.from([0, 0, 1, 0, 0, 1]),
        indices: Uint32Array.from([0, 1, 2]),
        material: { name: material, baseColorFactor: [0.8, 0.2, 0.1, 1], baseColorImage: image ? { mime: "image/png", bytes: png } : null },
      },
    ],
  };
}
const entry = (id: string, mesh: string, over: Partial<MeshSidecarEntry> = {}): MeshSidecarEntry => ({ id, name: id, mesh, transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }, ...over });

function scene(): MeshSidecar {
  const crate = serializeMeshAsset(brick("wood", true));
  const rock = serializeMeshAsset(brick("stone"));
  let sc: MeshSidecar = {
    ...emptyMeshSidecar(),
    meshes: [entry("crate", crate), entry("crate2", crate), entry("rock", rock)],
    effects: [{ ...particlePreset("sparks", "sparks") }],
    decals: [{ name: "scorch", pattern: "scorch", size: 1, life: 0, color: [1, 1, 1], opacity: 1 } as never],
    decalMarks: [{ decal: "scorch", position: [0, 0, 0], normal: [0, 1, 0], size: 0, angle: 0 } as never],
  };
  sc = createPrefab(sc, "rock", "boulder").sidecar;
  return { ...sc, debris: [{ name: "chips", source: "boulder", without: ["stone"], life: 3, bounce: 0.3, friction: 0.5, max: 8 }] };
}

describe("collecting assets", () => {
  it("lists shared meshes once with their users, prefabs with their copies, materials, textures, effects, decals and debris", () => {
    const assets = collectAssets(scene());
    const mesh = assets.find((a) => a.kind === "mesh" && a.name === "wood-brick")!;
    expect(mesh.objects).toEqual(["crate", "crate2"]);
    expect(mesh.detail).toContain("2 uses");
    expect(assets.find((a) => a.kind === "prefab")).toMatchObject({ name: "boulder", objects: ["rock"] });
    expect(assets.filter((a) => a.kind === "material").map((a) => a.name).sort()).toEqual(["stone", "wood"]);
    const texture = assets.find((a) => a.kind === "texture")!;
    expect(texture.objects).toEqual(["crate", "crate2"]);
    expect(texture.image?.bytes).toEqual(png);
    expect(assets.find((a) => a.kind === "effect")?.name).toBe("sparks");
    expect(assets.find((a) => a.kind === "decal")?.detail).toContain("1 mark");
    expect(assets.find((a) => a.kind === "debris")?.detail).toBe("from boulder");
  });

  it("searches by name or detail, within a folder or all of them", () => {
    const assets = collectAssets(scene());
    expect(filterAssets(assets, "all", "WOOD").map((a) => a.kind).sort()).toEqual(["material", "mesh", "texture"]);
    expect(filterAssets(assets, "material", "").length).toBe(2);
    expect(filterAssets(assets, "effect", "wood")).toEqual([]);
  });

  it("collects the Lockout starter's assets: the soldier mesh shared by its seven bots", () => {
    const sc = decodeMeshSidecar(lockoutMeshSidecar());
    const assets = collectAssets(sc);
    expect(assets.some((a) => a.kind === "mesh" && a.objects.length === 7)).toBe(true);
    expect(assets.some((a) => a.kind === "prefab" && a.name === "casing")).toBe(true);
    expect(assets.some((a) => a.kind === "debris" && a.name === "drop_br")).toBe(true);
  });
});

describe("references", () => {
  it("finds a name as a whole string literal in the code, and renames those literals", () => {
    const code = `cartbox.burst("sparks", 0, 0, 0)\nlocal s = 'sparks'\nprint("sparks_big")\n-- sparks`;
    expect(codeReferences(code, "sparks")).toEqual([1, 2]);
    const renamed = renameInCode(code, "sparks", "embers");
    expect(renamed.count).toBe(2);
    expect(renamed.code).toBe(`cartbox.burst("embers", 0, 0, 0)\nlocal s = 'embers'\nprint("sparks_big")\n-- sparks`);
    expect(codeReferences("x(\"a.b\")", "a.b")).toEqual([1]);
    expect(codeReferences("x(\"axb\")", "a.b")).toEqual([]); // the name is matched literally
  });

  it("names what else in the scene refers to an asset", () => {
    const sc = scene();
    const assets = collectAssets(sc);
    expect(sceneReferences(sc, assets.find((a) => a.kind === "prefab")!)).toEqual(["Debris “chips” is drawn from it"]);
    expect(sceneReferences(sc, assets.find((a) => a.kind === "material" && a.name === "stone")!)).toEqual(["Debris “chips” leaves it off"]);
  });
});

describe("safe renames", () => {
  it("carries a prefab's new name to the debris drawn from it", () => {
    const sc = scene();
    const prefab = collectAssets(sc).find((a) => a.kind === "prefab")!;
    const next = renameAsset(sc, prefab, "big rock");
    expect(next.prefabs![0]!.name).toBe("big rock");
    expect(next.debris![0]!.source).toBe("big rock");
  });

  it("renames a material inside every mesh and in debris that leaves it off", () => {
    const sc = scene();
    const next = renameAsset(sc, collectAssets(sc).find((a) => a.kind === "material" && a.name === "stone")!, "granite");
    const rock = deserializeMeshAsset(next.meshes.find((m) => m.id === "rock")!.mesh);
    expect(rock.primitives[0]!.material.name).toBe("granite");
    expect(next.debris![0]!.without).toEqual(["granite"]);
    // The wood meshes are untouched (byte for byte).
    expect(next.meshes.find((m) => m.id === "crate")!.mesh).toBe(sc.meshes.find((m) => m.id === "crate")!.mesh);
  });

  it("renames a decal and its marks, an effect, and debris; and refuses empty or taken names", () => {
    const sc = scene();
    const assets = collectAssets(sc);
    const decal = renameAsset(sc, assets.find((a) => a.kind === "decal")!, "burn");
    expect(decal.decals![0]!.name).toBe("burn");
    expect(decal.decalMarks![0]!.decal).toBe("burn");
    expect(renameAsset(sc, assets.find((a) => a.kind === "effect")!, "embers").effects![0]!.name).toBe("embers");
    expect(renameAsset(sc, assets.find((a) => a.kind === "debris")!, "rubble").debris![0]!.name).toBe("rubble");
    expect(renameAsset(sc, assets.find((a) => a.kind === "material" && a.name === "stone")!, "wood")).toBe(sc);
    expect(renameAsset(sc, assets.find((a) => a.kind === "effect")!, "  ")).toBe(sc);
    expect(renameAsset(sc, assets.find((a) => a.kind === "mesh")!, "anything")).toBe(sc);
  });
});

describe("placing", () => {
  it("places a mesh as a new object wearing that geometry, and a prefab as a new copy, where it was dropped", () => {
    const sc = scene();
    const assets = collectAssets(sc);
    const mesh = assets.find((a) => a.kind === "mesh" && a.name === "wood-brick")!;
    const placed = placeAsset(sc, mesh, [1, 2, 3]);
    const added = placed.sidecar.meshes.find((m) => m.id === placed.id)!;
    expect(added.mesh).toBe(sc.meshes[0]!.mesh);
    expect(added.name).toBe("crate (1)");
    expect(added.transform.position).toEqual([1, 2, 3]);
    expect(hashString(added.mesh)).toBe(mesh.key);
    const copy = placeAsset(sc, assets.find((a) => a.kind === "prefab")!, [5, 0, 0]);
    const root = copy.sidecar.meshes.find((m) => m.id === copy.id)!;
    expect(root.prefab?.id).toBe(sc.prefabs![0]!.id);
    expect(root.transform.position).toEqual([5, 0, 0]);
    expect(placeAsset(sc, assets.find((a) => a.kind === "effect")!, [0, 0, 0]).id).toBeNull();
  });
});
