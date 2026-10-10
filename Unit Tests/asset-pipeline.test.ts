/**
 * The asset pipeline (HALO_INFINITE_STYLE_ROADMAP.md I13): an artist's skinned
 * glTF arrives in one step — its skeleton, clips, a state machine to start
 * from, its PBR maps (a packed occlusion/roughness/metal map kept once) and its
 * material sets (KHR_materials_variants), which each placed copy can wear.
 */

import { describe, expect, it } from "vitest";
import {
  MAX_MESH_VARIANTS,
  applyMeshVariant,
  deserializeMeshAsset,
  encodeGlb,
  parseGlb,
  parseGltfText,
  serializeMeshAsset,
  type MeshAsset,
} from "@cartbox/editor";
import { parseMeshScene } from "@cartbox/player";
import { addImportedMesh, decodeMeshSidecar, emptyMeshSidecar, encodeMeshSidecar, setMeshVariant } from "@/lib/meshSidecar";
import { importSummary } from "@/lib/meshImport";
import { skinnedArmGltf } from "./helpers/skinnedGltf";

/** A data-URI image whose bytes are recognisable in a serialized mesh. */
const image = (tag: string) => ({ uri: `data:image/png;base64,${Buffer.from(`png-${tag}-${"x".repeat(40)}`).toString("base64")}`, mimeType: "image/png" });

/**
 * The skinned arm, dressed as an artist exports it from Blender: the body in
 * painted armour with one packed occlusion/roughness/metal map in both of its
 * slots, and two material sets — a battle-worn "Veteran" finish for the body
 * and a gold "Ceremonial" one for the body and the sword.
 */
function dressedArm(): string {
  const json = JSON.parse(skinnedArmGltf());
  json.images = [image("paint"), image("orm"), image("normal"), image("worn")];
  json.textures = [{ source: 0 }, { source: 1 }, { source: 2 }, { source: 3 }];
  json.materials = [
    { name: "armor", pbrMetallicRoughness: { baseColorTexture: { index: 0 }, metallicRoughnessTexture: { index: 1 }, roughnessFactor: 0.6 }, occlusionTexture: { index: 1 }, normalTexture: { index: 2 } },
    { name: "blade", pbrMetallicRoughness: { baseColorFactor: [0.6, 0.8, 1, 1], metallicFactor: 1 } },
    { name: "armor-veteran", pbrMetallicRoughness: { baseColorTexture: { index: 3 }, metallicRoughnessTexture: { index: 1 } }, occlusionTexture: { index: 1 }, normalTexture: { index: 2 } },
    { name: "gold", pbrMetallicRoughness: { baseColorFactor: [1, 0.8, 0.3, 1], metallicFactor: 1, roughnessFactor: 0.15 } },
  ];
  json.meshes[0].primitives[0].material = 0;
  json.meshes[0].primitives[0].extensions = { KHR_materials_variants: { mappings: [{ material: 2, variants: [0] }, { material: 3, variants: [1] }] } };
  json.meshes[1].primitives[0].material = 1;
  json.meshes[1].primitives[0].extensions = { KHR_materials_variants: { mappings: [{ material: 3, variants: [1] }] } };
  json.extensionsUsed = ["KHR_materials_variants"];
  json.extensions = { KHR_materials_variants: { variants: [{ name: "Veteran" }, { name: "Ceremonial" }, { name: "Unused" }] } };
  return JSON.stringify(json);
}

const count = (haystack: string, needle: string) => haystack.split(needle).length - 1;
const b64 = (tag: string) => Buffer.from(`png-${tag}-${"x".repeat(40)}`).toString("base64");

