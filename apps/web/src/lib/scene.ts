/**
 * Server-side handling of the cart parallax-scene sidecar.
 *
 * The scene is authored in the editor and stored on the cart row as JSON; the
 * play route hands it to @cartbox/player's `scene` mount option, which composites
 * the depth layers (with aerial-perspective atmosphere) behind the cart's live
 * foreground. This module owns the one decision the save route makes — what to
 * write to the column for a given request body — kept pure so it can be tested
 * on its own inputs and outputs, the way the FX and voxel sidecars are.
 */

import { parseScene, type SceneSpec } from "@cartbox/player";

/**
 * The outcome of validating a scene save. `scene` is what to write to the column
 * (null clears it); `error` is a client-facing message for a 400 response.
 */
export type SceneUpdate = { scene: SceneSpec | null } | { error: string };

/**
 * Decides what a `PUT /api/carts/:id/scene` body means for the stored column.
 *
 * An explicit `null` clears the scene — the author removed their backdrop. Any
 * other body is validated by the shared runtime parser: a well-formed scene
 * (at least one usable layer) is stored as its clamped, canonical form; anything
 * the parser rejects is a malformed request. `parseScene` already collapses a
 * layer-less scene to null, so there is no separate empty-scene case to store.
 */
export function resolveSceneUpdate(body: unknown): SceneUpdate {
  if (body === null) {
    return { scene: null };
  }
  const scene = parseScene(body);
  if (scene === null) {
    return { error: "Scene is malformed." };
  }
  return { scene };
}
