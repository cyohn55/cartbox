/**
 * A map's markup as actors (ENGINE_PARITY_ROADMAP.md EP21–EP22, and
 * BEAVER_CREEK_ROADMAP.md B4): every spawn, weapon pad, hill, bot
 * destination, teleporter end, collider and flight of an {@link ArenaMap} is
 * an actor the editor lists, draws, picks and drags, the way Unreal places
 * Player Starts and Target Points and Unity places empty objects.
 *
 * An actor is addressed by a stable-looking id, `arena:<kind>:<index>`, so it
 * shares the scene's selection with meshes. Indices are positions in the
 * map's arrays: removing an actor renumbers the ones after it, as the cart's
 * tables would.
 *
 * Also here: storing a map in a sidecar (ground holes as null, heights to the
 * centimetre the cart reads) and reading one back strictly, since a sidecar
 * comes back from storage untrusted. Pure.
 */

import {
  arenaColliders,
  type ArenaBox,
  type ArenaFlight,
  type ArenaGround,
  type ArenaMap,
  type ArenaMarker,
  type ArenaPoint,
  type ArenaTeam,
  type ArenaTeleporter,
  type ArenaWeapon,
} from "./forerunnerArena";

/** Every weapon a pad can carry, in the arsenal's order (the cart's weapon ids). */
export const ARENA_WEAPONS = [
  "br", "smg", "shotgun", "sniper", "magnum", "sword",
  "ar", "dmr", "carbine", "needlerifle", "beamrifle", "plasmapistol", "plasmarifle", "needler", "spiker", "mauler",
  "rocket", "splaser", "fuelrod", "bruteshot", "concussion", "hammer",
] as const satisfies readonly ArenaWeapon[];

export type ArenaActorKind = "spawn" | "pad" | "hill" | "ball" | "dest" | "tpfrom" | "tpto" | "solid" | "flight" | "death";

/** The kinds the editor can place, and how they read in lists. */
export const ARENA_ACTOR_LABELS: Readonly<Record<ArenaActorKind, string>> = {
  spawn: "Spawn",
  pad: "Weapon pad",
  hill: "Hill",
  ball: "Ball",
  dest: "Bot destination",
  tpfrom: "Teleporter",
  tpto: "Teleporter exit",
  solid: "Collider",
  flight: "Steps",
  death: "Death plane",
};

export interface ArenaActor {
  readonly id: string;
  readonly kind: ArenaActorKind;
  readonly index: number;
  readonly name: string;
  /** Its pivot: feet position for points, the centre of a box, the top of a flight's first step. */
  readonly at: ArenaPoint;
  /** A box's half-extents (colliders and pads, which resize). */
  readonly half?: ArenaPoint;
}

const PREFIX = "arena:";

export function arenaActorId(kind: ArenaActorKind, index: number): string {
  return `${PREFIX}${kind}:${index}`;
}

export function isArenaActorId(id: string): boolean {
  return id.startsWith(PREFIX);
}

const KINDS = new Set<string>(Object.keys(ARENA_ACTOR_LABELS));

export function parseArenaActorId(id: string): { kind: ArenaActorKind; index: number } | null {
  if (!isArenaActorId(id)) return null;
  const [kind, index] = id.slice(PREFIX.length).split(":");
  const n = Number(index);
  if (!kind || !KINDS.has(kind) || !Number.isInteger(n) || n < 0) return null;
  return { kind: kind as ArenaActorKind, index: n };
}

/** A flight's pivot: the top of its first step, on its centre line. */
function flightPivot(f: ArenaFlight): ArenaPoint {
  return f.axis === "z" ? [f.fixed, f.topFrom, f.start] : [f.start, f.topFrom, f.fixed];
}

/** Where the death plane's handle sits: under the middle of the map's colliders and ground. */
function deathPivot(map: ArenaMap): ArenaPoint {
  const xs: number[] = [];
  const zs: number[] = [];
  for (const [cx, , cz, hx, , hz] of map.solids) {
    xs.push(cx - hx, cx + hx);
    zs.push(cz - hz, cz + hz);
  }
  if (map.ground) {
    const span = map.ground.step * (map.ground.n - 1);
    xs.push(map.ground.x0, map.ground.x0 + span);
    zs.push(map.ground.z0, map.ground.z0 + span);
  }
  const mid = (v: number[]) => (v.length > 0 ? (Math.min(...v) + Math.max(...v)) / 2 : 0);
  return [mid(xs), map.deathY, mid(zs)];
}

