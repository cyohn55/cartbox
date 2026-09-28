/**
 * Navigation (ENGINE_ROADMAP.md, Phase 6): a walkable surface baked from a
 * scene's geometry, paths over it, agents the host walks along them (keeping
 * clear of each other and of obstacles), and the Lua calls that drive them —
 * on the real engine.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

import { NavGraph, bakeNavMesh, boxTriangles, readNavMesh, serializeNavMesh, serializeMeshAsset, type MeshAsset } from "@cartbox/editor";
import {
  AgentCrowd,
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
} from "@cartbox/player";
import { prependLuaCode } from "../packages/player/src/cartseed";

const ENGINE = path.resolve(__dirname, "../packages/engine/dist/xbox360/engine.js");

/**
 * A test yard: a 20×20 floor; a wall across the middle with a gap at one end;
 * a 2-high platform in a corner with a flight of 0.4 steps up to it; and a
 * 3-high ledge you can only drop off.
 */
const YARD = [
  [0, -0.5, 0, 10, 0.5, 10], // floor, top 0
  [-2, 1.5, 0, 8, 1.5, 0.25], // wall along X at z=0, from x=-10 to 6 (the only gap at x > 6)
  [-7, 1, -7, 2, 1, 2], // platform, top 2
  [-7, 0.2, -3.2, 1, 0.2, 0.2], // a flight of 0.4 steps up to its edge at z = -5
  [-7, 0.4, -3.6, 1, 0.4, 0.2],
  [-7, 0.6, -4.0, 1, 0.6, 0.2],
  [-7, 0.8, -4.4, 1, 0.8, 0.2],
  [-7, 0.9, -4.8, 1, 0.9, 0.2], // 1.8
  [7, 1.5, 7, 2, 1.5, 2], // ledge, top 3 (no way up)
];
const bake = () => bakeNavMesh(boxTriangles(YARD), { cell: 0.25, agent: { radius: 0.4, height: 1.8, climb: 0.45, maxDrop: 4 } });

describe("baking", () => {
  const mesh = bake();
  const g = new NavGraph(mesh);

  it("finds the floors, keeping a body's width from the walls", () => {
    expect(g.floorAt(0, 0, 5)).toBeGreaterThanOrEqual(0); // open floor
    expect(g.floorAt(0, 0, 0.5)).toBe(-1); // hugging the wall (inside the radius)
    expect(g.floorAt(0, 0, 0.8)).toBeGreaterThanOrEqual(0);
    expect(mesh.heights[g.floorAt(-7, 2, -7)]).toBeCloseTo(2, 5); // the platform top
    expect(g.floorAt(9.8, 0, 0)).toBe(-1); // the edge of the world
  });

  it("walks round the wall through the gap, and up the steps", () => {
    const round = g.findPath([0, 0, -5], [0, 0, 5])!;
    expect(round).not.toBeNull();
    expect(Math.max(...round.map((p) => p[0]))).toBeGreaterThan(6); // through the gap
    const up = g.findPath([0, 0, -5], [-7, 2, -7])!;
    expect(up.at(-1)![1]).toBeCloseTo(2, 3);
    // Every straight leg of the path stays on the surface.
    for (let i = 1; i < up.length; i += 1) expect(g.walkable(up[i - 1]!, up[i]!) || Math.abs(up[i]![1] - up[i - 1]![1]) > 0.45).toBe(true);
  });

  it("drops off a ledge but never climbs one", () => {
    expect(mesh.drops.length).toBeGreaterThan(0);
    const down = g.findPath([7, 3, 7], [0, 0, 5]);
    expect(down).not.toBeNull();
    expect(g.findPath([0, 0, 5], [7, 3, 7])).toBeNull(); // no way up
  });

  it("stores compactly and reads back, rejecting junk", () => {
    const stored = JSON.parse(JSON.stringify(serializeNavMesh(mesh)));
    const back = readNavMesh(stored)!;
    expect(back.cols).toBe(mesh.cols);
    expect(back.counts).toEqual(mesh.counts);
    back.heights.forEach((h, i) => expect(Math.abs(h - mesh.heights[i]!)).toBeLessThan(0.006));
    expect(Array.from(back.drops)).toEqual(Array.from(mesh.drops));
    expect(readNavMesh({ ...stored, counts: "AAAA" })).toBeNull();
    expect(readNavMesh({ ...stored, cols: 1e9 })).toBeNull();
    expect(readNavMesh(null)).toBeNull();
  });
});

