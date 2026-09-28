/**
 * Navigation agents (ENGINE_ROADMAP.md, Phase 6): characters the host walks
 * over a scene's baked surface (see navmesh.ts in @cartbox/editor) — each finds
 * its own path to wherever the cart sends it, and keeps clear of the others.
 *
 * Every tick an agent heads for the next corner of its path at its speed; then
 * agents that overlap push apart (half each; all of it for an agent against an
 * obstacle — something the cart moves itself, like the player), and every move
 * is kept on the surface: a step onto a floor within `climb` follows it up or
 * down (stairs, ramps), a step off a ledge along a drop link falls under gravity,
 * and a step anywhere else is refused (it slides along the edge instead). Paths
 * are found again when the goal moves or the agent is knocked off its route.
 *
 * Deterministic: a fixed step, no randomness, agents in key order.
 */

import { NavGraph, type NavMesh } from "@cartbox/editor";

import { NAV_FLAG_AIR, NAV_FLAG_ARRIVED, NAV_FLAG_MOVING, NAV_FLAG_NO_PATH, NAV_FLAG_OBSTACLE, type AgentState } from "../physics/protocol.js";

type Vec3 = [number, number, number];

interface Agent {
  key: number;
  pos: Vec3;
  radius: number;
  speed: number;
  obstacle: boolean;
  goal: Vec3 | null;
  path: Vec3[];
  /** Which corners are reached by a drop (see NavGraph.findRoute). */
  drops: boolean[];
  corner: number;
  /** Ticks until the path may be found again. */
  repath: number;
  facing: number;
  vy: number;
  air: boolean;
  /** Mid-drop: the height of the floor it's dropping to (its column may have none of its own near an edge). */
  landY: number | null;
  moving: boolean;
  noPath: boolean;
}

const GRAVITY = 22; // units/s²
/** Within this of a corner (units) counts as reaching it. */
const REACH = 0.18;
/** How far a knock can push an agent off its route before it re-plans. */
const OFF_ROUTE = 1.2;
/** Heights that overlap for separation (two bodies on different storeys don't collide). */
const BODY_HEIGHT = 1.6;

export class AgentCrowd {
  readonly graph: NavGraph;
  private readonly agents = new Map<number, Agent>();

  constructor(mesh: NavMesh) {
    this.graph = new NavGraph(mesh);
  }

  /** Place an agent (creating it): a walker, or an obstacle the cart moves. */
  place(key: number, pos: Vec3, speed: number, radius: number, obstacle: boolean): void {
    const existing = this.agents.get(key);
    const a: Agent = existing ?? {
      key,
      pos: [0, 0, 0],
      radius,
      speed,
      obstacle,
      goal: null,
      path: [],
      drops: [],
      corner: 0,
      repath: 0,
      facing: 0,
      vy: 0,
      air: false,
      landY: null,
      moving: false,
      noPath: false,
    };
    a.radius = Math.max(0.05, radius);
    if (speed > 0) a.speed = speed;
    a.obstacle = obstacle;
    a.pos = obstacle ? [...pos] : this.settle(pos);
    a.vy = 0;
    a.air = false;
    if (!obstacle && existing) {
      // Teleported: the old route no longer starts here.
      a.path = [];
      a.repath = 0;
    }
    this.agents.set(key, a);
  }

  /** Send an agent toward a point (speed > 0 changes its speed). */
  goto(key: number, goal: Vec3, speed = 0): void {
    const a = this.agents.get(key);
    if (!a || a.obstacle) return;
    if (speed > 0) a.speed = speed;
    const moved = !a.goal || Math.hypot(goal[0] - a.goal[0], goal[1] - a.goal[1], goal[2] - a.goal[2]) > 0.75;
    a.goal = [...goal];
    if (moved) {
      a.repath = 0;
      a.path = [];
    }
  }

  stop(key: number): void {
    const a = this.agents.get(key);
    if (!a) return;
    a.goal = null;
    a.path = [];
    a.noPath = false;
  }

  remove(key: number): void {
    this.agents.delete(key);
  }

