/**
 * Projectiles (AAA_PRODUCTION_ROADMAP.md S4): on the dedicated Modern core a
 * cart fires a projectile and the physics session flies it each tick, with
 * gravity and drag, sweeping its sphere along the tick's travel so a fast one
 * can't pass through a thin wall; it ends on a hit (pushing a dynamic body)
 * or when its life runs out, and the cart reads the impacts.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import RAPIER from "@dimforge/rapier3d-compat";
import RAPIER_DETERMINISTIC from "@dimforge/rapier3d-deterministic-compat";
import { beforeAll, describe, expect, it } from "vitest";
import { serializeMeshAsset, type MeshAsset } from "@cartbox/editor";
import {
  DIRECT_MAX_BODIES,
  DIRECT_MAX_PROJECTILES,
  PHYS_BLOCK_BYTES,
  PHYS_Q_FIRE,
  PHYS_Q_FIRE_OPTIONS,
  PHYS_Q_IMPACTS,
  PHYS_Q_PROJECTILE,
  PHYS_Q_STOP,
  PhysicsSession,
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
import { prependLuaCode } from "../packages/player/src/cartseed";
import { createRapierBackend } from "../apps/web/src/lib/physicsRapier";

const CORE = path.resolve(__dirname, "../packages/modern-core/dist/modern-core.js");

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

function sceneOf(entries: readonly Entry[], deterministic = false): MeshScene {
  const mesh = cube();
  return parseMeshScene(
    JSON.stringify({
      version: 2,
      ...(deterministic ? { physicsWorld: { deterministic: true } } : {}),
      meshes: entries.map((e) => ({ id: e.id, name: e.id, mesh, transform: { position: e.position, rotation: [0, 0, 0], scale: e.scale ?? [1, 1, 1] }, physics: e.physics })),
    }),
  )!;
}

const FLOOR: Entry = { id: "floor", position: [0, -0.5, 0], scale: [200, 1, 200], physics: { body: "static", shape: "box" } };

/** Fire through the session's queries, as the Lua does: options, then the shot. */
function fire(session: PhysicsSession, from: number[], velocity: number[], o: { radius?: number; gravity?: number; drag?: number; life?: number; owner?: number; mask?: number; push?: number } = {}): number | null {
  session.query(PHYS_Q_FIRE_OPTIONS, (o.owner ?? -1) + 1, [o.radius ?? 0.05, o.gravity ?? 1, o.drag ?? 0, o.life ?? 10, o.mask ?? 0, o.push ?? 0]);
  return session.query(PHYS_Q_FIRE, 0, [...from, ...velocity])?.[0] ?? null;
}

/** Every impact of the last step, read page by page. */
function impacts(session: PhysicsSession): number[][] {
  const total = session.query(PHYS_Q_IMPACTS, 0, [])![0]!;
  const out: number[][] = [];
  for (let from = 0; from < total; from += 3) {
    const r = session.query(PHYS_Q_IMPACTS, from, [])!.slice(1);
    for (let k = 0; k < r.length; k += 10) out.push(r.slice(k, k + 10));
  }
  return out;
}

/** Step until a projectile ends (or `max` ticks), returning the tick and its impact. */
function flyUntilEnd(session: PhysicsSession, id: number, max = 600): { tick: number; impact: number[] } | null {
  for (let tick = 1; tick <= max; tick += 1) {
    session.run([]);
    const e = impacts(session).find((i) => i[0] === id);
    if (e) return { tick, impact: e };
  }
  return null;
}

