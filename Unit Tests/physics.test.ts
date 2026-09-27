/**
 * Physics (ENGINE_ROADMAP.md, Phase 2): the shared block at the end of RAM (its
 * address checked against every real engine core, so an engine rebuild that moves
 * RAM fails here), the block protocol, and a whole scene run through the real
 * Xbox 360 engine with the Rapier backend: a crate falls onto a static floor and
 * the cart reads it land, an impulse from Lua throws it up, a character walks and
 * reports the ground, and a raycast from Lua hits the floor object.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import RAPIER from "@dimforge/rapier3d-compat";
import { beforeAll, describe, expect, it } from "vitest";

import { serializeMeshAsset, type MeshAsset } from "@cartbox/editor";
import {
  NET_WORDS,
  PHYS_BLOCK_BYTES,
  PHYS_MAGIC,
  PhysicsSession,
  RAM_LAYOUTS,
  codeChunks,
  injectSdk,
  parseMeshScene,
  physicsBlockAddress,
  physicsSdkLua,
  sceneObjectsSdkLua,
  takePhysicsCommands,
  writePhysicsState,
  type MeshScene,
  type RamLayout,
} from "@cartbox/player";
import { prependLuaCode } from "../packages/player/src/cartseed";
import { createRapierBackend } from "../apps/web/src/lib/physicsRapier";

const DIST = path.resolve(__dirname, "../packages/engine/dist");
const CORES: [string, string][] = [
  ["classic", "tic80.js"],
  ["pro", "pro/engine.js"],
  ["portrait", "portrait/engine.js"],
  ["ps1", "ps1/engine.js"],
  ["n64", "n64/engine.js"],
  ["xbox360", "xbox360/engine.js"],
];

/** A unit cube (±0.5), serialized as the sidecar stores meshes. */
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

interface Engine {
  mod: {
    HEAPU8: Uint8Array;
    _cbx_create(rate: number): number;
    _cbx_load(h: number, ptr: number, len: number): number;
    _cbx_tick(h: number, buttons: number): void;
    _cbx_mailbox_ptr(h: number): number;
    _malloc(n: number): number;
    _free(p: number): void;
  };
  h: number;
}

async function boot(file: string, code: string): Promise<Engine> {
  const tic = codeChunks(new TextEncoder().encode(code));
  return bootBytes(file, tic);
}

async function bootBytes(file: string, tic: Uint8Array): Promise<Engine> {
  const mod = await (await import(pathToFileURL(path.join(DIST, file)).href)).default();
  const h = mod._cbx_create(44100);
  const ptr = mod._malloc(tic.length);
  mod.HEAPU8.set(tic, ptr);
  expect(mod._cbx_load(h, ptr, tic.length)).toBe(1);
  mod._free(ptr);
  return { mod, h };
}

const pmem = (e: Engine) => new Uint32Array(e.mod.HEAPU8.buffer, e.mod._cbx_mailbox_ptr(e.h) - NET_WORDS * 4, 256);
function block(e: Engine, layout: RamLayout): DataView {
  const start = e.mod._cbx_mailbox_ptr(e.h) - NET_WORDS * 4 + physicsBlockAddress(layout) - layout.pmemAddress;
  return new DataView(e.mod.HEAPU8.buffer, start, PHYS_BLOCK_BYTES);
}

describe("physics block location", () => {
  for (const [model, file] of CORES) {
    it.skipIf(!existsSync(path.join(DIST, file)))(`${model}: the host and Lua agree on where the block is`, async () => {
      const layout = RAM_LAYOUTS[model as keyof typeof RAM_LAYOUTS];
      const B = physicsBlockAddress(layout);
      // Lua reads the host's magic word from the block, and writes one back at +4.
      const e = await boot(
        file,
        `function TIC()
  local v = peek(${B}) | (peek(${B + 1}) << 8) | (peek(${B + 2}) << 16) | (peek(${B + 3}) << 24)
  pmem(100, v)
  poke(${B + 4}, 0x21) poke(${B + 5}, 0x43) poke(${B + 6}, 0x65) poke(${B + 7}, 0x07)
end`,
      );
      block(e, layout).setInt32(0, PHYS_MAGIC, true);
      e.mod._cbx_tick(e.h, 0);
      expect(pmem(e)[100]).toBe(PHYS_MAGIC);
      expect(block(e, layout).getInt32(4, true)).toBe(0x07654321);
    }, 60_000);
  }
});

describe("physics block protocol", () => {
  it("writes state and reads back (and clears) commands", () => {
    const view = new DataView(new ArrayBuffer(PHYS_BLOCK_BYTES));
    writePhysicsState(view, 7, [{ object: 3, position: [1.5, -2, 3.25], velocity: [0, 9.81, 0], grounded: true, sleeping: false }], [
      { object: -1, point: [0, 1, 0], normal: [0, 1, 0], distance: 4 },
    ]);
    expect(view.getInt32(0, true)).toBe(PHYS_MAGIC);
    expect(view.getInt32(4, true)).toBe(1);
    expect(view.getInt32(64 + 8, true)).toBe(-2048); // y = -2 in 1/1024ths
    expect(view.getInt32(2112, true)).toBe(1); // a hit on something that isn't a scene object
    // A command as the Lua writes it: op 1 (impulse) on object 3.
    view.setInt32(4096, 1, true);
    view.setInt32(4100, 1, true);
    view.setInt32(4104, 3, true);
    view.setInt32(4112, 5 * 1024, true);
    expect(takePhysicsCommands(view)).toEqual([{ op: 1, a: 3, v: [0, 5, 0, 0, 0, 0] }]);
    expect(takePhysicsCommands(view)).toEqual([]);
  });
});

