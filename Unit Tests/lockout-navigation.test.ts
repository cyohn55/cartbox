/**
 * The Lockout bots' navigation, checked against the arena's real colliders
 * (read from the shipped cart code): the walkable surface baked from them
 * reaches every place the bots go — the tower decks, the BR top, the walkway,
 * the pit, the shotgun room — from every spawn; its routes never pass through a
 * wall; and seven bots walked over it as agents never walk through each other.
 */

import { describe, expect, it } from "vitest";

import { LOCKOUT_CODE, NavGraph, lockoutMeshSidecar, lockoutNavMesh } from "@cartbox/editor";
import { AgentCrowd, parseMeshScene } from "@cartbox/player";

function luaTable(name: string): number[] {
  const m = new RegExp(`local ${name}\\s*=\\s*\\{([^}]*)\\}`).exec(LOCKOUT_CODE);
  if (!m) throw new Error(`no ${name} table`);
  return m[1]!.split(",").map(Number);
}
const triples = (t: number[]) => Array.from({ length: t.length / 3 }, (_, i) => [t[i * 3]!, t[i * 3 + 1]!, t[i * 3 + 2]!] as [number, number, number]);

const COL = luaTable("COL");
const boxes = Array.from({ length: COL.length / 6 }, (_, i) => COL.slice(i * 6, i * 6 + 6) as [number, number, number, number, number, number]);
const ROAM = triples(luaTable("ROAM"));
const POWER = triples(luaTable("POWER"));
const SPAWNS = triples(luaTable("SPN"));

/** Whether a body of `radius` between heights lo..hi at (x,z) overlaps any collider. */
function blocked(x: number, z: number, lo: number, hi: number, radius: number): number[] | null {
  for (const b of boxes) {
    const [x0, y0, z0, x1, y1, z1] = b;
    if (x + radius > x0 && x - radius < x1 && z + radius > z0 && z - radius < z1 && hi > y0 && lo < y1) return b;
  }
  return null;
}

const mesh = lockoutNavMesh();
const graph = new NavGraph(mesh);

describe("the Lockout walkable surface", () => {
  it("ships in the scene sidecar", () => {
    const scene = parseMeshScene(lockoutMeshSidecar())!;
    expect(scene.navmesh?.heights.length).toBe(mesh.heights.length);
    expect(LOCKOUT_CODE).not.toContain("NAVN"); // no hand-placed waypoint graph any more
    expect(LOCKOUT_CODE).toContain("cartbox.moveto(o.id");
  });

  it("covers every place the bots go, standing on it", () => {
    for (const [x, y, z] of [...ROAM, ...POWER]) {
      const f = graph.nearest(x, y, z, 1.2);
      expect(f, `(${x},${y},${z}) has no surface near it`).toBeGreaterThanOrEqual(0);
      const [fx, fy, fz] = graph.position(f);
      expect(Math.abs(fy - y), `(${x},${y},${z}) is at the wrong height: ${fy}`).toBeLessThan(0.65);
      expect(Math.hypot(fx - x, fz - z)).toBeLessThan(1.2);
    }
  });

  it("reaches all of them from every spawn, by routes that never go through a wall", () => {
    for (const s of SPAWNS) {
      for (const goal of ROAM) {
        const path = graph.findPath(s, goal);
        expect(path, `no way from (${s}) to (${goal})`).not.toBeNull();
        for (let i = 1; i < path!.length; i += 1) {
          const [ax, ay, az] = path![i - 1]!;
          const [bx, by, bz] = path![i]!;
          const drop = by < ay - mesh.agent.climb;
          let y = ay;
          const samples = Math.max(10, Math.ceil(Math.hypot(bx - ax, bz - az) / 0.1));
          for (let k = 1; k < samples; k += 1) {
            const t = k / samples;
            const x = ax + (bx - ax) * t;
            const z = az + (bz - az) * t;
            // Follow the surface up and down the leg (a drop keeps its height until it lands).
            const f = graph.floorAt(x, y, z);
            if (!drop && f >= 0) y = mesh.heights[f]!;
            // Stairs are 0.5m risers under the hood, so a leg may sit a riser off
            // the stepped surface — but never inside a wall.
            const hit = blocked(x, z, y + 0.65, y + 1.6, 0.15);
            expect(hit, `leg (${ax},${az})→(${bx},${bz}) passes through ${hit}`).toBeNull();
          }
        }
      }
    }
  });

  it("gets up to the high ground, and takes the drops off it", () => {
    const deck = graph.findPath([-4, 0, -9.5], [-6.2, 7, -9.4])!;
    expect(deck.at(-1)![1]).toBeCloseTo(7, 1);
    const br = graph.findPath([2.6, 0, 11.2], [9.9, 4, 8.4])!;
    expect(br.at(-1)![1]).toBeCloseTo(4, 1);
    const pit = graph.findPath([0, 3.65, 0], [0, 0.7, 0])!;
    expect(pit.length).toBeLessThan(6); // straight off the walkway, not all the way round
    expect(mesh.drops.length).toBeGreaterThan(0);
  });

  it("names high ground as power positions", () => {
    expect(POWER.length).toBeGreaterThanOrEqual(4);
    for (const [, y] of POWER) expect(y).toBeGreaterThanOrEqual(2);
    expect(POWER.some(([, y]) => y === 7)).toBe(true); // the sniper deck
  });
});

describe("the bots as agents", () => {
  it("walk the arena for a minute without walking through each other or into a wall", () => {
    const crowd = new AgentCrowd(mesh);
    let seed = 7;
    const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    for (let i = 1; i <= 7; i += 1) crowd.place(i, SPAWNS[i]!, 4.5, 0.45, false);
    crowd.place(100, SPAWNS[0]!, 0, 0.44, true); // the player
    let closest = Infinity;
    let arrivals = 0;
    for (let t = 0; t < 60 * 60; t += 1) {
      for (const a of crowd.state()) {
        if (a.key === 100) continue;
        if ((a.flags & 4) !== 0) {
          arrivals += 1;
          crowd.goto(a.key, ROAM[Math.floor(rand() * ROAM.length)]!);
        }
      }
      crowd.step(1 / 60);
      const all = crowd.state();
      for (const a of all) {
        if (a.key !== 100) expect(blocked(a.position[0], a.position[2], a.position[1] + 0.65, a.position[1] + 1.6, 0.3), `bot ${a.key} in a wall at ${a.position}`).toBeNull();
        for (const b of all) {
          if (a.key >= b.key || Math.abs(a.position[1] - b.position[1]) > 1.2) continue;
          closest = Math.min(closest, Math.hypot(a.position[0] - b.position[0], a.position[2] - b.position[2]));
        }
      }
    }
    expect(arrivals).toBeGreaterThan(20); // they get places
    expect(closest).toBeGreaterThan(0.5); // bodies (0.45 + 0.45) never pass through each other
  }, 60_000);
});
