/**
 * Lockout's assets as editable data (LOCKOUT_MULTIPLAYER_ROADMAP.md L13): a
 * model replaced in place — every copy of it, each object keeping its id,
 * place, animator and material set — after a check that it keeps the joints,
 * clips and material sets the cart uses; and the demo laying a saved cart's
 * Spartans, viewmodels and pickups over its own, where they keep that
 * contract. End to end: a Spartan sent out as GLB (L14), reshaped as Blender
 * would, brought back and saved, is what the demo's bots wear.
 */

import { describe, expect, it } from "vitest";
import { deserializeMeshAsset, encodeGlb, lockoutMeshSidecar, parseGlb, type MeshAsset } from "@cartbox/editor";
import { parseMeshScene } from "@cartbox/player";

import { decodeMeshSidecar, encodeMeshSidecar, type MeshSidecar } from "../apps/web/src/lib/meshSidecar";
import { animatorClips, assetContract, contractKept, describeContract, replaceModel, replacementContract } from "../apps/web/src/lib/meshReplace";
import { isLockoutAsset, isLockoutSidecar, lockoutSidecarWithAssets, overlayLockoutAssets } from "../apps/web/src/lib/lockoutAssets";

const base: MeshSidecar = decodeMeshSidecar(lockoutMeshSidecar());
const entry = (s: MeshSidecar, id: string) => s.meshes.find((m) => m.id === id)!;
const soldier: MeshAsset = deserializeMeshAsset(entry(base, "bot-1").mesh);
const bots = base.meshes.filter((m) => /^bot-\d+$/.test(m.id)).map((m) => m.id);

/** The soldier with every position pushed out 5% (a bulkier Spartan), as an edit in Blender might leave it. */
function bulkier(mesh: MeshAsset): MeshAsset {
  return { ...mesh, primitives: mesh.primitives.map((p) => ({ ...p, positions: p.positions.map((v) => v * 1.05) })) };
}

/** The soldier without a joint and a clip the cart uses. */
function brokenRig(mesh: MeshAsset): MeshAsset {
  return {
    ...mesh,
    skin: { ...mesh.skin!, joints: mesh.skin!.joints.map((j) => (j.name === "head" ? { ...j, name: "skull" } : j)) },
    clips: (mesh.clips ?? []).filter((c) => c.name !== "run"),
  };
}

describe("replacing a model in place", () => {
  it("puts it on every copy, each keeping its id, place, animator and material set", () => {
    const { sidecar, replaced } = replaceModel(base, "bot-3", bulkier(soldier));
    expect([...replaced].sort()).toEqual([...bots].sort());
    for (const id of bots) {
      const before = entry(base, id);
      const after = entry(sidecar, id);
      expect(after.mesh).not.toBe(before.mesh);
      expect(after.transform).toEqual(before.transform);
      expect(after.animator).toEqual(before.animator);
      expect(after.variant).toBe(before.variant);
      expect(sidecar.meshes.indexOf(after)).toBe(base.meshes.indexOf(before));
    }
    // Everything else is untouched.
    expect(entry(sidecar, "viewmodel-br").mesh).toBe(entry(base, "viewmodel-br").mesh);
    expect(sidecar.meshes).toHaveLength(base.meshes.length);
  });

  it("says what a replacement lacks that the cart uses: joints, clips the state machine plays, material sets", () => {
    expect(contractKept(replacementContract(base, "bot-1", bulkier(soldier))!)).toBe(true);
    const contract = replacementContract(base, "bot-1", brokenRig(soldier))!;
    expect(contract.missingJoints).toEqual(["head"]);
    expect(contract.missingClips).toContain("run");
    expect(animatorClips(entry(base, "bot-1").animator)).toContain("run");
    const plain = { ...soldier, variants: undefined };
    expect(replacementContract(base, "bot-2", plain)!.missingVariants.length).toBeGreaterThan(0);
    expect(describeContract(contract)).toMatch(/^Missing joints head; clips .*run/);
    expect(assetContract(soldier, soldier).missingJoints).toEqual([]);
  });

  it("drops a material set the new model doesn't have, and keeps the rest of the object", () => {
    const plain = { ...soldier, variants: undefined };
    const { sidecar } = replaceModel(base, "bot-1", plain);
    for (const id of bots) expect(entry(sidecar, id).variant).toBeUndefined();
    expect(entry(sidecar, "bot-1").animator).toEqual(entry(base, "bot-1").animator);
  });
});

