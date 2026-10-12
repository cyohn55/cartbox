/**
 * From an arena map's markup to the game (ENGINE_PARITY_ROADMAP.md EP24–EP25,
 * BEAVER_CREEK_ROADMAP.md B4): what the editor does when its author presses
 * Build, and what the demo does to play a saved cart's map.
 *
 * - **Pickups.** The weapons floating over the pads are scene objects, one per
 *   weapon a pad turns through, in a run of the sidecar the cart's code counts
 *   on. They are laid out again for the edited pads; a weapon the cart
 *   already had keeps its model (and any replacement its author made).
 * - **The camera's centre.** The cart's mesh camera orbits the centre of the
 *   scene's bounds as the runtime measures them (`parseMeshScene`), which
 *   moves when Pickups do, so it is measured the same way here.
 * - **The code.** The cart's map lines are rewritten for the edited markup
 *   (`patchArenaCode`); every other line stays the author's.
 * - **Navigation.** The bots' navmesh is baked again from the collision.
 * - **Map Check.** Unreal's Map Check: the validator over the navmesh the bots
 *   will walk, with the sidecar against its budget.
 */

import {
  ARENA_FIRST_PICKUP,
  LOCKOUT_NAV_AGENT,
  arenaNavMesh,
  arenaPickupInstances,
  patchArenaCode,
  readNavMesh,
  serializeNavMesh,
  validateArenaMap,
  type ArenaIssue,
  type ArenaMap,
  type ArenaPoint,
  type AttachedComponent,
  type NavMesh,
} from "@cartbox/editor";
import { parseMeshScene } from "@cartbox/player";

import { encodeMeshSidecar, setMeshArena, setMeshNavMesh, type MeshSidecar, type MeshSidecarEntry } from "./meshSidecar";

/** What a match's sidecar may weigh (the shipped maps are held to it in CI). */
export const ARENA_SIDECAR_BUDGET = 2_800_000;

const isPickup = (id: string) => /^pickup-\d+$/.test(id);

export interface PickupRelay {
  readonly sidecar: MeshSidecar;
  /** Set when the scene's objects aren't in the order the cart's code counts on (something before the Holograms was added or removed). */
  readonly warning: string | null;
}

/** The scene with its Pickups laid out for `map`'s pads, where the old ones were. */
export function relayArenaPickups(sidecar: MeshSidecar, map: ArenaMap): PickupRelay {
  const old = sidecar.meshes.filter((m) => isPickup(m.id));
  const byWeapon = new Map<string, MeshSidecarEntry>();
  for (const m of old) if (!byWeapon.has(m.name)) byWeapon.set(m.name, m);
  const fresh: MeshSidecarEntry[] = arenaPickupInstances(map).map((p) => {
    const kept = byWeapon.get(p.name);
    const transform = p.transform as MeshSidecarEntry["transform"];
    const components = p.components as readonly AttachedComponent[];
    // A weapon this scene already floats keeps its model, level of detail and look.
    if (kept) return { ...kept, id: p.id, name: p.name, transform, components };
    return { id: p.id, name: p.name, mesh: p.mesh, transform, components };
  });
  const firstOld = sidecar.meshes.findIndex((m) => isPickup(m.id));
  const holo = sidecar.meshes.findIndex((m) => m.id === "hologram-1");
  const at = firstOld >= 0 ? firstOld : holo >= 0 ? holo : Math.min(ARENA_FIRST_PICKUP, sidecar.meshes.length);
  const rest = sidecar.meshes.filter((m) => !isPickup(m.id));
  const before = rest.slice(0, Math.min(at, rest.length));
  const meshes = [...before, ...fresh, ...rest.slice(before.length)];
  const holoAt = meshes.findIndex((m) => m.id === "hologram-1");
  const warning =
    at !== ARENA_FIRST_PICKUP || (holoAt >= 0 && holoAt !== ARENA_FIRST_PICKUP + fresh.length)
      ? `The scene's first objects aren't the arena's own (its map, bots and viewmodels, then the Pickups and Holograms), so the cart may draw the wrong object for a Pickup or a Hologram. Keep new objects after the arena's.`
      : null;
  return { sidecar: { ...sidecar, meshes }, warning };
}

/** The centre the runtime frames the scene on (and the cart's camera orbits), or null when it doesn't parse. */
export function arenaSceneCentre(sidecar: MeshSidecar): ArenaPoint | null {
  const json = encodeMeshSidecar(sidecar);
  const scene = json ? parseMeshScene(json) : null;
  return scene ? [scene.bounds.center[0], scene.bounds.center[1], scene.bounds.center[2]] : null;
}

/** The bots' navmesh baked from the markup's collision (its colliders, steps and ground). */
export function bakeArenaNavMesh(map: ArenaMap): NavMesh {
  return arenaNavMesh(map, LOCKOUT_NAV_AGENT);
}

/** The scene with its bots' navmesh rebuilt from its markup. */
export function rebuildArenaNavigation(sidecar: MeshSidecar): MeshSidecar {
  return sidecar.arena ? setMeshNavMesh(sidecar, serializeNavMesh(bakeArenaNavMesh(sidecar.arena))) : sidecar;
}

/** Map Check: every problem with the scene's map, against the navmesh its bots will walk (baked fresh when it has none). */
export function checkArenaMap(sidecar: MeshSidecar): ArenaIssue[] {
  const map = sidecar.arena;
  if (!map) return [];
  const navmesh = readNavMesh(sidecar.navmesh) ?? bakeArenaNavMesh(map);
  const size = encodeMeshSidecar(sidecar)?.length ?? 0;
  return validateArenaMap(map, { navmesh, sidecar: { size, budget: ARENA_SIDECAR_BUDGET } });
}

export interface ArenaBuild {
  readonly code: string;
  readonly sidecar: MeshSidecar;
  /** The camera's new centre. */
  readonly centre: ArenaPoint | null;
  /** Why the code couldn't be written (it isn't an arena cart's, or its map lines were edited away). */
  readonly missing: readonly string[];
  /** Lines of code that changed. */
  readonly changed: number;
  readonly warning: string | null;
}

/**
 * Build the scene's markup into the game: lay out its Pickups, measure the
 * camera's centre, and rewrite the cart's map lines. The navmesh is the
 * caller's to rebuild (it is slow, and only collision edits need it).
 */
export function buildArenaToGame(code: string, sidecar: MeshSidecar): ArenaBuild | null {
  const map = sidecar.arena;
  if (!map) return null;
  const relaid = relayArenaPickups(setMeshArena(sidecar, map), map);
  const centre = arenaSceneCentre(relaid.sidecar);
  if (!centre) return { code, sidecar: relaid.sidecar, centre: null, missing: ["the scene doesn't parse"], changed: 0, warning: relaid.warning };
  const patch = patchArenaCode(code, map, centre);
  return { code: patch.code, sidecar: relaid.sidecar, centre, missing: patch.missing, changed: patch.changed, warning: relaid.warning };
}
