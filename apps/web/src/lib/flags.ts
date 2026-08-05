/**
 * Server-side handling of the cart tile-flags sidecar.
 *
 * The flags layer is authored in the Map tab and stored on the cart row as JSON:
 * one byte (eight gameplay flags) per map cell. Like collision it is gameplay data
 * the cart's own logic reads (via cartbox.flag), not a render input. This module
 * owns the one decision the save route makes — what to write to the column for a
 * given request body — kept pure so it can be tested on its own inputs and
 * outputs, the way the collision and FX sidecars are.
 */

import { isFlagData, type FlagData } from "@cartbox/editor";

/** The outcome of validating a flags save: what to write (null clears), or a 400 message. */
export type FlagsUpdate = { flags: FlagData | null } | { error: string };

/**
 * Decide what a `PUT /api/carts/:id/flags` body means for the stored column. An
 * explicit `null` clears the layer; any other body must be a well-formed
 * {@link FlagData} payload (a layer with no flags set is valid and stored as-is).
 */
export function resolveFlagsUpdate(body: unknown): FlagsUpdate {
  if (body === null) {
    return { flags: null };
  }
  if (!isFlagData(body)) {
    return { error: "Tile-flags layer is malformed." };
  }
  return { flags: body };
}

/** Validate a value read back from the cart row, returning null when absent/malformed. */
export function parseFlags(value: unknown): FlagData | null {
  return isFlagData(value) ? value : null;
}
