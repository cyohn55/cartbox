/**
 * Inverse kinematics (ENGINE_ROADMAP.md, Phase 3): two-bone limbs reach their
 * targets without stretching, bend toward a pole, straighten toward targets out
 * of reach and blend by weight; look-at turns a joint toward a point within a
 * limit.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

import { createLiveSkinnedMesh, jointPosition, restPose, serializeMeshAsset, skinMatrices, solveLookAt, solveTwoBoneIK } from "@cartbox/editor";
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
import { skinnedLeg } from "./helpers/skinnedLeg";

const ENGINE = path.resolve(__dirname, "../packages/engine/dist/xbox360/engine.js");

const HIP = 0;
const KNEE = 1;
const FOOT = 2;
const HEAD = 3;
const dist = (a: number[], b: number[]) => Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!);

describe("two-bone IK", () => {
  const leg = skinnedLeg();
  const skin = leg.skin!;

  it("puts the foot on a reachable target, keeping both bones' lengths", () => {
    const pose = restPose(skin);
    expect(solveTwoBoneIK(skin, pose, FOOT, [0.5, 0.6, 0.3])).toBe(true);
    const foot = jointPosition(skin, pose, FOOT);
    const knee = jointPosition(skin, pose, KNEE);
    const hip = jointPosition(skin, pose, HIP);
    expect(dist(foot, [0.5, 0.6, 0.3])).toBeLessThan(1e-4);
    expect(dist(knee, hip)).toBeCloseTo(1, 4);
    expect(dist(foot, knee)).toBeCloseTo(1, 4);
    // Skinning follows: the vertex on the foot is where the foot went.
    const live = createLiveSkinnedMesh(leg);
    live.update(skinMatrices(skin, pose));
    expect(dist(Array.from(live.mesh.primitives[0]!.positions.subarray(6, 9)), [0.5, 0.6, 0.3])).toBeLessThan(1e-4);
  });

  it("bends the knee toward the pole", () => {
    for (const pz of [5, -5]) {
      const pose = restPose(skin);
      solveTwoBoneIK(skin, pose, FOOT, [0, 0.8, 0], [0, 1, pz]);
      expect(Math.sign(jointPosition(skin, pose, KNEE)[2])).toBe(Math.sign(pz));
      expect(dist(jointPosition(skin, pose, FOOT), [0, 0.8, 0])).toBeLessThan(1e-4);
    }
  });

  it("points the leg straight at a target out of reach", () => {
    const pose = restPose(skin);
    solveTwoBoneIK(skin, pose, FOOT, [4, 2, 0]);
    const foot = jointPosition(skin, pose, FOOT);
    expect(foot[0]).toBeCloseTo(2, 3); // 2 m of leg, straight out along +x from the hip
    expect(foot[1]).toBeCloseTo(2, 3);
  });

  it("blends from the animated pose by weight", () => {
    const pose = restPose(skin);
    solveTwoBoneIK(skin, pose, FOOT, [0.8, 0.5, 0], [0, 1, 1], 0.5);
    const foot = jointPosition(skin, pose, FOOT);
    // Part way: no longer straight down, not yet at the target.
    expect(dist(foot, [0, 0, 0])).toBeGreaterThan(0.2);
    expect(dist(foot, [0.8, 0.5, 0])).toBeGreaterThan(0.2);
    expect(solveTwoBoneIK(skin, restPose(skin), HIP, [1, 1, 1])).toBe(false); // the hip has no grandparent
  });
});

describe("look-at", () => {
  const skin = skinnedLeg().skin!;

  it("turns a joint's front toward the target, within the limit", () => {
    const facing = (pose: Float32Array) => {
      const live = createLiveSkinnedMesh(skinnedLeg());
      live.update(skinMatrices(skin, pose));
      const p = live.mesh.primitives[0]!.positions;
      return [p[12]! - p[9]!, p[13]! - p[10]!, p[14]! - p[11]!].map((v) => v / 0.2); // head → nose
    };
    const pose = restPose(skin);
    solveLookAt(skin, pose, HEAD, [3, 2.5, 3], 1, Math.PI / 2); // 45° to the right, allowed
    const f = facing(pose);
    expect(f[0]).toBeCloseTo(Math.SQRT1_2, 3);
    expect(f[2]).toBeCloseTo(Math.SQRT1_2, 3);
    // Limited to 30°: it turns only that far.
    const limited = restPose(skin);
    solveLookAt(skin, limited, HEAD, [5, 2.5, 0], 1, Math.PI / 6);
    const g = facing(limited);
    expect(Math.atan2(g[0]!, g[2]!)).toBeCloseTo(Math.PI / 6, 3);
    // The head's parent (the hip) is untouched.
    expect(jointPosition(skin, limited, KNEE)).toEqual([0, 1, 0]);
  });
});

describe.skipIf(!existsSync(ENGINE))("IK driven from Lua (real engine)", () => {
  it("reaches world-space targets on a placed, turned object and reports joint positions", async () => {
    const layout = RAM_LAYOUTS.xbox360;
    // The leg stands at x = 5, turned a quarter turn about Y (its front, +Z, now faces world +X).
    const sc = parseMeshScene(
      JSON.stringify({
        version: 2,
        meshes: [{ id: "leg", name: "leg", mesh: serializeMeshAsset(skinnedLeg()), transform: { position: [5, 0, 0], rotation: [0, 90, 0], scale: [1, 1, 1] } }],
      }),
    )!;
    const code = `
t = 0
function TIC()
  t = t + 1
  pmem(100, #cartbox.joints("leg"))
  if t < 20 then cartbox.ik("leg", "foot", 5.25, 0.5, 0.5, 1, 7, 1, 0) end
  local x, y, z = cartbox.joint("leg", "foot")
  if x then pmem(101, math.floor(x * 1000) & 0xffffffff) pmem(102, math.floor(y * 1000) & 0xffffffff) pmem(103, math.floor(z * 1000) & 0xffffffff) end
  local kx = cartbox.joint("leg", 1) -- by index: the knee
  if kx then pmem(104, math.floor(kx * 1000) & 0xffffffff) end
  pmem(105, cartbox.joint("leg", "nope") == nil and 1 or 0)
  if t == 20 then cartbox.ik("leg", "foot", 0, 0, 0, 0) end -- let go
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
    const w = (i: number) => (new Int32Array(mod.HEAPU8.buffer, base, 256)[i]! | 0) / 1000;
    const run = (n: number) => {
      for (let i = 0; i < n; i += 1) {
        channel.beforeTick(block());
        mod._cbx_tick(h, 0);
        channel.afterTick(block());
        channel.skinning(); // what the renderer does each frame
      }
    };
    run(5);
    expect(w(100) * 1000).toBe(4);
    // The foot reached the world-space target.
    expect(w(101)).toBeCloseTo(5.25, 2);
    expect(w(102)).toBeCloseTo(0.5, 2);
    expect(w(103)).toBeCloseTo(0.5, 2);
    // The knee bent toward the pole out at world x = 7 (the leg's front).
    expect(w(104)).toBeGreaterThan(5.1);
    expect(w(105) * 1000).toBe(1);
    run(20); // let go: the foot is back under the hip
    expect(w(101)).toBeCloseTo(5, 2);
    expect(w(102)).toBeCloseTo(0, 2);
    channel.destroy();
  }, 120_000);
});
