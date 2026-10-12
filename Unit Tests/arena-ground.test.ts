/**
 * Walkable ground and the map validator (BEAVER_CREEK_ROADMAP.md B3). A map's
 * terrain becomes ground the cart's soldiers stand and walk on -- up a gentle
 * slope, not up a cliff -- that shots strike, and that the bots' navmesh is
 * baked over. The validator passes Lockout and flags, on purpose-broken maps,
 * each thing that would spoil a match.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

import {
  LOCKOUT_MAP,
  NavGraph,
  arenaGround,
  arenaLua,
  arenaNavMesh,
  groundBoxes,
  groundHeight,
  groundTriangles,
  lockoutCartridge,
  lockoutCode,
  lockoutMeshSidecar,
  lockoutNavMesh,
  validateArenaMap,
  type ArenaMap,
} from "@cartbox/editor";
import { NET_WORDS, injectSdk, readSidecarUi, uiSdkLua } from "@cartbox/player";
import { prependLuaCode } from "../packages/player/src/cartseed";

const ENGINE = path.resolve(__dirname, "../packages/engine/dist/xbox360/engine.js");

/** Flat to the west; a gentle rise (0.15 a metre) east of x = 0; a 4 m cliff north of z = 10; a hole at the far corner. */
const height = (x: number, z: number) => {
  if (x > 15 && z < -15) return NaN;
  return (z > 10 ? 4 : 0) + Math.max(0, x) * 0.15;
};
const GROUND = arenaGround(-20, -20, 1.25, 33, height);

const HILLSIDE: ArenaMap = {
  id: "hillside",
  name: "Hillside",
  solids: [],
  flights: [],
  spawns: [
    { at: [-10, 0, 0], team: "blue" },
    { at: [-10, 0, -4], team: "red" },
  ],
  destinations: [[-5, 0, 0], [10, 1.5, 0]],
  power: [1],
  hills: [[0, 0, 5]],
  ball: [-5, 0, 5],
  deathY: -6,
  markers: [{ box: [5, 0.75 + 0.4, 0, 0.28, 0.4, 0.28], weapon: "rocket" }],
  ground: GROUND,
};