describe("importing an artist's glTF", () => {
  const mesh = parseGltfText(dressedArm(), "spartan");
  const [body, sword] = mesh.primitives;

  it("brings the skeleton and its clips with the PBR maps", () => {
    expect(mesh.skin?.joints.length).toBe(2);
    expect(mesh.clips?.map((c) => c.name)).toEqual(["bend", "wave"]);
    expect(body!.material.baseColorImage).not.toBeNull();
    expect(body!.material.normalImage).not.toBeNull();
    expect(body!.material.roughnessFactor).toBe(0.6);
  });

  it("keeps a packed occlusion/roughness/metal map as one image in both slots, stored once", () => {
    expect(body!.material.occlusionImage).toBe(body!.material.metallicRoughnessImage);
    const stored = serializeMeshAsset(mesh);
    expect(count(stored, b64("orm"))).toBe(1);
    const back = deserializeMeshAsset(stored);
    expect(back.primitives[0]!.material.occlusionImage).toBe(back.primitives[0]!.material.metallicRoughnessImage);
  });

  it("reads its material sets, dropping one that changes nothing", () => {
    expect(mesh.variants?.map((v) => v.name)).toEqual(["Veteran", "Ceremonial"]);
    const [veteran, ceremonial] = mesh.variants!;
    expect(veteran!.materials.map((m) => m?.name ?? null)).toEqual(["armor-veteran", null]);
    expect(ceremonial!.materials.map((m) => m?.name ?? null)).toEqual(["gold", "gold"]);
    // The same glTF material is one object wherever it's used, and a set shares the images it has in common.
    expect(ceremonial!.materials[0]).toBe(ceremonial!.materials[1]);
    expect(veteran!.materials[0]!.metallicRoughnessImage).toBe(body!.material.metallicRoughnessImage);
    expect(sword!.material.name).toBe("blade");
  });

  it("dresses a copy in a set, and leaves it as it is for an unknown one", () => {
    const worn = applyMeshVariant(mesh, "Veteran");
    expect(worn.primitives.map((p) => p.material.name)).toEqual(["armor-veteran", "blade"]);
    expect(worn.primitives[0]!.positions).toBe(body!.positions);
    expect(applyMeshVariant(mesh, "Nope")).toBe(mesh);
    expect(applyMeshVariant(mesh, undefined)).toBe(mesh);
  });

  it("stores its sets with the mesh, each shared image once, and rejects a malformed set", () => {
    const stored = serializeMeshAsset(mesh);
    expect(count(stored, b64("orm"))).toBe(1);
    expect(count(stored, b64("worn"))).toBe(1);
    const back = deserializeMeshAsset(stored);
    expect(back.variants?.map((v) => v.name)).toEqual(["Veteran", "Ceremonial"]);
    expect(back.variants![0]!.materials[0]!.baseColorImage!.bytes).toEqual(mesh.variants![0]!.materials[0]!.baseColorImage!.bytes);
    const raw = JSON.parse(stored);
    raw.variants[0].materials.pop();
    expect(() => deserializeMeshAsset(JSON.stringify(raw))).toThrow();
    raw.variants = Array.from({ length: MAX_MESH_VARIANTS + 1 }, (_, i) => ({ name: `v${i}`, materials: [null, null] }));
    expect(() => deserializeMeshAsset(JSON.stringify(raw))).toThrow();
  });

  it("exports back to GLB with its maps and sets, and reads in again the same", () => {
    const back = parseGlb(encodeGlb(mesh), "again");
    expect(back.variants?.map((v) => v.name)).toEqual(["Veteran", "Ceremonial"]);
    expect(back.variants![1]!.materials.map((m) => m?.name ?? null)).toEqual(["gold", "gold"]);
    const m = back.primitives[0]!.material;
    expect(m.occlusionImage).toBe(m.metallicRoughnessImage);
    expect(m.normalImage!.bytes).toEqual(body!.material.normalImage!.bytes);
    expect(m.roughnessFactor).toBe(0.6);
  });
});

