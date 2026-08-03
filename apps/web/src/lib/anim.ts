/**
 * Server-side handling of the cart animation-timeline sidecar.
 *
 * The animation is authored in the editor and stored on the cart row as JSON; the
 * play route hands it to @cartbox/player's `anim` mount option, which plays the
 * declared clips/tracks/placements host-side off the frame clock (driving scene
 * layers, post-FX values, and foreground set-dressing — no cart code). This module
 * owns the one decision the save route makes — what to write to the column for a
 * given request body — kept pure so it can be tested on its own inputs and outputs,
 * the way the FX, scene, and voxel sidecars are.
 */

import { parseAnim, type AnimSpec } from "@cartbox/player";

/**
 * The outcome of validating an animation save. `anim` is what to write to the
 * column (null clears it); `error` is a client-facing message for a 400 response.
 */
export type AnimUpdate = { anim: AnimSpec | null } | { error: string };

/**
 * Decides what a `PUT /api/carts/:id/anim` body means for the stored column.
 *
 * An explicit `null` clears the animation — the author removed it. Any other body
 * is validated by the shared runtime parser: a well-formed animation (at least one
 * usable clip, track, or placement) is stored as its clamped, canonical form;
 * anything the parser rejects is a malformed request. `parseAnim` already collapses
 * an empty animation to null, so there is no separate empty case to store.
 */
export function resolveAnimUpdate(body: unknown): AnimUpdate {
  if (body === null) {
    return { anim: null };
  }
  const anim = parseAnim(body);
  if (anim === null) {
    return { error: "Animation is malformed." };
  }
  return { anim };
}