describe.skipIf(!existsSync(path.join(DIST, "xbox360/engine.js")))("physics through the real engine (Rapier)", () => {
  beforeAll(async () => {
    await RAPIER.init();
  });

  /** A 20×1×20 static floor with its top at y = 0, a crate above it, a character, and a wall. */
  function scene(): MeshScene {
    const mesh = cube();
    const entry = (id: string, position: number[], scale: number[], physics: object) => ({
      id,
      name: id,
      mesh,
      transform: { position, rotation: [0, 0, 0], scale },
      physics,
    });
    return parseMeshScene(
      JSON.stringify({
        version: 2,
        meshes: [
          entry("floor", [0, -0.5, 0], [20, 1, 20], { body: "static", shape: "box" }),
          entry("crate", [0, 5, 0], [1, 1, 1], { body: "dynamic", shape: "box", mass: 2 }),
          entry("hero", [4, 1, 0], [0.6, 1.6, 0.6], { body: "character" }),
        ],
      }),
    )!;
  }

  it("drops a crate, throws it, walks a character and casts a ray from Lua", async () => {
    const layout = RAM_LAYOUTS.xbox360;
    const sc = scene();
    const code = `
t = 0
function TIC()
  t = t + 1
  local x, y, z, vx, vy, vz = cartbox.body("crate")
  pmem(100, math.floor((y or -99) * 1000 + 0.5) & 0xffffffff)
  if t == 150 then cartbox.impulse("crate", 0, 20, 0) end
  if t > 150 and t < 170 then pmem(101, math.max(pmem(101), math.floor(y * 1000))) end
  if t > 200 then
    cartbox.move("hero", 0.05, -0.1, 0)
    local hx, hy, hz, _, _, _, grounded = cartbox.body("hero")
    pmem(102, math.floor(hx * 1000)) pmem(103, grounded and 1 or 0)
  end
  cartbox.ray(0, -5, 10, 0, 0, -1, 0, 50)
  local hit, obj, px, py, pz, nx, ny, nz, dist = cartbox.hit(0)
  pmem(104, hit and 1 or 0) pmem(105, (obj or -1) + 1) pmem(106, math.floor((dist or 0) * 1000))
  pmem(107, cartbox.physics() and 1 or 0)
end`;
    let tic = codeChunks(new TextEncoder().encode(code));
    tic = prependLuaCode(tic, sceneObjectsSdkLua(sc));
    tic = prependLuaCode(tic, physicsSdkLua(sc, layout));
    tic = injectSdk(tic);
    const e = await bootBytes("xbox360/engine.js", tic);
    const session = new PhysicsSession(sc, createRapierBackend(RAPIER));
    const word = (i: number) => pmem(e)[i]! | 0;
    const run = (ticks: number) => {
      for (let i = 0; i < ticks; i += 1) {
        session.beforeTick(block(e, layout));
        e.mod._cbx_tick(e.h, 0);
        session.afterTick(block(e, layout));
      }
    };

    run(140); // ~2.3 s: the crate has fallen 4.5 m and settled on the floor
    expect(word(107)).toBe(1);
    expect(word(100) / 1000).toBeCloseTo(0.5, 1); // its centre half a metre above the floor top
    expect(session.overrides().get(1)![13]).toBeCloseTo(0.5, 1); // and that's where it's drawn

    run(30); // the impulse at tick 150 throws it up
    expect(word(101) / 1000).toBeGreaterThan(1.5);

    run(60); // the character walks +x for 30 ticks on the floor
    expect(word(102) / 1000).toBeGreaterThan(4.5);
    expect(word(103)).toBe(1);

    // The ray from (-5, 10, 0) straight down hits the floor (object 0) 10 m below.
    expect(word(104)).toBe(1);
    expect(word(105)).toBe(1); // object 0
    expect(word(106) / 1000).toBeCloseTo(10, 1);
    session.destroy();
  }, 120_000);

  it("leaves the calls as safe no-ops when there is no physics running", async () => {
    // Only the SDK (no scene, no physics): its defaults answer.
    const withSdk = await bootBytes("xbox360/engine.js", injectSdk(codeChunks(new TextEncoder().encode(
      `function TIC() pmem(100, cartbox.physics() and 1 or 0) pmem(101, cartbox.body(0) == nil and 1 or 0) cartbox.impulse(0, 1, 2, 3) end`,
    ))));
    withSdk.mod._cbx_tick(withSdk.h, 0);
    expect(pmem(withSdk)[100]).toBe(0);
    expect(pmem(withSdk)[101]).toBe(1);
  }, 60_000);
});
