/**
 * The Lockout arena's Forerunner architecture pass: the loft builder that draws
 * sloped, chamfered and leaning forms, and the invariants that keep the visual
 * shell and the physics honest — every spawn stands in open space (a spawn
 * inside a tower tier opened the match staring at the inside of a wall), and
 * the shotgun room's roof clears the player's head.
 */

import { describe, expect, it } from "vitest";

import { LOCKOUT_CODE, lockoutMeshSidecar, deserializeMeshAsset, lockoutTerrain, lockoutTerrainTriangles, terrainChunks, terrainHeight, terrainMesh } from "@cartbox/editor";
import { chamferedRect, newStreams, pushLoft } from "../packages/editor/src/model/seedGeometry";

/** Read a `local NAME = {…}` numeric table out of the shipped cart code. */
function luaTable(name: string): number[] {
  const m = new RegExp(`local ${name}\\s*=\\s*\\{([^}]*)\\}`).exec(LOCKOUT_CODE);
  if (!m) throw new Error(`no ${name} table`);
  return m[1]!.split(",").map(Number);
}
const PLAYER_RADIUS = 0.55;
const PLAYER_HEIGHT = 1.7;

describe("pushLoft", () => {
  it("builds a closed frustum whose faces all point outward", () => {
    const s = newStreams();
    const bottom = chamferedRect(0, 0, 2, 2, 0, 0);
    const top = chamferedRect(0, 0, 1, 1, 0, 3);
    pushLoft(s, bottom, top, 1, { top: true, bottom: true });
    expect(s.indices.length / 3).toBe(12); // 4 sides + 2 caps, two triangles each
    // Every vertex normal points away from the solid's centre (0, 1.5, 0).
    for (let i = 0; i < s.positions.length; i += 3) {
      const d = s.normals[i]! * s.positions[i]! + s.normals[i + 1]! * (s.positions[i + 1]! - 1.5) + s.normals[i + 2]! * s.positions[i + 2]!;
      expect(d).toBeGreaterThan(0);
    }
    // Battered walls lean inward: the side normals tilt up.
    expect(s.normals.some((n, i) => i % 3 === 1 && n > 0.1 && n < 0.99)).toBe(true);
  });

  it("drops a collapsed edge to a triangle, so wedges and ramps emit no slivers", () => {
    const s = newStreams();
    const bottom = [[0, 0, 0], [2, 0, 0], [2, 0, 1], [0, 0, 1]] as const;
    const top = [[0, 1, 0], [2, 1, 0], [2, 0, 1], [0, 0, 1]] as const; // back edge meets the floor
    pushLoft(s, bottom, top, 1, { top: true, bottom: true });
    // No zero-area triangles.
    for (let t = 0; t < s.indices.length; t += 3) {
      const [a, b, c] = [s.indices[t]!, s.indices[t + 1]!, s.indices[t + 2]!].map((i) => [s.positions[i * 3]!, s.positions[i * 3 + 1]!, s.positions[i * 3 + 2]!]);
      const u = [b![0]! - a![0]!, b![1]! - a![1]!, b![2]! - a![2]!];
      const v = [c![0]! - a![0]!, c![1]! - a![1]!, c![2]! - a![2]!];
      const area = Math.hypot(u[1]! * v[2]! - u[2]! * v[1]!, u[2]! * v[0]! - u[0]! * v[2]!, u[0]! * v[1]! - u[1]! * v[0]!);
      expect(area).toBeGreaterThan(1e-6);
    }
  });

  it("cuts 45-degree chamfers, clamped to the footprint", () => {
    expect(chamferedRect(0, 0, 1, 1, 0.25, 0)).toHaveLength(8);
    expect(chamferedRect(0, 0, 1, 1, 0, 0)).toHaveLength(4);
    const tiny = chamferedRect(0, 0, 0.1, 0.1, 5, 0);
    for (const [x, , z] of tiny) {
      expect(Math.abs(x)).toBeLessThanOrEqual(0.1 + 1e-9);
      expect(Math.abs(z)).toBeLessThanOrEqual(0.1 + 1e-9);
    }
  });
});

