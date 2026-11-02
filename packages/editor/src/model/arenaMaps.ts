/**
 * The arena's maps (BEAVER_CREEK_ROADMAP.md B2): each with its own sidecar
 * and its own cart code, every one built from the same arena code and shared
 * assets. The demo loads one map at a time; the cart's menu offers the others
 * and asks the page to load one (REQ_MAP), and online the host's match word
 * carries the map, so a guest follows its host's.
 */

import type { ArenaPoint } from "./forerunnerArena";
import { BEAVER_SCENE, beaverCenter } from "./beaverCreekSeed";
import { BEAVER_TEXTURES } from "./beaverCreekTextures.generated";
import { withCompressedImages } from "./compressedImages";
import {
  LOCKOUT_CENTER_X,
  LOCKOUT_CENTER_Y,
  LOCKOUT_CENTER_Z,
  LOCKOUT_FX,
  LOCKOUT_SCENE,
  lockoutCartridge,
  arenaMeshSidecar,
  lockoutCode,
  lockoutMeshSidecar,
  type ArenaScene,
} from "./lockoutSeed";

let beaverSidecar: string | null = null;

export interface ArenaMapEntry {
  readonly id: string;
  readonly name: string;
  readonly scene: ArenaScene;
  /** The scene's centre, which the mesh camera orbits (the sidecar's bounds' centre). */
  readonly center: () => ArenaPoint;
  /** The title screen's heading. */
  readonly title: string;
  /** Its sidecar (memoised by the scene). */
  readonly sidecar: () => string;
  /** Its post-processing (the page passes it to the player). */
  readonly fx: unknown;
}

/** Every map, in the order of their index (the match word carries it, 1-based). */
export const ARENA_MAPS: readonly ArenaMapEntry[] = [
  {
    id: "lockout",
    name: "Lockout",
    scene: LOCKOUT_SCENE,
    center: () => [LOCKOUT_CENTER_X, LOCKOUT_CENTER_Y, LOCKOUT_CENTER_Z],
    title: "LOCKOUT ARENA",
    sidecar: lockoutMeshSidecar,
    fx: LOCKOUT_FX,
  },
  {
    id: "beaver",
    name: "Beaver Creek",
    scene: BEAVER_SCENE,
    center: beaverCenter,
    title: "BEAVER CREEK",
    // With its images' baked KTX2 beside their PNGs, for a renderer that samples compressed formats (F1a).
    sidecar: () => (beaverSidecar ??= withCompressedImages(arenaMeshSidecar(BEAVER_SCENE), BEAVER_TEXTURES)),
    fx: LOCKOUT_FX,
  },
];

/** A map by id (the first, Lockout, for an unknown one). */
export function arenaMap(id: string | null | undefined): ArenaMapEntry {
  return ARENA_MAPS.find((m) => m.id === id) ?? ARENA_MAPS[0]!;
}

const codes = new Map<string, string>();

/**
 * A map's cart code: the arena code on its map, knowing every map's name and its own place among them.
 * `center` is the map's scene centre when the caller already has it (a worker that built the sidecar
 * worked it out on the way: DEMO_QUALITY_ROADMAP.md R2), sparing the map's mesh being built again here.
 */
export function arenaMapCode(id: string, center?: ArenaPoint): string {
  const entry = arenaMap(id);
  if (!codes.has(entry.id)) {
    codes.set(
      entry.id,
      lockoutCode(entry.scene.map, center ?? entry.center(), { maps: ARENA_MAPS.map((m) => m.name), mapIndex: ARENA_MAPS.indexOf(entry), title: entry.title }),
    );
  }
  return codes.get(entry.id)!;
}

/**
 * A map's cartridge, with `boot` -- Lua the page appends for this load (say,
 * `MAP_SWITCHED = true` when the menu's map choice brought it here).
 */
export function arenaMapCartridge(id: string, boot = "", center?: ArenaPoint): Uint8Array {
  const code = arenaMapCode(id, center);
  return lockoutCartridge(boot ? `${code}\n${boot}` : code);
}
