/**
 * Physics at scale (AAA_PRODUCTION_ROADMAP.md S1–S3):
 *
 * - S1: on the dedicated Modern core a cart reads bodies by query, so the
 *   RAM block's 64 moving bodies (and its 48 contacts and 64 overlaps) no
 *   longer cap it; a body past a core's cap is left out and reported.
 * - S2: there, cartbox.ray and cartbox.sweep are cast in the call, against the
 *   world as last stepped, instead of answering on the next tick.
 * - S3: collision layers and masks, for bodies and for rays and sweeps.
 *
 * The session tests run Rapier in Node; the last suite runs a cart on the real
 * Modern core with the player's own SDK and runtime.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import RAPIER from "@dimforge/rapier3d-compat";
import { beforeAll, describe, expect, it } from "vitest";
import { PHYSICS_LAYERS, PHYSICS_MASK_ALL, physicsGroups, queryGroups, readPhysicsSpec, serializeMeshAsset, type MeshAsset } from "@cartbox/editor";
import {
  DIRECT_MAX_BODIES,
  PHYS_BLOCK_BYTES,
  PHYS_MAX_BODIES,
  PHYS_Q_BODY,
  PHYS_Q_CAST,
  PHYS_Q_CONTACTS,
  PHYS_Q_HASH,
  PHYS_Q_INSIDE,
  PHYS_Q_RAY,
  PhysicsSession,
  RAM_LAYOUTS,
  RuntimeChannel,
  bodyCapacity,
  codeChunks,
  createDirectConsole,
  getModel,
  injectSdk,
  movingBodies,
  parseMeshScene,
  physicsBlockAddress,
  physicsSlots,
  runtimeSdkLua,
  sceneObjectsSdkLua,
  type MeshScene,
} from "@cartbox/player";
import { PHYS_CAST_SPHERE, PHYS_HDR_HASH, PHYS_OP_CAST, PHYS_OP_RAY, PHYS_RAYS, PHYS_RAY_BYTES } from "../packages/player/src/physics/protocol";
import { prependLuaCode } from "../packages/player/src/cartseed";
import { createRapierBackend } from "../apps/web/src/lib/physicsRapier";

const CORE = path.resolve(__dirname, "../packages/modern-core/dist/modern-core.js");

/** A unit cube (±0.5), serialized as the sidecar stores meshes. */
function cube(): string {
  const p = [-0.5, -0.5, -0.5, 0.5, -0.5, -0.5, 0.5, 0.5, -0.5, -0.5, 0.5, -0.5, -0.5, -0.5, 0.5, 0.5, -0.5, 0.5, 0.5, 0.5, 0.5, -0.5, 0.5, 0.5];
  const idx = [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 3, 7, 6, 3, 6, 2, 0, 4, 7, 0, 7, 3, 1, 2, 6, 1, 6, 5];
  const mesh: MeshAsset = {
    name: "cube",
    primitives: [{ positions: Float32Array.from(p), normals: null, uvs: null, indices: Uint32Array.from(idx), material: { name: "m", baseColorFactor: [1, 1, 1, 1], baseColorImage: null } }],
  };
  return serializeMeshAsset(mesh);
}

type Entry = { id: string; position: number[]; scale?: number[]; physics: object };

function sceneOf(entries: readonly Entry[]): MeshScene {
  const mesh = cube();
  return parseMeshScene(
    JSON.stringify({
      version: 2,
      meshes: entries.map((e) => ({ id: e.id, name: e.id, mesh, transform: { position: e.position, rotation: [0, 0, 0], scale: e.scale ?? [1, 1, 1] }, physics: e.physics })),
    }),
  )!;
}

const FLOOR: Entry = { id: "floor", position: [0, -0.5, 0], scale: [20, 1, 20], physics: { body: "static", shape: "box" } };

/** Step a session `n` ticks with no commands. */
function step(session: PhysicsSession, n: number): void {
  for (let i = 0; i < n; i += 1) session.run([]);
}