const fmtWeapons = (m: ArenaMarker) => (m.rotation && m.rotation.length > 0 ? m.rotation : [m.weapon]).join(" → ");

/** Every actor in the map, grouped by kind in a stable order (the outliner's). */
export function arenaActors(map: ArenaMap): ArenaActor[] {
  const out: ArenaActor[] = [];
  const power = new Set(map.power);
  map.spawns.forEach((s, i) => out.push({ id: arenaActorId("spawn", i), kind: "spawn", index: i, name: `Spawn ${i + 1}${s.team ? ` (${s.team})` : ""}`, at: s.at }));
  map.markers.forEach((m, i) => {
    const [cx, cy, cz, hx, hy, hz] = m.box;
    out.push({ id: arenaActorId("pad", i), kind: "pad", index: i, name: `Pad ${i + 1}: ${fmtWeapons(m)}`, at: [cx, cy, cz], half: [hx, hy, hz] });
  });
  map.hills.forEach((h, i) => out.push({ id: arenaActorId("hill", i), kind: "hill", index: i, name: `Hill ${i + 1}`, at: h }));
  out.push({ id: arenaActorId("ball", 0), kind: "ball", index: 0, name: "Ball", at: map.ball });
  map.destinations.forEach((d, i) => out.push({ id: arenaActorId("dest", i), kind: "dest", index: i, name: `Destination ${i + 1}${power.has(i) ? " ★" : ""}`, at: d }));
  (map.teleporters ?? []).forEach((t, i) => {
    out.push({ id: arenaActorId("tpfrom", i), kind: "tpfrom", index: i, name: `Teleporter ${i + 1}`, at: t.from });
    out.push({ id: arenaActorId("tpto", i), kind: "tpto", index: i, name: `Teleporter ${i + 1} exit`, at: t.to });
  });
  map.solids.forEach(([cx, cy, cz, hx, hy, hz], i) => out.push({ id: arenaActorId("solid", i), kind: "solid", index: i, name: `Collider ${i + 1}`, at: [cx, cy, cz], half: [hx, hy, hz] }));
  map.flights.forEach((f, i) => out.push({ id: arenaActorId("flight", i), kind: "flight", index: i, name: `Steps ${i + 1}`, at: flightPivot(f) }));
  out.push({ id: arenaActorId("death", 0), kind: "death", index: 0, name: "Death plane", at: deathPivot(map) });
  return out;
}

/** One actor, or null when the id names nothing in this map. */
export function arenaActor(map: ArenaMap, id: string): ArenaActor | null {
  return arenaActors(map).find((a) => a.id === id) ?? null;
}

const withAt = <T>(list: readonly T[], i: number, value: T): T[] => list.map((v, k) => (k === i ? value : v));
const add3 = (a: ArenaPoint, d: ArenaPoint): ArenaPoint => [a[0] + d[0], a[1] + d[1], a[2] + d[2]];

/** Move an actor's pivot to `to` (the death plane only up and down). */
export function moveArenaActor(map: ArenaMap, id: string, to: ArenaPoint): ArenaMap {
  const ref = parseArenaActorId(id);
  if (!ref) return map;
  const { kind, index: i } = ref;
  const p: ArenaPoint = [to[0], to[1], to[2]];
  switch (kind) {
    case "spawn":
      return map.spawns[i] ? { ...map, spawns: withAt(map.spawns, i, { ...map.spawns[i]!, at: p }) } : map;
    case "pad": {
      const m = map.markers[i];
      return m ? { ...map, markers: withAt(map.markers, i, { ...m, box: [p[0], p[1], p[2], m.box[3], m.box[4], m.box[5]] }) } : map;
    }
    case "hill":
      return map.hills[i] ? { ...map, hills: withAt(map.hills, i, p) } : map;
    case "ball":
      return { ...map, ball: p };
    case "dest":
      return map.destinations[i] ? { ...map, destinations: withAt(map.destinations, i, p) } : map;
    case "tpfrom":
    case "tpto": {
      const t = map.teleporters?.[i];
      if (!t) return map;
      return { ...map, teleporters: withAt(map.teleporters!, i, kind === "tpfrom" ? { ...t, from: p } : { ...t, to: p }) };
    }
    case "solid": {
      const b = map.solids[i];
      return b ? { ...map, solids: withAt(map.solids, i, [p[0], p[1], p[2], b[3], b[4], b[5]] as ArenaBox) } : map;
    }
    case "flight": {
      const f = map.flights[i];
      if (!f) return map;
      const dy = p[1] - f.topFrom;
      const [along, fixed] = f.axis === "z" ? [p[2], p[0]] : [p[0], p[2]];
      // Steps stand on y = 0 (flightSteps): a flight can't sink below it.
      const lift = Math.max(dy, 0.05 - Math.min(f.topFrom, f.topTo));
      return { ...map, flights: withAt(map.flights, i, { ...f, start: along, fixed, topFrom: f.topFrom + lift, topTo: f.topTo + lift }) };
    }
    case "death":
      return { ...map, deathY: p[1] };
  }
}

