/**
 * Arena maps as data, and the Forerunner kit's arena builders
 * (LOCKOUT_MULTIPLAYER_ROADMAP.md L1).
 *
 * An {@link ArenaMap} is everything an arena cart's code needs to play a map:
 * the boxes it collides and shoots against, the flights of steps it climbs,
 * where Spartans spawn, where bots go, the hills, the ball's spawn, the death
 * plane and the weapon markers. {@link arenaLua} writes it as the Lua tables
 * the cart reads, so one cart's code plays any map.
 *
 * {@link forerunnerBuilder} draws Forerunner architecture over such boxes: tiers
 * walled in kit panels (each the kit wall's recipe, made with the editor's face
 * edits), battered feet, cornices, smooth ramps over flights, fins and
 * columns, all tiled at the kit's texel density. Pure.
 */

import { editFace, faceAt } from "./meshEdit";
import type { MeshPrimitive } from "./MeshAsset";
import { chamferedRect, pushLoft, type Streams } from "./seedGeometry";

/** An axis-aligned box: centre (cx, cy, cz) and half-extents (hx, hy, hz). */
export type ArenaBox = readonly [number, number, number, number, number, number];
export type ArenaPoint = readonly [number, number, number];

/** A flight of steps between two heights along one axis (drawn as a ramp; collided as steps). */
export interface ArenaFlight {
  readonly axis: "x" | "z";
  /** Its centre line on the other axis, and half its width. */
  readonly fixed: number;
  readonly halfFixed: number;
  /** Where it starts along `axis`, and which way it runs from there. */
  readonly start: number;
  readonly sign: 1 | -1;
  /** The top at the start, and at the far end. */
  readonly topFrom: number;
  readonly topTo: number;
}

export const arenaFlight = (axis: "x" | "z", fixed: number, halfFixed: number, start: number, sign: 1 | -1, topFrom: number, topTo: number): ArenaFlight => ({
  axis, fixed, halfFixed, start, sign, topFrom, topTo,
});

/** A team a spawn belongs to; a spawn with none serves anyone. */
export type ArenaTeam = "blue" | "red";

export interface ArenaSpawn {
  /** Feet position. */
  readonly at: ArenaPoint;
  readonly team?: ArenaTeam;
}

/** The weapons a marker can hold (the cart's weapon ids). */
export type ArenaWeapon = "br" | "smg" | "shotgun" | "sniper" | "magnum" | "sword";

export interface ArenaMarker {
  /** The marker's box (a cyan-lit plinth; the weapon floats over it). */
  readonly box: ArenaBox;
  readonly weapon: ArenaWeapon;
}

/** Everything an arena cart's code needs to play a map. */
export interface ArenaMap {
  readonly id: string;
  readonly name: string;
  /** Solid colliders (besides the flights' steps). */
  readonly solids: readonly ArenaBox[];
  readonly flights: readonly ArenaFlight[];
  readonly spawns: readonly ArenaSpawn[];
  /** Places bots go (feet positions); they route between them over the navmesh. */
  readonly destinations: readonly ArenaPoint[];
  /** Positions worth holding, as indices into `destinations`. */
  readonly power: readonly number[];
  /** King of the Hill's hills, in the order they rotate. */
  readonly hills: readonly ArenaPoint[];
  /** Where Oddball's ball spawns. */
  readonly ball: ArenaPoint;
  /** Fall below this height and you die. */
  readonly deathY: number;
  readonly markers: readonly ArenaMarker[];
}

/** One flight's steps, each a collider box (the cart's step-up climbs the ~0.5 m risers). */
export function flightSteps(f: ArenaFlight): ArenaBox[] {
  const n = Math.max(1, Math.round(Math.abs(f.topFrom - f.topTo) / 0.5));
  const rise = (f.topFrom - f.topTo) / n;
  const run = 0.85;
  const out: ArenaBox[] = [];
  for (let i = 0; i < n; i += 1) {
    const top = f.topFrom - rise * (i + 1);
    const pos = f.start + f.sign * (i + 0.5) * run;
    const hy = Math.max(0.05, top / 2);
    out.push(f.axis === "z" ? [f.fixed, top / 2, pos, f.halfFixed, hy, run / 2] : [pos, top / 2, f.fixed, run / 2, hy, f.halfFixed]);
  }
  return out;
}