describe("collision layers in the spec (S3)", () => {
  it("keeps a layer and a mask only when they aren't the defaults, clamped", () => {
    expect(readPhysicsSpec({ body: "dynamic", layer: 3, mask: 0b101 })).toMatchObject({ layer: 3, mask: 5 });
    const plain = readPhysicsSpec({ body: "dynamic", layer: 0, mask: PHYSICS_MASK_ALL })!;
    expect("layer" in plain || "mask" in plain).toBe(false);
    expect(readPhysicsSpec({ body: "static", layer: 99, mask: 1e9 })).toMatchObject({ layer: PHYSICS_LAYERS - 1 });
    expect("mask" in readPhysicsSpec({ body: "static", mask: 1e9 })!).toBe(false); // clamped to all
    expect(readPhysicsSpec({ body: "static", mask: 0 })).toMatchObject({ mask: 0 }); // collides with nothing
  });

  it("packs layer and mask as Rapier's groups: memberships high, filter low", () => {
    expect(physicsGroups()).toBe(0x0001ffff);
    expect(physicsGroups(3, 0b101)).toBe(0x00080005);
    expect(physicsGroups(15, 0)).toBe(0x80000000);
    expect(queryGroups(0b100)).toBe(0xffff0004);
    expect(queryGroups()).toBe(0xffffffff);
  });
});

