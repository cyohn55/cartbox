/**
 * Spartans (HALO_INFINITE_STYLE_ROADMAP.md I11): team-colour masks by part,
 * Lockout's higher-detail armour with its reflective visor, and the armour's
 * own moves — a melee, a flinch and a landing — driven by the bots.
 */

import { describe, expect, it } from "vitest";
import {
  LOCKOUT_CODE,
  LOCKOUT_SOLDIER_ANIMATOR,
  deserializeMeshAsset,
  lockoutMeshSidecar,
  readMeshLibrary,
  resolveMeshRef,
  serializeMeshAsset,
  type MeshAsset,
} from "@cartbox/editor";
import { AnimationSession, TINT_PALETTE, parseMeshScene } from "@cartbox/player";
import { tintMesh } from "../packages/player/src/mesh/MeshOverlaySurface";

const DT = 1 / 60;

describe("team-colour masks", () => {
  const part = (name: string, tintMix?: number) => ({
    positions: new Float32Array(9),
    normals: null,
    uvs: null,
    indices: Uint32Array.from([0, 1, 2]),
    material: { name, baseColorFactor: [0.2, 0.4, 0.6, 1] as [number, number, number, number], baseColorImage: null, tintable: true, ...(tintMix !== undefined ? { tintMix } : {}) },
  });

  it("paint a part the team colour outright, or mix in only its share", () => {
    const mesh: MeshAsset = { name: "m", primitives: [part("plate"), part("trim", 0.25)] };
    const red = TINT_PALETTE[1]!;
    const tinted = tintMesh(mesh, 1);
    expect(tinted.primitives[0]!.material.baseColorFactor.slice(0, 3)).toEqual([...red]);
    tinted.primitives[1]!.material.baseColorFactor.slice(0, 3).forEach((v, k) => expect(v).toBeCloseTo([0.2, 0.4, 0.6][k]! + (red[k]! - [0.2, 0.4, 0.6][k]!) * 0.25, 9));
  });

  it("survive a save and load, and only on a tintable part", () => {
    const mesh: MeshAsset = { name: "m", primitives: [part("trim", 0.25)] };
    expect(deserializeMeshAsset(serializeMeshAsset(mesh)).primitives[0]!.material.tintMix).toBe(0.25);
    const plain = { ...mesh, primitives: [{ ...part("trim", 0.25), material: { ...part("trim", 0.25).material, tintable: false } }] };
    expect(deserializeMeshAsset(serializeMeshAsset(plain)).primitives[0]!.material.tintMix).toBeUndefined();
  });
});

describe("Lockout's Spartans", () => {
  const sidecar = JSON.parse(lockoutMeshSidecar());
  const library = readMeshLibrary(sidecar.library);
  const soldier = deserializeMeshAsset(resolveMeshRef(sidecar.meshes.find((m: { id: string }) => m.id === "bot-1").mesh, library)!);
  const material = (name: string) => soldier.primitives.find((p) => p.material.name === name)!.material;

  it("wear team-colour plates over grey trim that takes a hint of the team colour", () => {
    expect(material("armor").tintable).toBe(true);
    expect(material("armor").tintMix).toBeUndefined();
    expect(material("armor-trim").tintable).toBe(true);
    expect(material("armor-trim").tintMix).toBeGreaterThan(0);
    expect(material("armor-trim").tintMix).toBeLessThan(0.5);
  });

  it("have a gold mirror visor, coated and smooth enough to reflect the arena", () => {
    const visor = material("visor");
    expect(visor.metallicFactor).toBeGreaterThan(0.9);
    expect(visor.roughnessFactor).toBeLessThan(0.1);
    expect(visor.clearcoat).toBe(1);
    expect(visor.reflectivity).toBeGreaterThan(1);
  });

  it("are built in more detail than before, yet stored lighter (no normals; a byte a vertex for its joints)", () => {
    const triangles = soldier.primitives.reduce((n, p) => n + p.indices.length / 3, 0);
    expect(triangles).toBeGreaterThan(1000);
    const stored = resolveMeshRef(sidecar.meshes.find((m: { id: string }) => m.id === "bot-1").mesh, library)!;
    expect(stored.length).toBeLessThan(100_000);
  });

  it("play a melee and a flinch on their triggers, and land after a jump", () => {
    const scene = parseMeshScene(lockoutMeshSidecar())!;
    const bot = 1;
    const s = new AnimationSession(scene);
    const param = (name: string) => LOCKOUT_SOLDIER_ANIMATOR.params.findIndex((p) => p.name === name);
    const state = () => LOCKOUT_SOLDIER_ANIMATOR.states[s.state().find((p) => p.object === bot)!.state]?.name;
    s.step(DT);
    for (const [trigger, name] of [["melee", "melee"], ["hit", "hit"]] as const) {
      s.setParam(bot, param(trigger), 1);
      s.step(DT);
      expect(state()).toBe(name);
      for (let t = 0; t < 60; t += 1) s.step(DT);
      expect(state()).toBe("move");
    }
    s.setParam(bot, param("grounded"), 0);
    s.step(DT);
    expect(state()).toBe("air");
    s.setParam(bot, param("grounded"), 1);
    s.step(DT);
    expect(state()).toBe("land");
    for (let t = 0; t < 40; t += 1) s.step(DT);
    expect(state()).toBe("move");
    // Killed from any of them.
    s.setParam(bot, param("melee"), 1);
    s.step(DT);
    s.setParam(bot, param("dead"), 1);
    s.step(DT);
    expect(state()).toBe("die");
  });

  it("swing up close and flinch when hit, as the cart says", () => {
    expect(LOCKOUT_CODE).toContain('cartbox.trigger(i, "melee")');
    expect(LOCKOUT_CODE).toContain('cartbox.trigger(i, "hit")');
    expect(LOCKOUT_CODE).toContain("target.flinch = true");
    expect(LOCKOUT_CODE).toContain("if w.melee or m < 1.8 then o.swing = true");
  });
});
