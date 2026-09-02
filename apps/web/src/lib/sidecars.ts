/**
 * The cart's sidecar registry — one table describing every payload that rides
 * beside the .tic bytes on the cart row.
 *
 * A cartridge is more than its .tic. The FX stack, character rig, material
 * bindings, voxel sculpt, imported meshes, HD-2D world, parallax backdrop,
 * animation timeline, weather, collision and tile flags all have nowhere to
 * live in TIC-80's banks, so each one occupies a column on `carts` and is
 * authored by its own editor tab.
 *
 * Before this table each of those eleven payloads was threaded by hand through
 * roughly twenty places: the page's resolve (three of them), the workbench's
 * props, the history hook's snapshot / equality / capture / apply / refs /
 * setters, the save path, the browser-local draft store, the static-export
 * entry, the playtest overlay, and an API route of its own. Two of them —
 * `mesh` and `world` — were never threaded through the last six, so a creator's
 * mesh and world work was silently dropped by Save on the static demo build.
 *
 * That is what a twenty-step manual checklist produces, so the checklist is
 * gone: a sidecar is one entry here, and everything else derives from it.
 *
 * This module is deliberately pure and isomorphic — parsers only, no storage,
 * no database — so the editor, the API routes and the tests all read the same
 * table. The server-only half (object-storage offload, row reads and writes)
 * lives in `sidecarStorage.ts`.
 */

import {
  parseAnim,
  parseParticles,
  parsePostFxSettings,
  parseScene,
  parseWorldScene,
  type AnimSpec,
  type ParticleSpec,
  type PostFxSettings,
  type SceneSpec,
} from "@cartbox/player";
import type { CollisionData, FlagData } from "@cartbox/editor";

import { parseCollision, resolveCollisionUpdate } from "./collision";
import { parseFlags, resolveFlagsUpdate } from "./flags";
import { parseMaterials, type WireMaterials } from "./materials";
import { decodeMeshSidecar, encodeMeshSidecar } from "./meshSidecar";
import { resolveAnimUpdate } from "./anim";
import { resolveParticlesUpdate } from "./particles";
import { resolveSceneUpdate } from "./scene";
import { parseRig, type WireRig } from "./rig";
import { parseVoxelPayload } from "./voxelSidecar";

/**
 * One sidecar: which column holds it, how to validate it, and whether the
 * editor's undo timeline covers it.
 */
export interface SidecarDef<T> {
  /** Column on the `carts` row this sidecar occupies. */
  readonly column: string;
  /** How the sidecar is named in an error a creator reads. */
  readonly label: string;
  /**
   * Whether an edit to this sidecar is an undo step. Everything authored by a
   * tab is; the answer is only ever false for a payload the creator cannot
   * edit, and today nothing qualifies — which is the point: `mesh` and `world`
   * sat outside the timeline only because nobody added them to it.
   */
  readonly inHistory: boolean;
  /**
   * Validate a value from any source — a database column, a request body, or a
   * browser-local draft — into the shape stored on the row. Returns null for
   * anything absent or malformed, which clears the column rather than
   * persisting junk. Every parser here is total: it never throws.
   */
  readonly parse: (raw: unknown) => T | null;
  /**
   * True when a not-yet-provisioned column (a migration lagging a deploy)
   * should degrade to "this cart has no such sidecar" instead of failing the
   * whole load or save.
   *
   * Set for every sidecar whose own route carried that tolerance before the
   * registry existed — mesh, world, collision and flags. Folding one of these
   * into the shared UPDATE would make a deploy that ran ahead of its migration
   * fail the creator's *whole* save rather than one layer of it.
   */
  readonly optionalColumn?: boolean;
  /**
   * How a request body for *this* sidecar becomes a stored value, when the
   * sidecar has its own decision helper. Those helpers carry wording and
   * edge cases the generic path cannot infer ("Scene is malformed."), and are
   * unit-tested in their own right, so the registry defers to one where it
   * exists and falls back to {@link parse} where it does not.
   */
  readonly resolveUpdate?: (body: unknown) => SidecarUpdate<T>;
}