/** The smallest half-extent a box may have. */
const MIN_HALF = 0.05;

/** Set a box actor's half-extents (colliders and pads); others are unchanged. */
export function resizeArenaActor(map: ArenaMap, id: string, half: ArenaPoint): ArenaMap {
  const ref = parseArenaActorId(id);
  if (!ref) return map;
  const h = half.map((v) => Math.max(MIN_HALF, Math.abs(v))) as [number, number, number];
  if (ref.kind === "solid" && map.solids[ref.index]) {
    const [cx, cy, cz] = map.solids[ref.index]!;
    return { ...map, solids: withAt(map.solids, ref.index, [cx, cy, cz, ...h] as ArenaBox) };
  }
  if (ref.kind === "pad" && map.markers[ref.index]) {
    const m = map.markers[ref.index]!;
    return { ...map, markers: withAt(map.markers, ref.index, { ...m, box: [m.box[0], m.box[1], m.box[2], ...h] as ArenaBox }) };
  }
  return map;
}

/** The kinds that can be placed (the ball is moved, never added; the death plane is one plane). */
export type PlaceableArenaKind = "spawn" | "pad" | "hill" | "dest" | "tpfrom" | "solid";

/** A pad's plinth: half a metre across, 0.8 m tall, standing on the floor. */
const PAD_HALF: ArenaPoint = [0.28, 0.4, 0.28];

/** Place a new actor standing on `floor` (a feet position), returning the map and its id. */
export function addArenaActor(map: ArenaMap, kind: PlaceableArenaKind, floor: ArenaPoint, options: { team?: ArenaTeam; weapon?: ArenaWeapon } = {}): { map: ArenaMap; id: string } {
  const p: ArenaPoint = [floor[0], floor[1], floor[2]];
  switch (kind) {
    case "spawn":
      return { map: { ...map, spawns: [...map.spawns, { at: p, ...(options.team ? { team: options.team } : {}) }] }, id: arenaActorId("spawn", map.spawns.length) };
    case "pad": {
      const weapon = options.weapon ?? "br";
      const box: ArenaBox = [p[0], p[1] + PAD_HALF[1], p[2], ...PAD_HALF];
      return { map: { ...map, markers: [...map.markers, { box, weapon, rotation: [weapon] }] }, id: arenaActorId("pad", map.markers.length) };
    }
    case "hill":
      return { map: { ...map, hills: [...map.hills, p] }, id: arenaActorId("hill", map.hills.length) };
    case "dest":
      return { map: { ...map, destinations: [...map.destinations, p] }, id: arenaActorId("dest", map.destinations.length) };
    case "tpfrom": {
      const list = map.teleporters ?? [];
      return { map: { ...map, teleporters: [...list, { from: p, to: [p[0] + 3, p[1], p[2]], yaw: 0 }] }, id: arenaActorId("tpfrom", list.length) };
    }
    case "solid":
      return { map: { ...map, solids: [...map.solids, [p[0], p[1] + 0.5, p[2], 1, 0.5, 1]] }, id: arenaActorId("solid", map.solids.length) };
  }
}

/** Keep the items whose indices aren't in `drop`. */
const without = <T>(list: readonly T[], drop: ReadonlySet<number>): T[] => list.filter((_, i) => !drop.has(i));

/**
 * Remove actors. Removing either end of a teleporter removes the teleporter;
 * removing a destination drops it from the power positions and renumbers the
 * rest. The ball and the death plane can't be removed (every map has them).
 */
