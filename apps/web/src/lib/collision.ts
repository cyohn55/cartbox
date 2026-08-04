/**
 * Server-side handling of the cart collision sidecar.
 *
 * The collision layer is authored in the Map tab and stored on the cart row as
 * JSON: one boolean per map cell, packed, describing which cells a game should
 * treat as solid. Unlike the FX or scene sidecars it is gameplay data rather
 * than a render input, so nothing in the player consumes it at draw time — it
 * rides alongside the cart for the cart's own logic to read. This module owns the
 * one decision the save route makes — what to write to the column for a given
 * request body — kept pure so it can be tested on its own inputs and outputs, the
 * way the FX, scene and voxel sidecars are.
 */

import { isCollisionData, type CollisionData } from "@cartbox/editor";

/**
 * The outcome of validating a collision save. `collision` is what to write to
 * the column (null clears it); `error` is a client-facing message for a 400.
 */
export type CollisionUpdate = { collision: CollisionData | null } | { error: string };

/**
 * Decides what a `PUT /api/carts/:id/collision` body means for the stored column.
 *
 * An explicit `null` clears the layer — the author removed all collision. Any
 * other body must be a well-formed {@link CollisionData} payload; a layer with no
 * solid cells is valid and stored as-is (the author may have cleared it while
 * keeping the layer). Anything the validator rejects is a malformed request.
 */
export function resolveCollisionUpdate(body: unknown): CollisionUpdate {
  if (body === null) {
    return { collision: null };
  }
  if (!isCollisionData(body)) {
    return { error: "Collision layer is malformed." };
  }
  return { collision: body };
}

/** Validate a value read back from the cart row, returning null when absent/malformed. */
export function parseCollision(value: unknown): CollisionData | null {
  return isCollisionData(value) ? value : null;
}