describe("the physics session on Rapier", () => {
  beforeAll(async () => {
    await RAPIER.init();
  });

  it("lets bodies on layers each other's masks leave out pass through (S3)", () => {
    const sc = sceneOf([
      FLOOR,
      { id: "plate", position: [0, 1, 0], scale: [4, 0.2, 4], physics: { body: "static", shape: "box", layer: 2 } },
      { id: "stops", position: [-1, 4, 0], physics: { body: "dynamic", shape: "box" } },
      { id: "ghost", position: [1, 4, 0], physics: { body: "dynamic", shape: "box", layer: 1, mask: 0b011 } },
    ]);
    const session = new PhysicsSession(sc, createRapierBackend(RAPIER));
    step(session, 120);
    const y = (object: number) => session.overrides().get(object)![13]!;
    expect(y(2)).toBeCloseTo(1.6, 1); // on the plate (top at 1.1) + half a metre
    expect(y(3)).toBeCloseTo(0.5, 1); // through the plate (layer 2 isn't in its mask), onto the floor
    session.destroy();
  });

  it("walks a character through a wall its mask leaves out, and not through one it keeps (S3)", () => {
    const sc = sceneOf([
      FLOOR,
      { id: "glass", position: [1.5, 1, 0], scale: [0.2, 2, 4], physics: { body: "static", shape: "box", layer: 4 } },
      { id: "solid", position: [1.5, 1, 6], scale: [0.2, 2, 4], physics: { body: "static", shape: "box" } },
      { id: "spirit", position: [0, 0.9, 0], scale: [0.6, 1.6, 0.6], physics: { body: "character", mask: 0b1 } },
      { id: "walker", position: [0, 0.9, 6], scale: [0.6, 1.6, 0.6], physics: { body: "character" } },
    ]);
    const session = new PhysicsSession(sc, createRapierBackend(RAPIER));
    for (let i = 0; i < 60; i += 1) {
      session.run([
        { op: 4, a: 3, v: [0.05, -0.05, 0, 0, 0, 0] },
        { op: 4, a: 4, v: [0.05, -0.05, 0, 0, 0, 0] },
      ]);
    }
    const x = (object: number) => session.overrides().get(object)![12]!;
    expect(x(3)).toBeGreaterThan(2.5); // through the glass on layer 4
    expect(x(4)).toBeLessThan(1.3); // stopped by the solid wall
    session.destroy();
  });

  it("masks a ray through the block's commands, as the TIC-80 cores send it (S3)", () => {
    const sc = sceneOf([FLOOR, { id: "plate", position: [0, 2, 0], scale: [4, 0.2, 4], physics: { body: "static", shape: "box", layer: 2 } }]);
    const session = new PhysicsSession(sc, createRapierBackend(RAPIER));
    const block = new DataView(new ArrayBuffer(PHYS_BLOCK_BYTES));
    const ray = (slot: number) => ({ op: PHYS_OP_RAY, a: slot, v: [0, 10, 0, 0, -20, 0] as [number, number, number, number, number, number] });
    session.run([
      ray(0),
      { op: PHYS_OP_CAST, a: 1, v: [0, 0, 0, 0, 0, 0b001] }, // only layer 0: past the plate to the floor
      ray(1),
      { op: PHYS_OP_CAST, a: 2, v: [0, 0, 0, 0, 0, 0b010] }, // only layer 1: nothing there
      ray(2),
    ]);
    session.beforeTick(block);
    const slot = (s: number) => ({ word: block.getInt32(PHYS_RAYS + s * PHYS_RAY_BYTES, true), distance: block.getInt32(PHYS_RAYS + s * PHYS_RAY_BYTES + 28, true) / 1024 });
    expect(slot(0)).toEqual({ word: 3, distance: expect.closeTo(7.9, 2) }); // the plate (object 1) on top
    expect(slot(1)).toEqual({ word: 2, distance: expect.closeTo(10, 2) }); // the floor (object 0)
    expect(slot(2).word).toBe(0);
    session.destroy();
  });

  it("answers queries from the world as last stepped: bodies, rays and sweeps with masks, the hash (S1, S2)", () => {
    const sc = sceneOf([
      FLOOR,
      { id: "plate", position: [0, 2, 0], scale: [4, 0.2, 4], physics: { body: "static", shape: "box", layer: 2 } },
      { id: "crate", position: [6, 3, 0], physics: { body: "dynamic", shape: "box" } },
    ]);
    const session = new PhysicsSession(sc, createRapierBackend(RAPIER));
    step(session, 90);
    const body = session.query(PHYS_Q_BODY, 2, [])!;
    expect(body).toHaveLength(7);
    expect(body[1]).toBeCloseTo(0.5, 1);
    expect(session.query(PHYS_Q_BODY, 0, [])).toBeNull(); // static: nothing to read
    expect(session.query(PHYS_Q_BODY, 99, [])).toBeNull();

    const down = [0, 10, 0, 0, -20, 0];
    const top = session.query(PHYS_Q_RAY, 0, down)!;
    expect(top[0]).toBe(3); // the plate, object 1
    expect(top[7]).toBeCloseTo(7.9, 2);
    expect(top.slice(4, 7)).toEqual([expect.closeTo(0, 3), expect.closeTo(1, 3), expect.closeTo(0, 3)]);
    expect(session.query(PHYS_Q_CAST, 0, [0, 0, 0, 0, 0b001])).toBeNull();
    expect(session.query(PHYS_Q_RAY, 0, down)![0]).toBe(2); // masked past the plate: the floor
    expect(session.query(PHYS_Q_RAY, 0, down)![0]).toBe(3); // the options were for that one ray
    expect(session.query(PHYS_Q_RAY, 0, [0, 10, 0, 0, 5, 0])).toEqual([0]); // up: a miss
    expect(session.query(PHYS_Q_RAY, 0, [0, 10, 0, 0, 0, 0])).toEqual([0]); // no direction
    // A sphere of radius 0.5 swept down stops half a metre above the plate's top (2.1).
    session.query(PHYS_Q_CAST, PHYS_CAST_SPHERE, [0.5, 0, 0, 0, 0]);
    expect(session.query(PHYS_Q_RAY, 0, down)![7]).toBeCloseTo(10 - 2.1 - 0.5, 2);

    const block = new DataView(new ArrayBuffer(PHYS_BLOCK_BYTES));
    session.beforeTick(block);
    expect(session.query(PHYS_Q_HASH, 0, [])).toEqual([block.getInt32(PHYS_HDR_HASH, true)]);
    expect(session.query(999, 0, [])).toBeNull();
    session.destroy();
  });

  it("pages contacts and a trigger's contents past one answer's 32 numbers (S1)", () => {
    const crates: Entry[] = Array.from({ length: 40 }, (_, i) => ({ id: `c${i}`, position: [-8 + (i % 8) * 2, 1, -8 + Math.floor(i / 8) * 2], physics: { body: "dynamic", shape: "box" } }));
    const sc = sceneOf([FLOOR, { id: "zone", position: [0, 1, 0], scale: [20, 2, 20], physics: { body: "static", shape: "box", trigger: true } }, ...crates]);
    const session = new PhysicsSession(sc, createRapierBackend(RAPIER));
    let most = 0;
    for (let i = 0; i < 60; i += 1) {
      session.run([]);
      const total = session.query(PHYS_Q_CONTACTS, 0, [])![0]!;
      if (total > most) {
        most = total;
        // Read every page, as the Lua does, and get them all, in order.
        const all: number[] = [];
        for (let from = 0; from < total; from += 10) all.push(...session.query(PHYS_Q_CONTACTS, from, [])!.slice(1));
        expect(all.length).toBe(total * 3);
        expect(all.slice(0, 3)).toEqual(session.query(PHYS_Q_CONTACTS, 0, [])!.slice(1, 4));
      }
    }
    expect(most).toBeGreaterThan(10);
    const first = session.query(PHYS_Q_INSIDE, 1, [0])!;
    expect(first[0]).toBe(40);
    expect(first).toHaveLength(31);
    const rest = session.query(PHYS_Q_INSIDE, 1, [30])!;
    expect(rest).toHaveLength(11);
    expect(new Set([...first.slice(1), ...rest.slice(1)]).size).toBe(40);
    session.destroy();
  });

  it("runs the first 64 moving bodies on a block core and leaves the rest out, but runs them all on the dedicated core (S1)", () => {
    const crates: Entry[] = Array.from({ length: 100 }, (_, i) => ({ id: `c${i}`, position: [-9 + (i % 10) * 2, 3, -9 + Math.floor(i / 10) * 2], physics: { body: "dynamic", shape: "box" } }));
    const sc = sceneOf([FLOOR, ...crates]);
    expect(movingBodies(sc)).toHaveLength(100);
    expect(physicsSlots(sc)).toHaveLength(PHYS_MAX_BODIES);
    expect(physicsSlots(sc, DIRECT_MAX_BODIES)).toHaveLength(100);

    const capped = new PhysicsSession(sc, createRapierBackend(RAPIER));
    expect(capped.maxBodies).toBe(64);
    expect(capped.dropped).toEqual(movingBodies(sc).slice(64));
    expect(capped.overrides().size).toBe(64);
    capped.destroy();

    expect(bodyCapacity(sc, false)).toEqual({ bodies: 100, cap: 64, over: 36 });
    expect(bodyCapacity(sc, true)).toEqual({ bodies: 100, cap: DIRECT_MAX_BODIES, over: 0 });

    const direct = new PhysicsSession(sc, createRapierBackend(RAPIER), { maxBodies: DIRECT_MAX_BODIES });
    expect(direct.dropped).toEqual([]);
    step(direct, 90);
    expect(direct.overrides().size).toBe(100);
    expect(direct.query(PHYS_Q_BODY, 100, [])![1]).toBeCloseTo(0.5, 1); // the last crate, landed
    direct.destroy();
  });
});