/** A validated write, or a client-facing message for a 400. */
export type SidecarUpdate<T> = { value: T | null } | { error: string };

/** Identity helper: keeps each entry's value type inferred from its parser. */
function define<T>(def: SidecarDef<T>): SidecarDef<T> {
  return def;
}

/**
 * Normalise a column that may hold either a string or parsed JSON. Supabase
 * returns a `jsonb` column as a value and a `text` column as a string, and the
 * opaque-string sidecars have been written both ways over time.
 */
function asString(raw: unknown): string | null {
  if (typeof raw === "string") return raw.length > 0 ? raw : null;
  if (raw === null || raw === undefined) return null;
  try {
    return JSON.stringify(raw);
  } catch {
    return null;
  }
}

export const SIDECARS = {
  fx: define<PostFxSettings>({
    column: "fx",
    label: "effects",
    inHistory: true,
    parse: parsePostFxSettings,
  }),
  rig: define<WireRig>({
    column: "rig",
    label: "character rig",
    inHistory: true,
    parse: parseRig,
  }),
  materials: define<WireMaterials>({
    column: "materials",
    label: "materials",
    inHistory: true,
    parse: parseMaterials,
  }),
  voxel: define<string>({
    column: "voxel",
    label: "sculpt",
    inHistory: true,
    parse: (raw) => parseVoxelPayload(asString(raw)),
  }),
  mesh: define<string>({
    column: "mesh",
    label: "meshes",
    inHistory: true,
    optionalColumn: true,
    // Re-encode through the decoder so only well-formed geometry is stored: a
    // corrupt entry is dropped, and a sidecar with no meshes left clears the
    // column rather than storing an empty placeholder.
    parse: (raw) => {
      const encoded = asString(raw);
      return encoded ? encodeMeshSidecar(decodeMeshSidecar(encoded)) : null;
    },
    // A sidecar the decoder empties is a legitimate save — the creator removed
    // their last mesh — so it clears the column instead of being rejected as
    // malformed. Without this, deleting every mesh would 400 the whole save.
    resolveUpdate: (body) => ({
      value: typeof body === "string" ? encodeMeshSidecar(decodeMeshSidecar(body)) : null,
    }),
  }),
  world: define<string>({
    column: "world",
    label: "world",
    inHistory: true,
    optionalColumn: true,
    // Round-trip through the runtime's own parser, so what is stored is exactly
    // what the player will accept when the cart runs.
    parse: (raw) => {
      const encoded = asString(raw);
      const parsed = encoded ? parseWorldScene(encoded) : null;
      return parsed ? JSON.stringify(parsed) : null;
    },
    // Like the mesh sidecar: a world the parser empties clears the column
    // rather than failing the save the creator just asked for.
    resolveUpdate: (body) => {
      const encoded = asString(body);
      const parsed = encoded ? parseWorldScene(encoded) : null;
      return { value: parsed ? JSON.stringify(parsed) : null };
    },
  }),
  scene: define<SceneSpec>({
    column: "scene",
    label: "backdrop",
    inHistory: true,
    parse: parseScene,
    resolveUpdate: (body) => {
      const update = resolveSceneUpdate(body);
      return "error" in update ? update : { value: update.scene };
    },
  }),
  anim: define<AnimSpec>({
    column: "anim",
    label: "animation",
    inHistory: true,
    parse: parseAnim,
    resolveUpdate: (body) => {
      const update = resolveAnimUpdate(body);
      return "error" in update ? update : { value: update.anim };
    },
  }),
  particles: define<ParticleSpec>({
    column: "particles",
    label: "weather",
    inHistory: true,
    parse: parseParticles,
    resolveUpdate: (body) => {
      const update = resolveParticlesUpdate(body);
      return "error" in update ? update : { value: update.particles };
    },
  }),
  collision: define<CollisionData>({
    column: "collision",
    label: "collision",
    inHistory: true,
    optionalColumn: true,
    parse: parseCollision,
    resolveUpdate: (body) => {
      const update = resolveCollisionUpdate(body);
      return "error" in update ? update : { value: update.collision };
    },
  }),
  flags: define<FlagData>({
    column: "flags",
    label: "tile flags",
    inHistory: true,
    optionalColumn: true,
    parse: parseFlags,
    resolveUpdate: (body) => {
      const update = resolveFlagsUpdate(body);
      return "error" in update ? update : { value: update.flags };
    },
  }),
} as const;