  /** Stand a point on the floor beneath it (or the nearest floor), unchanged when there's none. */
  private settle(pos: Vec3): Vec3 {
    const g = this.graph;
    let f = g.floorAt(pos[0], pos[1] + 0.25, pos[2]);
    if (f < 0) f = g.nearest(pos[0], pos[1], pos[2], 2);
    if (f < 0) return [...pos];
    const fy = g.mesh.heights[f]!;
    if (g.floorAt(pos[0], pos[1] + 0.25, pos[2]) === f) return [pos[0], fy, pos[2]];
    return g.position(f);
  }

  /** Advance every agent by `dt` seconds. */
  step(dt: number): void {
    const list = [...this.agents.values()].sort((a, b) => a.key - b.key);
    const g = this.graph;
    const climb = g.mesh.agent.climb;
    const want = new Map<number, Vec3>();
    // 1. Steering: head for the next corner.
    for (const a of list) {
      if (a.obstacle) continue;
      let vx = 0;
      let vz = 0;
      if (a.goal) {
        if (a.repath > 0) a.repath -= 1;
        if (a.path.length === 0 && a.repath === 0) {
          const route = g.findRoute(a.pos, a.goal);
          a.noPath = route === null;
          a.path = route?.points ?? [];
          a.drops = route?.drop ?? [];
          a.corner = 1;
          a.repath = 30; // at most twice a second
        }
        while (a.corner < a.path.length) {
          const c = a.path[a.corner]!;
          if (Math.hypot(c[0] - a.pos[0], c[2] - a.pos[2]) > REACH) break;
          if (a.drops[a.corner]) a.landY = c[1]; // over the landing: drop to it
          a.corner += 1;
        }
        if (a.corner < a.path.length) {
          const c = a.path[a.corner]!;
          const dx = c[0] - a.pos[0];
          const dz = c[2] - a.pos[2];
          const d = Math.hypot(dx, dz);
          const s = Math.min(a.speed * dt, d);
          vx = (dx / d) * s;
          vz = (dz / d) * s;
        } else if (a.path.length > 0) {
          a.goal = null; // arrived
          a.path = [];
        }
      }
      want.set(a.key, [vx, 0, vz]);
    }
    // 2. Separation: overlapping bodies push apart.
    for (let i = 0; i < list.length; i += 1) {
      for (let j = i + 1; j < list.length; j += 1) {
        const a = list[i]!;
        const b = list[j]!;
        if (a.obstacle && b.obstacle) continue;
        if (Math.abs(a.pos[1] - b.pos[1]) > BODY_HEIGHT) continue;
        let dx = a.pos[0] - b.pos[0];
        let dz = a.pos[2] - b.pos[2];
        let d = Math.hypot(dx, dz);
        const overlap = a.radius + b.radius - d;
        if (overlap <= 0) continue;
        if (d < 1e-6) {
          // Exactly on top of each other: split along a fixed direction by key.
          dx = 1;
          dz = 0;
          d = 1;
        }
        const ux = dx / d;
        const uz = dz / d;
        const share = a.obstacle ? 0 : b.obstacle ? 1 : 0.5;
        const wa = want.get(a.key);
        const wb = want.get(b.key);
        if (wa) {
          wa[0] += ux * overlap * share;
          wa[2] += uz * overlap * share;
        }
        if (wb) {
          wb[0] -= ux * overlap * (1 - share);
          wb[2] -= uz * overlap * (1 - share);
        }
      }
    }
    // 3. Move, keeping to the surface.
    for (const a of list) {
      if (a.obstacle) continue;
      const v = want.get(a.key)!;
      const before: Vec3 = [...a.pos];
      this.move(a, v[0], v[2], dt, climb);
      const mx = a.pos[0] - before[0];
      const mz = a.pos[2] - before[2];
      const dist = Math.hypot(mx, mz);
      a.moving = dist > a.speed * dt * 0.2;
      if (a.moving) {
        const target = Math.atan2(mx, mz);
        let delta = target - a.facing;
        while (delta > Math.PI) delta -= 2 * Math.PI;
        while (delta < -Math.PI) delta += 2 * Math.PI;
        a.facing += delta * 0.35;
      }
      // Knocked well off the route: find a new one.
      if (a.goal && a.corner < a.path.length && a.path.length > 1) {
        const p = a.path[a.corner - 1] ?? a.path[0]!;
        const c = a.path[a.corner]!;
        if (distanceToSegment(a.pos, p, c) > OFF_ROUTE && a.repath === 0) a.path = [];
      }
    }
  }

