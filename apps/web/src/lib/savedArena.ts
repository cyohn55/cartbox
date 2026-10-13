/**
 * A saved arena map, played (EDITOR_PRO_ROADMAP.md P7): `/lockout?map=cart:<id>`
 * plays the arena a cart saved in this browser marked up. Its scene is the
 * arena's scaffold for that map — the shared Spartans, weapons, pickups over
 * its pads, a navmesh baked over its colliders and ground — with the saved
 * scene's own objects, lighting, terrains, foliage and splines laid in after
 * (and its edited Spartans and weapons, where they keep the cart's contract).
 * Its code is the arena code on that map. Pure but for the bake.
 */

import { lockoutCode, readArenaMap, savedArenaSidecar, type ArenaMap, type ArenaPoint } from "@cartbox/editor";

import { isLockoutAsset, overlayLockoutAssets } from "./lockoutAssets";
import { decodeMeshSidecar, encodeMeshSidecar, type MeshSidecar } from "./meshSidecar";

export interface PlayableArena {
  readonly map: ArenaMap;
  /** The scene's sidecar JSON. */
  readonly json: string;
  /** The arena code for the map, with the camera about `center`. */
  readonly code: (center: ArenaPoint) => string;
}

/** The saved scene's parts that travel into play (its world, not the arena's scaffolding). */
function worldOf(saved: MeshSidecar): MeshSidecar["meshes"] {
  return saved.meshes.filter((m) => !isLockoutAsset(m.id));
}

/** A saved scene's arena, made playable; null (with why) when it has no arena map. */
export function playableArena(savedJson: string | null | undefined): PlayableArena | { problem: string } {
  if (!savedJson) return { problem: "That cart isn't saved in this browser." };
  let saved: MeshSidecar;
  try {
    saved = decodeMeshSidecar(savedJson);
  } catch {
    return { problem: "That cart's scene doesn't read." };
  }
  const map = readArenaMap(saved.arena);
  if (!map) return { problem: "That cart's scene isn't an arena map (mark one up in the Mesh tab's Arena panel)." };
  if (map.spawns.length === 0) return { problem: "That arena has no spawns." };
  const scaffold = decodeMeshSidecar(savedArenaSidecar(map));
  // The saved Spartans and weapons, where it has edited ones that keep the contract.
  const assets = overlayLockoutAssets(scaffold, saved).sidecar;
  const scene: MeshSidecar = {
    ...assets,
    meshes: [...assets.meshes, ...worldOf(saved)],
    lighting: saved.lighting ?? assets.lighting,
    ...(saved.terrains ? { terrains: saved.terrains } : {}),
    ...(saved.foliage ? { foliage: saved.foliage } : {}),
    ...(saved.splines ? { splines: saved.splines } : {}),
    ...(saved.materials ? { materials: saved.materials } : {}),
    ...(saved.decalMarks ? { decalMarks: saved.decalMarks } : {}),
    ...(saved.audio ? { audio: saved.audio } : {}),
    ...(saved.timelines ? { timelines: saved.timelines } : {}),
  };
  const json = encodeMeshSidecar(scene);
  if (!json) return { problem: "That arena's scene is empty." };
  return { map, json, code: (center) => lockoutCode(map, center, { maps: [map.name], mapIndex: 0, title: map.name.toUpperCase() }) };
}
