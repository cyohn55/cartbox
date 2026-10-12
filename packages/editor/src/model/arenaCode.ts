/**
 * Writing a map's markup into an arena cart's code (ENGINE_PARITY_ROADMAP.md
 * EP25, BEAVER_CREEK_ROADMAP.md B4). Every table the cart reads a map from
 * sits on one line of its code: the colliders, spawns, pads, destinations,
 * hills, ball, death plane, ground and teleporters (arenaLua), the scene's
 * centre the mesh camera orbits, and the tables that follow the pads'
 * Pickups through the sidecar (PAD_ROT, PICKUPS, HOLO_IDX, VM_LEFT).
 *
 * So the editor rewrites exactly those lines, taken from the code
 * {@link lockoutCode} writes for the edited map, and leaves the rest of the
 * cart's code -- whatever its author changed -- as it is. Pure.
 */

import type { ArenaMap, ArenaPoint } from "./forerunnerArena";
import { lockoutCode } from "./lockoutSeed";

/**
 * The lines a map writes, by how each begins. `HF_N,` follows `HF =` only on
 * a map with ground, so it is the one line that may come or go.
 */
export const ARENA_CODE_KEYS = [
  "local CENTER_X =",
  "local CENTER_Y =",
  "local CENTER_Z =",
  "local COL =",
  "local SPN =",
  "local SPT =",
  "local MRK =",
  "local MW  =",
  "local ROAM =",
  "local POWER =",
  "local HILLS =",
  "local BALL =",
  "local DEATH_Y =",
  "HF =",
  "HF_N,",
  "TP =",
  "HOLO_IDX =",
  "VM_LEFT =",
  "PAD_ROT =",
  "PICKUPS =",
] as const;

const OPTIONAL = new Set<string>(["HF_N,"]);

const keyOf = (line: string): string | undefined => ARENA_CODE_KEYS.find((k) => line.startsWith(k));

/** The map's lines as the arena code writes them, by key. */
export function arenaCodeLines(map: ArenaMap, center: ArenaPoint): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of lockoutCode(map, center).split("\n")) {
    const key = keyOf(line);
    if (key && !out.has(key)) out.set(key, line);
  }
  return out;
}

export interface ArenaCodePatch {
  /** The code with the map's lines rewritten (unchanged when any is missing). */
  readonly code: string;
  /** Lines the code should have and doesn't: it isn't an arena cart's, or they were edited away. */
  readonly missing: readonly string[];
  /** How many lines changed. */
  readonly changed: number;
}

/** Rewrite the map's lines in an arena cart's `code` for `map`, its camera orbiting `center`. */
export function patchArenaCode(code: string, map: ArenaMap, center: ArenaPoint): ArenaCodePatch {
  const fresh = arenaCodeLines(map, center);
  const lines = code.split("\n");
  const at = new Map<string, number>();
  lines.forEach((line, i) => {
    const key = keyOf(line);
    if (key && !at.has(key)) at.set(key, i);
  });
  const missing = ARENA_CODE_KEYS.filter((k) => !OPTIONAL.has(k) && !at.has(k));
  if (missing.length > 0) return { code, missing, changed: 0 };
  let changed = 0;
  const out: string[] = [];
  lines.forEach((line, i) => {
    const key = keyOf(line);
    if (!key || at.get(key) !== i) return void out.push(line);
    if (key === "HF_N,") {
      // Written after HF below (or dropped, when the map has no ground).
      if (!fresh.has("HF_N,")) changed += 1;
      return;
    }
    const next = fresh.get(key)!;
    if (next !== line) changed += 1;
    out.push(next);
    if (key === "HF =" && fresh.has("HF_N,")) {
      const old = at.has("HF_N,") ? lines[at.get("HF_N,")!] : undefined;
      if (old !== fresh.get("HF_N,")) changed += 1;
      out.push(fresh.get("HF_N,")!);
    }
  });
  return { code: out.join("\n"), missing: [], changed };
}

/** Whether `code` is an arena cart's: it carries every line a map writes. */
export function isArenaCode(code: string): boolean {
  const lines = new Set(code.split("\n").map(keyOf).filter((k): k is (typeof ARENA_CODE_KEYS)[number] => k !== undefined));
  return ARENA_CODE_KEYS.every((k) => OPTIONAL.has(k) || lines.has(k));
}
