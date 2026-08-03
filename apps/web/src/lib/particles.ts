/**
 * Server-side handling of the cart particle/weather sidecar.
 *
 * The weather is authored in the editor and stored on the cart row as JSON; the
 * play route hands it to @cartbox/player's `particles` mount option, which
 * composites the declared emitters (rain/snow/embers/fog) over each frame host-side
 * off a stateless field — no cart code. This module owns the one decision the save
 * route makes — what to write to the column for a given request body — kept pure so
 * it can be tested on its own inputs and outputs, the way the FX, scene, and anim
 * sidecars are.
 */

import { parseParticles, type ParticleSpec } from "@cartbox/player";

/**
 * The outcome of validating a particle save. `particles` is what to write to the
 * column (null clears it); `error` is a client-facing message for a 400 response.
 */
export type ParticlesUpdate = { particles: ParticleSpec | null } | { error: string };

/**
 * Decides what a `PUT /api/carts/:id/particles` body means for the stored column.
 *
 * An explicit `null` clears the weather — the author removed it. Any other body is
 * validated by the shared runtime parser: a well-formed spec (at least one usable
 * emitter) is stored as its clamped, canonical form; anything the parser rejects is
 * a malformed request. `parseParticles` already collapses an emitter-less spec to
 * null, so there is no separate empty case to store.
 */
export function resolveParticlesUpdate(body: unknown): ParticlesUpdate {
  if (body === null) {
    return { particles: null };
  }
  const particles = parseParticles(body);
  if (particles === null) {
    return { error: "Weather is malformed." };
  }
  return { particles };
}
