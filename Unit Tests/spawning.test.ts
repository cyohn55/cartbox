/**
 * Spawning prefab copies at run time (ENGINE_ROADMAP.md, Phase 1): each prefab
 * keeps a reserve of hidden copies in the runtime scene; cartbox.spawn hands one
 * out at once (from Lua) and the host places it — with its physics bodies, if
 * any — and cartbox.despawn puts it back. Runs through the real Xbox 360 engine
 * with the Rapier backend, and checks what the renderer draws.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import RAPIER from "@dimforge/rapier3d-compat";
import { beforeAll, describe, expect, it } from "vitest";

import { serializeMeshAsset, type MeshAsset } from "@cartbox/editor";
import {
  MeshOverlaySurface,
  NET_WORDS,
  PHYS_BLOCK_BYTES,
  PhysicsSession,
  RAM_LAYOUTS,
  RuntimeChannel,
  codeChunks,
  injectSdk,
  parseMeshScene,
  physicsBlockAddress,
  runtimeSdkLua,
  sceneObjectsSdkLua,
  type MeshScene,
} from "@cartbox/player";
import { prependLuaCode } from "../packages/player/src/cartseed";
import { createRapierBackend } from "../apps/web/src/lib/physicsRapier";

const ENGINE = path.resolve(__dirname, "../packages/engine/dist/xbox360/engine.js");

function cube(): string {
  const p = [-0.5, -0.5, -0.5, 0.5, -0.5, -0.5, 0.5, 0.5, -0.5, -0.5, 0.5, -0.5, -0.5, -0.5, 0.5, 0.5, -0.5, 0.5, 0.5, 0.5, 0.5, -0.5, 0.5, 0.5];
  const idx = [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 3, 7, 6, 3, 6, 2, 0, 4, 7, 0, 7, 3, 1, 2, 6, 1, 6, 5];
  const mesh: MeshAsset = {
    name: "cube",
    primitives: [
      {
        positions: Float32Array.from(p),
        normals: Float32Array.from(p.map((v) => v * 2)),
        uvs: null,
        indices: Uint32Array.from(idx),
        material: { name: "m", baseColorFactor: [0.6, 0.6, 0.6, 1], baseColorImage: null },
      },
    ],
  };
  return serializeMeshAsset(mesh);
}

/** A static floor, and a "Crate" prefab (a dynamic box with a lamp on top) keeping 3 copies. */
function scene(pool = 3): MeshScene {
  const mesh = cube();
  const T = (position: number[], scale = [1, 1, 1]) => ({ position, rotation: [0, 0, 0], scale });
  return parseMeshScene(
    JSON.stringify({
      version: 2,
      meshes: [{ id: "floor", name: "floor", mesh, transform: T([0, -0.5, 0], [20, 1, 20]), physics: { body: "static", shape: "box" } }],
      prefabs: [
        {
          id: "p1",
          name: "Crate",
          pool,
          nodes: [
            { key: "n0", name: "crate", mesh, transform: T([9, 9, 9]), physics: { body: "dynamic", shape: "box", mass: 1 } },
            { key: "n1", name: "lamp", mesh, transform: T([0, 1, 0], [0.2, 0.2, 0.2]), parent: "n0" },
          ],
        },
      ],
    }),
  )!;
}

describe("prefab reserves in the runtime scene", () => {
  it("adds hidden copies after the placed objects, each with its own root", () => {
    const sc = scene();
    expect(sc.instances).toHaveLength(1 + 3 * 2);
    expect(sc.pools).toEqual([{ prefab: "Crate", roots: [1, 3, 5] }]);
    const names = sc.instances.map((i) => i.name);
    expect(names.slice(1, 3)).toEqual(["Crate 1", "lamp"]);
    expect(sc.instances[2]!.parent).toBe(1);
    expect(sc.instances[2]!.pooled).toEqual({ prefab: "Crate", copy: 0, root: 1 });
    // A copy's root sits at the origin (the prefab root's own placement is ignored).
    expect([sc.instances[1]!.model[12], sc.instances[1]!.model[13]]).toEqual([0, 0]);
    // Framing bounds come from placed objects only.
    expect(sc.bounds.max[0]).toBeCloseTo(10);
  });

  it("holds none for a prefab set to 0 copies, and draws no reserve copy until spawned", async () => {
    expect(scene(0).pools).toBeUndefined();
    const sc = scene();
    const surface = await MeshOverlaySurface.create({ blit() {}, destroy() {} }, 16, 16, sc);
    const drawn = () => (surface as unknown as { posedInstances(): { main: unknown[] } }).posedInstances().main.length;
    expect(drawn()).toBe(1); // the floor only
    const at = new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 2, 3, 4, 1]);
    surface.setSpawned(new Map([[3, at]]));
    expect(drawn()).toBe(3); // floor + the spawned crate and its lamp
  });
});