describe("the demo with a saved cart's assets", () => {
  it("knows Lockout's assets and carts", () => {
    expect(["bot-1", "viewmodel-sword", "pickup-3"].every(isLockoutAsset)).toBe(true);
    expect(["lockout-map", "kit-wall", "bot"].some(isLockoutAsset)).toBe(false);
    expect(isLockoutSidecar(base)).toBe(true);
  });

  it("plays the saved Spartans in place of its own, and nothing else of the cart", () => {
    const saved = replaceModel(base, "bot-1", bulkier(soldier)).sidecar;
    // The saved cart also moved the arena: the demo keeps its own.
    const moved = { ...saved, meshes: saved.meshes.map((m) => (m.id === "lockout-map" ? { ...m, transform: { ...m.transform, position: [9, 9, 9] as [number, number, number] } } : m)) };
    const overlay = overlayLockoutAssets(base, moved);
    expect([...overlay.replaced].sort()).toEqual([...bots].sort());
    expect(overlay.refused).toEqual([]);
    expect(entry(overlay.sidecar, "bot-5").mesh).toBe(entry(saved, "bot-5").mesh);
    expect(entry(overlay.sidecar, "lockout-map")).toEqual(entry(base, "lockout-map"));
  });

  it("keeps its own model for an asset whose replacement breaks the contract, saying why", () => {
    const saved = replaceModel(base, "bot-1", brokenRig(soldier)).sidecar;
    const overlay = overlayLockoutAssets(base, saved);
    expect(overlay.replaced).toEqual([]);
    expect(overlay.refused).toHaveLength(bots.length);
    expect(overlay.refused[0]!.reason).toMatch(/head/);
    expect(entry(overlay.sidecar, "bot-1").mesh).toBe(entry(base, "bot-1").mesh);
  });

  it("plays the demo unchanged when there's no saved cart, or it changed nothing", () => {
    const json = lockoutMeshSidecar();
    expect(lockoutSidecarWithAssets(json, null)).toEqual({ json, overlay: null });
    const same = lockoutSidecarWithAssets(json, encodeMeshSidecar(base));
    expect(same.json).toBe(json);
    expect(same.overlay!.replaced).toEqual([]);
  });

  it("plays a Spartan sent out to Blender as GLB, reshaped, and brought back (L14 + L13)", () => {
    // Out and back: the GLB carries the rig and clips; "Blender" bulks the armour.
    const back = parseGlb(encodeGlb(soldier), soldier.name);
    const edited = bulkier(back);
    expect(contractKept(replacementContract(base, "bot-1", edited)!)).toBe(true);
    const saved = encodeMeshSidecar(replaceModel(base, "bot-1", edited).sidecar)!;
    const { json, overlay } = lockoutSidecarWithAssets(lockoutMeshSidecar(), saved);
    expect(overlay!.replaced).toHaveLength(bots.length);
    // The demo's scene parses, and its bots wear the bulkier Spartan.
    const scene = parseMeshScene(json)!;
    const botIndex = decodeMeshSidecar(json).meshes.findIndex((m) => m.id === "bot-1");
    const worn = scene.instances[botIndex]!.mesh;
    const reach = (m: MeshAsset) => Math.max(...m.primitives.flatMap((p) => Array.from(p.positions, Math.abs)));
    expect(reach(worn) / reach(soldier)).toBeCloseTo(1.05, 3);
    expect(worn.skin?.joints.map((j) => j.name)).toEqual(soldier.skin?.joints.map((j) => j.name));
    expect(worn.clips?.map((c) => c.name)).toEqual(soldier.clips?.map((c) => c.name));
  });
});