  /** Move one agent by (dx, dz), sliding along edges, stepping and falling as the floor allows. */
  private move(a: Agent, dx: number, dz: number, dt: number, climb: number): void {
    const g = this.graph;
    const tryTo = (x: number, z: number): boolean => {
      // Walking: a floor within a step of where it stands.
      const f = g.floorAt(x, a.pos[1], z, climb);
      if (f >= 0 && a.pos[1] - g.mesh.heights[f]! <= climb) {
        a.pos = [x, a.air ? a.pos[1] : g.mesh.heights[f]!, z];
        return true;
      }
      // Off a ledge: allowed when the route drops here — across the edge band,
      // which has no floor of its own.
      if (a.drops[a.corner]) {
        a.pos = [x, a.pos[1], z];
        a.air = true;
        return true;
      }
      return false;
    };
    if (dx !== 0 || dz !== 0) {
      if (!tryTo(a.pos[0] + dx, a.pos[2] + dz)) {
        // Slide along the edge: try each axis alone.
        if (!tryTo(a.pos[0] + dx, a.pos[2])) tryTo(a.pos[0], a.pos[2] + dz);
      }
    }
    // Falling: gravity until it lands on the floor below. Over the edge band of
    // a ledge (no floor of its own — it's still the ledge, really) it keeps its
    // height, so it doesn't sink into the solid it's stepping off.
    const floor = g.floorAt(a.pos[0], a.pos[1], a.pos[2], climb);
    if (floor < 0 && a.air && a.landY === null) return;
    // Stepping off a ledge: it keeps its height until it's over the landing
    // (which the bake placed clear of the ledge for the whole body), then drops
    // straight down — so it never sinks into what it stepped off.
    const ledge = a.path[a.corner - 1];
    if (a.drops[a.corner] && ledge && a.pos[1] >= ledge[1] - 1e-3) return;
    if (floor >= 0 && !a.air) a.landY = null; // back over a floor of its own
    const fy = floor >= 0 ? g.mesh.heights[floor]! : (a.landY ?? -Infinity);
    if (a.air || a.pos[1] > fy + 1e-3) {
      a.vy -= GRAVITY * dt;
      a.pos[1] += a.vy * dt;
      a.air = true;
      if (a.pos[1] <= fy) {
        a.pos[1] = fy;
        a.vy = 0;
        a.air = false;
      }
      if (fy === -Infinity && a.pos[1] < -100) {
        a.pos = this.settle(a.pos); // fell out of the world: back onto the surface
        a.air = false;
        a.vy = 0;
      }
    }
  }

  /** Every agent as the cart reads it, in key order. */
  state(): AgentState[] {
    return [...this.agents.values()]
      .sort((a, b) => a.key - b.key)
      .map((a) => ({
        key: a.key,
        position: a.pos,
        facing: a.facing,
        flags:
          (a.moving ? NAV_FLAG_MOVING : 0) |
          (a.air ? NAV_FLAG_AIR : 0) |
          (!a.goal ? NAV_FLAG_ARRIVED : 0) |
          (a.noPath ? NAV_FLAG_NO_PATH : 0) |
          (a.obstacle ? NAV_FLAG_OBSTACLE : 0),
      }));
  }

  /** One agent's current path corners (for inspection and tests). */
  path(key: number): readonly Vec3[] {
    return this.agents.get(key)?.path ?? [];
  }
}

function distanceToSegment(p: Vec3, a: Vec3, b: Vec3): number {
  const dx = b[0] - a[0];
  const dz = b[2] - a[2];
  const l2 = dx * dx + dz * dz;
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[2] - a[2]) * dz) / l2)) : 0;
  return Math.hypot(p[0] - (a[0] + dx * t), p[2] - (a[2] + dz * t));
}
