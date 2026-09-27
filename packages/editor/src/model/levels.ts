/**
 * Levels (ENGINE_ROADMAP.md, Phase 4 — streaming): a 3D scene's objects can be
 * grouped into named levels, of which one is loaded at a time.
 *
 * - Objects with no level are always loaded (the player, the HUD, anything
 *   shared). Objects in a level exist only while it's the current one: hidden,
 *   with their physics bodies out of the world, otherwise.
 * - A child with no level of its own is in its parent's.
 * - The first level is where a cart starts. `cartbox.level("cave")` switches;
 *   a published cart fetches the new level's textures first (see
 *   textureStream.ts in the web app) and switches once they're in.
 *
 * Stored on the mesh sidecar as `levels: [{id, name}]`, with an object's level
 * as its `level` (the level id). Pure.
 */

export interface SceneLevel {
  readonly id: string;
  readonly name: string;
}

/** Levels a scene may define. */
export const MAX_LEVELS = 32;
const NAME_MAX = 40;

/** Read stored levels: well-formed entries only, unique ids, at most {@link MAX_LEVELS}. */
export function readLevels(value: unknown): SceneLevel[] {
  if (!Array.isArray(value)) return [];
  const out: SceneLevel[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const level = item as { id?: unknown; name?: unknown };
    if (typeof level.id !== "string" || !level.id || seen.has(level.id)) continue;
    const name = typeof level.name === "string" && level.name.trim() ? level.name.trim().slice(0, NAME_MAX) : `Level ${out.length + 1}`;
    seen.add(level.id);
    out.push({ id: level.id, name });
    if (out.length >= MAX_LEVELS) break;
  }
  return out;
}

/**
 * Each object's effective level index (into `levels`), or -1 for always loaded:
 * its own level if it names one that exists, else its parent's. `parents` are
 * indices (-1 for a root), and may come in any order.
 */
export function effectiveLevels(ownLevel: readonly (string | undefined)[], parents: readonly number[], levels: readonly SceneLevel[]): number[] {
  const index = new Map(levels.map((l, i) => [l.id, i]));
  const out = new Array<number>(ownLevel.length).fill(-2); // -2: not yet resolved
  const resolve = (i: number, depth: number): number => {
    if (out[i] !== -2) return out[i]!;
    const own = ownLevel[i] !== undefined ? index.get(ownLevel[i]!) : undefined;
    const parent = parents[i] ?? -1;
    const level = own ?? (parent >= 0 && depth < ownLevel.length ? resolve(parent, depth + 1) : -1);
    out[i] = level;
    return level;
  };
  for (let i = 0; i < ownLevel.length; i += 1) resolve(i, 0);
  return out;
}