export type SidecarKey = keyof typeof SIDECARS;

/** The stored shape of one sidecar, inferred from its parser. */
export type SidecarValue<K extends SidecarKey> =
  (typeof SIDECARS)[K] extends SidecarDef<infer T> ? T : never;

/** Every sidecar a cart carries, each null when the cart has none. */
export type Sidecars = { [K in SidecarKey]: SidecarValue<K> | null };

/** Every sidecar key, in table order. */
export const SIDECAR_KEYS = Object.keys(SIDECARS) as SidecarKey[];

/** The `carts` columns the sidecars occupy, for a row select. */
export const SIDECAR_COLUMNS: readonly string[] = SIDECAR_KEYS.map((key) => SIDECARS[key].column);

/** Keys whose column may not exist yet, and so are read and written separately. */
export const OPTIONAL_SIDECAR_KEYS: readonly SidecarKey[] = SIDECAR_KEYS.filter(
  (key) => SIDECARS[key].optionalColumn === true,
);

/** Keys the editor's undo timeline snapshots. */
export const HISTORY_SIDECAR_KEYS: readonly SidecarKey[] = SIDECAR_KEYS.filter(
  (key) => SIDECARS[key].inHistory,
);

/**
 * Write one sidecar into a bundle.
 *
 * Indexing `Sidecars` with a *union* key makes the write position an
 * intersection of every sidecar's type, which nothing satisfies. The values
 * come from the matching entry's own parser, so the cast is sound; this helper
 * keeps it in one place instead of at every loop that fills a bundle.
 */
export function assignSidecar(target: Sidecars, key: SidecarKey, value: unknown): void {
  (target as Record<SidecarKey, unknown>)[key] = value;
}

/** A cart with no sidecars at all — a brand-new cartridge. */
export function emptySidecars(): Sidecars {
  const empty = {} as Sidecars;
  for (const key of SIDECAR_KEYS) assignSidecar(empty, key, null);
  return empty;
}

/**
 * Validate a whole bundle at once, from a database row, a request body, or a
 * browser-local draft. Unknown keys are ignored and malformed ones become null,
 * so one bad sidecar never costs a creator the other ten.
 */
export function parseSidecars(raw: unknown): Sidecars {
  const source = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const parsed = {} as Sidecars;
  for (const key of SIDECAR_KEYS) {
    // Accept either the sidecar's own key or its column name; they match today,
    // and reading both keeps a future rename from silently dropping payloads.
    const value = key in source ? source[key] : source[SIDECARS[key].column];
    assignSidecar(parsed, key, SIDECARS[key].parse(value));
  }
  return parsed;
}

/** Read a row's sidecar columns into a bundle. */
export function sidecarsFromRow(row: Record<string, unknown> | null | undefined): Sidecars {
  const parsed = {} as Sidecars;
  for (const key of SIDECAR_KEYS) {
    assignSidecar(parsed, key, SIDECARS[key].parse(row?.[SIDECARS[key].column]));
  }
  return parsed;
}

/** Project a bundle onto the row columns it writes. */
export function sidecarsToRow(sidecars: Sidecars, keys: readonly SidecarKey[] = SIDECAR_KEYS): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  for (const key of keys) row[SIDECARS[key].column] = sidecars[key];
  return row;
}

/** Two bundles are equal when every sidecar matches structurally. */
export function sidecarsEqual(a: Sidecars, b: Sidecars): boolean {
  for (const key of SIDECAR_KEYS) {
    const left = a[key];
    const right = b[key];
    if (left === right) continue;
    if (left === null || right === null) return false;
    // Every sidecar is either an opaque string or small plain data produced by
    // the same code paths, so a structural string compare is sound and cheap.
    if (typeof left === "string" || typeof right === "string") return false;
    if (JSON.stringify(left) !== JSON.stringify(right)) return false;
  }
  return true;
}
