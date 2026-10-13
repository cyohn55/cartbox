/**
 * The level editor's arena edits (EDITOR_PRO_ROADMAP.md P7): a scene's arena
 * map — gameplay markup and the collision layer — kept on its sidecar, with
 * colliders fitted to scene objects, ground taken from a terrain, the map
 * checked as it changes, and a saved map made playable in the arena cart.
 * Pure: the Arena panel and /lockout use it, and the tests check it.
 */

import {
  LOCKOUT_NAV_AGENT,
  arenaNavMesh,
  colliderFromBounds,
  groundFromTerrain,
  meshBounds,
  readArenaMap,
  readTerrain,
  validateArenaMap,
  writeArenaMap,
  type ArenaBox,
  type ArenaIssue,
  type ArenaMap,
} from "@cartbox/editor";

import { meshWorldMatrices, readMeshEntry, type MeshSidecar } from "./meshSidecar";

/** The scene's arena map, or null when it has none. */
export function sidecarArena(sidecar: MeshSidecar): ArenaMap | null {
  return readArenaMap(sidecar.arena);
}

/** Store an arena map on the scene (null removes it). */
export function setSidecarArena(sidecar: MeshSidecar, map: ArenaMap | null): MeshSidecar {
  const { arena: _old, ...rest } = sidecar;
  void _old;
  return map ? { ...rest, arena: writeArenaMap(map) } : rest;
}

/** Each object's world bounds (its mesh's box through its world matrix), by id. */
function worldBounds(sidecar: MeshSidecar, ids: readonly string[]): { min: [number, number, number]; max: [number, number, number] }[] {
  const worlds = meshWorldMatrices(sidecar);
  const out: { min: [number, number, number]; max: [number, number, number] }[] = [];
  sidecar.meshes.forEach((entry, k) => {
    if (!ids.includes(entry.id)) return;
    const b = meshBounds(readMeshEntry(entry));
    const m = worlds[k];
    if (!b || !m) return;
    const min: [number, number, number] = [Infinity, Infinity, Infinity];
    const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
    for (let c = 0; c < 8; c += 1) {
      const x = c & 1 ? b.max[0] : b.min[0];
      const y = c & 2 ? b.max[1] : b.min[1];
      const z = c & 4 ? b.max[2] : b.min[2];
      const w = [m[0]! * x + m[4]! * y + m[8]! * z + m[12]!, m[1]! * x + m[5]! * y + m[9]! * z + m[13]!, m[2]! * x + m[6]! * y + m[10]! * z + m[14]!];
      for (let a = 0; a < 3; a += 1) {
        min[a] = Math.min(min[a]!, w[a]!);
        max[a] = Math.max(max[a]!, w[a]!);
      }
    }
    out.push({ min, max });
  });
  return out;
}

/** A collider box fitted round each of the objects (by id), in the order they stand in the scene. */
export function collidersFromObjects(sidecar: MeshSidecar, ids: readonly string[]): ArenaBox[] {
  return worldBounds(sidecar, ids).map((b) => colliderFromBounds(b.min, b.max));
}

/** The world point an object stands on (the bottom centre of its bounds), or null. */
export function objectFoot(sidecar: MeshSidecar, id: string): [number, number, number] | null {
  const b = worldBounds(sidecar, [id])[0];
  return b ? [(b.min[0] + b.max[0]) / 2, b.max[1] >= b.min[1] ? b.min[1] : 0, (b.min[2] + b.max[2]) / 2] : null;
}

/** Walkable ground from one of the scene's terrains (`step` metres between samples), or null. */
export function groundFromSidecarTerrain(sidecar: MeshSidecar, terrainId: string, step = 1) {
  const raw = (sidecar.terrains ?? []).find((t) => (t as { id?: unknown }).id === terrainId);
  const terrain = raw ? readTerrain(raw) : null;
  return terrain ? groundFromTerrain(terrain, step) : null;
}

/**
 * What's wrong with a map. Quick checks (floors under spawns, spawns in
 * walls, the death plane, kill volumes, net range) run as it's edited;
 * `reach` also bakes the bots' navmesh and checks every place can be reached
 * from the first spawn, which takes a moment on a big map.
 */
export function arenaIssues(map: ArenaMap, reach = false): ArenaIssue[] {
  return validateArenaMap(map, reach ? { navmesh: arenaNavMesh(map, LOCKOUT_NAV_AGENT) } : {});
}