export function removeArenaActors(map: ArenaMap, ids: readonly string[]): ArenaMap {
  const drop = new Map<string, Set<number>>();
  for (const id of ids) {
    const ref = parseArenaActorId(id);
    if (!ref || ref.kind === "ball" || ref.kind === "death") continue;
    const kind = ref.kind === "tpto" ? "tpfrom" : ref.kind;
    if (!drop.has(kind)) drop.set(kind, new Set());
    drop.get(kind)!.add(ref.index);
  }
  if (drop.size === 0) return map;
  const of = (kind: string) => drop.get(kind) ?? new Set<number>();
  const dests = of("dest");
  // A destination's new index: its old one less the removed ones before it.
  const renumber = (i: number) => i - [...dests].filter((d) => d < i).length;
  const next: ArenaMap = {
    ...map,
    spawns: without(map.spawns, of("spawn")),
    markers: without(map.markers, of("pad")),
    hills: without(map.hills, of("hill")),
    destinations: without(map.destinations, dests),
    power: map.power.filter((i) => !dests.has(i)).map(renumber),
    solids: without(map.solids, of("solid")),
    flights: without(map.flights, of("flight")),
  };
  return map.teleporters ? { ...next, teleporters: without(map.teleporters, of("tpfrom")) } : next;
}

/**
 * Copy actors `offset` away (a teleporter end copies its whole teleporter),
 * returning the map and the copies' ids. The ball and the death plane aren't
 * copied.
 */
export function duplicateArenaActors(map: ArenaMap, ids: readonly string[], offset: ArenaPoint = [1, 0, 1]): { map: ArenaMap; ids: string[] } {
  let next = map;
  const out: string[] = [];
  const seenTeleporters = new Set<number>();
  for (const id of ids) {
    const ref = parseArenaActorId(id);
    if (!ref) continue;
    const i = ref.index;
    switch (ref.kind) {
      case "spawn": {
        const s = map.spawns[i];
        if (!s) break;
        out.push(arenaActorId("spawn", next.spawns.length));
        next = { ...next, spawns: [...next.spawns, { ...s, at: add3(s.at, offset) }] };
        break;
      }
      case "pad": {
        const m = map.markers[i];
        if (!m) break;
        out.push(arenaActorId("pad", next.markers.length));
        const [cx, cy, cz, hx, hy, hz] = m.box;
        next = { ...next, markers: [...next.markers, { ...m, box: [cx + offset[0], cy + offset[1], cz + offset[2], hx, hy, hz] }] };
        break;
      }
      case "hill": {
        const h = map.hills[i];
        if (!h) break;
        out.push(arenaActorId("hill", next.hills.length));
        next = { ...next, hills: [...next.hills, add3(h, offset)] };
        break;
      }
      case "dest": {
        const d = map.destinations[i];
        if (!d) break;
        out.push(arenaActorId("dest", next.destinations.length));
        next = { ...next, destinations: [...next.destinations, add3(d, offset)] };
        break;
      }
      case "tpfrom":
      case "tpto": {
        const t = map.teleporters?.[i];
        if (!t || seenTeleporters.has(i)) break;
        seenTeleporters.add(i);
        const list = next.teleporters ?? [];
        out.push(arenaActorId(ref.kind, list.length));
        next = { ...next, teleporters: [...list, { ...t, from: add3(t.from, offset), to: add3(t.to, offset) }] };
        break;
      }
      case "solid": {
        const b = map.solids[i];
        if (!b) break;
        out.push(arenaActorId("solid", next.solids.length));
        next = { ...next, solids: [...next.solids, [b[0] + offset[0], b[1] + offset[1], b[2] + offset[2], b[3], b[4], b[5]]] };
        break;
      }
      case "flight": {
        const f = map.flights[i];
        if (!f) break;
        out.push(arenaActorId("flight", next.flights.length));
        const [da, df] = f.axis === "z" ? [offset[2], offset[0]] : [offset[0], offset[2]];
        next = { ...next, flights: [...next.flights, { ...f, start: f.start + da, fixed: f.fixed + df }] };
        break;
      }
      default:
        break;
    }
  }
  return { map: next, ids: out };
}

// --- The inspector's edits ----------------------------------------------------

export function setSpawnTeam(map: ArenaMap, index: number, team: ArenaTeam | null): ArenaMap {
  const s = map.spawns[index];
  if (!s) return map;
  const { team: _old, ...rest } = s;
  void _old;
  return { ...map, spawns: withAt(map.spawns, index, team ? { ...rest, team } : rest) };
}

