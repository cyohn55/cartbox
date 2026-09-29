/**
 * Cosmetic debris (HALO2_STYLE_ROADMAP.md, H10): definitions on the sidecar,
 * each wearing a scene object's or prefab's mesh (minus parts it leaves off);
 * the local rigid-body simulation (rigid, bounces, settles, fades, recycles);
 * cartbox.debris through the runtime (in the real engine) and the overlay; the
 * editor sidecar round trip; and Lockout's casings and dropped weapons.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

import {
  DEBRIS_FADE,
  DebrisSystem,
  LOCKOUT_CODE,
  LOCKOUT_DEBRIS,
  debrisDefaults,
  lockoutMeshSidecar,
  parseDebrisDefs,
  ragdollBoxesFromCentreHalf,
  serializeMeshAsset,
  type DebrisDef,
  type MeshAsset,
} from "@cartbox/editor";
import {
  MeshOverlaySurface,
  NET_WORDS,
  PHYS_BLOCK_BYTES,
  RAM_LAYOUTS,
  RuntimeChannel,
  codeChunks,
  injectSdk,
  parseMeshScene,
  physicsBlockAddress,
  runtimeSdkLua,
  sceneNeedsRuntime,
  sceneObjectsSdkLua,
  type SceneDraw,
  type SceneRenderer,
} from "@cartbox/player";
import { prependLuaCode } from "../packages/player/src/cartseed";
import { addMesh, decodeMeshSidecar, emptyMeshSidecar, encodeMeshSidecar, setMeshDebris } from "../apps/web/src/lib/meshSidecar";

const ENGINE = path.resolve(__dirname, "../packages/engine/dist/xbox360/engine.js");

/** A box `sx × sy × sz` with two materials, "body" and "grip". */
function brick(sx: number, sy: number, sz: number): MeshAsset {
  const p = [-1, -1, -1, 1, -1, -1, 1, 1, -1, -1, 1, -1, -1, -1, 1, 1, -1, 1, 1, 1, 1, -1, 1, 1].map((v, i) => (v * [sx, sy, sz][i % 3]!) / 2);
  const idx = [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 3, 7, 6, 3, 6, 2, 0, 4, 7, 0, 7, 3, 1, 2, 6, 1, 6, 5];
  const prim = (name: string) => ({ positions: Float32Array.from(p), normals: null, uvs: null, indices: Uint32Array.from(idx), material: { name, baseColorFactor: [0.6, 0.5, 0.3, 1] as [number, number, number, number], baseColorImage: null } });
  return { name: "brick", primitives: [prim("body"), prim("grip")] };
}

const floor = ragdollBoxesFromCentreHalf([[0, -0.5, 0, 20, 0.5, 20]]);
const def = (over: Partial<DebrisDef> = {}): DebrisDef => ({ ...debrisDefaults("shell", "shell"), ...over });
const corners = (sys: DebrisSystem, i: number) => {
  const m = sys.instances()[i]!.model;
  return [0, 1, 2].map((c) => Math.hypot(m[c * 4]!, m[c * 4 + 1]!, m[c * 4 + 2]!));
};

describe("debris model", () => {
  it("reads definitions defensively: a source required, names unique, fields clamped, parts kept distinct", () => {
    const defs = parseDebrisDefs([
      { name: "a", source: "casing", life: 999, bounce: 3, friction: -1, max: 1000, without: ["glove", "glove", 7, "sleeve"] },
      { name: "a", source: "x" },
      { name: "nosource" },
      null,
    ]);
    expect(defs).toHaveLength(2);
    expect(defs[0]).toMatchObject({ name: "a", source: "casing", life: 120, bounce: 1, friction: 0, max: 64, without: ["glove", "sleeve"] });
    expect(defs[1]!.name).toBe("a_");
  });
});

