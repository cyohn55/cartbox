/**
 * The rest of the runtime past the block (AAA_PRODUCTION_ROADMAP.md S1b): on
 * the dedicated Modern core a cart reads animation playback, clip events,
 * watched joints and navigation agents by query, past the RAM block's 64
 * animated objects, 32 events, 16 joints and 16 agents; and a prefab keeps up
 * to 256 copies there, where a TIC-80–derived core spawns 32.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { bakeNavMesh, boxTriangles, parseGltfText, serializeMeshAsset, serializeNavMesh, type MeshAsset } from "@cartbox/editor";
import {
  MAX_PREFAB_POOL,
  MAX_PREFAB_POOL_DIRECT,
  PHYS_BLOCK_BYTES,
  PHYS_Q_AGENT,
  PHYS_Q_ANIM,
  PHYS_Q_ANIM_EVENTS,
  PHYS_Q_JOINT,
  RAM_LAYOUTS,
  RuntimeChannel,
  codeChunks,
  createDirectConsole,
  getModel,
  injectSdk,
  parseMeshScene,
  physicsBlockAddress,
  runtimeSdkLua,
  sceneObjectsSdkLua,
  type MeshScene,
} from "@cartbox/player";
import { PHYS_OP_AGENT, PHYS_OP_WATCH } from "../packages/player/src/physics/protocol";
import { prependLuaCode } from "../packages/player/src/cartseed";
import { skinnedArmGltf } from "./helpers/skinnedGltf";

const CORE = path.resolve(__dirname, "../packages/modern-core/dist/modern-core.js");
const T = (position: number[], scale = [1, 1, 1]) => ({ position, rotation: [0, 0, 0], scale });

function cube(): string {
  const p = [-0.5, -0.5, -0.5, 0.5, -0.5, -0.5, 0.5, 0.5, -0.5, -0.5, 0.5, -0.5, -0.5, -0.5, 0.5, 0.5, -0.5, 0.5, 0.5, 0.5, 0.5, -0.5, 0.5, 0.5];
  const idx = [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 3, 7, 6, 3, 6, 2, 0, 4, 7, 0, 7, 3, 1, 2, 6, 1, 6, 5];
  const mesh: MeshAsset = {
    name: "cube",
    primitives: [{ positions: Float32Array.from(p), normals: null, uvs: null, indices: Uint32Array.from(idx), material: { name: "m", baseColorFactor: [1, 1, 1, 1], baseColorImage: null } }],
  };
  return serializeMeshAsset(mesh);
}

/** A flat 20 × 20 m yard, baked for agents. */
const yard = () => serializeNavMesh(bakeNavMesh(boxTriangles([[0, -0.5, 0, 10, 0.5, 10]]), { cell: 0.25, agent: { radius: 0.4, height: 1.8, climb: 0.45, maxDrop: 4 } }));

/** `arms` skinned arms, a "Crate" prefab keeping `pool` copies, and the yard's navmesh. */
function scene(arms: number, pool: number): MeshScene {
  const arm = serializeMeshAsset(parseGltfText(skinnedArmGltf(1), "arm"));
  const box = cube();
  return parseMeshScene(
    JSON.stringify({
      version: 2,
      meshes: Array.from({ length: arms }, (_, i) => ({ id: `a${i}`, name: `a${i}`, mesh: arm, transform: T([-9 + (i % 10) * 2, 0, -9 + Math.floor(i / 10) * 2]) })),
      prefabs: [{ id: "p", name: "Crate", pool, nodes: [{ key: "n0", name: "crate", mesh: box, transform: T([0, 0, 0]) }] }],
      navmesh: yard(),
    }),
  )!;
}

/** The roots a generated SDK hands out for a prefab, read from its spawn table. */
function spawnable(lua: string, prefab: string): number {
  const table = lua.match(new RegExp(`\\["${prefab}"\\]=\\{([^}]*)\\}`))?.[1] ?? "";
  return table ? table.split(",").length : 0;
}

describe("prefab pools by core (S1b)", () => {
  it("keeps up to 256 copies in the scene, and the SDK hands out 32 on a block core and all on the dedicated one", () => {
    expect(MAX_PREFAB_POOL).toBe(32);
    expect(MAX_PREFAB_POOL_DIRECT).toBe(256);
    expect(scene(0, 40).pools![0]!.roots).toHaveLength(40);
    expect(scene(0, 400).pools![0]!.roots).toHaveLength(256);
    const sc = scene(0, 40);
    expect(spawnable(runtimeSdkLua(sc, RAM_LAYOUTS.xbox360, { physics: false }), "Crate")).toBe(32);
    expect(spawnable(runtimeSdkLua(sc, RAM_LAYOUTS.xbox360, { physics: false, maxPool: MAX_PREFAB_POOL_DIRECT }), "Crate")).toBe(40);
  });
});