describe("projectiles in the physics session (S4)", () => {
  beforeAll(async () => {
    await RAPIER.init();
    await RAPIER_DETERMINISTIC.init();
  });

  it("falls along its arc and lands where the physics says", () => {
    const session = new PhysicsSession(sceneOf([FLOOR]), createRapierBackend(RAPIER));
    const id = fire(session, [0, 5, 0], [20, 0, 0], { radius: 0 })!;
    expect(id).toBeGreaterThan(0);
    const end = flyUntilEnd(session, id)!;
    // Dropping 5 m takes √(2·5/9.81) = 1.01 s: ~61 ticks, ~20 m on at 20 m/s.
    expect(end.tick).toBeGreaterThanOrEqual(59);
    expect(end.tick).toBeLessThanOrEqual(62);
    const [, kind, obj, x, y, , nx, ny, , speed] = end.impact;
    expect(kind).toBe(1);
    expect(obj).toBe(2); // the floor, object 0
    expect(x).toBeCloseTo(20.2, 0);
    expect(y).toBeCloseTo(0, 3);
    expect([nx, ny]).toEqual([expect.closeTo(0, 3), expect.closeTo(1, 3)]);
    expect(speed).toBeGreaterThan(20);
    expect(session.query(PHYS_Q_PROJECTILE, id, [])).toBeNull(); // gone
    session.destroy();
  });

  it("hits a 5 cm wall at 600 m/s, which a check at each tick's end would miss", () => {
    const sc = sceneOf([FLOOR, { id: "plate", position: [30, 2, 0], scale: [0.05, 4, 4], physics: { body: "static", shape: "box" } }]);
    const session = new PhysicsSession(sc, createRapierBackend(RAPIER));
    // A tick's travel is 10 m: the bullet is at x = 20 one tick and x = 30.0… the next is never inside the plate's 5 cm.
    const id = fire(session, [0.5, 2, 0], [600, 0, 0], { radius: 0.01, gravity: 0 })!;
    const end = flyUntilEnd(session, id, 10)!;
    expect(end.tick).toBe(3);
    expect(end.impact[2]).toBe(3); // the plate, object 1
    expect(end.impact[3]).toBeCloseTo(30 - 0.025, 2); // its near face
    expect(end.impact[6]).toBeCloseTo(-1, 3);
    session.destroy();
  });

  it("passes through its owner and the layers its mask leaves out, and pushes what it hits", () => {
    const sc = sceneOf([
      FLOOR,
      { id: "gunner", position: [0, 1, 0], scale: [1, 2, 1], physics: { body: "kinematic", shape: "box" } },
      { id: "glass", position: [5, 1, 0], scale: [0.1, 2, 4], physics: { body: "static", shape: "box", layer: 2 } },
      { id: "crate", position: [10, 0.5, 0], physics: { body: "dynamic", shape: "box", mass: 1 } },
    ]);
    const session = new PhysicsSession(sc, createRapierBackend(RAPIER));
    session.run([]);
    // From inside the gunner (object 1), every layer but 2: through the glass to the crate.
    const id = fire(session, [0, 0.5, 0], [100, 0, 0], { owner: 1, mask: 0b1011, push: 0.1, gravity: 0 })!;
    const end = flyUntilEnd(session, id, 20)!;
    expect(end.impact[2]).toBe(5); // the crate, object 3
    session.run([]);
    expect(session.inspect().get(3)!.velocity[0]).toBeGreaterThan(1); // shoved along +x
    // Without the mask it stops at the glass (object 2).
    const glassId = fire(session, [0, 0.5, 0], [100, 0, 0], { owner: 1, gravity: 0 })!;
    expect(flyUntilEnd(session, glassId, 20)!.impact[2]).toBe(4);
    session.destroy();
  });

  it("slows with drag, expires at the end of its life, and stops when told", () => {
    const session = new PhysicsSession(sceneOf([FLOOR]), createRapierBackend(RAPIER));
    const slow = fire(session, [0, 50, 0], [10, 0, 0], { gravity: 0, drag: 1, life: 0.5 })!;
    const stopped = fire(session, [0, 60, 0], [10, 0, 0], { gravity: 0 })!;
    for (let i = 0; i < 15; i += 1) session.run([]);
    const [, , , vx] = session.query(PHYS_Q_PROJECTILE, slow, [])!;
    expect(vx).toBeCloseTo(10 * (1 - 1 / 60) ** 15, 6); // a quarter of a second at drag 1
    session.query(PHYS_Q_STOP, stopped, []);
    expect(session.query(PHYS_Q_PROJECTILE, stopped, [])).toBeNull();
    const end = flyUntilEnd(session, slow, 30)!;
    expect(end.impact[1]).toBe(2); // expired
    expect(end.impact[2]).toBe(0); // nothing hit
    expect(15 + end.tick).toBe(30); // half a second
    expect(impacts(session).some((i) => i[0] === stopped)).toBe(false);
    session.destroy();
  });

  it("caps the projectiles in flight and refuses a shot from nowhere", () => {
    const session = new PhysicsSession(sceneOf([FLOOR]), createRapierBackend(RAPIER));
    for (let i = 0; i < DIRECT_MAX_PROJECTILES; i += 1) expect(fire(session, [0, 50, 0], [1, 0, 0])).not.toBeNull();
    expect(fire(session, [0, 50, 0], [1, 0, 0])).toBeNull();
    expect(new PhysicsSession(sceneOf([FLOOR]), createRapierBackend(RAPIER)).query(PHYS_Q_FIRE, 0, [Number.NaN, 0, 0, 1, 0, 0])).toBeNull();
    session.destroy();
  });

  it("flies the same in two worlds, in deterministic mode", () => {
    const run = () => {
      const sc = sceneOf([FLOOR, { id: "crate", position: [6, 0.5, 0], physics: { body: "dynamic", shape: "box" } }], true);
      const session = new PhysicsSession(sc, createRapierBackend(RAPIER_DETERMINISTIC));
      const out: number[][] = [];
      for (let t = 0; t < 120; t += 1) {
        if (t % 10 === 0) fire(session, [0, 1 + t / 100, 0], [15 + t / 7, 3, 0.3], { radius: 0.1, drag: 0.3, push: 0.2 });
        session.run([]);
        out.push(...impacts(session));
      }
      session.destroy();
      return out;
    };
    const a = run();
    expect(a.length).toBeGreaterThan(5);
    expect(run()).toEqual(a);
  });
});