describe("debris simulation", () => {
  it("falls, stays rigid, lands on the floor and settles", () => {
    const sys = new DebrisSystem([def({ life: 30 })], [brick(0.2, 0.05, 0.6)]);
    sys.throw(0, [0, 1.5, 0], [1, 2, 0]);
    for (let i = 0; i < 400; i += 1) sys.step(1 / 60, floor);
    expect(sys.settled(0)).toBe(true);
    const c = sys.centreOf(0);
    expect(c[1]).toBeGreaterThan(0);
    expect(c[1]).toBeLessThan(0.35); // on the floor, lying down (its half-height is ≤ 0.3)
    expect(c[0]).toBeGreaterThan(0.2); // carried the way it was thrown
    // The box stayed a box: the matrix's axes are still unit length (scale 1).
    for (const s of corners(sys, 0)) expect(s).toBeCloseTo(1, 2);
  });

  it("bounces higher with more bounce", () => {
    const peak = (bounce: number) => {
      const sys = new DebrisSystem([def({ bounce, friction: 0, life: 30 })], [brick(0.1, 0.1, 0.1)]);
      sys.throw(0, [0, 1, 0], [0, 0, 0], 1, 0);
      let hit = false;
      let best = 0;
      for (let i = 0; i < 200; i += 1) {
        sys.step(1 / 60, floor);
        const y = sys.centreOf(0)[1];
        if (y < 0.1) hit = true;
        else if (hit) best = Math.max(best, y);
      }
      return best;
    };
    expect(peak(0.8)).toBeGreaterThan(peak(0) + 0.1);
  });

  it("fades at the end of its life, then goes; past its cap the oldest is recycled", () => {
    const sys = new DebrisSystem([def({ life: 1, max: 2 })], [brick(0.1, 0.1, 0.1)]);
    sys.throw(0, [0, 0.2, 0], [0, 0, 0]);
    for (let i = 0; i < Math.round((1 - DEBRIS_FADE / 2) * 60); i += 1) sys.step(1 / 60, floor);
    expect(corners(sys, 0)[0]!).toBeLessThan(0.7); // shrinking away
    for (let i = 0; i < 40; i += 1) sys.step(1 / 60, floor);
    expect(sys.count()).toBe(0);
    for (let k = 0; k < 3; k += 1) sys.throw(0, [k, 0.2, 0], [0, 0, 0]);
    expect(sys.count()).toBe(2);
    expect(sys.centreOf(0)[0]).toBeCloseTo(1, 1); // the first went
  });

  it("throws nothing for a definition without a mesh, or at scale 0", () => {
    const sys = new DebrisSystem([def(), def({ name: "b" })], [null, brick(0.1, 0.1, 0.1)]);
    sys.throw(0, [0, 1, 0], [0, 0, 0]);
    sys.throw(1, [0, 1, 0], [0, 0, 0], 0);
    expect(sys.count()).toBe(0);
    sys.throw(1, [0, 1, 0], [0, 0, 0]);
    expect(sys.instances()[0]!.mesh.primitives).toHaveLength(2);
  });
});

function sidecar(extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    version: 2,
    meshes: [{ id: "gun", name: "gun", mesh: serializeMeshAsset(brick(0.1, 0.1, 0.5)), transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [0.001, 0.001, 0.001] } }],
    prefabs: [{ id: "p1", name: "shell", pool: 0, nodes: [{ key: "root", name: "shell", mesh: serializeMeshAsset(brick(0.01, 0.01, 0.04)), transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] } }] }],
    debris: [
      { name: "casing", source: "shell", life: 4 },
      { name: "dropped", source: "gun", without: ["grip"] },
      { name: "ghost", source: "nothing" },
    ],
    ...extra,
  });
}

