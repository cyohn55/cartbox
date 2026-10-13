/**
 * Arena maps authored in the editor (EDITOR_PRO_ROADMAP.md P7, completing
 * BEAVER_CREEK_ROADMAP.md B4): an {@link ArenaMap} as JSON a scene stores, so
 * a map's gameplay markup — spawns, weapon pads, hills, the ball,
 * teleporters, kill volumes, bot destinations — and its collision layer
 * (boxes, flights of steps, ground) travel with the scene and play in the
 * arena cart; and the edits the editor's Arena panel makes to it.
 *
 * Reading is defensive (malformed entries dropped, values clamped, limits
 * kept), and a shipped map written and read back is the same map, so Lockout
 * and Beaver Creek round-trip as saved maps. Pure.
 */

import { ARENA_WEAPONS, type ArenaBox, type ArenaFlight, type ArenaGround, type ArenaMap, type ArenaMarker, type ArenaPoint, type ArenaSpawn, type ArenaTeleporter, type ArenaWeapon } from "./forerunnerArena";
import { terrainHeight, type Terrain } from "./terrain";

/** The most of each a stored map keeps. */
export const ARENA_LIMITS = {
  solids: 4096,
  flights: 256,
  spawns: 64,
  destinations: 256,
  hills: 16,
  markers: 32,
  rotation: 6,
  teleporters: 32,
  kills: 64,
  groundSamples: 513,
} as const;

/** How far a stored position may sit from the origin (beyond the net state's reach anyway). */
const SPAN = 1000;

/** An arena map as a scene stores it (plain JSON: a hole in the ground is null). */
export interface StoredArenaMap {
  readonly version: 1;
  readonly id: string;
  readonly name: string;
  readonly solids: readonly (readonly number[])[];
  readonly flights: readonly ArenaFlight[];
  readonly spawns: readonly ArenaSpawn[];
  readonly destinations: readonly (readonly number[])[];
  readonly power: readonly number[];
  readonly hills: readonly (readonly number[])[];
  readonly ball: readonly number[];
  readonly deathY: number;
  readonly markers: readonly ArenaMarker[];
  readonly ground?: { readonly x0: number; readonly z0: number; readonly step: number; readonly n: number; readonly heights: readonly (number | null)[] };
  readonly teleporters?: readonly ArenaTeleporter[];
  readonly kills?: readonly (readonly number[])[];
}

/** A map as JSON. */
export function writeArenaMap(map: ArenaMap): StoredArenaMap {
  return {
    version: 1,
    id: map.id,
    name: map.name,
    solids: map.solids.map((b) => [...b]),
    flights: map.flights.map((f) => ({ ...f })),
    spawns: map.spawns.map((s) => ({ at: [...s.at] as unknown as ArenaPoint, ...(s.team ? { team: s.team } : {}) })),
    destinations: map.destinations.map((p) => [...p]),
    power: [...map.power],
    hills: map.hills.map((p) => [...p]),
    ball: [...map.ball],
    deathY: map.deathY,
    markers: map.markers.map((m) => ({ box: [...m.box] as unknown as ArenaBox, weapon: m.weapon, ...(m.rotation ? { rotation: [...m.rotation] } : {}) })),
    ...(map.ground ? { ground: { ...map.ground, heights: map.ground.heights.map((h) => (Number.isFinite(h) ? h : null)) } } : {}),
    ...(map.teleporters ? { teleporters: map.teleporters.map((t) => ({ from: [...t.from] as unknown as ArenaPoint, to: [...t.to] as unknown as ArenaPoint, yaw: t.yaw })) } : {}),
    ...(map.kills ? { kills: map.kills.map((b) => [...b]) } : {}),
  };
}

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const list = (v: unknown, max: number): unknown[] => (Array.isArray(v) ? v.slice(0, max) : []);

function point(v: unknown): ArenaPoint | null {
  if (!Array.isArray(v) || v.length !== 3 || !v.every(finite)) return null;
  const [x, y, z] = v as number[];
  return [clamp(x!, -SPAN, SPAN), clamp(y!, -SPAN, SPAN), clamp(z!, -SPAN, SPAN)];
}

