/**
 * The server half of the sidecar registry: reading a cart's sidecars off its
 * row and writing them back.
 *
 * Kept apart from `sidecars.ts` because this half reaches object storage and
 * the database, and the editor imports the table itself. The split is what lets
 * one registry serve the client, the API and the tests.
 *
 * Two wrinkles the plain table cannot express, both handled here:
 *
 * - **The mesh offload.** A large mesh sidecar does not belong in a row, so it
 *   is written to object storage and the column keeps a reference. Reads
 *   resolve the reference back to the payload; writes offload or inline it, and
 *   drop an orphaned object when a sidecar shrinks back under the limit.
 * - **Columns a migration has not reached yet.** `mesh` and `world` are marked
 *   `optionalColumn`, so they are read and written in their own statement. A
 *   missing column then costs that one sidecar, not every sidecar on the cart —
 *   folding them into the main statement would blank a creator's whole cart on
 *   a deploy that ran ahead of its migration.
 */

import { serviceClient } from "./supabase";
import { deleteMeshObject, parseMeshReference, resolveMeshSidecar, storeMeshSidecar } from "./meshStorage";
import {
  OPTIONAL_SIDECAR_KEYS,
  SIDECARS,
  SIDECAR_KEYS,
  emptySidecars,
  assignSidecar,
  sidecarsToRow,
  type SidecarKey,
  type Sidecars,
} from "./sidecars";

/** Postgres "column does not exist" — a migration lagging this deploy. */
const UNDEFINED_COLUMN = "42703";

/** Keys read and written in the main statement (everything not optional). */
const REQUIRED_KEYS: readonly SidecarKey[] = SIDECAR_KEYS.filter(
  (key) => SIDECARS[key].optionalColumn !== true,
);

/**
 * Read every sidecar on a cart. A failure anywhere degrades to "no sidecar"
 * for the affected keys rather than failing the cart load — an editor that
 * opens without a backdrop is recoverable, one that refuses to open is not.
 */
export async function loadSidecars(cartId: string): Promise<Sidecars> {
  const sidecars = emptySidecars();
  const db = serviceClient();

  try {
    const columns = REQUIRED_KEYS.map((key) => SIDECARS[key].column).join(", ");
    const { data, error } = await db.from("carts").select(columns).eq("id", cartId).maybeSingle();
    if (!error && data) {
      const row = data as unknown as Record<string, unknown>;
      for (const key of REQUIRED_KEYS) {
        assignSidecar(sidecars, key, SIDECARS[key].parse(row[SIDECARS[key].column]));
      }
    }
  } catch {
    // Leaves every required sidecar null.
  }

  // Each optional column in its own query, so one unprovisioned column costs
  // only itself.
  await Promise.all(
    OPTIONAL_SIDECAR_KEYS.map(async (key) => {
      try {
        const column = SIDECARS[key].column;
        const { data, error } = await db.from("carts").select(column).eq("id", cartId).maybeSingle();
        if (error || !data) return;
        const raw = (data as unknown as Record<string, unknown>)[column];
        // A large mesh lives in object storage with only a reference on the row.
        const resolved = key === "mesh" ? await resolveMeshSidecar(toStored(raw)) : raw;
        assignSidecar(sidecars, key, SIDECARS[key].parse(resolved));
      } catch {
        // Leaves this sidecar null.
      }
    }),
  );

  return sidecars;
}

function toStored(raw: unknown): string | null {
  if (typeof raw === "string") return raw;
  if (raw === null || raw === undefined) return null;
  try {
    return JSON.stringify(raw);
  } catch {
    return null;
  }
}

/** What a write did, so the caller can report an honest failure. */
export interface SidecarWriteResult {
  ok: boolean;
  /** Sidecars that could not be stored because their column is not provisioned. */
  skipped: SidecarKey[];
  error?: string;
}

/**
 * Write every sidecar to the cart row, plus any extra columns the caller owns
 * (the marketplace details ride along, so a whole save is one statement).
 *
 * The required columns go in **one** UPDATE, which is the point: a creator can
 * no longer end up with a row carrying a new backdrop beside an old collision
 * layer because the fourth of twelve requests failed.
 */
export async function storeSidecars(
  cartId: string,
  sidecars: Sidecars,
  extraColumns: Record<string, unknown> = {},
): Promise<SidecarWriteResult> {
  const db = serviceClient();
  const skipped: SidecarKey[] = [];

  const row = { ...sidecarsToRow(sidecars, REQUIRED_KEYS), ...extraColumns };
  const { error } = await db.from("carts").update(row).eq("id", cartId);
  if (error) {
    return { ok: false, skipped, error: error.message };
  }

  for (const key of OPTIONAL_SIDECAR_KEYS) {
    const result = await writeOptionalColumn(cartId, key, sidecars[key]);
    if (!result.ok) return { ok: false, skipped, error: result.error };
    if (result.skipped) skipped.push(key);
  }

  return { ok: true, skipped };
}

/** Write one sidecar's column, for the single-sidecar endpoints. */
export async function storeSidecar(
  cartId: string,
  key: SidecarKey,
  value: unknown,
): Promise<SidecarWriteResult> {
  if (SIDECARS[key].optionalColumn) {
    const result = await writeOptionalColumn(cartId, key, value);
    if (!result.ok) return { ok: false, skipped: [], error: result.error };
    return { ok: true, skipped: result.skipped ? [key] : [] };
  }

  const { error } = await serviceClient()
    .from("carts")
    .update({ [SIDECARS[key].column]: value })
    .eq("id", cartId);
  return error ? { ok: false, skipped: [], error: error.message } : { ok: true, skipped: [] };
}

/**
 * Write a column a migration may not have created yet, in its own statement, so
 * its absence costs only this sidecar. Also carries the mesh offload: a large
 * payload goes to object storage and the column keeps a reference to it.
 */
async function writeOptionalColumn(
  cartId: string,
  key: SidecarKey,
  value: unknown,
): Promise<{ ok: boolean; skipped?: boolean; error?: string }> {
  // storeMeshSidecar returns either the payload itself or a reference to the
  // object it wrote, depending on size and whether R2 is configured.
  const stored = key === "mesh" ? await storeMeshSidecar(cartId, toStored(value)) : value;

  const { error } = await serviceClient()
    .from("carts")
    .update({ [SIDECARS[key].column]: stored })
    .eq("id", cartId);

  if (error) {
    if (error.code === UNDEFINED_COLUMN) return { ok: true, skipped: true };
    return { ok: false, error: error.message };
  }

  // A save that inlined (or cleared) the mesh leaves any previously offloaded
  // object orphaned; a re-offload reuses the same deterministic key, so only
  // these transitions can strand one.
  if (key === "mesh" && !parseMeshReference(typeof stored === "string" ? stored : null)) {
    await deleteMeshObject(cartId);
  }
  return { ok: true };
}
