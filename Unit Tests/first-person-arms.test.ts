/**
 * First-person arms and viewmodel animation (HALO_INFINITE_STYLE_ROADMAP.md
 * I9): every Lockout weapon's viewmodel is skinned to a small rig, carries its
 * clips and runs a state machine the cart drives — and a part bound wholly to
 * one joint is stored as just that joint.
 */

import { describe, expect, it } from "vitest";
import {
  LOCKOUT_CODE,
  LOCKOUT_VIEWMODELS,
  LOCKOUT_VIEWMODEL_ANIMATOR,
  createLiveSkinnedMesh,
  deserializeMeshAsset,
  findClip,
  lockoutMeshSidecar,
  readMeshLibrary,
  resolveMeshRef,
  sampleClip,
  serializeMeshAsset,
  skinMatrices,
  type MeshAsset,
} from "@cartbox/editor";
import { AnimationSession, parseMeshScene } from "@cartbox/player";

const DT = 1 / 60;
const sidecar = JSON.parse(lockoutMeshSidecar());
const library = readMeshLibrary(sidecar.library);
const storedMesh = (id: string): string => resolveMeshRef(sidecar.meshes.find((m: { id: string }) => m.id === id).mesh, library)!;
const viewmodel = (id: string): MeshAsset => deserializeMeshAsset(storedMesh(`viewmodel-${id}`));

/** Where a primitive's vertices end up after posing `clip` at `t` seconds. */
function posed(mesh: MeshAsset, clip: string, t: number): Float32Array[] {
  const live = createLiveSkinnedMesh(mesh);
  live.update(skinMatrices(mesh.skin!, sampleClip(mesh.skin!, mesh.clips![findClip(mesh, clip)]!, t, false)));
  return live.mesh.primitives.map((p) => p.positions);
}

const centroid = (positions: Float32Array): number[] => {
  const c = [0, 0, 0];
  for (let i = 0; i < positions.length; i += 3) for (let k = 0; k < 3; k += 1) c[k]! += positions[i + k]! / (positions.length / 3);
  return c;
};

describe("the rig", () => {
  it("skins every viewmodel: root, weapon and left hand, with its six clips", () => {
    for (const id of LOCKOUT_VIEWMODELS) {
      const mesh = viewmodel(id);
      expect(mesh.skin!.joints.map((j) => j.name), id).toEqual(["root", "weapon", "hand_l"]);
      expect(mesh.clips!.map((c) => c.name).sort(), id).toEqual(["fire", "idle", "melee", "ready", "reload", "run"]);
      expect(mesh.primitives.every((p) => p.joints && p.weights), id).toBe(true);
    }
  });

  it("takes the left hand off the gun in a reload, and leaves it on otherwise", () => {
    const mesh = viewmodel("br");
    const leftGlove = mesh.primitives.findIndex((p) => p.material.name === "glove" && p.joints![0] === 2);
    const gun = mesh.primitives.findIndex((p) => p.material.name === "polymer");
    const rest = posed(mesh, "idle", 0);
    const reloading = posed(mesh, "reload", 0.45);
    const handMoved = centroid(reloading[leftGlove]!).map((v, k) => v - centroid(rest[leftGlove]!)[k]!);
    const gunMoved = centroid(reloading[gun]!).map((v, k) => v - centroid(rest[gun]!)[k]!);
    // The hand drops toward the magazine, well apart from how the tipped gun moved.
    expect(Math.hypot(...handMoved.map((v, k) => v - gunMoved[k]!))).toBeGreaterThan(0.05);
  });

  it("kicks back on a shot, lunges forward in a melee, and is raised from below on a swap", () => {
    const mesh = viewmodel("br");
    const gun = mesh.primitives.findIndex((p) => p.material.name === "polymer");
    const at = (clip: string, t: number) => centroid(posed(mesh, clip, t)[gun]!);
    const rest = at("idle", 0);
    expect(at("fire", 0.03)[2]!).toBeLessThan(rest[2]! - 0.01); // back toward the eye
    expect(at("melee", 0.13)[2]!).toBeGreaterThan(rest[2]! + 0.05); // out toward the target
    expect(at("ready", 0)[1]!).toBeLessThan(rest[1]! - 0.1); // starts low
    expect(at("ready", 0.35)[1]!).toBeCloseTo(rest[1]!, 2); // ends where it is held
  });

  it("swings the sword across the view for both its attack and its melee", () => {
    const mesh = viewmodel("sword");
    const blade = mesh.primitives.findIndex((p) => p.material.name === "plasma");
    const x = (clip: string, t: number) => centroid(posed(mesh, clip, t)[blade]!)[0]!;
    // Wound back to one side, then carried across to the other.
    expect(Math.abs(x("fire", 0.08) - x("fire", 0.3))).toBeGreaterThan(0.05);
    expect(x("melee", 0.3)).toBeCloseTo(x("fire", 0.3), 6);
  });
});