function box(v: unknown): ArenaBox | null {
  if (!Array.isArray(v) || v.length !== 6 || !v.every(finite)) return null;
  const [cx, cy, cz, hx, hy, hz] = v as number[];
  return [clamp(cx!, -SPAN, SPAN), clamp(cy!, -SPAN, SPAN), clamp(cz!, -SPAN, SPAN), clamp(hx!, 0.01, SPAN), clamp(hy!, 0.01, SPAN), clamp(hz!, 0.01, SPAN)];
}

const isWeapon = (v: unknown): v is ArenaWeapon => typeof v === "string" && (ARENA_WEAPONS as readonly string[]).includes(v);

function flight(v: unknown): ArenaFlight | null {
  const r = (v ?? {}) as Record<string, unknown>;
  if ((r.axis !== "x" && r.axis !== "z") || (r.sign !== 1 && r.sign !== -1)) return null;
  if (![r.fixed, r.halfFixed, r.start, r.topFrom, r.topTo].every(finite)) return null;
  return {
    axis: r.axis,
    fixed: clamp(r.fixed as number, -SPAN, SPAN),
    halfFixed: clamp(r.halfFixed as number, 0.1, 50),
    start: clamp(r.start as number, -SPAN, SPAN),
    sign: r.sign,
    topFrom: clamp(r.topFrom as number, 0, 100),
    topTo: clamp(r.topTo as number, 0, 100),
  };
}

function ground(v: unknown): ArenaGround | null {
  const r = (v ?? {}) as Record<string, unknown>;
  if (![r.x0, r.z0, r.step, r.n].every(finite) || !Array.isArray(r.heights)) return null;
  const n = Math.round(r.n as number);
  if (n < 2 || n > ARENA_LIMITS.groundSamples || r.heights.length !== n * n || !((r.step as number) > 0)) return null;
  return {
    x0: clamp(r.x0 as number, -SPAN, SPAN),
    z0: clamp(r.z0 as number, -SPAN, SPAN),
    step: clamp(r.step as number, 0.1, 50),
    n,
    heights: r.heights.map((h) => (finite(h) ? clamp(h, -SPAN, SPAN) : Number.NaN)),
  };
}

/** Read a stored map defensively, or null when it isn't one. */
export function readArenaMap(value: unknown): ArenaMap | null {
  if (!value || typeof value !== "object") return null;
  const r = value as Record<string, unknown>;
  if (typeof r.id !== "string" || !finite(r.deathY)) return null;
  const ball = point(r.ball);
  if (!ball) return null;
  const destinations = list(r.destinations, ARENA_LIMITS.destinations).map(point).filter((p): p is ArenaPoint => p !== null);
  const markers: ArenaMarker[] = [];
  for (const raw of list(r.markers, ARENA_LIMITS.markers)) {
    const m = (raw ?? {}) as Record<string, unknown>;
    const b = box(m.box);
    if (!b || !isWeapon(m.weapon)) continue;
    const rotation = list(m.rotation, ARENA_LIMITS.rotation).filter(isWeapon);
    markers.push({ box: b, weapon: m.weapon, ...(Array.isArray(m.rotation) && rotation.length > 0 ? { rotation } : {}) });
  }
  const spawns: ArenaSpawn[] = [];
  for (const raw of list(r.spawns, ARENA_LIMITS.spawns)) {
    const s = (raw ?? {}) as Record<string, unknown>;
    const at = point(s.at);
    if (at) spawns.push({ at, ...(s.team === "blue" || s.team === "red" ? { team: s.team } : {}) });
  }
  const teleporters: ArenaTeleporter[] = [];
  for (const raw of list(r.teleporters, ARENA_LIMITS.teleporters)) {
    const t = (raw ?? {}) as Record<string, unknown>;
    const from = point(t.from);
    const to = point(t.to);
    if (from && to) teleporters.push({ from, to, yaw: finite(t.yaw) ? t.yaw : 0 });
  }
  const kills = list(r.kills, ARENA_LIMITS.kills).map(box).filter((b): b is ArenaBox => b !== null);
  const g = r.ground === undefined ? null : ground(r.ground);
  return {
    id: r.id.slice(0, 64),
    name: typeof r.name === "string" ? r.name.slice(0, 64) : "Arena",
    solids: list(r.solids, ARENA_LIMITS.solids).map(box).filter((b): b is ArenaBox => b !== null),
    flights: list(r.flights, ARENA_LIMITS.flights).map(flight).filter((f): f is ArenaFlight => f !== null),
    spawns,
    destinations,
    power: [...new Set(list(r.power, ARENA_LIMITS.destinations).filter((i): i is number => Number.isInteger(i) && (i as number) >= 0 && (i as number) < destinations.length))],
    hills: list(r.hills, ARENA_LIMITS.hills).map(point).filter((p): p is ArenaPoint => p !== null),
    ball,
    deathY: clamp(r.deathY, -SPAN, SPAN),
    markers,
    ...(g ? { ground: g } : {}),
    ...(Array.isArray(r.teleporters) ? { teleporters } : {}),
    ...(Array.isArray(r.kills) ? { kills } : {}),
  };
}