describe.skipIf(!existsSync(CORE))("physics at scale on the dedicated Modern core", () => {
  beforeAll(async () => {
    await RAPIER.init();
  });

  it("reads 150 bodies, casts rays in the call with masks, and pages contacts and a trigger's contents in Lua", async () => {
    const crates: Entry[] = Array.from({ length: 150 }, (_, i) => ({
      id: `c${i}`,
      position: [-9 + (i % 10) * 1.2, 1, -9 + Math.floor(i / 10) * 1.2],
      physics: { body: "dynamic", shape: "box", layer: 1 },
    }));
    const sc = sceneOf([
      FLOOR,
      { id: "zone", position: [0, 1, 0], scale: [20, 2, 20], physics: { body: "static", shape: "box", trigger: true } },
      ...crates,
      // On layer 3 and colliding only with layer 3: it falls through the floor.
      { id: "ghost", position: [8, 4, -8], physics: { body: "dynamic", shape: "box", layer: 3, mask: 0b1000 } },
    ]);
    const code = `
t = 0
function TIC()
  t = t + 1
  if t == 1 then
    -- Cast in the call: no tick to wait (a TIC-80 core answers on the next).
    local hit, obj, x, y, z, nx, ny, nz, d = cartbox.ray(0, 8, 10, 8, 0, -1, 0, 50)
    pmem(100, hit and 1 or 0) pmem(101, (obj or -1) + 1) pmem(102, math.floor(d * 1000 + 0.5))
    local h2 = cartbox.hit(0)
    pmem(103, h2 and 1 or 0)
    pmem(104, cartbox.ray(1, 8, 10, 8, 0, -1, 0, 50, nil, cartbox.layers(3)) and 1 or 0)
    pmem(105, cartbox.ray(2, 8, 10, 8, 0, -1, 0, 50, nil, cartbox.layers(0, 3)) and 1 or 0)
    local s = cartbox.sweep(40, 0.5, 8, 10, 8, 0, -1, 0, 50)
    pmem(106, s and 1 or 0)
  end
  local n = #cartbox.contacts()
  if n > pmem(107) then pmem(107, n) end
  if t == 150 then
    local _, y = cartbox.body("c149")
    pmem(108, math.floor(y * 1000 + 0.5))
    local _, gy = cartbox.body("ghost")
    pmem(109, math.floor(-gy))
    pmem(110, #cartbox.inside("zone"))
    pmem(111, cartbox.physicshash() ~= 0 and 1 or 0)
  end
end`;
    const layout = RAM_LAYOUTS.xbox360;
    let tic = codeChunks(new TextEncoder().encode(code));
    tic = prependLuaCode(tic, sceneObjectsSdkLua(sc));
    tic = prependLuaCode(tic, runtimeSdkLua(sc, layout, { maxBodies: DIRECT_MAX_BODIES }));
    tic = injectSdk(tic);
    const mod = await (await import(pathToFileURL(CORE).href)).default();
    const console = createDirectConsole(mod, getModel("xbox360"));
    expect(console.loadCartridge(tic)).toBe(true);

    const session = new PhysicsSession(sc, createRapierBackend(RAPIER), { maxBodies: DIRECT_MAX_BODIES });
    expect(session.dropped).toEqual([]);
    const channel = new RuntimeChannel(sc, session);
    console.setQuery((op, a, v) => channel.query(op, a, v));
    const block = () => {
      const bytes = console.ramView(physicsBlockAddress(layout) - layout.pmemAddress, PHYS_BLOCK_BYTES)!;
      return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    };
    for (let i = 0; i < 150; i += 1) {
      channel.beforeTick(block());
      console.tick(0);
      expect(console.readError().message).toBe("");
      channel.afterTick(block(), null, console.takeCommands());
    }
    const word = (i: number) => console.netWords()![i]! | 0;

    expect(word(100)).toBe(1); // the first tick's ray hit
    expect(word(101)).toBe(1); // the floor, object 0
    expect(word(102) / 1000).toBeCloseTo(10, 2);
    expect(word(103)).toBe(1); // and cartbox.hit(0) has it too
    expect(word(104)).toBe(0); // only layer 3: nothing there
    expect(word(105)).toBe(1); // layers 0 and 3: the floor
    expect(word(106)).toBe(1); // a sweep in slot 40, past the block's 16
    expect(word(107)).toBeGreaterThan(48); // more contacts in a step than the block holds
    expect(word(108) / 1000).toBeCloseTo(0.5, 1); // the 150th crate, past the block's 64, landed
    expect(word(109)).toBeGreaterThan(5); // the ghost fell through the floor
    expect(word(110)).toBe(150); // every crate in the zone, past the block's 64 overlaps
    expect(word(111)).toBe(1);
    session.destroy();
  }, 120_000);
});
