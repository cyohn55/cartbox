/**
 * The overflow command ring (ENGINE_PARITY_ROADMAP.md EP20): on every core
 * whose free RAM affords one (HD, Pro, era), the cart's scene commands no
 * longer stop at 64 a tick.
 * Covers where the ring sits (only where the core's free RAM affords it, clear
 * of every other block), that the real engine never touches it while drawing,
 * and that a cart's commands past the 64th arrive in order, up to the new cap.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

import { serializeMeshAsset, type MeshAsset } from "@cartbox/editor";
import {
  CMD_RING_BYTES,
  CMD_RING_MAX,
  NET_WORDS,
  PHYS_BLOCK_BYTES,
  RAM_LAYOUTS,
  RuntimeChannel,
  codeChunks,
  commandRingAddress,
  commandRingBytes,
  commandsPerTick,
  injectSdk,
  parseMeshScene,
  physicsBlockAddress,
  runtimeSdkLua,
  sceneObjectsSdkLua,
} from "@cartbox/player";
import { prependLuaCode } from "../packages/player/src/cartseed";
import { saveBlockAddress } from "../packages/player/src/saveSdk";
import { PHYS_MAX_CMDS } from "../packages/player/src/physics/protocol";

const ENGINE = path.resolve(__dirname, "../packages/engine/dist/xbox360/engine.js");
const HD = RAM_LAYOUTS.modern;

describe("where the ring sits", () => {
  it("on every core whose free RAM holds one: 128 KB on HD and Pro, 64 KB on the era core, none on Classic", () => {
    const sizes = Object.fromEntries((["classic", "voxel", "pro", "portrait", "ps1", "n64", "xbox360", "modern"] as const).map((m) => [m, commandRingBytes(RAM_LAYOUTS[m])]));
    expect(sizes).toEqual({ classic: 0, voxel: 0, pro: 131072, portrait: 131072, ps1: 65536, n64: 65536, xbox360: 131072, modern: 131072 });
    expect(commandRingAddress(RAM_LAYOUTS.classic)).toBeNull();
    expect(commandsPerTick(RAM_LAYOUTS.classic)).toBe(PHYS_MAX_CMDS);
    expect(commandsPerTick(HD)).toBe(PHYS_MAX_CMDS + CMD_RING_MAX);
    expect(commandsPerTick(RAM_LAYOUTS.ps1)).toBe(PHYS_MAX_CMDS + 2047);
    expect(CMD_RING_MAX).toBe(4095);
  });

  it("just below the save block, above the end of TIC-80's own RAM (pmem, flags, font, mapping)", () => {
    for (const model of ["pro", "ps1", "xbox360"] as const) {
      const layout = RAM_LAYOUTS[model];
      const ring = commandRingAddress(layout)!;
      expect(ring + commandRingBytes(layout)).toBe(saveBlockAddress(layout));
      expect(ring).toBeGreaterThan(layout.pmemAddress + 0x1024);
      expect(saveBlockAddress(layout)).toBeLessThan(physicsBlockAddress(layout));
    }
  });
});

describe.skipIf(!existsSync(ENGINE))("in the real engines", () => {
  const box: MeshAsset = { name: "b", primitives: [{ positions: Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0]), normals: null, uvs: null, indices: Uint32Array.from([0, 1, 2]), material: { name: "m", baseColorFactor: [1, 1, 1, 1], baseColorImage: null } }] };
  const tf = { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] };
  // A timeline gives the scene its runtime (and so cartbox.place).
  const sc = parseMeshScene(
    JSON.stringify({
      version: 2,
      lighting: null,
      meshes: [{ id: "a", name: "crate", mesh: serializeMeshAsset(box), transform: tf }],
      timelines: [{ name: "t", duration: 1, tracks: [] }],
    }),
  )!;

  async function boot(code: string, preludes: string[], engineFile = ENGINE, layout = HD) {
    let tic = codeChunks(new TextEncoder().encode(code));
    for (const p of preludes) if (p) tic = prependLuaCode(tic, p);
    tic = injectSdk(tic);
    const mod = await (await import(pathToFileURL(engineFile).href)).default();
    const h = mod._cbx_create(44100);
    const ptr = mod._malloc(tic.length);
    mod.HEAPU8.set(tic, ptr);
    expect(mod._cbx_load(h, ptr, tic.length)).toBe(1);
    mod._free(ptr);
    const base = mod._cbx_mailbox_ptr(h) - NET_WORDS * 4;
    const view = (address: number, bytes: number) => new DataView(mod.HEAPU8.buffer, base + address - layout.pmemAddress, bytes);
    return { tick: () => mod._cbx_tick(h, 0), view, pmem: (i: number) => new Int32Array(mod.HEAPU8.buffer, base, 256)[i]! };
  }

  for (const model of ["xbox360", "pro", "ps1", "n64"] as const) {
    const file = path.resolve(__dirname, `../packages/engine/dist/${model}/engine.js`);
    it.skipIf(!existsSync(file))(`never touches the ring's RAM on the ${model} core, however much a cart draws`, async () => {
      const layout = RAM_LAYOUTS[model];
      const code = `
function TIC()
  cls(3)
  for i = 0, 200 do
    rect(i % 300, i, 40, 20, i % 16) circ(i * 3 % 600, 200, 30, 5) line(0, i, 639, 359 - i, 7)
    spr(i % 64, i * 2 % 600, i % 300, 0, 2) print("STRESS " .. i, i % 500, i % 340, 12)
  end
  map(0, 0, 60, 34, 0, 0)
  sfx(0, 30, 10) music(0)
end`;
      const engine = await boot(code, [], file, layout);
      const bytes = commandRingBytes(layout);
      const ring = engine.view(commandRingAddress(layout)!, bytes);
      for (let i = 0; i < bytes; i += 4) ring.setUint32(i, (0x9e3779b1 * (i + 1)) >>> 0, true);
      for (let t = 0; t < 10; t += 1) engine.tick();
      const after = engine.view(commandRingAddress(layout)!, bytes);
      let changed = 0;
      for (let i = 0; i < bytes; i += 4) if (after.getUint32(i, true) !== (0x9e3779b1 * (i + 1)) >>> 0) changed += 1;
      expect(changed).toBe(0);
    });
  }

  it("carries a cart's commands past the 64th, in order, up to the new cap", async () => {
    // Each tick asks for N placements of one object at x = 1..N: the last one
    // that arrives is where it ends up, and cartbox.place reports each accepted.
    const code = `
local t = 0
local asks = { 300, 5000, 10 }
function TIC()
  t = t + 1
  local n = asks[t]
  if not n then return end
  local ok = 0
  for i = 1, n do if cartbox.place("crate", i, 0, 0, 0, 0, 0, 1) then ok = ok + 1 end end
  pmem(100 + t, ok)
end`;
    const engine = await boot(code, [sceneObjectsSdkLua(sc), runtimeSdkLua(sc, HD, { physics: false })]);
    const channel = new RuntimeChannel(sc, null);
    const block = () => engine.view(physicsBlockAddress(HD), PHYS_BLOCK_BYTES);
    const ring = () => engine.view(commandRingAddress(HD)!, CMD_RING_BYTES);
    const xs: number[] = [];
    for (let t = 0; t < 3; t += 1) {
      channel.beforeTick(block());
      engine.tick();
      channel.afterTick(block(), ring());
      xs.push(Math.round(channel.placements().get(0)![12]!));
    }
    channel.destroy();
    expect([engine.pmem(101), engine.pmem(102), engine.pmem(103)]).toEqual([300, PHYS_MAX_CMDS + CMD_RING_MAX, 10]);
    // The last accepted placement wins each tick: everything arrived, in order (and the ring was emptied between ticks).
    expect(xs).toEqual([300, PHYS_MAX_CMDS + CMD_RING_MAX, 10]);
  });

  it.skipIf(!existsSync(path.resolve(__dirname, "../packages/engine/dist/ps1/engine.js")))("on the era core, up to its own cap (2111)", async () => {
    const layout = RAM_LAYOUTS.ps1;
    const code = `
function TIC()
  local ok = 0
  for i = 1, 3000 do if cartbox.place("crate", i, 0, 0, 0, 0, 0, 1) then ok = ok + 1 end end
  pmem(101, ok)
end`;
    const engine = await boot(code, [sceneObjectsSdkLua(sc), runtimeSdkLua(sc, layout, { physics: false })], path.resolve(__dirname, "../packages/engine/dist/ps1/engine.js"), layout);
    const channel = new RuntimeChannel(sc, null);
    channel.beforeTick(engine.view(physicsBlockAddress(layout), PHYS_BLOCK_BYTES));
    engine.tick();
    channel.afterTick(engine.view(physicsBlockAddress(layout), PHYS_BLOCK_BYTES), engine.view(commandRingAddress(layout)!, commandRingBytes(layout)));
    expect(engine.pmem(101)).toBe(commandsPerTick(layout));
    expect(Math.round(channel.placements().get(0)![12]!)).toBe(commandsPerTick(layout));
    channel.destroy();
  });

  it("without the host reading the ring, only the block's 64 arrive", async () => {
    const code = `
function TIC() for i = 1, 100 do cartbox.place("crate", i, 0, 0, 0, 0, 0, 1) end end`;
    const engine = await boot(code, [sceneObjectsSdkLua(sc), runtimeSdkLua(sc, HD, { physics: false })]);
    const channel = new RuntimeChannel(sc, null);
    const block = () => engine.view(physicsBlockAddress(HD), PHYS_BLOCK_BYTES);
    channel.beforeTick(block());
    engine.tick();
    channel.afterTick(block());
    expect(Math.round(channel.placements().get(0)![12]!)).toBe(PHYS_MAX_CMDS);
    channel.destroy();
  });
});