/** A new, empty map: a ball at the origin and a death plane 20 m down. */
export function emptyArenaMap(id: string, name: string): ArenaMap {
  return { id, name, solids: [], flights: [], spawns: [], destinations: [], power: [], hills: [], ball: [0, 1, 0], deathY: -20, markers: [] };
}

// --- Editing ----------------------------------------------------------------------------

/** What the Arena panel places and lists. */
export type MarkupKind = "spawn" | "pad" | "hill" | "ball" | "destination" | "teleporter" | "exit" | "kill" | "collider";

/** One piece of markup: its kind and its place in its list (a teleporter's exit shares the teleporter's index). */
export interface MarkupRef {
  readonly kind: MarkupKind;
  readonly index: number;
}

export const MARKUP_LABELS: Readonly<Record<MarkupKind, string>> = {
  spawn: "Spawn",
  pad: "Weapon pad",
  hill: "Hill",
  ball: "Ball",
  destination: "Bot destination",
  teleporter: "Teleporter",
  exit: "Teleporter exit",
  kill: "Kill volume",
  collider: "Collider",
};

/** Sizes new boxes start at: a pad's plinth, a kill volume, a collider. */
const PAD_HALF: readonly [number, number, number] = [0.6, 0.15, 0.6];
const KILL_HALF: readonly [number, number, number] = [4, 1, 4];
const COLLIDER_HALF: readonly [number, number, number] = [1, 1, 1];

/** A box of half-size `half` standing on `at`. */
const standing = (at: ArenaPoint, half: readonly [number, number, number]): ArenaBox => [at[0], at[1] + half[1], at[2], half[0], half[1], half[2]];

/** Add a piece of markup at a point (a box stands on it). A teleporter's exit starts 4 m along +z. */
export function addMarkup(map: ArenaMap, kind: MarkupKind, at: ArenaPoint): { map: ArenaMap; ref: MarkupRef } {
  switch (kind) {
    case "spawn":
      return { map: { ...map, spawns: [...map.spawns, { at }] }, ref: { kind, index: map.spawns.length } };
    case "pad":
      return { map: { ...map, markers: [...map.markers, { box: standing(at, PAD_HALF), weapon: "br" }] }, ref: { kind, index: map.markers.length } };
    case "hill":
      return { map: { ...map, hills: [...map.hills, at] }, ref: { kind, index: map.hills.length } };
    case "ball":
      return { map: { ...map, ball: at }, ref: { kind, index: 0 } };
    case "destination":
      return { map: { ...map, destinations: [...map.destinations, at] }, ref: { kind, index: map.destinations.length } };
    case "teleporter":
    case "exit": {
      const all = map.teleporters ?? [];
      return { map: { ...map, teleporters: [...all, { from: at, to: [at[0], at[1], at[2] + 4], yaw: 0 }] }, ref: { kind: "teleporter", index: all.length } };
    }
    case "kill": {
      const all = map.kills ?? [];
      return { map: { ...map, kills: [...all, standing(at, KILL_HALF)] }, ref: { kind, index: all.length } };
    }
    case "collider":
      return { map: { ...map, solids: [...map.solids, standing(at, COLLIDER_HALF)] }, ref: { kind, index: map.solids.length } };
  }
}