describe("the Lockout architecture", () => {
  const COL = luaTable("COL");
  const SPN = luaTable("SPN");
  const boxes = Array.from({ length: COL.length / 6 }, (_, i) => COL.slice(i * 6, i * 6 + 6));

  it("spawns every player in open space, never inside a collider", () => {
    for (let s = 0; s < SPN.length; s += 3) {
      const [x, y, z] = [SPN[s]!, SPN[s + 1]!, SPN[s + 2]!];
      for (const [x0, y0, z0, x1, y1, z1] of boxes) {
        const overlapsXZ = x + PLAYER_RADIUS > x0! && x - PLAYER_RADIUS < x1! && z + PLAYER_RADIUS > z0! && z - PLAYER_RADIUS < z1!;
        // Standing *on* a box (feet at its top) is fine; the body must not be inside one.
        const overlapsY = y + PLAYER_HEIGHT > y0! + 1e-3 && y < y1! - 1e-3;
        expect(overlapsXZ && overlapsY, `spawn ${s / 3} (${x},${y},${z}) inside box ${[x0, y0, z0, x1, y1, z1].join(",")}`).toBe(false);
      }
    }
  });

  it("gives the shotgun room enough headroom to stand in", () => {
    // Floor top 2.2; the roof's underside must clear a 1.7-tall player.
    const roof = boxes.find(([x0, y0, , x1]) => x0! < -9 && x1! > -9 && y0! > 3 && y0! < 5)!;
    expect(roof, "the shotgun-room roof").toBeTruthy();
    expect(roof[1]! - 2.2).toBeGreaterThanOrEqual(PLAYER_HEIGHT);
  });

  it("draws the arena as sloped Forerunner forms plus snow, not just boxes", () => {
    const map = deserializeMeshAsset((JSON.parse(lockoutMeshSidecar()) as { meshes: { mesh: string }[] }).meshes[0]!.mesh);
    const names = map.primitives.map((p) => p.material.name);
    expect(names).toEqual(expect.arrayContaining(["forerunner", "forerunner-underside", "snow", "energy"]));
    // Sloped faces: some structure normals are neither axis-aligned nor flat.
    const structure = map.primitives.find((p) => p.material.name === "forerunner")!;
    const n = structure.normals!;
    let sloped = 0;
    for (let i = 0; i < n.length; i += 3) {
      const m = Math.max(Math.abs(n[i]!), Math.abs(n[i + 1]!), Math.abs(n[i + 2]!));
      if (m < 0.97) sloped += 1;
    }
    expect(sloped).toBeGreaterThan(100);
    // The deck hangs over a drop: the underside reaches well below the floor.
    const under = map.primitives.find((p) => p.material.name === "forerunner-underside")!;
    let minY = Infinity;
    for (let i = 1; i < under.positions.length; i += 3) minY = Math.min(minY, under.positions[i]!);
    expect(minY).toBeLessThan(-8);
  });
});

describe("the Lockout mountains", () => {
  const t = lockoutTerrain();

  it("hangs the arena over a chasm, with cliffs and peaks all round", () => {
    // Under the whole deck (and a margin past it) the ground is far below.
    for (let x = -20; x <= 20; x += 2) for (let z = -16; z <= 16; z += 2) expect(terrainHeight(t, x, z)!).toBeLessThan(-60);
    // Walking out in any direction, the ground climbs well above the deck.
    for (let a = 0; a < Math.PI * 2; a += Math.PI / 12) {
      let top = -Infinity;
      for (let r = 20; r <= 120; r += 2) top = Math.max(top, terrainHeight(t, Math.cos(a) * r, Math.sin(a) * r)!);
      expect(top).toBeGreaterThan(15);
    }
  });

  it("settles snow on the gentle ground and bares rock on the cliffs", () => {
    const mesh = terrainMesh(t);
    const [snow, rock] = mesh.primitives;
    expect(snow!.material.name).toBe("terrain-snow");
    expect(rock!.material.name).toBe("terrain-rock");
    expect(rock!.material.baseColorImage).toBeTruthy(); // weathered rock texture + normal map
    expect(rock!.material.normalImage).toBeTruthy();
    // Where they meet the two blend per vertex (H4): each blended primitive is
    // named for its dominant layer first.
    const count = (prefix: string) => mesh.primitives.filter((p) => p.material.name.startsWith(prefix)).reduce((n, p) => n + p.indices.length, 0);
    expect(count("terrain-snow")).toBeGreaterThan(count("terrain-rock") * 0.3);
    const blended = mesh.primitives.filter((p) => p.blend);
    expect(blended.length).toBeGreaterThan(0);
    for (const p of blended) expect(p.blend!.some((w) => w > 0.05 && w < 0.95)).toBe(true);
    expect(lockoutTerrainTriangles()).toBeLessThan(20000);
    // Drawn in blocks: from the arena the far range is coarser, so it costs far less.
    const tris = (m: { primitives: { indices: Uint32Array }[] }) => m.primitives.reduce((n, p) => n + p.indices.length / 3, 0);
    const fromArena = terrainChunks(t).reduce((sum, c) => {
      const cell = t.size[0] / (t.samples - 1);
      const x0 = t.origin[0] + c.cells[0] * cell, x1 = t.origin[0] + c.cells[2] * cell;
      const z0 = t.origin[2] + c.cells[1] * cell, z1 = t.origin[2] + c.cells[3] * cell;
      const d = Math.hypot(Math.max(x0, 0, -x1), Math.max(z0, 0, -z1));
      const level = d < c.detail ? 0 : d < c.detail * 2 ? 1 : 2;
      return sum + tris(level === 0 ? c.mesh : c.lods[level - 1]!);
    }, 0);
    expect(fromArena).toBeLessThan(lockoutTerrainTriangles() * 0.75);
  });

  it("ships on the sidecar, riding on the map so the menus' hiding the map hides it too", () => {
    const sidecar = JSON.parse(lockoutMeshSidecar());
    // The mountains, then the far range drawn into the sky (I7; see vistas.test.ts).
    expect(sidecar.terrains.map((t: { id: string }) => t.id)).toEqual(["lockout-range", "lockout-vista"]);
    expect(sidecar.terrains[0].parent).toBe("lockout-map");
    expect(sidecar.meshes[0].id).toBe("lockout-map");
    expect(LOCKOUT_CODE).toMatch(/for i=0,NBOT do cartbox\.meshpose\(i,0,-999/);
    // Compact: the heightfield and its one rock texture, not a mesh.
    expect(JSON.stringify(sidecar.terrains[0]).length).toBeLessThan(140_000);
    expect(JSON.stringify(sidecar.terrains[1]).length).toBeLessThan(80_000);
  });
});
