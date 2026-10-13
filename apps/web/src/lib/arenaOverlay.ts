/**
 * The scene view's gameplay actors (ENGINE_PARITY_ROADMAP.md EP22–EP23), as
 * pure functions: which actors each show flag reveals, picking one under the
 * cursor (by its icon on screen, or a collider by its box), the floor under a
 * point (for placing and for End, "drop to floor"), and the navmesh's floors
 * as points for the Navigation view. The drawing itself is in the viewport.
 */

import {
  arenaActors,
  arenaCollisionBoxes,
  flightSteps,
  groundHeight,
  type ArenaActor,
  type ArenaActorKind,
  type ArenaMap,
  type ArenaPoint,
  type NavMesh,
} from "@cartbox/editor";

import type { Vec3 } from "./viewportCamera";

/** Unreal's Show menu, for a map: its markup, its collision, its bots' navigation. */
export interface ArenaShowFlags {
  readonly gameplay: boolean;
  readonly collision: boolean;
  readonly navigation: boolean;
}

export const DEFAULT_SHOW_FLAGS: ArenaShowFlags = { gameplay: true, collision: false, navigation: false };

/** Kinds that are collision (shown, picked and moved with the Collision flag); the rest are gameplay markup. */
const COLLISION_KINDS: ReadonlySet<ArenaActorKind> = new Set(["solid", "flight"]);

export function isCollisionKind(kind: ArenaActorKind): boolean {
  return COLLISION_KINDS.has(kind);
}

/** The actors the flags show. */
export function visibleArenaActors(map: ArenaMap, flags: ArenaShowFlags): ArenaActor[] {
  return arenaActors(map).filter((a) => (isCollisionKind(a.kind) ? flags.collision : flags.gameplay));
}

/** Where an actor's icon is drawn and picked: a spawn's at its chest (it stands 1.8 m tall), the rest at their pivots. */
export function iconPoint(actor: ArenaActor): ArenaPoint {
  return actor.kind === "spawn" ? [actor.at[0], actor.at[1] + 0.9, actor.at[2]] : actor.at;
}

/** A box's world corners, as min and max. */
export function actorBox(actor: ArenaActor): { min: Vec3; max: Vec3 } | null {
  if (!actor.half) return null;
  const [x, y, z] = actor.at;
  const [hx, hy, hz] = actor.half;
  return { min: [x - hx, y - hy, z - hz], max: [x + hx, y + hy, z + hz] };
}

/** Where a ray enters a box (its distance along the ray), or null if it misses. */
export function rayBox(ray: { readonly origin: Vec3; readonly dir: Vec3 }, min: Vec3, max: Vec3): number | null {
  let near = -Infinity;
  let far = Infinity;
  for (let a = 0; a < 3; a += 1) {
    const o = ray.origin[a]!;
    const d = ray.dir[a]!;
    if (Math.abs(d) < 1e-12) {
      if (o < min[a]! || o > max[a]!) return null;
      continue;
    }
    const t1 = (min[a]! - o) / d;
    const t2 = (max[a]! - o) / d;
    near = Math.max(near, Math.min(t1, t2));
    far = Math.min(far, Math.max(t1, t2));
  }
  if (near > far || far < 0) return null;
  return Math.max(0, near);
}

/**
 * The actor under the cursor: the nearest icon on screen within `radius`
 * pixels, else the nearest collider box the ray passes through (icons win:
 * they sit on top). `project` gives an actor's pivot in canvas pixels.
 */
export function pickArenaActor(
  actors: readonly ArenaActor[],
  project: (p: ArenaPoint) => readonly [number, number] | null,
  cursor: readonly [number, number],
  radius: number,
  ray?: { readonly origin: Vec3; readonly dir: Vec3 },
): string | null {
  let best: { id: string; d: number } | null = null;
  for (const a of actors) {
    if (a.kind === "solid") continue;
    const p = project(iconPoint(a));
    if (!p) continue;
    const d = Math.hypot(p[0] - cursor[0], p[1] - cursor[1]);
    if (d <= radius && (!best || d < best.d)) best = { id: a.id, d };
  }
  if (best) return best.id;
  if (!ray) return null;
  let hit: { id: string; t: number } | null = null;
  for (const a of actors) {
    const box = a.kind === "solid" ? actorBox(a) : null;
    const t = box ? rayBox(ray, box.min, box.max) : null;
    if (t !== null && (!hit || t < hit.t)) hit = { id: a.id, t };
  }
  return hit?.id ?? null;
}

