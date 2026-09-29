/**
 * Ragdolls (HALO2_STYLE_ROADMAP.md, H9): a skeleton goes limp and tumbles — it
 * keeps its bones' lengths, bends without folding, lands on boxes and sleeps
 * once settled; the pose rebuilt from it skins where the particles are; and
 * cartbox.ragdoll / unragdoll drive it through the runtime (in the real engine)
 * without touching the physics world. Lockout's soldiers use it.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

import {
  LOCKOUT_CODE,
  LOCKOUT_RAGDOLL_COLLIDERS,
  RAGDOLL_KILL_Y,
  Ragdoll,
  composeModelMatrix,
  jointWorldMatrices,
  lockoutMeshSidecar,
  parseRagdollColliders,
  ragdollBoxesFromCentreHalf,
  ragdollRadii,
  restPose,
  serializeMeshAsset,
  type MeshAsset,
  type RagdollBox,
} from "@cartbox/editor";
import {
  NET_WORDS,
  PHYS_BLOCK_BYTES,
  RAM_LAYOUTS,
  RuntimeChannel,
  codeChunks,
  injectSdk,
  parseMeshScene,
  physicsBlockAddress,
  runtimeSdkLua,
  sceneObjectsSdkLua,
} from "@cartbox/player";
import { prependLuaCode } from "../packages/player/src/cartseed";

const ENGINE = path.resolve(__dirname, "../packages/engine/dist/xbox360/engine.js");

const soldier: MeshAsset = parseMeshScene(lockoutMeshSidecar())!.instances.find((i) => i.mesh.skin)!.mesh;
const skin = soldier.skin!;
const J = (name: string) => skin.joints.findIndex((j) => j.name === name);
const floor = ragdollBoxesFromCentreHalf([[0, -0.5, 0, 20, 0.5, 20]]);
const dist = (a: readonly number[], b: readonly number[]) => Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!);
const run = (r: Ragdoll, boxes: readonly RagdollBox[], max = 1200) => {
  let n = 0;
  while (r.step(1 / 60, boxes) && n < max) n += 1;
  return n;
};

describe("ragdoll", () => {
  it("rebuilds the pose it died in exactly while nothing has moved", () => {
    const pose = restPose(skin);
    const world = composeModelMatrix([3, 0, -2], [0, 70, 0], [1, 1, 1]);
    const out = new Float32Array(pose.length);
    new Ragdoll(skin, pose, world).writePose(out, world);
    for (let i = 0; i < pose.length; i += 1) expect(Math.min(Math.abs(out[i]! - pose[i]!), Math.abs(out[i]! + pose[i]!))).toBeLessThan(1e-5);
  });

  it("falls, keeps its bones, lands on the floor without sinking in, and sleeps", () => {
    const pose = restPose(skin);
    const radii = ragdollRadii(soldier)!;
    const r = new Ragdoll(skin, pose, composeModelMatrix([0, 0, 0], [0, 0, 0], [1, 1, 1]), { radii, impulse: [0, 1, -3], joint: J("chest") });
    const bones = skin.joints.map((j, i) => (j.parent >= 0 ? dist(r.at(i), r.at(j.parent)) : 0));
    const steps = run(r, floor);
    expect(r.asleep).toBe(true);
    expect(steps).toBeLessThan(600); // settled well inside the 10 s limit
    skin.joints.forEach((j, i) => {
      if (j.parent >= 0) expect(Math.abs(dist(r.at(i), r.at(j.parent)) - bones[i]!)).toBeLessThan(0.01);
      // Resting on the deck: each joint about its radius above it, none below.
      expect(r.at(i)[1]).toBeGreaterThan(radii[i]! - 0.02);
      expect(r.at(i)[1]).toBeLessThan(0.6);
    });
    // Thrown back the way it was shoved (−Z), not left standing where it was.
    expect(r.at(J("chest"))[2]).toBeLessThan(-0.3);
  });

  it("bends a knee but never folds it flat", () => {
    const pose = restPose(skin);
    const r = new Ragdoll(skin, pose, composeModelMatrix([0, 0, 0], [0, 0, 0], [1, 1, 1]), { impulse: [0, 0, 6], joint: J("foot_l") });
    const rest = dist(r.at(J("foot_l")), r.at(J("thigh_l")));
    run(r, floor);
    const now = dist(r.at(J("foot_l")), r.at(J("thigh_l")));
    expect(now).toBeGreaterThanOrEqual(rest * 0.6 - 1e-3);
    expect(now).toBeLessThanOrEqual(rest + 1e-3);
  });

  it("slides off an oriented box's face and stops when it falls off the world", () => {
    const pose = restPose(skin);
    // A slab tipped 30° about Z under the body: it lands and slides down toward −X.
    const a = Math.PI / 6;
    const slab: RagdollBox = { center: [0, -0.4, 0], half: [3, 0.3, 3], axes: [[Math.cos(a), Math.sin(a), 0], [-Math.sin(a), Math.cos(a), 0], [0, 0, 1]] };
    const r = new Ragdoll(skin, pose, composeModelMatrix([0, 0.5, 0], [0, 0, 0], [1, 1, 1]));
    for (let i = 0; i < 90; i += 1) r.step(1 / 60, [slab]);
    expect(r.at(J("hips"))[0]).toBeLessThan(-0.2);
    // Nothing to land on: it drops until the kill plane puts it to sleep.
    const drop = new Ragdoll(skin, pose, composeModelMatrix([0, 0, 0], [0, 0, 0], [1, 1, 1]));
    run(drop, [], 20000);
    expect(drop.asleep).toBe(true);
    expect(Math.min(...skin.joints.map((_, i) => drop.at(i)[1]))).toBeLessThan(RAGDOLL_KILL_Y + 5);
  });

  it("skins where its particles are, in whatever frame the object is now", () => {
    const pose = restPose(skin);
    const death = composeModelMatrix([1, 0, 1], [0, 30, 0], [1.25, 1.25, 1.25]);
    const r = new Ragdoll(skin, pose, death, { impulse: [2, 0, 0] });
    for (let i = 0; i < 40; i += 1) r.step(1 / 60, floor);
    // The object has since been moved: the body stays where it fell.
    const now = composeModelMatrix([6, 2, -3], [0, -45, 0], [1.25, 1.25, 1.25]);
    const out = new Float32Array(pose.length);
    r.writePose(out, now);
    const m = jointWorldMatrices(skin, out);
    const apply = (p: number[]) => [0, 1, 2].map((k) => now[k]! * p[0]! + now[4 + k]! * p[1]! + now[8 + k]! * p[2]! + now[12 + k]!);
    for (const name of ["hips", "chest", "spine"]) {
      const j = J(name);
      expect(dist(apply([m[j * 16 + 12]!, m[j * 16 + 13]!, m[j * 16 + 14]!]), r.at(j))).toBeLessThan(0.08);
    }
  });

  it("sizes each joint from its armour and reads colliders defensively", () => {
    const radii = ragdollRadii(soldier)!;
    expect(radii[J("chest")]!).toBeGreaterThan(radii[J("forearm_l")]!);
    expect(radii[J("forearm_l")]!).toBeLessThanOrEqual(radii[J("upperarm_l")]! * 1.2 + 1e-9);
    expect(parseRagdollColliders([{ center: [1, 2, 3], half: [-1, 2, 3] }, { center: [1, 2] }, null, 5])).toEqual([{ center: [1, 2, 3], half: [1, 2, 3] }]);
    expect(parseRagdollColliders("nope")).toEqual([]);
  });
});

describe.skipIf(!existsSync(ENGINE))("cartbox.ragdoll (real engine)", () => {
  it("goes limp with a shove, lands on the scene's boxes, and stands back up on unragdoll", async () => {
    const layout = RAM_LAYOUTS.xbox360;
    const sc = parseMeshScene(
      JSON.stringify({
        version: 2,
        meshes: [{ id: "s", name: "s", mesh: serializeMeshAsset(soldier), transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] } }],
        ragdollColliders: [{ center: [0, -0.5, 0], half: [20, 0.5, 20] }],
      }),
    )!;
    expect(runtimeSdkLua(sc, layout, { physics: false })).toContain("cartbox.ragdoll");
    const code = `
t = 0
function TIC()
  t = t + 1
  if t == 3 then cartbox.ragdoll("s", 0, 1, -3, "chest") end
  if t == 200 then cartbox.unragdoll("s") end
  cartbox.ragdoll("nobody", 1, 2, 3)
  local _, hy = cartbox.joint("s", "head")
  if hy then pmem(100, math.floor(hy * 1000) & 0xffffffff) end
end`;
    let tic = codeChunks(new TextEncoder().encode(code));
    tic = prependLuaCode(tic, sceneObjectsSdkLua(sc));
    tic = prependLuaCode(tic, runtimeSdkLua(sc, layout, { physics: false }));
    tic = injectSdk(tic);
    const mod = await (await import(pathToFileURL(ENGINE).href)).default();
    const h = mod._cbx_create(44100);
    const ptr = mod._malloc(tic.length);
    mod.HEAPU8.set(tic, ptr);
    expect(mod._cbx_load(h, ptr, tic.length)).toBe(1);
    mod._free(ptr);
    const channel = new RuntimeChannel(sc, null);
    const base = mod._cbx_mailbox_ptr(h) - NET_WORDS * 4;
    const block = () => new DataView(mod.HEAPU8.buffer, base + physicsBlockAddress(layout) - layout.pmemAddress, PHYS_BLOCK_BYTES);
    const head = () => (new Int32Array(mod.HEAPU8.buffer, base, 256)[100]! | 0) / 1000;
    const tick = (n: number) => {
      for (let i = 0; i < n; i += 1) {
        channel.beforeTick(block());
        mod._cbx_tick(h, 0);
        channel.afterTick(block());
        channel.skinning(); // what the renderer does each frame
      }
    };
    tick(2);
    const standing = head();
    expect(standing).toBeGreaterThan(1.3);
    tick(150);
    expect(channel.isRagdoll(0)).toBe(true);
    expect(head()).toBeLessThan(0.5); // down on the floor
    tick(60); // unragdoll at t = 200
    expect(channel.isRagdoll(0)).toBe(false);
    expect(head()).toBeCloseTo(standing, 2);
    channel.destroy();
  }, 120_000);
});

describe("Lockout", () => {
  it("throws killed soldiers as ragdolls onto the level's colliders, and stands them up on respawn", () => {
    expect(LOCKOUT_CODE).toContain("cartbox.ragdoll(i,");
    expect(LOCKOUT_CODE).toContain("cartbox.unragdoll(i)");
    const sc = parseMeshScene(lockoutMeshSidecar())!;
    expect(sc.ragdollColliders!.length).toBe(LOCKOUT_RAGDOLL_COLLIDERS.length);
    // The deck is among them: a body dropped on it comes to rest on top (y ≈ 0).
    const r = new Ragdoll(skin, restPose(skin), composeModelMatrix([6, 0.05, -8], [0, 0, 0], [1, 1, 1]), { radii: ragdollRadii(soldier)!, impulse: [0, 0.5, 2] });
    run(r, sc.ragdollColliders!);
    expect(r.at(J("hips"))[1]).toBeGreaterThan(0);
    expect(r.at(J("hips"))[1]).toBeLessThan(0.5);
  });
});