/** Move a piece of markup to stand on a point (a box keeps its size; its bottom lands on the point). */
export function placeMarkup(map: ArenaMap, ref: MarkupRef, at: ArenaPoint): ArenaMap {
  const onto = (b: ArenaBox): ArenaBox => [at[0], at[1] + b[4], at[2], b[3], b[4], b[5]];
  const set = <T>(items: readonly T[], f: (item: T) => T): T[] => items.map((item, i) => (i === ref.index ? f(item) : item));
  switch (ref.kind) {
    case "spawn":
      return { ...map, spawns: set(map.spawns, (s) => ({ ...s, at })) };
    case "pad":
      return { ...map, markers: set(map.markers, (m) => ({ ...m, box: onto(m.box) })) };
    case "hill":
      return { ...map, hills: set(map.hills, () => at) };
    case "ball":
      return { ...map, ball: at };
    case "destination":
      return { ...map, destinations: set(map.destinations, () => at) };
    case "teleporter":
      return { ...map, teleporters: set(map.teleporters ?? [], (t) => ({ ...t, from: at })) };
    case "exit":
      return { ...map, teleporters: set(map.teleporters ?? [], (t) => ({ ...t, to: at })) };
    case "kill":
      return { ...map, kills: set(map.kills ?? [], onto) };
    case "collider":
      return { ...map, solids: set(map.solids, onto) };
  }
}

/** Remove a piece of markup (the ball can't be: every map has one). Power positions follow their destinations. */
export function removeMarkup(map: ArenaMap, ref: MarkupRef): ArenaMap {
  const drop = <T>(items: readonly T[]): T[] => items.filter((_, i) => i !== ref.index);
  switch (ref.kind) {
    case "spawn":
      return { ...map, spawns: drop(map.spawns) };
    case "pad":
      return { ...map, markers: drop(map.markers) };
    case "hill":
      return { ...map, hills: drop(map.hills) };
    case "ball":
      return map;
    case "destination":
      return {
        ...map,
        destinations: drop(map.destinations),
        power: map.power.filter((i) => i !== ref.index).map((i) => (i > ref.index ? i - 1 : i)),
      };
    case "teleporter":
    case "exit":
      return { ...map, teleporters: drop(map.teleporters ?? []) };
    case "kill":
      return { ...map, kills: drop(map.kills ?? []) };
    case "collider":
      return { ...map, solids: drop(map.solids) };
  }
}

/** Make a destination a power position (one worth holding), or not. */
export function setPower(map: ArenaMap, index: number, power: boolean): ArenaMap {
  const has = map.power.includes(index);
  if (has === power || index < 0 || index >= map.destinations.length) return map;
  return { ...map, power: power ? [...map.power, index] : map.power.filter((i) => i !== index) };
}

/** Change a box's size (half-extents), keeping its bottom where it is. */
export function resizeMarkup(map: ArenaMap, ref: MarkupRef, half: readonly [number, number, number]): ArenaMap {
  const h: [number, number, number] = [Math.max(0.05, half[0]), Math.max(0.05, half[1]), Math.max(0.05, half[2])];
  const sized = (b: ArenaBox): ArenaBox => [b[0], b[1] - b[4] + h[1], b[2], h[0], h[1], h[2]];
  const set = (items: readonly ArenaBox[]) => items.map((b, i) => (i === ref.index ? sized(b) : b));
  if (ref.kind === "kill") return { ...map, kills: set(map.kills ?? []) };
  if (ref.kind === "collider") return { ...map, solids: set(map.solids) };
  if (ref.kind === "pad") return { ...map, markers: map.markers.map((m, i) => (i === ref.index ? { ...m, box: sized(m.box) } : m)) };
  return map;
}