describe("agents", () => {
  const run = (crowd: AgentCrowd, ticks: number, each?: () => void) => {
    for (let t = 0; t < ticks; t += 1) {
      each?.();
      crowd.step(1 / 60);
    }
  };
  const at = (crowd: AgentCrowd, key: number) => crowd.state().find((a) => a.key === key)!;

  it("walk their own way to a goal (round the wall), and say when they're there", () => {
    const crowd = new AgentCrowd(bake());
    crowd.place(1, [0, 0, -5], 4, 0.4, false);
    crowd.goto(1, [0, 0, 5]);
    expect(at(crowd, 1).flags & 4).toBe(0);
    let crossed = false;
    run(crowd, 60 * 12, () => {
      if (at(crowd, 1).position[0] > 6) crossed = true;
    });
    const a = at(crowd, 1);
    expect(crossed).toBe(true);
    expect(Math.hypot(a.position[0], a.position[2] - 5)).toBeLessThan(0.3);
    expect(a.flags & 4).toBe(4); // arrived
  });

  it("keep clear of each other, and of an obstacle the cart moves", () => {
    const crowd = new AgentCrowd(bake());
    // Two agents walking straight at each other along the same line.
    crowd.place(1, [-4, 0, 5], 3, 0.4, false);
    crowd.place(2, [4, 0, 5], 3, 0.4, false);
    crowd.goto(1, [4, 0, 5]);
    crowd.goto(2, [-4, 0, 5]);
    let closest = Infinity;
    run(crowd, 60 * 6, () => {
      const [a, b] = [at(crowd, 1).position, at(crowd, 2).position];
      closest = Math.min(closest, Math.hypot(a[0] - b[0], a[2] - b[2]));
    });
    expect(closest).toBeGreaterThan(0.55); // never walked through each other
    // An obstacle parked on an agent pushes it away.
    const still = new AgentCrowd(bake());
    still.place(1, [0, 0, 5], 3, 0.4, false);
    still.place(100, [0.2, 0, 5], 0, 0.5, true);
    run(still, 30);
    const p = at(still, 1).position;
    expect(Math.hypot(p[0] - 0.2, p[2] - 5)).toBeGreaterThan(0.85);
  });

  it("stay on the surface: pushed at a wall they slide, off a ledge they only go by falling", () => {
    const crowd = new AgentCrowd(bake());
    crowd.place(1, [0, 0, 1], 3, 0.4, false);
    crowd.place(100, [0, 0, 2], 0, 0.6, true); // shove it toward the wall
    run(crowd, 30);
    expect(at(crowd, 1).position[2]).toBeGreaterThan(0.6); // held off the wall by its radius
    // Off the ledge: it falls (air), then lands on the floor.
    const drop = new AgentCrowd(bake());
    drop.place(1, [7, 3, 7], 4, 0.4, false);
    drop.goto(1, [2, 0, 7]);
    let air = false;
    run(drop, 60 * 5, () => {
      if (at(drop, 1).flags & 2) air = true;
    });
    expect(air).toBe(true);
    expect(at(drop, 1).position[1]).toBeCloseTo(0, 3);
  });
});

function cube(): MeshAsset {
  return {
    name: "c",
    primitives: [
      {
        positions: Float32Array.from([0, 0, 0, 1, 0, 0, 1, 1, 0]),
        normals: null,
        uvs: null,
        indices: Uint32Array.from([0, 1, 2]),
        material: { name: "m", baseColorFactor: [1, 1, 1, 1], baseColorImage: null },
      },
    ],
  };
}

describe.skipIf(!existsSync(ENGINE))("agents from Lua (real engine)", () => {
  it("places, sends and reads back an agent; an unknown key reads nil", async () => {
    const layout = RAM_LAYOUTS.xbox360;
    const sidecar = JSON.stringify({
      version: 2,
      meshes: [{ id: "a", name: "yard", mesh: serializeMeshAsset(cube()), transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] } }],
      navmesh: serializeNavMesh(bake()),
    });
    const sc = parseMeshScene(sidecar)!;
    expect(sc.navmesh).toBeDefined();
    expect(sceneNeedsRuntime(sc, { physics: false })).toBe(true);
    const code = `
t = 0
function TIC()
  t = t + 1
  if t == 2 then
    pmem(100, cartbox.navigable() and 1 or 0)
    cartbox.agent(5, 0, 0, -5, 4, 0.4)
    cartbox.moveto(5, 0, 0, 5)
    pmem(101, cartbox.agentpos(9) == nil and 1 or 0)
  end
  if t == 4 then
    local x, y, z, face, moving, air, arrived = cartbox.agentpos(5)
    pmem(102, x and 1 or 0)
    pmem(103, moving and 1 or 0)
    pmem(104, arrived and 1 or 0)
  end
  local x, y, z, face, moving, air, arrived = cartbox.agentpos(5)
  if x and arrived and t > 10 and pmem(105) == 0 then
    pmem(105, t); pmem(106, math.floor(x * 100 + 0.5)); pmem(107, math.floor(z * 100 + 0.5))
  end
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
    for (let i = 1; i <= 60 * 12; i += 1) {
      channel.beforeTick(block());
      mod._cbx_tick(h, 0);
      channel.afterTick(block());
    }
    const w = (i: number) => new Int32Array(mod.HEAPU8.buffer, base, 256)[i]!;
    expect(w(100)).toBe(1);
    expect(w(101)).toBe(1);
    expect(w(102)).toBe(1);
    expect(w(103)).toBe(1);
    expect(w(104)).toBe(0);
    expect(w(105)).toBeGreaterThan(60); // it walked round the wall and got there
    expect(Math.abs(w(106))).toBeLessThan(30);
    expect(Math.abs(w(107) - 500)).toBeLessThan(30);
    channel.destroy();
  }, 120_000);
});