/** A pad's weapons in the order it turns through them; the first is what it carries at the start. */
export function setPadWeapons(map: ArenaMap, index: number, weapons: readonly ArenaWeapon[]): ArenaMap {
  const m = map.markers[index];
  const list = weapons.filter((w) => (ARENA_WEAPONS as readonly string[]).includes(w));
  if (!m || list.length === 0) return map;
  return { ...map, markers: withAt(map.markers, index, { box: m.box, weapon: list[0]!, rotation: list }) };
}

/** Make a destination a power position (one bots like to hold), or not. */
export function setDestinationPower(map: ArenaMap, index: number, power: boolean): ArenaMap {
  if (!map.destinations[index] || map.power.includes(index) === power) return map;
  return { ...map, power: power ? [...map.power, index] : map.power.filter((i) => i !== index) };
}

/** Which way a teleporter's arrivals face (radians: 0 along +z, π/2 along +x). */
export function setTeleporterYaw(map: ArenaMap, index: number, yaw: number): ArenaMap {
  const t = map.teleporters?.[index];
  if (!t || !Number.isFinite(yaw)) return map;
  return { ...map, teleporters: withAt(map.teleporters!, index, { ...t, yaw }) };
}

/** A map's ground replaced (null removes it: boxes only). */
export function setArenaGround(map: ArenaMap, ground: ArenaGround | null): ArenaMap {
  const { ground: _old, ...rest } = map;
  void _old;
  return ground ? { ...rest, ground } : rest;
}

/** Every box the map collides with, as the cart and the navmesh see it (colliders, then each flight's steps). */
export function arenaCollisionBoxes(map: ArenaMap): ArenaBox[] {
  return arenaColliders(map);
}

// --- Stored in a sidecar ------------------------------------------------------

/** The cart reads heights to the centimetre; storing more is weight for nothing. */
const cm = (v: number) => Math.round(v * 100) / 100;

/** A map as a sidecar stores it: plain JSON, ground holes as null. */
export interface StoredArenaMap extends Omit<ArenaMap, "ground"> {
  readonly ground?: Omit<ArenaGround, "heights"> & { readonly heights: readonly (number | null)[] };
}

export function storeArenaMap(map: ArenaMap): StoredArenaMap {
  const { ground, ...rest } = map;
  return {
    ...rest,
    ...(ground ? { ground: { x0: ground.x0, z0: ground.z0, step: ground.step, n: ground.n, heights: ground.heights.map((h) => (Number.isFinite(h) ? cm(h) : null)) } } : {}),
  };
}

/** Limits a stored map is held to, so a hostile sidecar can't make the editor bake forever. */
const MAX_ITEMS = 4096;
const MAX_GROUND = 512;
const MAX_COORD = 10000;

const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && Math.abs(v) <= MAX_COORD;
const nums = (v: unknown, n: number): number[] | null => (Array.isArray(v) && v.length === n && v.every(num) ? (v as number[]) : null);
const point = (v: unknown): ArenaPoint | null => {
  const p = nums(v, 3);
  return p ? [p[0]!, p[1]!, p[2]!] : null;
};
const box = (v: unknown): ArenaBox | null => {
  const b = nums(v, 6);
  return b && b.slice(3).every((h) => h >= 0) ? [b[0]!, b[1]!, b[2]!, b[3]!, b[4]!, b[5]!] : null;
};
const list = (v: unknown): unknown[] | null => (Array.isArray(v) && v.length <= MAX_ITEMS ? v : null);
const weapon = (v: unknown): ArenaWeapon | null => ((ARENA_WEAPONS as readonly unknown[]).includes(v) ? (v as ArenaWeapon) : null);

/** Read every item of a list, or null when any is malformed (a map is all or nothing: half a map plays wrong). */
function all<T>(v: unknown, read: (item: unknown) => T | null): T[] | null {
  const items = list(v);
  if (!items) return null;
  const out: T[] = [];
  for (const item of items) {
    const read1 = read(item);
    if (read1 === null) return null;
    out.push(read1);
  }
  return out;
}