describe("the runtime channel's limits and queries (S1b)", () => {
  const agent = (key: number) => ({ op: PHYS_OP_AGENT, a: key, v: [-8 + (key % 8) * 2, 0, -8 + Math.floor(key / 8) * 2, 3, 0.4, 0] as [number, number, number, number, number, number] });

  it("keeps 16 agents and 16 watched joints for a block core, and far more for the dedicated core", () => {
    const sc = scene(20, 0);
    const block = new RuntimeChannel(sc, null);
    const direct = new RuntimeChannel(sc, null, { direct: true });
    expect(block.limits).toEqual({ agents: 16, joints: 16 });
    expect(direct.limits).toEqual({ agents: 1024, joints: 1024 });
    const commands = [...Array.from({ length: 30 }, (_, k) => agent(k)), ...Array.from({ length: 20 }, (_, i) => ({ op: PHYS_OP_WATCH, a: i, v: [1, 0, 0, 0, 0, 0] as [number, number, number, number, number, number] }))];
    block.applyCommands(commands);
    direct.applyCommands(commands);
    expect(block.query(PHYS_Q_AGENT, 15, [])).not.toBeNull();
    expect(block.query(PHYS_Q_AGENT, 16, [])).toBeNull(); // the 17th was refused
    const a = direct.query(PHYS_Q_AGENT, 29, [])!;
    expect(a).toHaveLength(5);
    expect(a[0]).toBeCloseTo(-8 + 5 * 2, 0);
    // Watched joints have a position once skinned (the next poses), for all 20 on the dedicated core.
    direct.skinning();
    block.skinning();
    expect(direct.query(PHYS_Q_JOINT, 19, [1])).toHaveLength(3);
    expect(block.query(PHYS_Q_JOINT, 15, [1])).toHaveLength(3);
    expect(block.query(PHYS_Q_JOINT, 16, [1])).toBeNull();
    expect(direct.query(PHYS_Q_JOINT, 0, [0])).toBeNull(); // never watched
    // Playback for an animated object; nothing for one that isn't.
    const p = direct.query(PHYS_Q_ANIM, 19, [])!;
    expect(p).toHaveLength(3);
    expect(direct.query(PHYS_Q_ANIM, 999, [])).toBeNull();
    expect(direct.query(PHYS_Q_ANIM_EVENTS, 19, [0])).toEqual([0]);
    block.destroy();
    direct.destroy();
  });
});

describe.skipIf(!existsSync(CORE))("the runtime past the block on the dedicated Modern core (S1b)", () => {
  async function run(sc: MeshScene, code: string, maxPool: number, ticks: number) {
    const layout = RAM_LAYOUTS.xbox360;
    let tic = codeChunks(new TextEncoder().encode(code));
    tic = prependLuaCode(tic, sceneObjectsSdkLua(sc));
    tic = prependLuaCode(tic, runtimeSdkLua(sc, layout, { physics: false, maxPool }));
    tic = injectSdk(tic);
    const mod = await (await import(pathToFileURL(CORE).href)).default();
    const console = createDirectConsole(mod, getModel("xbox360"));
    expect(console.loadCartridge(tic)).toBe(true);
    const channel = new RuntimeChannel(sc, null, { direct: true });
    console.setQuery((op, a, v) => channel.query(op, a, v));
    const block = () => {
      const bytes = console.ramView(physicsBlockAddress(layout) - layout.pmemAddress, PHYS_BLOCK_BYTES)!;
      return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    };
    for (let i = 0; i < ticks; i += 1) {
      channel.beforeTick(block());
      console.tick(0);
      expect(console.readError().message).toBe("");
      channel.afterTick(block(), null, console.takeCommands());
      channel.skinning();
    }
    channel.destroy();
    return (i: number) => console.netWords()![i]! | 0;
  }

  it("reads 80 animations, 40 watched joints and 30 agents, and spawns 40 copies", async () => {
    const sc = scene(80, 40);
    const word = await run(
      sc,
      `
t = 0
function TIC()
  t = t + 1
  if t == 1 then
    cartbox.play("a79", "wave", 0, 1, true)
    for k = 0, 29 do cartbox.agent(k, -8 + (k % 8) * 2, 0, -8 + (k // 8) * 2, 3, 0.4) end
    local n = 0
    for k = 1, 40 do if cartbox.spawn("Crate", k, 0, 0) then n = n + 1 end end
    pmem(100, n)
  end
  local seen = 0
  for i = 0, 39 do if cartbox.joint("a" .. i, 1) then seen = seen + 1 end end
  pmem(101, seen)
  if t == 30 then
    local name, time = cartbox.anim("a79")
    pmem(102, name == "wave" and 1 or 0) pmem(103, math.floor(time * 1000))
    pmem(104, cartbox.agentpos(29) and 1 or 0)
    pmem(105, cartbox.agentpos(30) == nil and 1 or 0)
    pmem(106, #cartbox.events("a79"))
  end
end`,
      MAX_PREFAB_POOL_DIRECT,
      30,
    );
    expect(word(100)).toBe(40); // all 40 copies, past the block cores' 32
    expect(word(101)).toBe(40); // 40 watched joints, past the block's 16
    expect(word(102)).toBe(1); // the 80th arm's clip, past the block's 64
    expect(word(103)).toBeGreaterThan(400);
    expect(word(104)).toBe(1); // the 30th agent, past the block's 16
    expect(word(105)).toBe(1);
    expect(word(106)).toBe(0);
  }, 120_000);

  it("spawns 32 copies where the SDK is generated for a block core", async () => {
    const word = await run(scene(0, 40), `function TIC() local n = 0 for k = 1, 40 do if cartbox.spawn("Crate", k, 0, 0) then n = n + 1 end end pmem(100, n) end`, MAX_PREFAB_POOL, 1);
    expect(word(100)).toBe(32);
  }, 120_000);
});
