/**
 * The Lockout bots' navigation graph, checked against the arena's real
 * colliders (both read from the shipped cart code): every waypoint stands on a
 * surface with headroom, every two-way link is walkable in a straight line, the
 * graph is connected, and the high ground (sniper deck, BR top, walkway) is
 * reachable from the floor — the thing the old "snap to the tallest platform
 * under 2.7" bots could never do.
 */

import { describe, expect, it } from "vitest";

import { LOCKOUT_CODE } from "@cartbox/editor";

function luaTable(name: string): number[] {
  const m = new RegExp(`local ${name}\\s*=\\s*\\{([^}]*)\\}`).exec(LOCKOUT_CODE);
  if (!m) throw new Error(`no ${name} table`);
  return m[1]!.split(",").map(Number);
}

const COL = luaTable("COL");
const boxes = Array.from({ length: COL.length / 6 }, (_, i) => COL.slice(i * 6, i * 6 + 6) as [number, number, number, number, number, number]);
const NAVN = luaTable("NAVN");
const nodes = Array.from({ length: NAVN.length / 3 }, (_, i) => [NAVN[i * 3]!, NAVN[i * 3 + 1]!, NAVN[i * 3 + 2]!] as const);
const pairs = (t: number[]) => Array.from({ length: t.length / 2 }, (_, i) => [t[i * 2]! - 1, t[i * 2 + 1]! - 1] as const);
const links = pairs(luaTable("NAVL"));
const drops = pairs(luaTable("NAVD"));
const jumps = pairs(luaTable("NAVJ"));

/**
 * Highest collider top at or below `y + tol` under a body of `FOOT` radius at
 * (x,z) — a body stands wherever its footprint overlaps a surface, as the
 * cart's own physics has it (which is how the half-metre gaps between the
 * walkway and its ramps are crossed).
 */
const FOOT = 0.3;
function supportAt(x: number, z: number, y: number, tol: number): number {
  let top = -Infinity;
  for (const [x0, , z0, x1, y1, z1] of boxes) {
    if (x + FOOT >= x0 && x - FOOT <= x1 && z + FOOT >= z0 && z - FOOT <= z1 && y1 <= y + tol) top = Math.max(top, y1);
  }
  return top;
}

/** Whether a body of `radius` between heights lo..hi at (x,z) overlaps any collider. */
function blocked(x: number, z: number, lo: number, hi: number, radius: number): number[] | null {
  for (const b of boxes) {
    const [x0, y0, z0, x1, y1, z1] = b;
    if (x + radius > x0 && x - radius < x1 && z + radius > z0 && z - radius < z1 && hi > y0 && lo < y1) return b;
  }
  return null;
}

describe("the Lockout bot navigation graph", () => {
  it("puts every waypoint on a real surface with headroom", () => {
    nodes.forEach(([x, y, z], i) => {
      const top = supportAt(x, z, y, 0.15);
      expect(Math.abs(top - y), `node ${i} (${x},${y},${z}) floats/sinks: surface ${top}`).toBeLessThan(0.25);
      expect(blocked(x, z, y + 0.25, y + 1.6, 0.15), `node ${i} (${x},${y},${z}) is inside a wall`).toBeNull();
    });
  });

  it("links waypoints only along walkable straight lines", () => {
    for (const [a, b] of links) {
      const [ax, ay, az] = nodes[a]!;
      const [bx, by, bz] = nodes[b]!;
      for (let k = 1; k < 12; k += 1) {
        const t = k / 12;
        const x = ax + (bx - ax) * t;
        const y = ay + (by - ay) * t;
        const z = az + (bz - az) * t;
        // Ramps are flights of 0.5m steps under the hood, so the path may sit up
        // to a riser above or below the stepped surface — but never inside a wall.
        const hit = blocked(x, z, y + 0.65, y + 1.6, 0.12);
        expect(hit, `link ${a}-${b} passes through ${hit} at (${x.toFixed(2)},${y.toFixed(2)},${z.toFixed(2)})`).toBeNull();
        expect(supportAt(x, z, y, 0.65), `link ${a}-${b} crosses a gap at (${x.toFixed(2)},${z.toFixed(2)})`).toBeGreaterThan(y - 0.7);
      }
    }
  });

  it("only drops downward, and only jumps what a player can jump", () => {
    for (const [a, b] of drops) expect(nodes[b]![1]).toBeLessThan(nodes[a]![1]);
    for (const [a, b] of jumps) {
      const rise = nodes[b]![1] - nodes[a]![1];
      const reach = Math.hypot(nodes[b]![0] - nodes[a]![0], nodes[b]![2] - nodes[a]![2]);
      expect(rise).toBeGreaterThan(0);
      expect(rise).toBeLessThan(2.5); // the cart's jump clears a few metres
      expect(reach).toBeLessThan(2.5);
    }
  });

  it("is connected, and every node can get back down to the floor and up to the high ground", () => {
    const adj = nodes.map(() => [] as number[]);
    for (const [a, b] of links) {
      adj[a]!.push(b);
      adj[b]!.push(a);
    }
    for (const [a, b] of drops) adj[a]!.push(b);
    for (const [a, b] of jumps) {
      adj[a]!.push(b);
      adj[b]!.push(a);
    }
    const reach = (from: number) => {
      const seen = new Set([from]);
      const queue = [from];
      while (queue.length) {
        for (const n of adj[queue.shift()!]!) {
          if (!seen.has(n)) {
            seen.add(n);
            queue.push(n);
          }
        }
      }
      return seen;
    };
    const fromFloor = reach(0);
    expect(fromFloor.size).toBe(nodes.length); // everything reachable from the floor
    for (let i = 0; i < nodes.length; i += 1) expect(reach(i).has(0), `node ${i} is a dead end`).toBe(true);
    const deck = nodes.findIndex(([, y]) => y === 7);
    const brTop = nodes.findIndex(([, y]) => y === 4);
    expect(deck).toBeGreaterThan(-1);
    expect(brTop).toBeGreaterThan(-1);
  });
});

describe("the bots' power positions", () => {
  it("name high ground: the sniper deck, the BR top, the walkway and the shotgun room", () => {
    const power = luaTable("POWER").map((i) => nodes[i - 1]!); // Lua indices are 1-based
    expect(power.length).toBeGreaterThanOrEqual(4);
    for (const [, y] of power) expect(y).toBeGreaterThanOrEqual(2);
    expect(power.some(([, y]) => y === 7)).toBe(true); // the sniper deck
  });
});