describe.skipIf(!existsSync(CORE))("projectiles from Lua on the dedicated Modern core (S4)", () => {
  beforeAll(async () => {
    await RAPIER.init();
  });

  it("fires, follows and reads the impacts of 50 shots, and is nil on a block core's SDK", async () => {
    const sc = sceneOf([FLOOR, { id: "wall", position: [20, 2, 0], scale: [0.05, 4, 40], physics: { body: "static", shape: "box" } }]);
    const code = `
t = 0
ids = {}
function TIC()
  t = t + 1
  if t == 1 then
    for k = 1, 50 do ids[k] = cartbox.fire(0, 2, -10 + k * 0.4, 400, 0, 0, { radius = 0.02, gravity = 0 }) end
    pmem(100, #ids)
    local x = cartbox.projectile(ids[1]) pmem(101, x == 0 and 1 or 0)
  end
  for _, e in ipairs(cartbox.impacts()) do
    if e.hit and e.obj == 1 then pmem(102, pmem(102) + 1) pmem(103, math.floor(e.x * 1000)) end
  end
  if t == 10 then pmem(104, cartbox.projectile(ids[1]) == nil and 1 or 0) end
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
    const channel = new RuntimeChannel(sc, session, { direct: true });
    console.setQuery((op, a, v) => channel.query(op, a, v));
    const block = () => {
      const bytes = console.ramView(physicsBlockAddress(layout) - layout.pmemAddress, PHYS_BLOCK_BYTES)!;
      return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    };
    for (let i = 0; i < 10; i += 1) {
      channel.beforeTick(block());
      console.tick(0);
      expect(console.readError().message).toBe("");
      channel.afterTick(block(), null, console.takeCommands());
    }
    const word = (i: number) => console.netWords()![i]! | 0;
    expect(word(100)).toBe(50);
    expect(word(101)).toBe(1); // where it was fired, before the first step
    expect(word(102)).toBe(50); // every shot hit the 5 cm wall at 400 m/s
    expect(word(103) / 1000).toBeCloseTo(20 - 0.025, 2); // the point hit, on the near face
    expect(word(104)).toBe(1);
    session.destroy();

    // A block core's Lua has no _cbx_query: the calls answer nil and an empty list.
    const lua = runtimeSdkLua(sc, layout);
    expect(lua).toContain("cartbox.fire = function");
    expect(lua).toContain("if not _q or not _live() then return nil end");
  }, 120_000);
});