/** Every box a map's players, shots and bots collide with: its solids, then its flights' steps. */
export function arenaColliders(map: Pick<ArenaMap, "solids" | "flights">): ArenaBox[] {
  return [...map.solids, ...map.flights.flatMap(flightSteps)];
}

/** The centre of a map's colliders' bounds (for a map without a visual mesh to centre on). */
export function arenaCenter(map: ArenaMap): ArenaPoint {
  let lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const [cx, cy, cz, hx, hy, hz] of arenaColliders(map)) {
    lo = [Math.min(lo[0]!, cx - hx), Math.min(lo[1]!, cy - hy), Math.min(lo[2]!, cz - hz)];
    hi = [Math.max(hi[0]!, cx + hx), Math.max(hi[1]!, cy + hy), Math.max(hi[2]!, cz + hz)];
  }
  return [(lo[0]! + hi[0]!) / 2, (lo[1]! + hi[1]!) / 2, (lo[2]! + hi[2]!) / 2];
}

const n2 = (v: number) => v.toFixed(2);

/**
 * A map as the Lua tables an arena cart reads:
 * - `COL`: the colliders, as min/max corners (six numbers each);
 * - `SPN`: spawn feet positions (three each), and `SPT` their teams (0 any, 1 blue, 2 red);
 * - `MRK` and `MW`: the weapon markers' centres and weapons;
 * - `ROAM` and `POWER`: bot destinations and the power positions among them;
 * - `HILLS`, `BALL` and `DEATH_Y`.
 */
export function arenaLua(map: ArenaMap): string {
  const col = arenaColliders(map).flatMap(([cx, cy, cz, hx, hy, hz]) => [cx - hx, cy - hy, cz - hz, cx + hx, cy + hy, cz + hz]);
  const teams = map.spawns.map((s) => (s.team === "blue" ? 1 : s.team === "red" ? 2 : 0));
  const power = map.power.map((i) => {
    const p = map.destinations[i];
    if (!p) throw new Error(`arena "${map.id}": power position ${i} is not a destination`);
    return p;
  });
  return [
    `local COL = {${col.map(n2).join(",")}}`,
    `local SPN = {${map.spawns.flatMap((s) => s.at).map(n2).join(",")}}`,
    `local SPT = {${teams.join(",")}}`,
    `local MRK = {${map.markers.map(({ box: [cx, cy, cz] }) => `${n2(cx)},${n2(cy)},${n2(cz)}`).join(",")}}`,
    `local MW  = {${map.markers.map((m) => `"${m.weapon}"`).join(",")}}`,
    `local ROAM = {${map.destinations.flat().map(n2).join(",")}}`,
    `local POWER = {${power.flat().map(n2).join(",")}}`,
    `local HILLS = {${map.hills.map((h) => `{${h.map(n2).join(",")}}`).join(",")}}`,
    `local BALL = {${map.ball.map(n2).join(",")}}`,
    `local DEATH_Y = ${n2(map.deathY)}`,
  ].join("\n");
}

// --- The Forerunner kit's arena builders ------------------------------------

/** One full texture tile spans this many metres on any face, so panels read at one size everywhere. */
export const ARENA_TILE_WORLD = 4.4;
const UV = 1 / ARENA_TILE_WORLD;

type V3 = readonly [number, number, number];

/** A panel's target size; a side is divided into whole panels near it. */
const KIT_PANEL_W = 2.2;
const KIT_PANEL_H = 1.6;
/** The frame between panels, and the sunken plate's rim width and depth. */
const KIT_FRAME = 0.06;
const KIT_RIM = 0.1;
const KIT_SINK = 0.05;

export interface TierOptions {
  /** How far the foot flares out at the base (0 for none). */
  readonly batter?: number;
  /** How far the cornice overhangs the wall. */
  readonly cornice?: number;
  readonly chamfer?: number;
  /** Set light channels into every other panel of the top row. */
  readonly lit?: boolean;
}