/** A collider fitted to world bounds (say, a selected object's). */
export function colliderFromBounds(min: readonly [number, number, number], max: readonly [number, number, number]): ArenaBox {
  return [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2, Math.max(0.01, (max[0] - min[0]) / 2), Math.max(0.01, (max[1] - min[1]) / 2), Math.max(0.01, (max[2] - min[2]) / 2)];
}

/**
 * Walkable ground sampled from a terrain (in world space; a terrain riding on
 * an object should be given with that object's offset in its origin): a
 * square grid `step` apart over its extent, holes and off-terrain samples as
 * NaN.
 */
export function groundFromTerrain(t: Terrain, step = 1): ArenaGround {
  const span = Math.max(t.size[0], t.size[1]);
  const n = Math.max(2, Math.min(ARENA_LIMITS.groundSamples, Math.floor(span / step) + 1));
  const s = span / (n - 1);
  const heights: number[] = [];
  for (let j = 0; j < n; j += 1) for (let i = 0; i < n; i += 1) heights.push(terrainHeight(t, t.origin[0] + i * s, t.origin[2] + j * s) ?? Number.NaN);
  return { x0: t.origin[0], z0: t.origin[2], step: s, n, heights };
}

/** How the editor draws a piece of markup: a point, a box, or a teleporter's link from pad to exit. */
export interface MarkupOverlay {
  readonly ref: MarkupRef;
  readonly at: ArenaPoint;
  readonly box?: ArenaBox;
  readonly link?: readonly [ArenaPoint, ArenaPoint];
  readonly label: string;
  readonly color: string;
}

const COLORS: Readonly<Record<MarkupKind, string>> = {
  spawn: "#7dff9a",
  pad: "#5fe3ff",
  hill: "#ffd447",
  ball: "#ffffff",
  destination: "#c68bff",
  teleporter: "#ff8ae2",
  exit: "#ff8ae2",
  kill: "#ff4a4a",
  collider: "#9aa4b2",
};

/** Every piece of markup as the viewport draws it (colliders only when asked: a map can have thousands). */
export function markupOverlays(map: ArenaMap, colliders = false): MarkupOverlay[] {
  const out: MarkupOverlay[] = [];
  const add = (kind: MarkupKind, index: number, at: ArenaPoint, label: string, extra: Partial<MarkupOverlay> = {}) => out.push({ ref: { kind, index }, at, label, color: COLORS[kind], ...extra });
  const bottom = (b: ArenaBox): ArenaPoint => [b[0], b[1] - b[4], b[2]];
  map.spawns.forEach((s, i) => add("spawn", i, s.at, `${s.team ? `${s.team} ` : ""}spawn ${i + 1}`));
  map.markers.forEach((m, i) => add("pad", i, bottom(m.box), `${(m.rotation ?? [m.weapon]).join("/")}`, { box: m.box }));
  map.hills.forEach((h, i) => add("hill", i, h, `hill ${i + 1}`));
  add("ball", 0, map.ball, "ball");
  map.destinations.forEach((d, i) => add("destination", i, d, map.power.includes(i) ? `power ${i + 1}` : `${i + 1}`));
  (map.teleporters ?? []).forEach((t, i) => {
    add("teleporter", i, t.from, `teleporter ${i + 1}`, { link: [t.from, t.to] });
    add("exit", i, t.to, `exit ${i + 1}`);
  });
  (map.kills ?? []).forEach((b, i) => add("kill", i, bottom(b), `kill ${i + 1}`, { box: b }));
  if (colliders) map.solids.forEach((b, i) => add("collider", i, bottom(b), "", { box: b }));
  return out;
}