describe("in the editor and the player", () => {
  const mesh = parseGltfText(dressedArm(), "spartan");

  it("adds an import in one step, with a state machine for its clips", () => {
    const { sidecar, id } = addImportedMesh(emptyMeshSidecar(), mesh);
    const entry = sidecar.meshes.find((m) => m.id === id)!;
    expect(entry.animator?.states.map((s) => s.clip)).toEqual(["bend", "wave"]);
    expect(importSummary(mesh)).toBe(" With a 2-joint skeleton with 2 clips and a state machine, 2 material sets, packed occlusion/roughness/metal maps.");
    // A model without clips gets no state machine.
    const still: MeshAsset = { name: "rock", primitives: mesh.primitives.slice(1).map((p) => ({ ...p, joints: undefined, weights: undefined })) };
    const plain = addImportedMesh(emptyMeshSidecar(), still);
    expect(plain.sidecar.meshes[0]!.animator).toBeUndefined();
  });

  it("lets each placed copy wear a set, which the player draws it in", () => {
    const first = addImportedMesh(emptyMeshSidecar(), mesh);
    const id = first.id;
    const second = addImportedMesh(first.sidecar, mesh);
    const sidecar = setMeshVariant(second.sidecar, id, "Ceremonial");
    // The set survives a save and load; an unknown one is ignored by the player.
    const saved = encodeMeshSidecar(sidecar);
    expect(decodeMeshSidecar(saved).meshes.find((m) => m.id === id)!.variant).toBe("Ceremonial");
    const scene = parseMeshScene(saved)!;
    expect(scene.instances[0]!.mesh.primitives.map((p) => p.material.name)).toEqual(["gold", "gold"]);
    expect(scene.instances[1]!.mesh.primitives.map((p) => p.material.name)).toEqual(["armor", "blade"]);
    const unknown = JSON.parse(saved);
    unknown.meshes[0].variant = "Nope";
    expect(parseMeshScene(JSON.stringify(unknown))!.instances[0]!.mesh.primitives[0]!.material.name).toBe("armor");
    // Back to its own materials.
    expect(setMeshVariant(sidecar, id, null).meshes.find((m) => m.id === id)!.variant).toBeUndefined();
  });
});

describe("Lockout's Spartans", () => {
  it("ship their armour in material sets, which the bots take turns wearing", async () => {
    const { LOCKOUT_BOT_VARIANTS, lockoutMeshSidecar } = await import("@cartbox/editor");
    const sidecar = lockoutMeshSidecar();
    const scene = parseMeshScene(sidecar)!;
    const bots = JSON.parse(sidecar).meshes.filter((m: { id: string }) => m.id.startsWith("bot-"));
    const worn = bots.map((b: { id: string }) => scene.instances.find((i) => i.id === b.id)!.mesh);
    expect(worn[0]!.variants?.map((v: { name: string }) => v.name)).toEqual(["Veteran", "Recon"]);
    expect(bots.map((b: { variant?: string }) => b.variant ?? null)).toEqual(bots.map((_: unknown, i: number) => LOCKOUT_BOT_VARIANTS[i % LOCKOUT_BOT_VARIANTS.length]));
    const names = (m: MeshAsset) => m.primitives.map((p) => p.material.name);
    expect(names(worn[0]!)).toEqual(["armor", "armor-trim", "undersuit", "visor", "rifle"]);
    expect(names(worn[1]!)).toEqual(["armor-veteran", "armor-trim-veteran", "undersuit", "visor-veteran", "rifle"]);
    expect(names(worn[2]!)).toEqual(["armor-recon", "armor-trim-recon", "undersuit", "visor-recon", "rifle"]);
    // Every set keeps the team colour in its plates, and bots in the same set share one dressed mesh.
    expect(worn[1]!.primitives[0]!.material.tintable).toBe(true);
    expect(worn[1]!.primitives[0]!.material.clearcoat).toBeUndefined();
    expect(worn[4]).toBe(worn[1]);
    // Their distance levels wear the same set.
    const lod = scene.instances.find((i) => i.id === bots[1].id)!.lod;
    expect(lod?.meshes.at(-1)!.primitives[0]!.material.name).toBe("armor-veteran");
  });
});