describe("rigid parts on disk", () => {
  it("store just their joint, and read back to the same binding", () => {
    const mesh = viewmodel("smg");
    const stored = JSON.parse(serializeMeshAsset(mesh));
    expect(stored.primitives.every((p: { bone?: number; joints?: string }) => typeof p.bone === "number" && p.joints === undefined)).toBe(true);
    const back = deserializeMeshAsset(serializeMeshAsset(mesh));
    back.primitives.forEach((p, k) => {
      expect(Array.from(p.joints!)).toEqual(Array.from(mesh.primitives[k]!.joints!));
      expect(Array.from(p.weights!)).toEqual(Array.from(mesh.primitives[k]!.weights!));
    });
  });

  it("keep per-vertex joints where a part is shared between joints, and refuse a joint out of range", () => {
    const soldier = JSON.parse(storedMesh("bot-1"));
    expect(soldier.primitives.some((p: { joints?: string }) => typeof p.joints === "string")).toBe(true);
    const stored = JSON.parse(serializeMeshAsset(viewmodel("smg")));
    stored.primitives[0].bone = 9;
    expect(() => deserializeMeshAsset(JSON.stringify(stored))).toThrow();
  });
});

describe("the state machine", () => {
  const scene = parseMeshScene(lockoutMeshSidecar())!;
  const index = scene.instances.findIndex((i) => i.name === "viewmodel br");
  const param = (name: string) => LOCKOUT_VIEWMODEL_ANIMATOR.params.findIndex((p) => p.name === name);
  const stateName = (s: AnimationSession) => LOCKOUT_VIEWMODEL_ANIMATOR.states[s.state().find((p) => p.object === index)!.state]?.name;

  it("runs on every viewmodel", () => {
    for (const id of LOCKOUT_VIEWMODELS) expect(scene.instances.find((i) => i.name === `viewmodel ${id}`)!.animator, id).toBeDefined();
  });

  it("plays each one-shot on its trigger and returns to moving when it is done", () => {
    const s = new AnimationSession(scene);
    s.step(DT);
    expect(stateName(s)).toBe("move");
    for (const name of ["fire", "reload", "melee", "ready"]) {
      s.setParam(index, param(name), 1);
      s.step(DT);
      expect(stateName(s), name).toBe(name);
      for (let t = 0; t < 120; t += 1) s.step(DT);
      expect(stateName(s), `after ${name}`).toBe("move");
    }
  });

  it("starts the kick again on a shot during a shot", () => {
    const s = new AnimationSession(scene);
    s.setParam(index, param("fire"), 1);
    s.step(DT);
    for (let t = 0; t < 5; t += 1) s.step(DT);
    const before = s.state().find((p) => p.object === index)!.time;
    s.setParam(index, param("fire"), 1);
    s.step(DT);
    expect(stateName(s)).toBe("fire");
    expect(s.state().find((p) => p.object === index)!.time).toBeLessThan(before);
  });
});

describe("the cart", () => {
  it("tells the arms what happens, and no longer bobs or kicks the gun itself", () => {
    for (const name of ["fire", "reload", "melee", "ready"]) expect(LOCKOUT_CODE, name).toContain(`vm("${name}")`);
    expect(LOCKOUT_CODE).toContain('cartbox.set(idx, "speed", sp)');
    expect(LOCKOUT_CODE).not.toMatch(/math\.sin\(bob\)/);
    expect(LOCKOUT_CODE).toContain("cartbox.meshpose(idx, px*WS, py*WS, pz*WS, p.ay, -p.ap, 0, WS, 0, armor_tint(p), true)");
  });
});