/** The arena builders, and the light channels their lit panels have set (energy boxes, for the trim). */
export interface ForerunnerBuilder {
  /** A chamfered prism over a box's footprint, from y0 to y1 (sides only by default). */
  prism(s: Streams, box: ArenaBox, y0: number, y1: number, chamfer: number, caps?: { top: boolean; bottom: boolean }): void;
  /** A wall of kit panels: the chamfered prism over `box` from y0 to y1, its long sides divided into panels. */
  panelledPrism(s: Streams, box: ArenaBox, y0: number, y1: number, chamfer: number, lit: boolean): void;
  /** A tier: kit-panel walls, an optional battered foot, and a cornice whose cap is the walkable roof. */
  tier(s: Streams, box: ArenaBox, opts?: TierOptions): void;
  /** A smooth ramp over a flight of steps, with angled side skirts. */
  ramp(s: Streams, f: ArenaFlight): void;
  /** A blade-like fin rising from (x, y0, z) along (dx, dz), tapering to y1 and leaning outward. */
  fin(s: Streams, x: number, z: number, dx: number, dz: number, y0: number, y1: number, length: number, lean: number): void;
  /** A tapering octagonal column between two heights. */
  column(s: Streams, x0: number, z0: number, y0: number, r0: number, x1: number, z1: number, y1: number, r1: number): void;
  /** Light channels set into lit panels so far. */
  readonly channels: ArenaBox[];
}

/** World-projected tiling on the face's dominant axis, so the texture runs on across pieces. */
function tileUv(p: V3, normal: V3): [number, number] {
  const ax = Math.abs(normal[0]), ay = Math.abs(normal[1]), az = Math.abs(normal[2]);
  if (ay >= ax && ay >= az) return [p[0] * UV, p[2] * UV];
  if (ax >= az) return [p[2] * UV, p[1] * UV];
  return [p[0] * UV, p[1] * UV];
}

