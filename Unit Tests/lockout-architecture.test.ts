/**
 * The Lockout arena's Forerunner architecture pass: the loft builder that draws
 * sloped, chamfered and leaning forms, and the invariants that keep the visual
 * shell and the physics honest — every spawn stands in open space (a spawn
 * inside a tower tier opened the match staring at the inside of a wall), and
 * the shotgun room's roof clears the player's head.
 */

import { describe, expect, it } from "vitest";

import { LOCKOUT_CODE, LOCKOUT_MESH_SIDECAR, deserializeMeshAsset } from "@cartbox/editor";
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
    const map = deserializeMeshAsset((JSON.parse(LOCKOUT_MESH_SIDECAR) as { meshes: { mesh: string }[] }).meshes[0]!.mesh);
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