function readFlight(v: unknown): ArenaFlight | null {
  const f = (v ?? {}) as Partial<Record<keyof ArenaFlight, unknown>>;
  if ((f.axis !== "x" && f.axis !== "z") || (f.sign !== 1 && f.sign !== -1)) return null;
  if (![f.fixed, f.halfFixed, f.start, f.topFrom, f.topTo].every(num)) return null;
  return { axis: f.axis, fixed: f.fixed as number, halfFixed: f.halfFixed as number, start: f.start as number, sign: f.sign, topFrom: f.topFrom as number, topTo: f.topTo as number };
}

function readMarker(v: unknown): ArenaMarker | null {
  const m = (v ?? {}) as { box?: unknown; weapon?: unknown; rotation?: unknown };
  const b = box(m.box);
  const rotation = m.rotation === undefined ? [] : all(m.rotation, weapon);
  const first = weapon(m.weapon) ?? rotation?.[0] ?? null;
  if (!b || !rotation || !first) return null;
  return rotation.length > 0 ? { box: b, weapon: first, rotation } : { box: b, weapon: first };
}

function readTeleporter(v: unknown): ArenaTeleporter | null {
  const t = (v ?? {}) as { from?: unknown; to?: unknown; yaw?: unknown };
  const from = point(t.from);
  const to = point(t.to);
  return from && to && num(t.yaw) ? { from, to, yaw: t.yaw } : null;
}

function readGround(v: unknown): ArenaGround | null {
  const g = (v ?? {}) as { x0?: unknown; z0?: unknown; step?: unknown; n?: unknown; heights?: unknown };
  if (!num(g.x0) || !num(g.z0) || !num(g.step) || g.step <= 0) return null;
  if (typeof g.n !== "number" || !Number.isInteger(g.n) || g.n < 2 || g.n > MAX_GROUND) return null;
  if (!Array.isArray(g.heights) || g.heights.length !== g.n * g.n) return null;
  const heights: number[] = [];
  for (const h of g.heights) {
    if (h === null) heights.push(NaN);
    else if (num(h)) heights.push(h);
    else return null;
  }
  return { x0: g.x0, z0: g.z0, step: g.step, n: g.n, heights };
}

/** A stored map read back strictly: null when anything about it is malformed. */
export function readArenaMap(value: unknown): ArenaMap | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (typeof v.id !== "string" || !v.id || v.id.length > 64 || typeof v.name !== "string" || v.name.length > 64) return null;
  const solids = all(v.solids, box);
  const flights = all(v.flights, readFlight);
  const spawns = all(v.spawns, (s) => {
    const r = (s ?? {}) as { at?: unknown; team?: unknown };
    const at = point(r.at);
    if (!at || (r.team !== undefined && r.team !== "blue" && r.team !== "red")) return null;
    return r.team ? { at, team: r.team as ArenaTeam } : { at };
  });
  const destinations = all(v.destinations, point);
  const hills = all(v.hills, point);
  const markers = all(v.markers, readMarker);
  const ball = point(v.ball);
  if (!solids || !flights || !spawns || !destinations || !hills || !markers || !ball || !num(v.deathY)) return null;
  const power = all(v.power, (i) => (typeof i === "number" && Number.isInteger(i) && i >= 0 && i < destinations.length ? i : null));
  if (!power) return null;
  const teleporters = v.teleporters === undefined ? [] : all(v.teleporters, readTeleporter);
  if (!teleporters) return null;
  const ground = v.ground === undefined ? null : readGround(v.ground);
  if (v.ground !== undefined && !ground) return null;
  return {
    id: v.id,
    name: v.name,
    solids,
    flights,
    spawns,
    destinations,
    power,
    hills,
    ball,
    deathY: v.deathY,
    markers,
    ...(ground ? { ground } : {}),
    ...(teleporters.length > 0 ? { teleporters } : {}),
  };
}

/** Whether two maps play the same (compared as stored, so a centimetre's float noise doesn't count). */
export function sameArenaMap(a: ArenaMap, b: ArenaMap): boolean {
  return JSON.stringify(storeArenaMap(a)) === JSON.stringify(storeArenaMap(b));
}

/** Whether two maps collide the same (their bots' navmesh would bake the same). */
export function sameArenaCollision(a: ArenaMap, b: ArenaMap): boolean {
  const pick = (m: ArenaMap) => {
    const s = storeArenaMap(m);
    return JSON.stringify([s.solids, s.flights, s.ground ?? null]);
  };
  return pick(a) === pick(b);
}