describe.skipIf(!existsSync(ENGINE))("cartbox.spawn through the real engine", () => {
  beforeAll(async () => {
    await RAPIER.init();
  });

  it("spawns, simulates and despawns prefab copies from Lua", async () => {
    const layout = RAM_LAYOUTS.xbox360;
    const sc = scene();
    const code = `
t = 0
function TIC()
  t = t + 1
  if t == 1 then
    a = cartbox.spawn("Crate", 0, 4, 0)
    b = cartbox.spawn("Crate", 3, 4, 0, math.pi / 2)
    c = cartbox.spawn("Crate", -3, 4, 0)
    d = cartbox.spawn("Crate", 0, 8, 0) -- the reserve is empty: nil
    pmem(100, (a or -1) + 1) pmem(101, (b or -1) + 1) pmem(102, (c or -1) + 1) pmem(103, d == nil and 1 or 0)
    pmem(104, cartbox.spawn("Nope", 0, 0, 0) == nil and 1 or 0)
  end
  if a then
    local x, y = cartbox.body(a)
    pmem(105, math.floor((y or -9) * 1000) & 0xffffffff)
  end
  if t == 150 then
    cartbox.despawn(a)
    pmem(106, cartbox.alive(a) and 1 or 0)
    e = cartbox.spawn("Crate", 5, 2, 5) -- reuses the freed copy
    pmem(107, (e or -1) + 1)
  end
end`;
    let tic = codeChunks(new TextEncoder().encode(code));
    tic = prependLuaCode(tic, sceneObjectsSdkLua(sc));
    tic = prependLuaCode(tic, runtimeSdkLua(sc, layout));
    tic = injectSdk(tic);
    const mod = await (await import(pathToFileURL(ENGINE).href)).default();
    const h = mod._cbx_create(44100);
    const ptr = mod._malloc(tic.length);
    mod.HEAPU8.set(tic, ptr);
    expect(mod._cbx_load(h, ptr, tic.length)).toBe(1);
    mod._free(ptr);
    const physics = new PhysicsSession(sc, createRapierBackend(RAPIER));
    const channel = new RuntimeChannel(sc, physics);
    const pmem = () => new Uint32Array(mod.HEAPU8.buffer, mod._cbx_mailbox_ptr(h) - NET_WORDS * 4, 256);
    const block = () =>
      new DataView(mod.HEAPU8.buffer, mod._cbx_mailbox_ptr(h) - NET_WORDS * 4 + physicsBlockAddress(layout) - layout.pmemAddress, PHYS_BLOCK_BYTES);
    const run = (n: number) => {
      for (let i = 0; i < n; i += 1) {
        channel.beforeTick(block());
        mod._cbx_tick(h, 0);
        channel.afterTick(block());
      }
    };

    run(1);
    const w = (i: number) => pmem()[i]! | 0;
    expect([w(100), w(101), w(102)]).toEqual([2, 4, 6]); // roots 1, 3, 5 (+1)
    expect(w(103)).toBe(1);
    expect(w(104)).toBe(1);
    expect([...channel.spawned().keys()]).toEqual([1, 3, 5]);
    // The second crate was spawned at x = 3, turned a quarter turn.
    const second = channel.spawned().get(3)!;
    expect(second[12]).toBeCloseTo(3);
    expect(second[8]).toBeCloseTo(1, 5); // its local Z axis now points along world X

    run(120); // two seconds: the first crate has fallen from 4 m onto the floor
    expect(w(105) / 1000).toBeCloseTo(0.5, 1);
    expect(physics.overrides().get(1)![13]).toBeCloseTo(0.5, 1);

    run(30); // tick 150: despawned, and the freed copy handed out again
    expect(w(106)).toBe(0);
    expect(w(107)).toBe(2);
    expect(channel.spawned().get(1)![12]).toBeCloseTo(5);
    channel.destroy();
  }, 120_000);

  it("makes a spawned copy's joints where it's placed, and remakes them on respawn", async () => {
    const layout = RAM_LAYOUTS.xbox360;
    const mesh = cube();
    const T = (position: number[], scale = [1, 1, 1]) => ({ position, rotation: [0, 0, 0], scale });
    // A "Swing": a static beam with a seat hanging 2 m below it on a rope.
    const sc = parseMeshScene(
      JSON.stringify({
        version: 2,
        meshes: [{ id: "floor", name: "floor", mesh, transform: T([0, -0.5, 0], [40, 1, 40]), physics: { body: "static", shape: "box" } }],
        prefabs: [
          {
            id: "p2",
            name: "Swing",
            pool: 1,
            nodes: [
              { key: "n0", name: "beam", mesh, transform: T([0, 0, 0]), physics: { body: "static", shape: "box" } },
              {
                key: "n1", name: "seat", mesh, parent: "n0", transform: T([0, -2, 0], [0.5, 0.5, 0.5]),
                physics: { body: "dynamic", shape: "box", joint: { kind: "rope", anchor: [0, 4, 0] } },
              },
            ],
          },
        ],
      }),
    )!;
    const code = `
t = 0
function TIC()
  t = t + 1
  if t == 1 then s = cartbox.spawn("Swing", 0, 6, 0) end
  if t == 100 then cartbox.despawn(s) end
  if t == 101 then s = cartbox.spawn("Swing", 8, 6, 3) end
  local x, y, z = cartbox.body("seat")
  if t == 99 or t == 199 then
    local at = t == 99 and 100 or 104
    pmem(at, math.floor(x * 1000) & 0xffffffff) pmem(at + 1, math.floor(y * 1000) & 0xffffffff) pmem(at + 2, math.floor(z * 1000) & 0xffffffff)
  end
end`;
    let tic = codeChunks(new TextEncoder().encode(code));
    tic = prependLuaCode(tic, sceneObjectsSdkLua(sc));
    tic = prependLuaCode(tic, runtimeSdkLua(sc, layout));
    tic = injectSdk(tic);
    const mod = await (await import(pathToFileURL(ENGINE).href)).default();
    const h = mod._cbx_create(44100);
    const ptr = mod._malloc(tic.length);
    mod.HEAPU8.set(tic, ptr);
    expect(mod._cbx_load(h, ptr, tic.length)).toBe(1);
    mod._free(ptr);
    const physics = new PhysicsSession(sc, createRapierBackend(RAPIER));
    const channel = new RuntimeChannel(sc, physics);
    const base = mod._cbx_mailbox_ptr(h) - NET_WORDS * 4;
    const block = () => new DataView(mod.HEAPU8.buffer, base + physicsBlockAddress(layout) - layout.pmemAddress, PHYS_BLOCK_BYTES);
    for (let i = 0; i < 200; i += 1) {
      channel.beforeTick(block());
      mod._cbx_tick(h, 0);
      channel.afterTick(block());
    }
    const w = (i: number) => (new Int32Array(mod.HEAPU8.buffer, base, 256)[i]! | 0) / 1000;
    // Hanging from the beam where it was spawned (rather than fallen to the floor)…
    expect([w(100), w(101), w(102)].map((v) => Math.round(v * 10) / 10)).toEqual([0, 4, 0]);
    // …and from where it was spawned the second time.
    expect(w(104)).toBeCloseTo(8, 1);
    expect(w(105)).toBeCloseTo(4, 1);
    expect(w(106)).toBeCloseTo(3, 1);
    channel.destroy();
  }, 120_000);
});