describe("ground", () => {
  it("is the same height function between samples, with holes", () => {
    expect(groundHeight(GROUND, -10, 0)).toBeCloseTo(0, 9);
    expect(groundHeight(GROUND, 10, 0)).toBeCloseTo(1.5, 6);
    expect(groundHeight(GROUND, 17, -17)).toBeNull(); // the hole
    expect(groundHeight(GROUND, 40, 0)).toBeNull(); // off it
    // Two triangles a cell, none over the hole.
    const cells = 32 * 32;
    const tris = groundTriangles(GROUND).length / 9;
    expect(tris).toBeLessThan(cells * 2);
    expect(tris).toBeGreaterThan(cells * 2 * 0.9);
    // Coarse boxes for ragdolls and debris, their tops near the ground's.
    for (const [cx, cy, cz, , hy] of groundBoxes(GROUND)) {
      const g = groundHeight(GROUND, cx, cz);
      if (g !== null && cz < 8) expect(Math.abs(cy + hy - g)).toBeLessThan(0.6);
    }
  });

  it("goes into the cart as its HF table, and nothing for a map without", () => {
    const lua = arenaLua(HILLSIDE);
    expect(lua).toMatch(/^HF = \{/m);
    expect(lua).toContain("HF_N, HF_X0, HF_Z0, HF_S, HF_TOP = 33, -20.00, -20.00, 1.25");
    expect(lua).toContain("-999"); // the hole
    expect(arenaLua(LOCKOUT_MAP)).toContain("HF = nil");
  });

  it("is in the bots' navmesh: a route up the slope to its top", () => {
    const graph = new NavGraph(arenaNavMesh(HILLSIDE, { radius: 0.45, height: 1.7, climb: 0.6, maxSlope: 45, maxDrop: 5 }));
    const path = graph.findPath([-10, 0, 0], [10, 1.5, 0]);
    expect(path).not.toBeNull();
    // ... and not up the cliff.
    expect(graph.findPath([-10, 0, 0], [0, 4, 15])).toBeNull();
  });
});

describe("the map validator", () => {
  it("passes Lockout, and the hillside", () => {
    expect(validateArenaMap(LOCKOUT_MAP, { navmesh: lockoutNavMesh(), sidecar: { size: lockoutMeshSidecar().length, budget: 2_800_000 } })).toEqual([]);
    const navmesh = arenaNavMesh(HILLSIDE, { radius: 0.45, height: 1.7, climb: 0.6, maxSlope: 45, maxDrop: 5 });
    expect(validateArenaMap(HILLSIDE, { navmesh })).toEqual([]);
  });

  it("flags each failure on purpose-broken maps", () => {
    const navmesh = arenaNavMesh(HILLSIDE, { radius: 0.45, height: 1.7, climb: 0.6, maxSlope: 45, maxDrop: 5 });
    const kinds = (map: ArenaMap, nav = navmesh) => validateArenaMap(map, { navmesh: nav }).map((i) => i.kind);
    // A spawn in mid-air.
    expect(kinds({ ...HILLSIDE, spawns: [...HILLSIDE.spawns, { at: [-8, 3, 0] }] })).toContain("spawn-floor");
    // A spawn inside a wall.
    const walled = { ...HILLSIDE, solids: [[-6, 1, -6, 0.5, 1, 0.5]] as ArenaMap["solids"], spawns: [...HILLSIDE.spawns, { at: [-6, 0, -6] as [number, number, number] }] };
    expect(kinds(walled, arenaNavMesh(walled, { radius: 0.45, height: 1.7, climb: 0.6, maxSlope: 45, maxDrop: 5 }))).toContain("spawn-solid");
    // A destination on the clifftop bots can't climb to.
    expect(kinds({ ...HILLSIDE, destinations: [...HILLSIDE.destinations, [0, 4, 15]] })).toContain("unreachable");
    // A hill near the death plane.
    expect(kinds({ ...HILLSIDE, deathY: -0.5 })).toContain("death-plane");
    // A ball beyond what the net state carries.
    expect(kinds({ ...HILLSIDE, ball: [400, 0, 0] })).toContain("out-of-range");
    // Over budget.
    expect(validateArenaMap(HILLSIDE, { navmesh, sidecar: { size: 3, budget: 2 } }).map((i) => i.kind)).toEqual(["over-budget"]);
  });
});

describe.skipIf(!existsSync(ENGINE))("ground in the cart, on the real engine", () => {
  /** The hillside's cart, the player driven by `probe`; pmem 117/118 as it writes them. */
  async function run(probe: string, ticks: number) {
    const code = `${lockoutCode(HILLSIDE, [0, 0, 0])}\n${probe}`;
    const tic = injectSdk(prependLuaCode(lockoutCartridge(code), uiSdkLua(readSidecarUi(lockoutMeshSidecar()), 1280, 720)));
    const mod = await (await import(pathToFileURL(ENGINE).href)).default();
    const h = mod._cbx_create(44100);
    const ptr = mod._malloc(tic.length);
    mod.HEAPU8.set(tic, ptr);
    expect(mod._cbx_load(h, ptr, tic.length)).toBe(1);
    mod._free(ptr);
    const words = () => new Uint32Array(mod.HEAPU8.buffer, mod._cbx_mailbox_ptr(h) - NET_WORDS * 4, NET_WORDS);
    for (let i = 0; i < 3; i += 1) mod._cbx_tick(h, 0);
    mod._cbx_tick(h, 1 << 4); // Free for All
    for (let i = 0; i < 40; i += 1) mod._cbx_tick(h, i % 2 ? 1 << 4 : 0); // past the intro
    for (let i = 0; i < ticks; i += 1) mod._cbx_tick(h, 0);
    return [words()[117]!, words()[118]!] as const;
  }
  const walk = (x: number, z: number, yaw: number, n: number) => `;(function()
local _T, k = TIC, 0
function TIC()
  _T()
  if phase == "play" and p then
    k = k + 1
    for _,o in ipairs(bots) do o.dead, o.respawn, o.x, o.y, o.z = true, 1e9, 0, -60, 0 end
    if k == 2 then p.x, p.y, p.z, p.vy, p.dead = ${x}, ${height(x, z).toFixed(2)}, ${z}, 0, false end
    if k > 2 and k < ${n} then move_soldier(p, 1, 0, ${yaw}, false, false, false, 0) end
    pmem(117, (math.floor(p.x*100 + 5000) & 0xffff) | ((math.floor(p.z*100 + 5000) & 0xffff) << 16))
    pmem(118, (math.floor(p.y*100 + 1000) & 0xffff) | ((math.floor((ground_at(p.x, p.z) or -10)*100 + 1000) & 0xffff) << 16))
  end
end
end)()`;
  const read = ([a, b]: readonly [number, number]) => ({ x: ((a & 0xffff) - 5000) / 100, z: ((a >>> 16) - 5000) / 100, y: ((b & 0xffff) - 1000) / 100, ground: ((b >>> 16) - 1000) / 100 });

  it("walks a soldier up a gentle slope, standing on it", async () => {
    // (about 9 m a second for two seconds: up the slope, short of the ground's east edge)
    const r = read(await run(walk(-2, 0, Math.PI / 2, 110), 120));
    expect(r.x).toBeGreaterThan(6);
    expect(r.y).toBeGreaterThan(0.9);
    expect(Math.abs(r.y - r.ground)).toBeLessThan(0.05);
  }, 60_000);

  it("stops a soldier at a cliff", async () => {
    const r = read(await run(walk(-5, 5, 0, 220), 240)); // north, toward z = 10
    expect(r.z).toBeLessThan(10);
    expect(r.z).toBeGreaterThan(8);
    expect(r.y).toBeLessThan(0.1);
  }, 60_000);

  it("stops shots at the ground: a rise between two points blocks the line, and a shot down strikes it", async () => {
    const probe = `;(function()
local _T = TIC
function TIC()
  _T()
  local over = seg_blocked(0, 1, 5, 0, 1, 15, 1, true) and 1 or 0   -- (into the cliff: blocked)
  local clear = seg_blocked(-15, 1.5, 0, -5, 1.5, 0, 1, true) and 1 or 0  -- over flat ground: clear
  local t, nx, ny = seg_first(10, 5, 0, 10, -5, 0)
  pmem(117, over | (clear << 1))
  pmem(118, math.floor((t or 0)*1000) | (math.floor((ny or 0)*100) << 16))
end
end)()`;
    const [a, b] = await run(probe, 2);
    expect(a & 1).toBe(1);
    expect((a >> 1) & 1).toBe(0);
    // Straight down from 5 m at x = 10: the ground at 1.5 m is 3.5 of the 10 m down.
    expect((b & 0xffff) / 1000).toBeCloseTo(0.35, 2);
    expect((b >>> 16) / 100).toBeGreaterThan(0.95); // the normal points up
  }, 60_000);
});