/** A fresh set of Forerunner arena builders, gathering the light channels they set. */
export function forerunnerBuilder(): ForerunnerBuilder {
  const channels: ArenaBox[] = [];

  /** One kit panel on a wall: the quad a→b→c→d (counter-clockwise from outside), framed and sunk. */
  function kitPanel(s: Streams, quad: readonly V3[], normal: V3, channel: boolean): void {
    const positions: number[] = [];
    const uvs: number[] = [];
    for (const p of quad) {
      positions.push(p[0], p[1], p[2]);
      uvs.push(...tileUv(p, normal));
    }
    let panel: MeshPrimitive = {
      positions: Float32Array.from(positions),
      normals: Float32Array.from([...normal, ...normal, ...normal, ...normal]),
      uvs: Float32Array.from(uvs),
      indices: Uint32Array.from([0, 1, 2, 0, 2, 3]),
      material: { name: "panel", baseColorFactor: [1, 1, 1, 1], baseColorImage: null },
    };
    panel = editFace(panel, [0, 1], { kind: "inset", amount: KIT_FRAME });
    panel = editFace(panel, faceAt(panel, 0).triangles, { kind: "bevel", width: KIT_RIM, depth: -KIT_SINK });
    const base = s.positions.length / 3;
    s.positions.push(...panel.positions);
    s.normals.push(...panel.normals!);
    s.uvs.push(...panel.uvs!);
    for (const i of panel.indices) s.indices.push(base + i);
    if (channel) {
      // A strip along the sunken plate's middle, just proud of it (still well inside the wall).
      const ax = Math.abs(normal[0]), az = Math.abs(normal[2]);
      const mid: V3 = [(quad[0]![0] + quad[2]![0]) / 2, (quad[0]![1] + quad[2]![1]) / 2, (quad[0]![2] + quad[2]![2]) / 2];
      const along = Math.hypot(quad[1]![0] - quad[0]![0], quad[1]![2] - quad[0]![2]);
      const half = Math.max(0.2, along / 2 - KIT_FRAME - KIT_RIM - 0.25);
      const inset = KIT_SINK - 0.015;
      const cx = mid[0] - normal[0] * inset, cz = mid[2] - normal[2] * inset;
      channels.push(ax > az ? [cx, mid[1], cz, 0.015, 0.05, half] : [cx, mid[1], cz, half, 0.05, 0.015]);
    }
  }

  /** One flat wall quad, wound and lit facing away from `inside`, world-mapped like the rest. */
  function plainQuad(s: Streams, quad: readonly V3[], inside: V3): void {
    const e1: V3 = [quad[1]![0] - quad[0]![0], quad[1]![1] - quad[0]![1], quad[1]![2] - quad[0]![2]];
    const e2: V3 = [quad[3]![0] - quad[0]![0], quad[3]![1] - quad[0]![1], quad[3]![2] - quad[0]![2]];
    let n: V3 = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    const l = Math.hypot(n[0], n[1], n[2]);
    if (l < 1e-9) return;
    n = [n[0] / l, n[1] / l, n[2] / l];
    const mid = quad.reduce<V3>((m, p) => [m[0] + p[0] / 4, m[1] + p[1] / 4, m[2] + p[2] / 4], [0, 0, 0]);
    let pts = quad;
    if (n[0] * (mid[0] - inside[0]) + n[1] * (mid[1] - inside[1]) + n[2] * (mid[2] - inside[2]) < 0) {
      pts = [quad[1]!, quad[0]!, quad[3]!, quad[2]!];
      n = [-n[0], -n[1], -n[2]];
    }
    const base = s.positions.length / 3;
    for (const p of pts) {
      s.positions.push(p[0], p[1], p[2]);
      s.normals.push(n[0], n[1], n[2]);
      s.uvs.push(...tileUv(p, n));
    }
    s.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }

  const prism: ForerunnerBuilder["prism"] = (s, [cx, , cz, hx, , hz], y0, y1, chamfer, caps = { top: false, bottom: false }) => {
    pushLoft(s, chamferedRect(cx, cz, hx, hz, chamfer, y0), chamferedRect(cx, cz, hx, hz, chamfer, y1), UV, caps);
  };

  const panelledPrism: ForerunnerBuilder["panelledPrism"] = (s, box, y0, y1, chamfer, lit) => {
    const [cx, , cz, hx, , hz] = box;
    const lo = chamferedRect(cx, cz, hx, hz, chamfer, y0);
    const hi = chamferedRect(cx, cz, hx, hz, chamfer, y1);
    const h = y1 - y0;
    for (let i = 0; i < lo.length; i += 1) {
      const j = (i + 1) % lo.length;
      const a = lo[i]!, b = lo[j]!;
      const len = Math.hypot(b[0] - a[0], b[2] - a[2]);
      const straight = Math.abs(b[0] - a[0]) < 1e-6 || Math.abs(b[2] - a[2]) < 1e-6;
      if (!straight || len < 1.2 || h < 0.9) {
        plainQuad(s, [a, b, hi[j]!, hi[i]!], [cx, (y0 + y1) / 2, cz]);
        continue;
      }
      // Outward: away from the box's centre.
      let normal: V3 = Math.abs(b[0] - a[0]) < 1e-6 ? [Math.sign(a[0] - cx), 0, 0] : [0, 0, Math.sign(a[2] - cz)];
      if (normal[0] === 0 && normal[2] === 0) normal = [0, 0, 1];
      const cols = Math.max(1, Math.round(len / KIT_PANEL_W));
      const rows = Math.max(1, Math.round(h / KIT_PANEL_H));
      for (let r = 0; r < rows; r += 1) {
        for (let c = 0; c < cols; c += 1) {
          const at = (u: number, v: number): V3 => [a[0] + (b[0] - a[0]) * u, y0 + h * v, a[2] + (b[2] - a[2]) * u];
          const u0 = c / cols, u1 = (c + 1) / cols, v0 = r / rows, v1 = (r + 1) / rows;
          let quad = [at(u0, v0), at(u1, v0), at(u1, v1), at(u0, v1)];
          // Wind it counter-clockwise seen from outside.
          const e1: V3 = [quad[1]![0] - quad[0]![0], quad[1]![1] - quad[0]![1], quad[1]![2] - quad[0]![2]];
          const e2: V3 = [quad[3]![0] - quad[0]![0], quad[3]![1] - quad[0]![1], quad[3]![2] - quad[0]![2]];
          const n: V3 = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
          if (n[0] * normal[0] + n[2] * normal[2] < 0) quad = [quad[1]!, quad[0]!, quad[3]!, quad[2]!];
          kitPanel(s, quad, normal, lit && r === rows - 1 && c % 2 === 0);
        }
      }
    }
  };

  const tier: ForerunnerBuilder["tier"] = (s, box, opts = {}) => {
    const [cx, cy, cz, hx, hy, hz] = box;
    const c = opts.chamfer ?? 0.55;
    const bottom = cy - hy;
    const top = cy + hy;
    const batter = opts.batter ?? 0;
    const lip = opts.cornice ?? 0.2;
    // The battered foot stays inside the player's collision radius, so feet never clip it.
    const footH = batter > 0 ? Math.min(0.9, (top - bottom) * 0.45) : 0;
    if (batter > 0) {
      pushLoft(s, chamferedRect(cx, cz, hx + batter, hz + batter, c + batter * 0.6, bottom), chamferedRect(cx, cz, hx, hz, c, bottom + footH), UV, { top: false, bottom: false });
    }
    const corniceH = 0.32;
    panelledPrism(s, box, bottom + footH, top - corniceH, c, opts.lit ?? false);
    // The cornice flares out to its lip, then its cap is the roof.
    pushLoft(s, chamferedRect(cx, cz, hx, hz, c, top - corniceH), chamferedRect(cx, cz, hx + lip, hz + lip, c + lip * 0.4, top), UV, { top: true, bottom: false });
  };

  const ramp: ForerunnerBuilder["ramp"] = (s, f) => {
    const n = Math.max(1, Math.round(Math.abs(f.topFrom - f.topTo) / 0.5));
    const rise = (f.topFrom - f.topTo) / n;
    const run = 0.85;
    const end = f.start + f.sign * n * run;
    const h0 = Math.max(0.02, f.topFrom - rise / 2);
    const h1 = Math.max(0.02, f.topTo + rise / 2 - rise); // one run past the last step centre
    const at = (along: number, across: number, y: number): V3 => (f.axis === "z" ? [f.fixed + across, y, along] : [along, y, f.fixed + across]);
    const w = f.halfFixed;
    const bottom = [at(f.start, -w, 0), at(f.start, w, 0), at(end, w, 0), at(end, -w, 0)];
    const top = [at(f.start, -w, h0), at(f.start, w, h0), at(end, w, Math.max(0.02, h1)), at(end, -w, Math.max(0.02, h1))];
    pushLoft(s, bottom, top, UV, { top: true, bottom: false });
    // Low angled side skirts so the ramp reads as a machined piece, not a slab.
    for (const side of [-1, 1]) {
      // The skirt's inner face sits just inside the ramp, never coplanar with its
      // side (coplanar faces z-fight into a sawtooth).
      const xi = side * (w - 0.03);
      const x0 = side * (w + 0.12);
      pushLoft(
        s,
        [at(f.start, xi, 0), at(f.start, x0, 0), at(end, x0, 0), at(end, xi, 0)],
        [at(f.start, xi, h0 + 0.18), at(f.start, x0, h0 + 0.1), at(end, x0, 0.1), at(end, xi, 0.18)],
        UV,
        { top: true, bottom: false },
      );
    }
  };

  const fin: ForerunnerBuilder["fin"] = (s, x, z, dx, dz, y0, y1, length, lean) => {
    const l = Math.hypot(dx, dz) || 1;
    const ux = dx / l;
    const uz = dz / l;
    const px = -uz * 0.16; // half thickness, perpendicular to the blade
    const pz = ux * 0.16;
    const base: V3[] = [
      [x - px, y0, z - pz],
      [x + ux * length - px, y0, z + uz * length - pz],
      [x + ux * length + px, y0, z + uz * length + pz],
      [x + px, y0, z + pz],
    ];
    const tx = x + ux * (lean + length * 0.25);
    const tz = z + uz * (lean + length * 0.25);
    const tipLen = length * 0.3;
    const tip: V3[] = [
      [tx - px * 0.5, y1, tz - pz * 0.5],
      [tx + ux * tipLen - px * 0.5, y1, tz + uz * tipLen - pz * 0.5],
      [tx + ux * tipLen + px * 0.5, y1, tz + uz * tipLen + pz * 0.5],
      [tx + px * 0.5, y1, tz + pz * 0.5],
    ];
    pushLoft(s, base, tip, UV);
  };

  const column: ForerunnerBuilder["column"] = (s, x0, z0, y0, r0, x1, z1, y1, r1) => {
    pushLoft(s, chamferedRect(x0, z0, r0, r0, r0 * 0.42, y0), chamferedRect(x1, z1, r1, r1, r1 * 0.42, y1), UV);
  };

  return { prism, panelledPrism, tier, ramp, fin, column, channels };
}