describe("scene", () => {
  it("wears a prefab's or an object's mesh, leaves parts off, and drops definitions it can't dress", () => {
    const sc = parseMeshScene(sidecar())!;
    expect(sc.debris!.map((d) => d.name)).toEqual(["casing", "dropped"]);
    expect(sc.debrisMeshes![0]!.primitives).toHaveLength(2); // the prefab's mesh (no copy sits in the level)
    expect(sc.instances.some((i) => i.pooled)).toBe(false);
    expect(sc.debrisMeshes![1]!.primitives.map((p) => p.material.name)).toEqual(["body"]);
    expect(sceneNeedsRuntime(sc, { physics: false })).toBe(true);
    expect(runtimeSdkLua(sc, RAM_LAYOUTS.xbox360, { physics: false })).toContain("cartbox.debris");
  });

  it("is simulated and drawn by the overlay without a cart", async () => {
    const sc = parseMeshScene(sidecar())!;
    const drawn: MeshAsset[][] = [];
    const renderer: SceneRenderer = { backend: "software", render: (instances, _d: SceneDraw) => void drawn.push(instances.map((i) => i.mesh)), dispose: () => {} };
    const surface = await MeshOverlaySurface.create({ blit() {}, destroy() {} }, 16, 16, sc, renderer);
    surface.throwDebris(0, [0, 1, 0], [0, 0, 0], 1);
    surface.throwDebris(1, [0, 1, 0], [1, 0, 0], 1);
    surface.blit(new Uint8Array(16 * 16 * 4));
    const debris = new Set<MeshAsset>(sc.debrisMeshes);
    expect(drawn.at(-1)!.filter((m) => debris.has(m))).toHaveLength(2);
  });
});

describe.skipIf(!existsSync(ENGINE))("cartbox.debris from Lua (real engine)", () => {
  it("queues throws with their debris, place, velocity and scale", async () => {
    const layout = RAM_LAYOUTS.xbox360;
    const sc = parseMeshScene(sidecar())!;
    const code = `
t = 0
function TIC()
  t = t + 1
  if t == 2 then cartbox.debris("casing", 1, 2, 3, 0.5, 1, -0.5) end
  if t == 3 then cartbox.debris(2, 0, 1, 0, 1, 0, 0, 2) cartbox.debris("nope", 0, 0, 0, 0, 1, 0) pmem(100, #cartbox.debrislist()) end
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
    const seen: ReturnType<RuntimeChannel["takeDebris"]>[] = [];
    for (let i = 1; i <= 4; i += 1) {
      channel.beforeTick(block());
      mod._cbx_tick(h, 0);
      channel.afterTick(block());
      seen.push(channel.takeDebris());
    }
    expect(seen[0]).toEqual([]);
    expect(seen[1]).toHaveLength(1);
    expect(seen[1]![0]).toMatchObject({ debris: 0, scale: 1 });
    expect(seen[1]![0]!.at.map((v) => +v.toFixed(3))).toEqual([1, 2, 3]);
    expect(seen[1]![0]!.velocity.map((v) => +v.toFixed(3))).toEqual([0.5, 1, -0.5]);
    expect(seen[2]).toHaveLength(1);
    expect(seen[2]![0]).toMatchObject({ debris: 1, scale: 2 });
    expect(new Int32Array(mod.HEAPU8.buffer, base, 256)[100]).toBe(2);
    channel.destroy();
  });
});

describe("editor sidecar", () => {
  it("stores debris definitions and removes them", () => {
    let sc = addMesh(emptyMeshSidecar(), brick(0.1, 0.1, 0.1), "box").sidecar;
    sc = setMeshDebris(sc, [debrisDefaults("chunk", "box"), { ...debrisDefaults("chunk2", "box"), without: ["grip"] }]);
    const back = decodeMeshSidecar(encodeMeshSidecar(sc)!);
    expect(back.debris).toEqual(sc.debris);
    expect("debris" in setMeshDebris(sc, [])).toBe(false);
  });
});

describe("Lockout", () => {
  it("ejects casings on shots and drops weapons on deaths", () => {
    const sc = parseMeshScene(lockoutMeshSidecar())!;
    expect(sc.debris!.map((d) => d.name)).toEqual(LOCKOUT_DEBRIS.map((d) => d.name));
    // Dropped weapons wear the first-person models without the hands.
    const drop = sc.debrisMeshes![sc.debris!.findIndex((d) => d.name === "drop_br")]!;
    expect(drop.primitives.some((p) => p.material.name === "glove" || p.material.name === "sleeve")).toBe(false);
    expect(drop.primitives.length).toBeGreaterThan(0);
    expect(LOCKOUT_CODE).toContain('cartbox.debris("casing"');
    expect(LOCKOUT_CODE).toContain('cartbox.debris("drop_"');
  });
});
