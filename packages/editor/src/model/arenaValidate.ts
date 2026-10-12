/**
 * Checking a map (BEAVER_CREEK_ROADMAP.md B3): its bots' navmesh, baked over
 * its boxes and its ground, and a validator that lists what would break a
 * match on it -- a spawn in mid-air or inside a wall, a place bots can't
 * reach, a spot below the death plane, a position the net state can't carry,
 * or a sidecar over budget. The editor runs it on a map before playing it
 * (B4); every shipped map passes it in CI.
 */

import { arenaColliders, arenaPads, groundHeight, groundTriangles, type ArenaMap, type ArenaPoint } from "./forerunnerArena";
import { NavGraph, bakeNavMesh, boxTriangles, type NavAgent, type NavMesh } from "./navmesh";

/** A navmesh for the map's bots, over its colliders and its walkable ground. */
export function arenaNavMesh(map: ArenaMap, agent: Partial<NavAgent>, cell = 0.25): NavMesh {
  const boxes = boxTriangles(arenaColliders(map));
  if (!map.ground) return bakeNavMesh(boxes, { cell, agent });
  const ground = groundTriangles(map.ground);
  const all = new Float32Array(boxes.length + ground.length);
  all.set(boxes, 0);
  all.set(ground, boxes.length);
  return bakeNavMesh(all, { cell, agent });
}

export type ArenaIssueKind = "spawn-floor" | "spawn-solid" | "unreachable" | "death-plane" | "out-of-range" | "over-budget";

export interface ArenaIssue {
  readonly kind: ArenaIssueKind;
  readonly message: string;
  readonly at?: ArenaPoint;
}

export interface ArenaValidateOptions {
  readonly navmesh: NavMesh;
  /** The soldier's radius and height (the cart's PR and PH). */
  readonly body?: { readonly radius: number; readonly height: number };
  /** The map's sidecar size and its budget, in characters. */
  readonly sidecar?: { readonly size: number; readonly budget: number };
}

/** Positions the net state carries: ±327 m across in centimetres; deployables' height to ±25.6 m (E3). */
const NET_SPAN = 320;
const NET_HEIGHT = 25;

/** Every problem with a map, in a stable order (none: it's good to play). */
export function validateArenaMap(map: ArenaMap, options: ArenaValidateOptions): ArenaIssue[] {
  const issues: ArenaIssue[] = [];
  const body = options.body ?? { radius: 0.4, height: 1.7 };
  const boxes = arenaColliders(map);
  const fmt = (p: ArenaPoint) => `(${p.map((v) => v.toFixed(2)).join(", ")})`;

  // The floor under a point: the highest collider top or ground at or just below it.
  const floorUnder = (x: number, y: number, z: number): number | null => {
    let best: number | null = null;
    for (const [cx, cy, cz, hx, hy, hz] of boxes) {
      const top = cy + hy;
      if (Math.abs(x - cx) <= hx && Math.abs(z - cz) <= hz && top <= y + 0.05 && top >= y - 0.35) best = Math.max(best ?? -Infinity, top);
    }
    const g = map.ground ? groundHeight(map.ground, x, z) : null;
    if (g !== null && g <= y + 0.05 && g >= y - 0.35) best = Math.max(best ?? -Infinity, g);
    return best;
  };
  const inside = (x: number, y: number, z: number): boolean =>
    boxes.some(([cx, cy, cz, hx, hy, hz]) => Math.abs(x - cx) < hx + body.radius && Math.abs(z - cz) < hz + body.radius && y + 0.1 < cy + hy && y + body.height > cy - hy);

  map.spawns.forEach((s, i) => {
    const [x, y, z] = s.at;
    if (floorUnder(x, y, z) === null) issues.push({ kind: "spawn-floor", message: `spawn ${i + 1} at ${fmt(s.at)} has no floor under it`, at: s.at });
    if (inside(x, y, z)) issues.push({ kind: "spawn-solid", message: `spawn ${i + 1} at ${fmt(s.at)} stands inside a collider`, at: s.at });
  });

  // Everywhere play goes, by name.
  const pads = arenaPads(map);
  const places: { name: string; at: ArenaPoint }[] = [
    ...map.spawns.map((s, i) => ({ name: `spawn ${i + 1}`, at: s.at })),
    ...map.destinations.map((d, i) => ({ name: `destination ${i + 1}`, at: d })),
    ...map.hills.map((h, i) => ({ name: `hill ${i + 1}`, at: h })),
    { name: "the ball", at: map.ball },
    ...map.markers.map((m, i) => ({ name: `pad ${i + 1} (${pads[i]!.join("/")})`, at: [m.box[0], m.box[1] - m.box[4], m.box[2]] as ArenaPoint })),
  ];

  for (const p of places) {
    const [x, y, z] = p.at;
    if (y < map.deathY + 1) issues.push({ kind: "death-plane", message: `${p.name} at ${fmt(p.at)} is within a metre of the death plane (${map.deathY})`, at: p.at });
    if (Math.abs(x) > NET_SPAN || Math.abs(z) > NET_SPAN || Math.abs(y) > NET_HEIGHT) {
      issues.push({ kind: "out-of-range", message: `${p.name} at ${fmt(p.at)} is beyond what the net state carries (±${NET_SPAN} m across, ±${NET_HEIGHT} m up)`, at: p.at });
    }
  }

  // Reachable from the first spawn, over the bots' navmesh.
  const graph = new NavGraph(options.navmesh);
  const from = map.spawns[0]?.at;
  if (from) {
    for (const p of places.slice(1)) {
      const reach = graph.nearest(p.at[0], p.at[1] + 0.05, p.at[2], 1.5) >= 0 && graph.findPath(from, p.at) !== null;
      if (!reach) issues.push({ kind: "unreachable", message: `${p.name} at ${fmt(p.at)} can't be reached from spawn 1`, at: p.at });
    }
  }

  if (options.sidecar && options.sidecar.size > options.sidecar.budget) {
    issues.push({ kind: "over-budget", message: `the sidecar is ${options.sidecar.size} characters, over its ${options.sidecar.budget} budget` });
  }
  return issues;
}