/** The actors whose pivots fall inside a screen rectangle (a box select). */
export function arenaActorsInRect(actors: readonly ArenaActor[], project: (p: ArenaPoint) => readonly [number, number] | null, rect: { x0: number; y0: number; x1: number; y1: number }): string[] {
  const [lx, hx] = [Math.min(rect.x0, rect.x1), Math.max(rect.x0, rect.x1)];
  const [ly, hy] = [Math.min(rect.y0, rect.y1), Math.max(rect.y0, rect.y1)];
  return actors.flatMap((a) => {
    const p = project(iconPoint(a));
    return p && p[0] >= lx && p[0] <= hx && p[1] >= ly && p[1] <= hy ? [a.id] : [];
  });
}

/**
 * The floor a soldier would stand on under (x, z), at or below `y` + `reach`:
 * the highest collider top or ground there. Null when there is none.
 */
export function arenaFloorBelow(map: ArenaMap, x: number, y: number, z: number, reach = 0.5): number | null {
  let best: number | null = null;
  for (const [cx, cy, cz, hx, hy, hz] of arenaCollisionBoxes(map)) {
    const top = cy + hy;
    if (Math.abs(x - cx) <= hx && Math.abs(z - cz) <= hz && top <= y + reach && (best === null || top > best)) best = top;
  }
  const g = map.ground ? groundHeight(map.ground, x, z) : null;
  if (g !== null && g <= y + reach && (best === null || g > best)) best = g;
  return best;
}

/** Where an actor's pivot sits when its feet are on `floor` (boxes stand on it; points are their feet). */
export function pivotOnFloor(actor: ArenaActor, floor: number): ArenaPoint {
  const lift = actor.half ? actor.half[1] : 0;
  return [actor.at[0], floor + lift, actor.at[2]];
}

/** A flight's step boxes, for the Collision view. */
export function flightBoxes(map: ArenaMap, index: number): { min: Vec3; max: Vec3 }[] {
  const f = map.flights[index];
  if (!f) return [];
  return flightSteps(f).map(([cx, cy, cz, hx, hy, hz]) => ({ min: [cx - hx, cy - hy, cz - hz], max: [cx + hx, cy + hy, cz + hz] }));
}

/** The ground's grid lines (every `stride`th sample), as segments, holes left out: the Collision view's wireframe. */
export function groundLines(map: ArenaMap, stride: number): [Vec3, Vec3][] {
  const g = map.ground;
  if (!g) return [];
  const s = Math.max(1, Math.round(stride));
  const at = (i: number, j: number): Vec3 | null => {
    const h = g.heights[j * g.n + i]!;
    return Number.isFinite(h) ? [g.x0 + i * g.step, h, g.z0 + j * g.step] : null;
  };
  const out: [Vec3, Vec3][] = [];
  for (let j = 0; j < g.n; j += s) {
    for (let i = 0; i + 1 < g.n; i += 1) {
      const a = at(i, j);
      const b = at(i + 1, j);
      if (a && b) out.push([a, b]);
    }
  }
  for (let i = 0; i < g.n; i += s) {
    for (let j = 0; j + 1 < g.n; j += 1) {
      const a = at(i, j);
      const b = at(i, j + 1);
      if (a && b) out.push([a, b]);
    }
  }
  return out;
}

/** The navmesh's walkable floors as points, every `stride`th column each way: the Navigation view. */
export function navmeshPoints(nav: NavMesh, stride = 2): Vec3[] {
  const out: Vec3[] = [];
  let at = 0;
  for (let row = 0; row < nav.rows; row += 1) {
    for (let col = 0; col < nav.cols; col += 1) {
      const n = nav.counts[row * nav.cols + col]!;
      if (row % stride === 0 && col % stride === 0) {
        const x = nav.originX + (col + 0.5) * nav.cell;
        const z = nav.originZ + (row + 0.5) * nav.cell;
        for (let k = 0; k < n; k += 1) out.push([x, nav.heights[at + k]!, z]);
      }
      at += n;
    }
  }
  return out;
}
